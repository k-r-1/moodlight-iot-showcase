#include "fleet_provisioning.h"

#include <stdbool.h>
#include <ctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "claim_binding.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "fleet_credentials.h"
#include "fleet_identity.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "mbedtls/platform_util.h"
#include "mqtt_client.h"

#if (!CONFIG_SECURE_FLASH_ENC_ENABLED || !CONFIG_NVS_ENCRYPTION) \
        && !CONFIG_MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS
#error "Fleet Provisioning requires flash/NVS encryption or the explicit plaintext demo exception"
#endif

#if CONFIG_MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS
#warning "Plaintext demo credentials are enabled; never use this build for production"
#define FLEET_IDENTITY_STORAGE_LABEL "plaintext demo NVS"
#else
#define FLEET_IDENTITY_STORAGE_LABEL "encrypted NVS"
#endif

#define FLEET_DONE_BIT BIT0
#define FLEET_FAILED_BIT BIT1
#define FLEET_NETWORK_READY_BIT BIT0
#define FLEET_RESPONSE_MAX_BYTES 12288
#define FLEET_TOPIC_MAX_BYTES 256
#define FLEET_RETRY_LIMIT 3
#define FLEET_ATTEMPT_TIMEOUT_MS 60000
#define FLEET_RETRY_DELAY_MS 5000
#define FLEET_TASK_STACK_BYTES 8192

typedef enum {
    FLEET_PHASE_IDLE,
    FLEET_PHASE_SUBSCRIBE_CREATE,
    FLEET_PHASE_WAIT_CREATE,
    FLEET_PHASE_SUBSCRIBE_REGISTER,
    FLEET_PHASE_WAIT_REGISTER,
    FLEET_PHASE_DONE,
    FLEET_PHASE_FAILED,
} fleet_phase_t;

static const char *TAG = "fleet_provisioning";
static const char *CREATE_TOPIC = "$aws/certificates/create/json";
static const char *CREATE_ACCEPTED = "$aws/certificates/create/json/accepted";
static const char *CREATE_REJECTED = "$aws/certificates/create/json/rejected";

static EventGroupHandle_t s_attempt_events;
static EventGroupHandle_t s_network_events;
static esp_mqtt_client_handle_t s_client;
static TaskHandle_t s_task;
static fleet_phase_t s_phase;
static unsigned s_pending_subscriptions;
static char s_serial[13];
static char s_expected_thing[129];
static char s_claim_client_id[129];
static char s_register_topic[FLEET_TOPIC_MAX_BYTES];
static char s_register_accepted[FLEET_TOPIC_MAX_BYTES];
static char s_register_rejected[FLEET_TOPIC_MAX_BYTES];
static char *s_device_certificate;
static char *s_device_private_key;
static char *s_device_certificate_id;
static char *s_ownership_token;
static char *s_response;
static int s_response_size;
static char s_response_topic[FLEET_TOPIC_MAX_BYTES];
static bool s_create_request_started;

static void network_handler(void *argument, esp_event_base_t base,
                            int32_t event_id, void *event_data);

static void clear_pending_identity(void)
{
    if (s_device_certificate != NULL) {
        mbedtls_platform_zeroize(s_device_certificate, strlen(s_device_certificate));
        free(s_device_certificate);
        s_device_certificate = NULL;
    }
    if (s_device_private_key != NULL) {
        mbedtls_platform_zeroize(s_device_private_key, strlen(s_device_private_key));
        free(s_device_private_key);
        s_device_private_key = NULL;
    }
    if (s_device_certificate_id != NULL) {
        mbedtls_platform_zeroize(s_device_certificate_id,
                                 strlen(s_device_certificate_id));
        free(s_device_certificate_id);
        s_device_certificate_id = NULL;
    }
    if (s_ownership_token != NULL) {
        mbedtls_platform_zeroize(s_ownership_token, strlen(s_ownership_token));
        free(s_ownership_token);
        s_ownership_token = NULL;
    }
}

static bool has_pending_identity(void)
{
    return s_device_certificate != NULL && s_device_private_key != NULL
        && s_device_certificate_id != NULL && s_ownership_token != NULL;
}

static bool valid_certificate_id(const char *value)
{
    if (value == NULL || strlen(value) != 64) {
        return false;
    }
    for (size_t i = 0; i < 64; i++) {
        if (!isxdigit((unsigned char)value[i])) {
            return false;
        }
    }
    return true;
}

static void clear_response(void)
{
    if (s_response != NULL) {
        mbedtls_platform_zeroize(s_response, (size_t)s_response_size);
        free(s_response);
        s_response = NULL;
    }
    s_response_size = 0;
    s_response_topic[0] = '\0';
}

static void fail_attempt(const char *reason)
{
    if (s_phase == FLEET_PHASE_DONE || s_phase == FLEET_PHASE_FAILED) {
        return;
    }
    s_phase = FLEET_PHASE_FAILED;
    ESP_LOGE(TAG, "Fleet attempt failed: %s; response and credentials were not logged.", reason);
    if (s_attempt_events != NULL) {
        xEventGroupSetBits(s_attempt_events, FLEET_FAILED_BIT);
    }
}

static esp_err_t make_serial(void)
{
    uint8_t mac[6];
    esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (err != ESP_OK) {
        return err;
    }
    const int serial_length = snprintf(s_serial, sizeof(s_serial),
                                       "%02x%02x%02x%02x%02x%02x",
                                       mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    const int thing_length = snprintf(s_expected_thing, sizeof(s_expected_thing),
                                      "%s%s", MOODLIGHT_FLEET_THING_NAME_PREFIX, s_serial);
    const int client_length = snprintf(s_claim_client_id, sizeof(s_claim_client_id),
                                       "%s%s", MOODLIGHT_FLEET_CLAIM_CLIENT_ID_PREFIX, s_serial);
    return serial_length == 12 && thing_length > 12 && client_length > 12
            && (size_t)thing_length < sizeof(s_expected_thing)
            && (size_t)client_length < sizeof(s_claim_client_id)
        ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

static char *hash_hex(const uint8_t hash[CLAIM_BINDING_NONCE_HASH_BYTES])
{
    char *encoded = calloc(CLAIM_BINDING_NONCE_HASH_BYTES * 2 + 1, 1);
    if (encoded == NULL) {
        return NULL;
    }
    for (size_t i = 0; i < CLAIM_BINDING_NONCE_HASH_BYTES; i++) {
        snprintf(encoded + i * 2, 3, "%02x", hash[i]);
    }
    return encoded;
}

static esp_err_t publish_registration(void)
{
    claim_binding_t binding;
    esp_err_t err = claim_binding_load(&binding);
    if (err != ESP_OK) {
        return err;
    }
    char *nonce_hash = hash_hex(binding.registration_nonce_sha256);
    if (nonce_hash == NULL) {
        return ESP_ERR_NO_MEM;
    }
    cJSON *root = cJSON_CreateObject();
    cJSON *parameters = root == NULL ? NULL : cJSON_AddObjectToObject(root, "parameters");
    cJSON *token_copy = root == NULL ? NULL
        : cJSON_AddStringToObject(root, "certificateOwnershipToken", s_ownership_token);
    cJSON *nonce_copy = parameters == NULL ? NULL
        : cJSON_AddStringToObject(parameters, "RegistrationNonceHash", nonce_hash);
    if (root == NULL || parameters == NULL || token_copy == NULL || nonce_copy == NULL
            || cJSON_AddStringToObject(parameters, "SerialNumber", s_serial) == NULL
            || cJSON_AddStringToObject(parameters, "ClaimId", binding.claim_id) == NULL
            || cJSON_AddStringToObject(parameters, "AWS::IoT::Certificate::Id",
                                       s_device_certificate_id) == NULL) {
        if (token_copy != NULL) {
            mbedtls_platform_zeroize(token_copy->valuestring, strlen(token_copy->valuestring));
        }
        if (nonce_copy != NULL) {
            mbedtls_platform_zeroize(nonce_copy->valuestring, strlen(nonce_copy->valuestring));
        }
        cJSON_Delete(root);
        mbedtls_platform_zeroize(nonce_hash, strlen(nonce_hash));
        free(nonce_hash);
        return ESP_ERR_NO_MEM;
    }
    char *payload = cJSON_PrintUnformatted(root);
    mbedtls_platform_zeroize(token_copy->valuestring, strlen(token_copy->valuestring));
    mbedtls_platform_zeroize(nonce_copy->valuestring, strlen(nonce_copy->valuestring));
    cJSON_Delete(root);
    mbedtls_platform_zeroize(nonce_hash, strlen(nonce_hash));
    free(nonce_hash);
    if (payload == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const int message_id = esp_mqtt_client_publish(s_client, s_register_topic,
                                                    payload, 0, 1, 0);
    mbedtls_platform_zeroize(payload, strlen(payload));
    cJSON_free(payload);
    return message_id >= 0 ? ESP_OK : ESP_FAIL;
}

static void handle_create_accepted(const char *payload, size_t length)
{
    if (s_phase != FLEET_PHASE_WAIT_CREATE) {
        fail_attempt("unexpected create response");
        return;
    }
    cJSON *root = cJSON_ParseWithLength(payload, length);
    const cJSON *certificate = root == NULL ? NULL : cJSON_GetObjectItemCaseSensitive(root, "certificatePem");
    const cJSON *private_key = root == NULL ? NULL : cJSON_GetObjectItemCaseSensitive(root, "privateKey");
    const cJSON *certificate_id = root == NULL ? NULL
        : cJSON_GetObjectItemCaseSensitive(root, "certificateId");
    const cJSON *token = root == NULL ? NULL : cJSON_GetObjectItemCaseSensitive(root, "certificateOwnershipToken");
    if (!cJSON_IsString(certificate) || !cJSON_IsString(private_key)
            || !cJSON_IsString(certificate_id) || !cJSON_IsString(token)
            || certificate->valuestring[0] == '\0' || private_key->valuestring[0] == '\0'
            || !valid_certificate_id(certificate_id->valuestring)
            || token->valuestring[0] == '\0') {
        cJSON_Delete(root);
        fail_attempt("invalid create response");
        return;
    }
    clear_pending_identity();
    s_device_certificate = strdup(certificate->valuestring);
    s_device_private_key = strdup(private_key->valuestring);
    s_device_certificate_id = strdup(certificate_id->valuestring);
    s_ownership_token = strdup(token->valuestring);
    mbedtls_platform_zeroize(private_key->valuestring, strlen(private_key->valuestring));
    mbedtls_platform_zeroize(token->valuestring, strlen(token->valuestring));
    cJSON_Delete(root);
    if (s_device_certificate == NULL || s_device_private_key == NULL
            || s_device_certificate_id == NULL || s_ownership_token == NULL) {
        fail_attempt("out of memory");
        return;
    }
    s_phase = FLEET_PHASE_SUBSCRIBE_REGISTER;
    s_pending_subscriptions = 2;
    if (esp_mqtt_client_subscribe(s_client, s_register_accepted, 1) < 0
            || esp_mqtt_client_subscribe(s_client, s_register_rejected, 1) < 0) {
        fail_attempt("register response subscription failed");
    }
}

static void handle_register_accepted(const char *payload, size_t length)
{
    if (s_phase != FLEET_PHASE_WAIT_REGISTER) {
        fail_attempt("unexpected register response");
        return;
    }
    const char *parse_end = NULL;
    cJSON *root = cJSON_ParseWithLengthOpts(payload, length + 1,
                                            &parse_end, true);
    const cJSON *thing = root == NULL ? NULL : cJSON_GetObjectItemCaseSensitive(root, "thingName");
    const cJSON *configuration = root == NULL ? NULL
        : cJSON_GetObjectItemCaseSensitive(root, "deviceConfiguration");
    const cJSON *topic_base = configuration == NULL ? NULL
        : cJSON_GetObjectItemCaseSensitive(configuration, "topicBase");
    if (!cJSON_IsObject(root) || parse_end != payload + length
            || cJSON_GetArraySize(root) != 2
            || !cJSON_IsString(thing)
            || strcmp(thing->valuestring, s_expected_thing) != 0
            || !cJSON_IsObject(configuration)
            || cJSON_GetArraySize(configuration) != 1
            || !cJSON_IsString(topic_base)) {
        cJSON_Delete(root);
        fail_attempt("invalid RegisterThing accepted response");
        return;
    }
    const esp_err_t err = fleet_identity_store_issued(
        s_device_certificate, s_device_private_key, thing->valuestring,
        topic_base->valuestring);
    cJSON_Delete(root);
    if (err != ESP_OK) {
        fail_attempt("device identity storage failed");
        return;
    }
    clear_pending_identity();
    s_phase = FLEET_PHASE_DONE;
    ESP_LOGI(TAG, "Fleet identity and runtime topic scope were stored in %s.",
             FLEET_IDENTITY_STORAGE_LABEL);
    xEventGroupSetBits(s_attempt_events, FLEET_DONE_BIT);
}

static void process_complete_response(const char *topic, const char *payload,
                                      size_t length)
{
    if (strcmp(topic, CREATE_ACCEPTED) == 0) {
        handle_create_accepted(payload, length);
    } else if (strcmp(topic, CREATE_REJECTED) == 0) {
        fail_attempt("certificate creation rejected");
    } else if (strcmp(topic, s_register_accepted) == 0) {
        handle_register_accepted(payload, length);
    } else if (strcmp(topic, s_register_rejected) == 0) {
        fail_attempt("Thing registration rejected");
    } else {
        fail_attempt("unexpected response topic");
    }
}

static void receive_response(const esp_mqtt_event_handle_t event)
{
    if (event->total_data_len <= 0 || event->total_data_len > FLEET_RESPONSE_MAX_BYTES
            || event->current_data_offset < 0 || event->data_len < 0
            || event->current_data_offset + event->data_len > event->total_data_len) {
        fail_attempt("invalid response length");
        return;
    }
    if (event->current_data_offset == 0) {
        clear_response();
        if (event->topic_len <= 0 || event->topic_len >= (int)sizeof(s_response_topic)) {
            fail_attempt("invalid response topic");
            return;
        }
        memcpy(s_response_topic, event->topic, (size_t)event->topic_len);
        s_response_topic[event->topic_len] = '\0';
        s_response = calloc((size_t)event->total_data_len + 1, 1);
        s_response_size = event->total_data_len;
        if (s_response == NULL) {
            fail_attempt("out of memory");
            return;
        }
    }
    if (s_response == NULL || event->total_data_len != s_response_size) {
        fail_attempt("fragmented response mismatch");
        return;
    }
    memcpy(s_response + event->current_data_offset, event->data, (size_t)event->data_len);
    if (event->current_data_offset + event->data_len == event->total_data_len) {
        process_complete_response(s_response_topic, s_response, (size_t)s_response_size);
        clear_response();
    }
}

static void fleet_mqtt_handler(void *argument, esp_event_base_t base,
                               int32_t event_id, void *event_data)
{
    (void)argument;
    (void)base;
    esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        s_phase = has_pending_identity() ? FLEET_PHASE_SUBSCRIBE_REGISTER
                                         : FLEET_PHASE_SUBSCRIBE_CREATE;
        s_pending_subscriptions = 2;
        if (s_phase == FLEET_PHASE_SUBSCRIBE_REGISTER) {
            if (esp_mqtt_client_subscribe(s_client, s_register_accepted, 1) < 0
                    || esp_mqtt_client_subscribe(s_client, s_register_rejected, 1) < 0) {
                fail_attempt("register response subscription failed");
            }
        } else if (esp_mqtt_client_subscribe(s_client, CREATE_ACCEPTED, 1) < 0
                || esp_mqtt_client_subscribe(s_client, CREATE_REJECTED, 1) < 0) {
            fail_attempt("create response subscription failed");
        }
        break;
    case MQTT_EVENT_SUBSCRIBED:
        if ((s_phase != FLEET_PHASE_SUBSCRIBE_CREATE
                    && s_phase != FLEET_PHASE_SUBSCRIBE_REGISTER)
                || s_pending_subscriptions == 0) {
            fail_attempt("unexpected subscription acknowledgement");
            break;
        }
        s_pending_subscriptions--;
        if (s_pending_subscriptions != 0) {
            break;
        }
        if (s_phase == FLEET_PHASE_SUBSCRIBE_CREATE) {
            if (s_create_request_started
                    || fleet_identity_mark_enrollment_started() != ESP_OK) {
                fail_attempt("certificate request cannot be started safely");
                break;
            }
            s_phase = FLEET_PHASE_WAIT_CREATE;
            s_create_request_started = true;
            if (esp_mqtt_client_publish(s_client, CREATE_TOPIC, "{}", 0, 1, 0) < 0) {
                fail_attempt("certificate request publish failed");
            }
        } else {
            s_phase = FLEET_PHASE_WAIT_REGISTER;
            if (publish_registration() != ESP_OK) {
                fail_attempt("Thing registration publish failed");
            }
        }
        break;
    case MQTT_EVENT_DATA:
        receive_response(event);
        break;
    case MQTT_EVENT_DISCONNECTED:
        fail_attempt("MQTT disconnected");
        break;
    case MQTT_EVENT_ERROR:
        fail_attempt("MQTT transport error");
        break;
    default:
        break;
    }
}

static esp_err_t configure_topics(void)
{
    const int base = snprintf(s_register_topic, sizeof(s_register_topic),
                              "$aws/provisioning-templates/%s/provision/json",
                              MOODLIGHT_FLEET_TEMPLATE_NAME);
    if (base <= 0 || (size_t)base >= sizeof(s_register_topic)) return ESP_ERR_INVALID_SIZE;
    if (snprintf(s_register_accepted, sizeof(s_register_accepted), "%s/accepted",
                 s_register_topic) >= (int)sizeof(s_register_accepted)) return ESP_ERR_INVALID_SIZE;
    if (snprintf(s_register_rejected, sizeof(s_register_rejected), "%s/rejected",
                 s_register_topic) >= (int)sizeof(s_register_rejected)) return ESP_ERR_INVALID_SIZE;
    return ESP_OK;
}

static esp_err_t run_attempt(void)
{
    clear_response();
    s_phase = FLEET_PHASE_IDLE;
    s_attempt_events = xEventGroupCreate();
    if (s_attempt_events == NULL) {
        return ESP_ERR_NO_MEM;
    }
    const esp_mqtt_client_config_t config = {
        .broker.address.hostname = MOODLIGHT_FLEET_ENDPOINT,
        .broker.address.port = 8883,
        .broker.address.transport = MQTT_TRANSPORT_OVER_SSL,
        .broker.verification.certificate = MOODLIGHT_FLEET_ROOT_CA_PEM,
        .credentials.client_id = s_claim_client_id,
        .credentials.authentication.certificate = MOODLIGHT_FLEET_CLAIM_CERT_PEM,
        .credentials.authentication.key = MOODLIGHT_FLEET_CLAIM_PRIVATE_KEY_PEM,
        .buffer.size = FLEET_RESPONSE_MAX_BYTES,
        .buffer.out_size = 4096,
        .session.keepalive = 60,
    };
    s_client = esp_mqtt_client_init(&config);
    esp_err_t err = s_client == NULL ? ESP_ERR_NO_MEM : ESP_OK;
    if (err == ESP_OK) {
        err = esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID,
                                             fleet_mqtt_handler, NULL);
    }
    if (err == ESP_OK) {
        err = esp_mqtt_client_start(s_client);
    }
    EventBits_t bits = 0;
    if (err == ESP_OK) {
        bits = xEventGroupWaitBits(s_attempt_events, FLEET_DONE_BIT | FLEET_FAILED_BIT,
                                   pdFALSE, pdFALSE,
                                   pdMS_TO_TICKS(FLEET_ATTEMPT_TIMEOUT_MS));
        if ((bits & FLEET_DONE_BIT) == 0) {
            err = (bits & FLEET_FAILED_BIT) != 0 ? ESP_FAIL : ESP_ERR_TIMEOUT;
        }
    }
    if (s_client != NULL) {
        esp_mqtt_client_stop(s_client);
        esp_mqtt_client_destroy(s_client);
        s_client = NULL;
    }
    clear_response();
    vEventGroupDelete(s_attempt_events);
    s_attempt_events = NULL;
    s_phase = FLEET_PHASE_IDLE;
    return (bits & FLEET_DONE_BIT) != 0 ? ESP_OK : err;
}

static void fleet_task(void *argument)
{
    (void)argument;
    xEventGroupWaitBits(s_network_events, FLEET_NETWORK_READY_BIT,
                        pdFALSE, pdTRUE, portMAX_DELAY);
    if (fleet_identity_is_issued()) {
        ESP_LOGI(TAG, "A device identity is already stored; Fleet enrollment was skipped.");
        goto done;
    }
    if (fleet_identity_recovery_required()) {
        ESP_LOGE(TAG, "A previous certificate request did not complete; automatic reissue is blocked and administrator recovery is required.");
        goto done;
    }
    if (claim_binding_load(&(claim_binding_t){0}) != ESP_OK) {
        ESP_LOGE(TAG, "Claim binding is missing; Fleet enrollment remains stopped.");
        goto done;
    }
    if (make_serial() != ESP_OK || configure_topics() != ESP_OK) {
        ESP_LOGE(TAG, "Fleet identifiers are invalid; enrollment remains stopped.");
        goto done;
    }
    esp_sntp_config_t clock_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    esp_err_t clock_err = esp_netif_sntp_init(&clock_config);
    if (clock_err != ESP_OK && clock_err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "Clock setup failed; Fleet enrollment remains stopped.");
        goto done;
    }
    clock_err = esp_netif_sntp_sync_wait(pdMS_TO_TICKS(10000));
    if (clock_err != ESP_OK) {
        ESP_LOGE(TAG, "Clock sync failed; Fleet enrollment remains stopped.");
        goto done;
    }
    s_create_request_started = false;
    for (unsigned attempt = 1; attempt <= FLEET_RETRY_LIMIT; attempt++) {
        const esp_err_t err = run_attempt();
        if (err == ESP_OK) {
            goto done;
        }
        if (s_create_request_started && !has_pending_identity()) {
            ESP_LOGE(TAG, "Certificate creation may have started without recoverable credentials; automatic reissue is blocked and administrator recovery is required.");
            break;
        }
        ESP_LOGW(TAG, "Fleet attempt %u/%u failed; no secret values were logged.",
                 attempt, FLEET_RETRY_LIMIT);
        if (attempt < FLEET_RETRY_LIMIT) {
            vTaskDelay(pdMS_TO_TICKS(FLEET_RETRY_DELAY_MS));
        }
    }
    ESP_LOGE(TAG, "Fleet enrollment stopped after bounded retries.");

done:
    clear_pending_identity();
    esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, network_handler);
    if (s_network_events != NULL) {
        vEventGroupDelete(s_network_events);
        s_network_events = NULL;
    }
    s_task = NULL;
    vTaskDelete(NULL);
}

static void network_handler(void *argument, esp_event_base_t base,
                            int32_t event_id, void *event_data)
{
    (void)argument;
    (void)event_data;
    if (base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP
            && s_network_events != NULL) {
        xEventGroupSetBits(s_network_events, FLEET_NETWORK_READY_BIT);
    }
}

esp_err_t fleet_provisioning_start_when_network_ready(void)
{
    if (s_task != NULL || fleet_identity_is_issued()) {
        return ESP_OK;
    }
    s_network_events = xEventGroupCreate();
    if (s_network_events == NULL) {
        return ESP_ERR_NO_MEM;
    }
    esp_err_t err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                               network_handler, NULL);
    if (err != ESP_OK) {
        vEventGroupDelete(s_network_events);
        s_network_events = NULL;
        return err;
    }
    if (xTaskCreate(fleet_task, "fleet_enroll", FLEET_TASK_STACK_BYTES,
                    NULL, 5, &s_task) != pdPASS) {
        esp_event_handler_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, network_handler);
        vEventGroupDelete(s_network_events);
        s_network_events = NULL;
        return ESP_ERR_NO_MEM;
    }
    esp_netif_t *station = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip;
    if (station != NULL && esp_netif_get_ip_info(station, &ip) == ESP_OK
            && ip.ip.addr != 0) {
        xEventGroupSetBits(s_network_events, FLEET_NETWORK_READY_BIT);
    }
    ESP_LOGI(TAG, "Fleet enrollment will start after Wi-Fi receives an IP address.");
    return ESP_OK;
}
