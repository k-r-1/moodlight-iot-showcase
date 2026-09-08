#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

typedef struct {
    bool power;
    uint8_t red;
    uint8_t green;
    uint8_t blue;
    uint8_t brightness;
} led_state_t;

enum {
    LED_UPDATE_POWER = 1U << 0,
    LED_UPDATE_RED = 1U << 1,
    LED_UPDATE_GREEN = 1U << 2,
    LED_UPDATE_BLUE = 1U << 3,
    LED_UPDATE_BRIGHTNESS = 1U << 4,
};

typedef struct {
    uint32_t fields;
    led_state_t values;
} led_update_t;

esp_err_t led_controller_init(void);
esp_err_t led_controller_apply(const led_update_t *update, led_state_t *applied);
esp_err_t led_controller_get_state(led_state_t *out);
esp_err_t led_controller_run_smoke_test(void);
