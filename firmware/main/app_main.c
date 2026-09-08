#include "esp_log.h"
#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING
#include "fleet_identity.h"
#include "fleet_provisioning.h"
#endif
#include "led_controller.h"
#ifdef CONFIG_MOODLIGHT_MQTT_RUNTIME
#include "mqtt_runtime.h"
#endif
#include "provisioning.h"
#include "serial_console.h"
#include "sdkconfig.h"

static const char *TAG = "moodlight";

void app_main(void)
{
    ESP_LOGI(TAG, "Moodlight firmware booted.");
    ESP_ERROR_CHECK(led_controller_init());
#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE
    ESP_LOGI(TAG, "Running low-brightness external RGB smoke test on GPIO%d/%d/%d.",
             CONFIG_MOODLIGHT_EXTERNAL_LED_RED_GPIO,
             CONFIG_MOODLIGHT_EXTERNAL_LED_GREEN_GPIO,
             CONFIG_MOODLIGHT_EXTERNAL_LED_BLUE_GPIO);
#else
    ESP_LOGI(TAG, "Running low-brightness onboard RGB smoke test on GPIO48.");
#endif

    const esp_err_t err = led_controller_run_smoke_test();
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "RGB smoke test finished; LED is now off.");
        ESP_ERROR_CHECK(provisioning_start());
        ESP_LOGI(TAG, "Serial control is ready. Type help and press Enter.");
        ESP_ERROR_CHECK(serial_console_start());
#ifdef CONFIG_MOODLIGHT_MQTT_RUNTIME
#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING
        const bool identity_existed_at_boot = fleet_identity_is_issued();
        if (identity_existed_at_boot) {
            const esp_err_t mqtt_err = mqtt_runtime_start_when_network_ready();
            if (mqtt_err != ESP_OK) {
                ESP_LOGE(TAG, "MQTT network start registration failed: %s", esp_err_to_name(mqtt_err));
            }
        } else {
            const esp_err_t fleet_err = fleet_provisioning_start_when_network_ready();
            if (fleet_err != ESP_OK) {
                ESP_LOGE(TAG, "Fleet network start registration failed: %s", esp_err_to_name(fleet_err));
            }
            ESP_LOGI(TAG, "Runtime MQTT remains blocked on this boot. Restart only after the server confirms runtime authorization.");
        }
#else
        const esp_err_t mqtt_err = mqtt_runtime_start_when_network_ready();
        if (mqtt_err != ESP_OK) {
            ESP_LOGE(TAG, "MQTT network start registration failed: %s", esp_err_to_name(mqtt_err));
        }
#endif
#else
        ESP_LOGI(TAG, "MQTT runtime is disabled by Kconfig.");
#endif
    } else {
        ESP_LOGE(TAG, "RGB smoke test failed: %s", esp_err_to_name(err));
    }
}
