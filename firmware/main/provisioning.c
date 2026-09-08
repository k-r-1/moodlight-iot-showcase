#include "provisioning.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "claim_binding.h"
#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"
#include "provisioning_credentials.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

static const char *TAG = "moodlight_prov";
static volatile bool connect_saved_wifi;

#if CONFIG_MOODLIGHT_WIFI_REPROVISION_BUTTON
static void reprovision_button_task(void *argument)
{
    const gpio_num_t button_gpio = CONFIG_MOODLIGHT_WIFI_REPROVISION_BUTTON_GPIO;
    const TickType_t poll_ticks = pdMS_TO_TICKS(50);
    const TickType_t hold_ticks =
        pdMS_TO_TICKS(CONFIG_MOODLIGHT_WIFI_REPROVISION_HOLD_MS);
    TickType_t held_ticks = 0;
    bool attempted = false;
    (void)argument;

    while (true) {
        if (gpio_get_level(button_gpio) != 0) {
            held_ticks = 0;
            attempted = false;
        } else if (!attempted) {
            held_ticks += poll_ticks;
            if (held_ticks >= hold_ticks) {
                attempted = true;
                connect_saved_wifi = false;
                const esp_err_t err = wifi_prov_mgr_reset_provisioning();
                if (err != ESP_OK) {
                    connect_saved_wifi = true;
                    ESP_LOGE(TAG, "Wi-Fi provisioning reset failed: %s",
                             esp_err_to_name(err));
                } else {
                    (void)esp_wifi_disconnect();
                    ESP_LOGW(TAG, "Wi-Fi settings cleared. Release BOOT to restart provisioning.");
                    while (gpio_get_level(button_gpio) == 0) {
                        vTaskDelay(poll_ticks);
                    }
                    vTaskDelay(pdMS_TO_TICKS(100));
                    esp_restart();
                }
            }
        }
        vTaskDelay(poll_ticks);
    }
}

static esp_err_t start_reprovision_button(void)
{
    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << CONFIG_MOODLIGHT_WIFI_REPROVISION_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        return err;
    }
    if (xTaskCreate(reprovision_button_task, "wifi_reset_button", 2048, NULL, 5,
                    NULL) != pdPASS) {
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "Hold BOOT for %d ms to clear Wi-Fi settings only.",
             CONFIG_MOODLIGHT_WIFI_REPROVISION_HOLD_MS);
    return ESP_OK;
}
#endif

/* Keep these parameters alive until the provisioning manager stops. */
static const wifi_prov_security2_params_t security2_params = {
    .salt = (const char *)MOODLIGHT_PROV_SALT,
    .salt_len = sizeof(MOODLIGHT_PROV_SALT),
    .verifier = (const char *)MOODLIGHT_PROV_VERIFIER,
    .verifier_len = sizeof(MOODLIGHT_PROV_VERIFIER),
};

static void provisioning_event_handler(void *argument, esp_event_base_t event_base,
                                       int32_t event_id, void *event_data)
{
    (void)argument;
    (void)event_data;

    if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
        case WIFI_PROV_START:
            ESP_LOGI(TAG, "Provisioning started.");
            break;
        case WIFI_PROV_CRED_RECV:
            ESP_LOGI(TAG, "Wi-Fi configuration received.");
            break;
        case WIFI_PROV_CRED_FAIL: {
            const esp_err_t reset_err =
                wifi_prov_mgr_reset_sm_state_on_failure();
            if (reset_err != ESP_OK) {
                ESP_LOGE(TAG, "Provisioning state reset failed: %s",
                         esp_err_to_name(reset_err));
            }
            ESP_LOGW(TAG, "Wi-Fi provisioning failed.");
            break;
        }
        case WIFI_PROV_CRED_SUCCESS:
            connect_saved_wifi = true;
            ESP_LOGI(TAG, "Wi-Fi provisioning succeeded.");
            break;
        case WIFI_PROV_END:
            ESP_LOGI(TAG, "Provisioning ended.");
            wifi_prov_mgr_deinit();
            break;
        default:
            break;
        }
        return;
    }

    if (event_base == WIFI_EVENT && connect_saved_wifi &&
        (event_id == WIFI_EVENT_STA_START ||
         event_id == WIFI_EVENT_STA_DISCONNECTED)) {
        const esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Wi-Fi connection attempt could not start: %s",
                     esp_err_to_name(err));
        }
    }
}

static esp_err_t custom_data_handler(uint32_t session_id, const uint8_t *input,
                                     ssize_t input_len, uint8_t **output,
                                     ssize_t *output_len, void *context)
{
    static const uint8_t request[] = {'p', 'i', 'n', 'g'};
    static const uint8_t response[] = {'p', 'o', 'n', 'g'};
    (void)session_id;
    (void)context;

    if (input == NULL || output == NULL || output_len == NULL || input_len <= 0) {
        return ESP_ERR_INVALID_ARG;
    }

    if (input_len != (ssize_t)sizeof(request) ||
        memcmp(input, request, sizeof(request)) != 0) {
        const esp_err_t err = claim_binding_handle(
            input, (size_t)input_len, output, output_len);
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "Claim binding accepted; identifiers and nonce were not logged.");
        }
        return err;
    }

    uint8_t *reply = malloc(sizeof(response));
    if (reply == NULL) {
        return ESP_ERR_NO_MEM;
    }
    memcpy(reply, response, sizeof(response));
    *output = reply;
    *output_len = sizeof(response);
    return ESP_OK;
}

static esp_err_t initialize_platform(void)
{
    esp_err_t err = nvs_flash_init();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS initialization failed; stored data was not erased: %s",
                 esp_err_to_name(err));
        return err;
    }

    err = esp_netif_init();
    if (err != ESP_OK) {
        return err;
    }
    err = esp_event_loop_create_default();
    if (err != ESP_OK) {
        return err;
    }
    if (esp_netif_create_default_wifi_sta() == NULL) {
        return ESP_ERR_NO_MEM;
    }

    const wifi_init_config_t wifi_config = WIFI_INIT_CONFIG_DEFAULT();
    err = esp_wifi_init(&wifi_config);
    if (err != ESP_OK) {
        return err;
    }
    err = esp_event_handler_register(
        WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, provisioning_event_handler, NULL);
    if (err != ESP_OK) {
        return err;
    }
    err = esp_event_handler_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, provisioning_event_handler, NULL);
    if (err != ESP_OK) {
        esp_event_handler_unregister(
            WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, provisioning_event_handler);
    }
    return err;
}

esp_err_t provisioning_start(void)
{
    static const uint8_t service_uuid[16] = {
        0x82, 0xc2, 0x1a, 0x62, 0x01, 0x3e, 0xf0, 0xa3,
        0xc0, 0x44, 0x8d, 0xa8, 0x2e, 0xfe, 0x91, 0x7d,
    };

    esp_err_t err = initialize_platform();
    if (err != ESP_OK) {
        return err;
    }

    const wifi_prov_mgr_config_t manager_config = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };
    err = wifi_prov_mgr_init(manager_config);
    if (err != ESP_OK) {
        return err;
    }

    bool provisioned = false;
    err = wifi_prov_mgr_is_provisioned(&provisioned);
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }
#if CONFIG_MOODLIGHT_WIFI_REPROVISION_BUTTON
    err = start_reprovision_button();
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }
#endif

    if (provisioned) {
        wifi_prov_mgr_deinit();
        connect_saved_wifi = true;
        err = esp_wifi_set_mode(WIFI_MODE_STA);
        if (err == ESP_OK) {
            err = esp_wifi_start();
        }
        return err;
    }

    err = wifi_prov_scheme_ble_set_service_uuid((uint8_t *)service_uuid);
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }
    err = wifi_prov_mgr_endpoint_create("custom-data");
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }
    err = wifi_prov_mgr_start_provisioning(
        WIFI_PROV_SECURITY_2, &security2_params,
        MOODLIGHT_PROV_SERVICE_NAME, NULL);
    if (err != ESP_OK) {
        wifi_prov_mgr_deinit();
        return err;
    }
    err = wifi_prov_mgr_endpoint_register(
        "custom-data", custom_data_handler, NULL);
    if (err != ESP_OK) {
        wifi_prov_mgr_stop_provisioning();
        wifi_prov_mgr_deinit();
        return err;
    }

    ESP_LOGI(TAG, "Secure BLE provisioning is ready.");
    return ESP_OK;
}
