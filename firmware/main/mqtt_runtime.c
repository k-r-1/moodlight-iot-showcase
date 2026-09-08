#include "mqtt_runtime.h"

#include <ctype.h>
#include <inttypes.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING
#include "fleet_credentials.h"
#include "fleet_identity.h"
#endif
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led_controller.h"
#include "mqtt_client.h"
#ifndef CONFIG_MOODLIGHT_FLEET_PROVISIONING
#include "mqtt_credentials.h"
#endif
#include "nvs.h"
#include "sdkconfig.h"

#define MQTT_PORT 8883
#define MQTT_TOPIC_CAPACITY 384
#define MQTT_COMMAND_MAX_BYTES 512
#define MQTT_IDENTIFIER_MAX_BYTES 128
#define MQTT_TASK_STACK_BYTES 4096
#define MQTT_SEQUENCE_MAX 9007199254740991ULL
#define MQTT_CLOCK_VALID_AFTER 1577836800
#define MQTT_SNTP_SYNC_TIMEOUT_MS 10000
#define MQTT_START_RETRY_MS 5000
#define MQTT_START_TASK_STACK_BYTES 4096
#define MQTT_NETWORK_READY_BIT BIT0
#define MQTT_APPLIED_COMMAND_RECORD_VERSION 1U
#define MQTT_APPLIED_COMMAND_KEY "applied_cmd"

typedef struct {
    char command_id[MQTT_IDENTIFIER_MAX_BYTES + 1];
    uint64_t command_sequence;
    led_update_t update;
} mqtt_command_t;

typedef struct {
    uint32_t version;
    uint32_t record_size;
    uint64_t command_sequence;
    char command_id[MQTT_IDENTIFIER_MAX_BYTES + 1];
    uint8_t power;
    uint8_t red;
    uint8_t green;
    uint8_t blue;
    uint8_t brightness;
    uint8_t reserved[2];
} mqtt_applied_command_record_t;

static const char *TAG = "mqtt_runtime";
static esp_mqtt_client_handle_t s_client;
static nvs_handle_t s_nvs;
static SemaphoreHandle_t s_lock;
static bool s_connected;
static bool s_boot_event_sent;
static bool s_has_last_command_sequence;
static uint64_t s_boot_sequence;
static uint64_t s_last_command_sequence;
static char s_last_command_id[MQTT_IDENTIFIER_MAX_BYTES + 1];
static uint64_t s_state_sequence;
static uint64_t s_telemetry_sequence;
static uint64_t s_event_sequence;
static uint64_t s_boot_started_at_ms;
static char s_boot_id[48];
static char s_state_topic[MQTT_TOPIC_CAPACITY];
static char s_telemetry_topic[MQTT_TOPIC_CAPACITY];
static char s_event_topic[MQTT_TOPIC_CAPACITY];
static char s_command_topic[MQTT_TOPIC_CAPACITY];
static EventGroupHandle_t s_network_events;
static TaskHandle_t s_start_task;
static bool s_network_start_registered;
static bool s_sntp_initialized;
static bool s_runtime_state_initialized;
#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING
static fleet_identity_t s_fleet_identity;
#endif
static const char *s_topic_base;

static bool is_identifier(const char *value)
{
    if (value == NULL) {
        return false;
    }
    const size_t length = strlen(value);
    if (length == 0 || length > MQTT_IDENTIFIER_MAX_BYTES) {
        return false;
    }
    for (size_t i = 0; i < length; i++) {
        const unsigned char ch = (unsigned char)value[i];
        if (!isalnum(ch) && ch != '_' && ch != '.' && ch != ':' && ch != '-') {
            return false;
        }
    }
    return true;
}

static bool is_topic_base(const char *value)
{
    if (value == NULL) {
        return false;
    }
    const size_t length = strlen(value);
    if (length == 0 || length + sizeof("/state") > MQTT_TOPIC_CAPACITY || value[length - 1] == '/') {
        return false;
    }
    for (size_t i = 0; i < length; i++) {
        const unsigned char ch = (unsigned char)value[i];
        if (!isalnum(ch) && ch != '_' && ch != '.' && ch != ':' && ch != '-' && ch != '/') {
            return false;
        }
    }
    return true;
}

static esp_err_t build_topic(char *destination, size_t capacity, const char *kind)
{
    const int written = snprintf(destination, capacity, "%s/%s", s_topic_base, kind);
    return written > 0 && (size_t)written < capacity ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static esp_err_t next_sequence(uint64_t *counter, uint64_t *result)
{
    if (xSemaphoreTake(s_lock, portMAX_DELAY) != pdTRUE) {
        return ESP_FAIL;
    }
    esp_err_t err = ESP_OK;
    if (*counter >= MQTT_SEQUENCE_MAX) {
        err = ESP_ERR_INVALID_STATE;
    } else {
        *result = ++(*counter);
    }
    xSemaphoreGive(s_lock);
    return err;
}

static bool is_connected(void)
{
    bool connected = false;
    if (xSemaphoreTake(s_lock, portMAX_DELAY) == pdTRUE) {
        connected = s_connected;
        xSemaphoreGive(s_lock);
    }
    return connected;
}

static void set_connected(bool connected)
{
    if (xSemaphoreTake(s_lock, portMAX_DELAY) == pdTRUE) {
        s_connected = connected;
        xSemaphoreGive(s_lock);
    }
}

static esp_err_t publish_json(const char *topic, cJSON *root)
{
    if (!is_connected()) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_STATE;
    }
    char *payload = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (payload == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const int message_id = esp_mqtt_client_enqueue(s_client, topic, payload, 0, 1, 0, true);
    cJSON_free(payload);
    return message_id >= 0 ? ESP_OK : ESP_FAIL;
}

static esp_err_t add_common_fields(cJSON *root, const char *kind, const char *message_id)
{
    if (cJSON_AddStringToObject(root, "kind", kind) == NULL
            || cJSON_AddStringToObject(root, "messageId", message_id) == NULL
            || cJSON_AddStringToObject(root, "bootId", s_boot_id) == NULL
            || cJSON_AddNumberToObject(root, "bootStartedAtMs", (double)s_boot_started_at_ms) == NULL
            || cJSON_AddNumberToObject(root, "bootSequence", (double)s_boot_sequence) == NULL) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

static esp_err_t publish_state(const char *applied_command_id)
{
    led_state_t state;
    esp_err_t err = led_controller_get_state(&state);
    uint64_t sequence = 0;
    if (err == ESP_OK) {
        err = next_sequence(&s_state_sequence, &sequence);
    }
    if (err != ESP_OK) {
        return err;
    }

    char message_id[96];
    snprintf(message_id, sizeof(message_id), "%s-state-%" PRIu64, s_boot_id, sequence);
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    err = add_common_fields(root, "state", message_id);
    if (err == ESP_OK && cJSON_AddNumberToObject(root, "stateSequence", (double)sequence) == NULL) {
        err = ESP_ERR_NO_MEM;
    }
    if (err == ESP_OK && applied_command_id != NULL
            && cJSON_AddStringToObject(root, "commandId", applied_command_id) == NULL) {
        err = ESP_ERR_NO_MEM;
    }
    if (err == ESP_OK && (cJSON_AddBoolToObject(root, "power", state.power) == NULL
            || cJSON_AddNumberToObject(root, "red", state.red) == NULL
            || cJSON_AddNumberToObject(root, "green", state.green) == NULL
            || cJSON_AddNumberToObject(root, "blue", state.blue) == NULL
            || cJSON_AddNumberToObject(root, "brightness", state.brightness) == NULL)) {
        err = ESP_ERR_NO_MEM;
    }
    if (err != ESP_OK) {
        cJSON_Delete(root);
        return err;
    }
    return publish_json(s_state_topic, root);
}

static esp_err_t format_utc_now(char *destination, size_t capacity)
{
    time_t now;
    time(&now);
    if (now < MQTT_CLOCK_VALID_AFTER) {
        return ESP_ERR_INVALID_STATE;
    }
    struct tm utc;
    if (gmtime_r(&now, &utc) == NULL
            || strftime(destination, capacity, "%Y-%m-%dT%H:%M:%SZ", &utc) == 0) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t publish_event(const char *event_type)
{
    char occurred_at[32];
    esp_err_t err = format_utc_now(occurred_at, sizeof(occurred_at));
    uint64_t sequence = 0;
    if (err == ESP_OK) {
        err = next_sequence(&s_event_sequence, &sequence);
    }
    if (err != ESP_OK) {
        return err;
    }

    char message_id[96];
    snprintf(message_id, sizeof(message_id), "%s-evt-%" PRIu64, s_boot_id, sequence);
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    err = add_common_fields(root, "evt", message_id);
    if (err == ESP_OK && (cJSON_AddNumberToObject(root, "eventSequence", (double)sequence) == NULL
            || cJSON_AddStringToObject(root, "eventType", event_type) == NULL
            || cJSON_AddStringToObject(root, "occurredAt", occurred_at) == NULL)) {
        err = ESP_ERR_NO_MEM;
    }
    if (err != ESP_OK) {
        cJSON_Delete(root);
        return err;
    }
    return publish_json(s_event_topic, root);
}

static esp_err_t publish_telemetry(void)
{
    uint64_t sequence = 0;
    esp_err_t err = next_sequence(&s_telemetry_sequence, &sequence);
    if (err != ESP_OK) {
        return err;
    }
    wifi_ap_record_t access_point = {0};
    const int rssi = esp_wifi_sta_get_ap_info(&access_point) == ESP_OK ? access_point.rssi : -127;
    const uint64_t uptime_seconds = (uint64_t)(esp_timer_get_time() / 1000000);

    char message_id[96];
    snprintf(message_id, sizeof(message_id), "%s-tele-%" PRIu64, s_boot_id, sequence);
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return ESP_ERR_NO_MEM;
    }
    err = add_common_fields(root, "tele", message_id);
    if (err == ESP_OK && (cJSON_AddNumberToObject(root, "telemetrySequence", (double)sequence) == NULL
            || cJSON_AddNumberToObject(root, "uptimeSeconds", (double)uptime_seconds) == NULL
            || cJSON_AddNumberToObject(root, "rssi", rssi) == NULL
            || cJSON_AddStringToObject(root, "firmwareVersion", esp_app_get_description()->version) == NULL)) {
        err = ESP_ERR_NO_MEM;
    }
    if (err != ESP_OK) {
        cJSON_Delete(root);
        return err;
    }
    return publish_json(s_telemetry_topic, root);
}

static bool number_in_range(const cJSON *item, double minimum, double maximum)
{
    return cJSON_IsNumber(item) && isfinite(item->valuedouble)
        && floor(item->valuedouble) == item->valuedouble
        && item->valuedouble >= minimum && item->valuedouble <= maximum;
}

static esp_err_t parse_command(const char *payload, size_t length,
                               mqtt_command_t *command)
{
    const char *parse_end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(payload, length, &parse_end, false);
    if (!cJSON_IsObject(root)) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }
    while (parse_end < payload + length && isspace((unsigned char)*parse_end)) {
        parse_end++;
    }
    if (parse_end != payload + length) {
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    enum {
        SEEN_COMMAND_ID = 1U << 0,
        SEEN_COMMAND_SEQUENCE = 1U << 1,
        SEEN_POWER = 1U << 2,
        SEEN_RED = 1U << 3,
        SEEN_GREEN = 1U << 4,
        SEEN_BLUE = 1U << 5,
        SEEN_BRIGHTNESS = 1U << 6,
    };
    uint32_t seen = 0;
    memset(command, 0, sizeof(*command));

    cJSON *item = NULL;
    cJSON_ArrayForEach(item, root) {
        uint32_t field = 0;
        if (strcmp(item->string, "commandId") == 0) {
            field = SEEN_COMMAND_ID;
            if (!cJSON_IsString(item) || !is_identifier(item->valuestring)) {
                goto invalid;
            }
            strcpy(command->command_id, item->valuestring);
        } else if (strcmp(item->string, "commandSequence") == 0) {
            field = SEEN_COMMAND_SEQUENCE;
            if (!number_in_range(item, 1, (double)MQTT_SEQUENCE_MAX)) {
                goto invalid;
            }
            command->command_sequence = (uint64_t)item->valuedouble;
        } else if (strcmp(item->string, "power") == 0) {
            field = SEEN_POWER;
            if (!cJSON_IsBool(item)) {
                goto invalid;
            }
            command->update.fields |= LED_UPDATE_POWER;
            command->update.values.power = cJSON_IsTrue(item);
        } else if (strcmp(item->string, "red") == 0) {
            field = SEEN_RED;
            if (!number_in_range(item, 0, 255)) {
                goto invalid;
            }
            command->update.fields |= LED_UPDATE_RED;
            command->update.values.red = (uint8_t)item->valuedouble;
        } else if (strcmp(item->string, "green") == 0) {
            field = SEEN_GREEN;
            if (!number_in_range(item, 0, 255)) {
                goto invalid;
            }
            command->update.fields |= LED_UPDATE_GREEN;
            command->update.values.green = (uint8_t)item->valuedouble;
        } else if (strcmp(item->string, "blue") == 0) {
            field = SEEN_BLUE;
            if (!number_in_range(item, 0, 255)) {
                goto invalid;
            }
            command->update.fields |= LED_UPDATE_BLUE;
            command->update.values.blue = (uint8_t)item->valuedouble;
        } else if (strcmp(item->string, "brightness") == 0) {
            field = SEEN_BRIGHTNESS;
            if (!number_in_range(item, 0, 100)) {
                goto invalid;
            }
            command->update.fields |= LED_UPDATE_BRIGHTNESS;
            command->update.values.brightness = (uint8_t)item->valuedouble;
        } else {
            goto invalid;
        }
        if ((seen & field) != 0) {
            goto invalid;
        }
        seen |= field;
    }

    cJSON_Delete(root);
    if ((seen & (SEEN_COMMAND_ID | SEEN_COMMAND_SEQUENCE))
            != (SEEN_COMMAND_ID | SEEN_COMMAND_SEQUENCE)
            || command->update.fields == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    return ESP_OK;

invalid:
    cJSON_Delete(root);
    return ESP_ERR_INVALID_ARG;
}

static led_update_t full_update_from_state(const led_state_t *state)
{
    const led_update_t update = {
        .fields = LED_UPDATE_POWER | LED_UPDATE_RED | LED_UPDATE_GREEN | LED_UPDATE_BLUE | LED_UPDATE_BRIGHTNESS,
        .values = *state,
    };
    return update;
}

static bool same_led_state(const led_state_t *left, const led_state_t *right)
{
    return left->power == right->power
        && left->red == right->red
        && left->green == right->green
        && left->blue == right->blue
        && left->brightness == right->brightness;
}

static esp_err_t persist_applied_command(const mqtt_command_t *command, const led_state_t *state)
{
    mqtt_applied_command_record_t record = {0};
    record.version = MQTT_APPLIED_COMMAND_RECORD_VERSION;
    record.record_size = (uint32_t)sizeof(record);
    record.command_sequence = command->command_sequence;
    strcpy(record.command_id, command->command_id);
    record.power = state->power ? 1U : 0U;
    record.red = state->red;
    record.green = state->green;
    record.blue = state->blue;
    record.brightness = state->brightness;

    esp_err_t err = nvs_set_blob(s_nvs, MQTT_APPLIED_COMMAND_KEY, &record, sizeof(record));
    if (err == ESP_OK) {
        err = nvs_commit(s_nvs);
    }
    return err;
}

static esp_err_t restore_applied_command(void)
{
    mqtt_applied_command_record_t record = {0};
    size_t record_size = sizeof(record);
    esp_err_t err = nvs_get_blob(s_nvs, MQTT_APPLIED_COMMAND_KEY, &record, &record_size);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        s_has_last_command_sequence = false;
        s_last_command_id[0] = '\0';
        return ESP_OK;
    }
    if (err != ESP_OK) {
        return err;
    }
    if (record_size != sizeof(record)
            || record.version != MQTT_APPLIED_COMMAND_RECORD_VERSION
            || record.record_size != (uint32_t)sizeof(record)
            || record.command_sequence > MQTT_SEQUENCE_MAX
            || record.power > 1U
            || record.brightness > 100U
            || memchr(record.command_id, '\0', sizeof(record.command_id)) == NULL
            || !is_identifier(record.command_id)) {
        return ESP_ERR_INVALID_STATE;
    }

    const led_state_t saved = {
        .power = record.power != 0,
        .red = record.red,
        .green = record.green,
        .blue = record.blue,
        .brightness = record.brightness,
    };
    const led_update_t update = full_update_from_state(&saved);
    led_state_t applied;
    err = led_controller_apply(&update, &applied);
    if (err != ESP_OK || !same_led_state(&saved, &applied)) {
        return err == ESP_OK ? ESP_FAIL : err;
    }

    s_last_command_sequence = record.command_sequence;
    strcpy(s_last_command_id, record.command_id);
    s_has_last_command_sequence = true;
    return ESP_OK;
}

static void report_runtime_error(const char *event_type, esp_err_t cause)
{
    ESP_LOGE(TAG, "%s: %s", event_type, esp_err_to_name(cause));
    const esp_err_t event_err = publish_event(event_type);
    if (event_err != ESP_OK && event_err != ESP_ERR_INVALID_STATE) {
        ESP_LOGW(TAG, "Could not publish error event: %s", esp_err_to_name(event_err));
    }
}

static void handle_command(const char *payload, size_t length)
{
    mqtt_command_t command;
    esp_err_t err = parse_command(payload, length, &command);
    if (err != ESP_OK) {
        report_runtime_error("INVALID_COMMAND", err);
        return;
    }

    if (xSemaphoreTake(s_lock, portMAX_DELAY) != pdTRUE) {
        report_runtime_error("COMMAND_LOCK_FAILED", ESP_FAIL);
        return;
    }
    if (s_has_last_command_sequence && command.command_sequence == s_last_command_sequence) {
        const bool is_retry = strcmp(command.command_id, s_last_command_id) == 0;
        xSemaphoreGive(s_lock);
        if (is_retry) {
            ESP_LOGI(TAG, "Re-publishing state for retried commandSequence=%" PRIu64,
                     command.command_sequence);
            err = publish_state(command.command_id);
            if (err != ESP_OK) {
                report_runtime_error("STATE_PUBLISH_FAILED", err);
            }
        } else {
            ESP_LOGW(TAG, "Rejected reused commandSequence=%" PRIu64, command.command_sequence);
            report_runtime_error("COMMAND_SEQUENCE_REJECTED", ESP_ERR_INVALID_STATE);
        }
        return;
    }
    if (s_has_last_command_sequence && command.command_sequence < s_last_command_sequence) {
        xSemaphoreGive(s_lock);
        ESP_LOGW(TAG, "Rejected stale commandSequence=%" PRIu64, command.command_sequence);
        report_runtime_error("COMMAND_SEQUENCE_REJECTED", ESP_ERR_INVALID_STATE);
        return;
    }

    led_state_t previous;
    err = led_controller_get_state(&previous);
    if (err != ESP_OK) {
        xSemaphoreGive(s_lock);
        report_runtime_error("COMMAND_STATE_READ_FAILED", err);
        return;
    }
    const bool had_previous_command = s_has_last_command_sequence;
    char previous_command_id[MQTT_IDENTIFIER_MAX_BYTES + 1];
    strcpy(previous_command_id, had_previous_command ? s_last_command_id : "");

    led_state_t applied;
    const esp_err_t apply_err = led_controller_apply(&command.update, &applied);
    esp_err_t persist_err = apply_err;
    if (apply_err == ESP_OK) {
        persist_err = persist_applied_command(&command, &applied);
    }
    if (persist_err == ESP_OK) {
        s_last_command_sequence = command.command_sequence;
        strcpy(s_last_command_id, command.command_id);
        s_has_last_command_sequence = true;
        xSemaphoreGive(s_lock);
    } else {
        esp_err_t rollback_err = ESP_OK;
        if (apply_err == ESP_OK) {
            const led_update_t rollback = full_update_from_state(&previous);
            led_state_t rolled_back;
            rollback_err = led_controller_apply(&rollback, &rolled_back);
            if (rollback_err == ESP_OK && !same_led_state(&previous, &rolled_back)) {
                rollback_err = ESP_FAIL;
            }
        }
        xSemaphoreGive(s_lock);
        if (apply_err != ESP_OK) {
            report_runtime_error("COMMAND_APPLY_FAILED", apply_err);
        } else {
            report_runtime_error("COMMAND_RECORD_PERSIST_FAILED", persist_err);
            if (rollback_err != ESP_OK) {
                report_runtime_error("COMMAND_ROLLBACK_FAILED", rollback_err);
            } else {
                err = publish_state(had_previous_command ? previous_command_id : NULL);
                if (err != ESP_OK) {
                    report_runtime_error("STATE_PUBLISH_FAILED", err);
                }
            }
        }
        return;
    }

    err = publish_state(command.command_id);
    if (err != ESP_OK) {
        report_runtime_error("STATE_PUBLISH_FAILED", err);
    }
}

static bool topic_equals(const esp_mqtt_event_handle_t event, const char *expected)
{
    const size_t expected_length = strlen(expected);
    return event->topic_len == (int)expected_length
        && memcmp(event->topic, expected, expected_length) == 0;
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        set_connected(true);
        if (esp_mqtt_client_subscribe(s_client, s_command_topic, 1) < 0) {
            report_runtime_error("COMMAND_SUBSCRIBE_FAILED", ESP_FAIL);
        }
        {
            const esp_err_t err = publish_state(s_has_last_command_sequence ? s_last_command_id : NULL);
            if (err != ESP_OK) report_runtime_error("INITIAL_STATE_FAILED", err);
        }
        break;
    case MQTT_EVENT_DISCONNECTED:
        set_connected(false);
        break;
    case MQTT_EVENT_DATA:
        if (!topic_equals(event, s_command_topic)) {
            ESP_LOGW(TAG, "Ignored message on an unexpected topic.");
            break;
        }
        if (event->current_data_offset != 0 || event->total_data_len != event->data_len
                || event->data_len <= 0 || event->data_len > MQTT_COMMAND_MAX_BYTES) {
            report_runtime_error("INVALID_COMMAND", ESP_ERR_INVALID_SIZE);
            break;
        }
        handle_command(event->data, (size_t)event->data_len);
        break;
    case MQTT_EVENT_ERROR:
        ESP_LOGE(TAG, "MQTT transport error; credentials and endpoint were not logged.");
        break;
    default:
        break;
    }
}

static void runtime_task(void *argument)
{
    (void)argument;
    int64_t last_telemetry_attempt = 0;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (!is_connected()) {
            continue;
        }
        if (!s_boot_event_sent) {
            const esp_err_t err = publish_event("BOOT");
            if (err == ESP_OK && xSemaphoreTake(s_lock, portMAX_DELAY) == pdTRUE) {
                s_boot_event_sent = true;
                xSemaphoreGive(s_lock);
            }
        }
        const int64_t now = esp_timer_get_time();
        if (last_telemetry_attempt == 0
                || now - last_telemetry_attempt >= (int64_t)CONFIG_MOODLIGHT_MQTT_TELEMETRY_INTERVAL_SECONDS * 1000000) {
            last_telemetry_attempt = now;
            const esp_err_t err = publish_telemetry();
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Telemetry publish failed: %s", esp_err_to_name(err));
            }
        }
    }
}

static esp_err_t initialize_sequences(void)
{
    esp_err_t err = nvs_open("mqtt_runtime", NVS_READWRITE, &s_nvs);
    if (err != ESP_OK) {
        return err;
    }
    uint64_t stored_boot_sequence = 0;
    err = nvs_get_u64(s_nvs, "boot_seq", &stored_boot_sequence);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        stored_boot_sequence = 0;
        err = ESP_OK;
    }
    if (err != ESP_OK || stored_boot_sequence >= MQTT_SEQUENCE_MAX) {
        return err == ESP_OK ? ESP_ERR_INVALID_STATE : err;
    }
    s_boot_sequence = stored_boot_sequence + 1;
    err = nvs_set_u64(s_nvs, "boot_seq", s_boot_sequence);
    if (err == ESP_OK) {
        err = nvs_commit(s_nvs);
    }
    if (err != ESP_OK) {
        return err;
    }

    err = restore_applied_command();
    if (err != ESP_OK) {
        nvs_close(s_nvs);
        s_nvs = 0;
        return err;
    }
    return ESP_OK;
}

static esp_err_t initialize_boot_identity(void)
{
    struct timeval now;
    if (gettimeofday(&now, NULL) != 0 || now.tv_sec < MQTT_CLOCK_VALID_AFTER) {
        return ESP_ERR_INVALID_STATE;
    }
    s_boot_started_at_ms = (uint64_t)now.tv_sec * 1000ULL + (uint64_t)now.tv_usec / 1000ULL;
    const uint32_t random_0 = esp_random();
    const uint32_t random_1 = esp_random();
    const uint32_t random_2 = esp_random();
    const uint32_t random_3 = esp_random();
    const int written = snprintf(s_boot_id, sizeof(s_boot_id),
                                 "%08" PRIx32 "%08" PRIx32 "%08" PRIx32 "%08" PRIx32,
                                 random_0, random_1, random_2, random_3);
    return written == 32 ? ESP_OK : ESP_FAIL;
}

esp_err_t mqtt_runtime_start(void)
{
    if (s_client != NULL) {
        return ESP_OK;
    }
    const char *endpoint;
    const char *thing_name;
    const char *root_ca;
    const char *client_certificate;
    const char *private_key;
#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING
    fleet_identity_free(&s_fleet_identity);
    const esp_err_t identity_err = fleet_identity_load(&s_fleet_identity, true);
    if (identity_err != ESP_OK) {
        ESP_LOGE(TAG, "Fleet identity or server-authorized topicBase is not ready; runtime remains stopped.");
        return ESP_ERR_INVALID_STATE;
    }
    endpoint = MOODLIGHT_FLEET_ENDPOINT;
    thing_name = s_fleet_identity.thing_name;
    s_topic_base = s_fleet_identity.topic_base;
    root_ca = MOODLIGHT_FLEET_ROOT_CA_PEM;
    client_certificate = s_fleet_identity.certificate_pem;
    private_key = s_fleet_identity.private_key_pem;
#else
    endpoint = MOODLIGHT_MQTT_ENDPOINT;
    thing_name = MOODLIGHT_MQTT_THING_NAME;
    s_topic_base = MOODLIGHT_MQTT_TOPIC_BASE;
    root_ca = MOODLIGHT_MQTT_ROOT_CA_PEM;
    client_certificate = MOODLIGHT_MQTT_CLIENT_CERT_PEM;
    private_key = MOODLIGHT_MQTT_PRIVATE_KEY_PEM;
#endif
    const size_t topic_base_length = strlen(s_topic_base);
    const size_t thing_name_length = strlen(thing_name);
    if (endpoint[0] == '\0' || strchr(endpoint, '/') != NULL
            || !is_identifier(thing_name)
            || !is_topic_base(s_topic_base)
            || topic_base_length <= thing_name_length
            || s_topic_base[topic_base_length - thing_name_length - 1] != '/'
            || strcmp(s_topic_base + topic_base_length - thing_name_length, thing_name) != 0
            || root_ca[0] == '\0' || client_certificate[0] == '\0'
            || private_key[0] == '\0') {
        ESP_LOGE(TAG, "MQTT local configuration is missing or invalid.");
        return ESP_ERR_INVALID_ARG;
    }
    esp_err_t err = build_topic(s_command_topic, sizeof(s_command_topic), "cmd");
    if (err == ESP_OK) {
        err = build_topic(s_state_topic, sizeof(s_state_topic), "state");
    }
    if (err == ESP_OK) {
        err = build_topic(s_telemetry_topic, sizeof(s_telemetry_topic), "tele");
    }
    if (err == ESP_OK) {
        err = build_topic(s_event_topic, sizeof(s_event_topic), "evt");
    }
    if (err != ESP_OK) {
        return err;
    }

    if (s_lock == NULL) {
        s_lock = xSemaphoreCreateMutex();
        if (s_lock == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    if (!s_sntp_initialized) {
        esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
        err = esp_netif_sntp_init(&sntp_config);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            return err;
        }
        s_sntp_initialized = true;
    }
    err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(MQTT_SNTP_SYNC_TIMEOUT_MS));
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Clock sync failed; MQTT uplink remains stopped.");
        return err;
    }
    if (!s_runtime_state_initialized) {
        err = initialize_sequences();
        if (err == ESP_OK) {
            err = initialize_boot_identity();
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Boot identity creation failed; MQTT uplink remains stopped.");
            return err;
        }
        s_runtime_state_initialized = true;
    }

    const esp_mqtt_client_config_t mqtt_config = {
        .broker.address.hostname = endpoint,
        .broker.address.port = MQTT_PORT,
        .broker.address.transport = MQTT_TRANSPORT_OVER_SSL,
        .broker.verification.certificate = root_ca,
        .credentials.client_id = thing_name,
        .credentials.authentication.certificate = client_certificate,
        .credentials.authentication.key = private_key,
        .session.keepalive = 60,
        .buffer.size = 2048,
        .buffer.out_size = 2048,
    };
    s_client = esp_mqtt_client_init(&mqtt_config);
    if (s_client == NULL) {
        return ESP_ERR_NO_MEM;
    }
    err = esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    if (err == ESP_OK) {
        err = esp_mqtt_client_start(s_client);
    }
    if (err != ESP_OK) {
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
        return err;
    }
    if (xTaskCreate(runtime_task, "mqtt_runtime", MQTT_TASK_STACK_BYTES, NULL, 5, NULL) != pdPASS) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "MQTT runtime started; secret values were not logged.");
    return ESP_OK;
}

static void mqtt_network_event_handler(void *argument, esp_event_base_t event_base,
                                       int32_t event_id, void *event_data)
{
    (void)argument;
    (void)event_data;
    if (event_base != IP_EVENT || s_network_events == NULL) {
        return;
    }
    if (event_id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_network_events, MQTT_NETWORK_READY_BIT);
    } else if (event_id == IP_EVENT_STA_LOST_IP) {
        xEventGroupClearBits(s_network_events, MQTT_NETWORK_READY_BIT);
    }
}

static void mqtt_start_task(void *argument)
{
    (void)argument;
    while (s_client == NULL) {
        xEventGroupWaitBits(s_network_events, MQTT_NETWORK_READY_BIT,
                            pdFALSE, pdTRUE, portMAX_DELAY);
        const esp_err_t err = mqtt_runtime_start();
        if (err == ESP_OK) {
            break;
        }
        if (err == ESP_ERR_INVALID_ARG || err == ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "MQTT identity/configuration is incomplete; automatic retry stopped.");
            break;
        }
        ESP_LOGW(TAG, "MQTT start failed: %s; retrying after network delay.",
                 esp_err_to_name(err));
        vTaskDelay(pdMS_TO_TICKS(MQTT_START_RETRY_MS));
    }
    s_start_task = NULL;
    vTaskDelete(NULL);
}

esp_err_t mqtt_runtime_start_when_network_ready(void)
{
    if (s_network_start_registered) {
        return ESP_OK;
    }
    s_network_events = xEventGroupCreate();
    if (s_network_events == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = esp_event_handler_register(
        IP_EVENT, ESP_EVENT_ANY_ID, mqtt_network_event_handler, NULL);
    if (err != ESP_OK) {
        vEventGroupDelete(s_network_events);
        s_network_events = NULL;
        return err;
    }
    if (xTaskCreate(mqtt_start_task, "mqtt_start", MQTT_START_TASK_STACK_BYTES,
                    NULL, 5, &s_start_task) != pdPASS) {
        esp_event_handler_unregister(
            IP_EVENT, ESP_EVENT_ANY_ID, mqtt_network_event_handler);
        vEventGroupDelete(s_network_events);
        s_network_events = NULL;
        return ESP_ERR_NO_MEM;
    }
    s_network_start_registered = true;

    esp_netif_t *station = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip_info;
    if (station != NULL && esp_netif_get_ip_info(station, &ip_info) == ESP_OK
            && ip_info.ip.addr != 0) {
        xEventGroupSetBits(s_network_events, MQTT_NETWORK_READY_BIT);
    }
    ESP_LOGI(TAG, "MQTT runtime will start after Wi-Fi receives an IP address.");
    return ESP_OK;
}
