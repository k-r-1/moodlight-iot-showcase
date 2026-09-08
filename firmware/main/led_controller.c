#include "led_controller.h"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "led_strip.h"
#include "sdkconfig.h"

#define ONBOARD_RGB_GPIO 48
#define ONBOARD_RGB_LED_COUNT 1
#define RGB_TEST_LEVEL 8
#define RGB_TEST_HOLD_MS 700
#define ONBOARD_RGB_RMT_RESOLUTION_HZ (10 * 1000 * 1000)
#define EXTERNAL_RGB_PWM_FREQUENCY_HZ 5000
#define LED_UPDATE_ALL_FIELDS (LED_UPDATE_POWER | LED_UPDATE_RED | LED_UPDATE_GREEN | LED_UPDATE_BLUE | LED_UPDATE_BRIGHTNESS)

#ifndef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE
static led_strip_handle_t s_strip;
#endif
static SemaphoreHandle_t s_mutex;
static led_state_t s_state;
static bool s_initialized;

#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE
static esp_err_t configure_external_channel(ledc_channel_t channel, int gpio)
{
    const ledc_channel_config_t channel_config = {
        .gpio_num = gpio,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel = channel,
        .intr_type = LEDC_INTR_DISABLE,
        .timer_sel = LEDC_TIMER_0,
        .duty = 0,
        .hpoint = 0,
        .flags.output_invert = 0,
    };
    return ledc_channel_config(&channel_config);
}

static esp_err_t init_external_rgb(void)
{
    const int red_gpio = CONFIG_MOODLIGHT_EXTERNAL_LED_RED_GPIO;
    const int green_gpio = CONFIG_MOODLIGHT_EXTERNAL_LED_GREEN_GPIO;
    const int blue_gpio = CONFIG_MOODLIGHT_EXTERNAL_LED_BLUE_GPIO;
    if (red_gpio == green_gpio || red_gpio == blue_gpio || green_gpio == blue_gpio) {
        return ESP_ERR_INVALID_ARG;
    }

    const int gpios[] = {red_gpio, green_gpio, blue_gpio};
    for (size_t i = 0; i < sizeof(gpios) / sizeof(gpios[0]); i++) {
        esp_err_t err = gpio_reset_pin((gpio_num_t)gpios[i]);
        if (err == ESP_OK) {
            err = gpio_set_direction((gpio_num_t)gpios[i], GPIO_MODE_OUTPUT);
        }
        if (err == ESP_OK) {
            err = gpio_set_level((gpio_num_t)gpios[i], 0);
        }
        if (err != ESP_OK) {
            return err;
        }
    }

    const ledc_timer_config_t timer_config = {
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LEDC_TIMER_8_BIT,
        .timer_num = LEDC_TIMER_0,
        .freq_hz = EXTERNAL_RGB_PWM_FREQUENCY_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    esp_err_t err = ledc_timer_config(&timer_config);
    if (err == ESP_OK) {
        err = configure_external_channel(LEDC_CHANNEL_0, red_gpio);
    }
    if (err == ESP_OK) {
        err = configure_external_channel(LEDC_CHANNEL_1, green_gpio);
    }
    if (err == ESP_OK) {
        err = configure_external_channel(LEDC_CHANNEL_2, blue_gpio);
    }
    return err;
}

static esp_err_t write_external_channel(ledc_channel_t channel, uint8_t duty)
{
    esp_err_t err = ledc_set_duty(LEDC_LOW_SPEED_MODE, channel, duty);
    if (err == ESP_OK) {
        err = ledc_update_duty(LEDC_LOW_SPEED_MODE, channel);
    }
    return err;
}
#endif

static esp_err_t write_state(const led_state_t *state)
{
    const uint8_t red = state->power ? (uint8_t)(((uint16_t)state->red * state->brightness) / 100U) : 0;
    const uint8_t green = state->power ? (uint8_t)(((uint16_t)state->green * state->brightness) / 100U) : 0;
    const uint8_t blue = state->power ? (uint8_t)(((uint16_t)state->blue * state->brightness) / 100U) : 0;

#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE
    esp_err_t err = write_external_channel(LEDC_CHANNEL_0, red);
    if (err == ESP_OK) {
        err = write_external_channel(LEDC_CHANNEL_1, green);
    }
    if (err == ESP_OK) {
        err = write_external_channel(LEDC_CHANNEL_2, blue);
    }
    return err;
#else
    if (!state->power || state->brightness == 0) {
        return led_strip_clear(s_strip);
    }

    esp_err_t err = led_strip_set_pixel(s_strip, 0, red, green, blue);
    if (err == ESP_OK) {
        err = led_strip_refresh(s_strip);
    }
    return err;
#endif
}

esp_err_t led_controller_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }

    if (s_mutex == NULL) {
        s_mutex = xSemaphoreCreateMutex();
        if (s_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE
    esp_err_t err = init_external_rgb();
#else
    const led_strip_config_t strip_config = {
        .strip_gpio_num = ONBOARD_RGB_GPIO,
        .max_leds = ONBOARD_RGB_LED_COUNT,
        .led_pixel_format = LED_PIXEL_FORMAT_GRB,
        .led_model = LED_MODEL_WS2812,
        .flags.invert_out = false,
    };
    const led_strip_rmt_config_t rmt_config = {
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = ONBOARD_RGB_RMT_RESOLUTION_HZ,
        .flags.with_dma = false,
    };

    esp_err_t err = led_strip_new_rmt_device(&strip_config, &rmt_config, &s_strip);
    if (err != ESP_OK) {
        s_strip = NULL;
        return err;
    }
#endif

    s_state = (led_state_t){0};
    if (err == ESP_OK) {
        err = write_state(&s_state);
    }
    if (err != ESP_OK) {
#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_ONBOARD_WS2812
        led_strip_del(s_strip);
        s_strip = NULL;
#endif
        return err;
    }
    s_initialized = true;
    return ESP_OK;
}

esp_err_t led_controller_apply(const led_update_t *update, led_state_t *applied)
{
    if (update == NULL || update->fields == 0 || (update->fields & ~LED_UPDATE_ALL_FIELDS) != 0) {
        return ESP_ERR_INVALID_ARG;
    }
    if ((update->fields & LED_UPDATE_BRIGHTNESS) != 0 && update->values.brightness > 100) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_initialized || s_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    led_state_t next = s_state;
    if ((update->fields & LED_UPDATE_POWER) != 0) {
        next.power = update->values.power;
    }
    if ((update->fields & LED_UPDATE_RED) != 0) {
        next.red = update->values.red;
    }
    if ((update->fields & LED_UPDATE_GREEN) != 0) {
        next.green = update->values.green;
    }
    if ((update->fields & LED_UPDATE_BLUE) != 0) {
        next.blue = update->values.blue;
    }
    if ((update->fields & LED_UPDATE_BRIGHTNESS) != 0) {
        next.brightness = update->values.brightness;
    }

    const esp_err_t err = write_state(&next);
    if (err == ESP_OK) {
        s_state = next;
        if (applied != NULL) {
            *applied = s_state;
        }
    }

    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t led_controller_get_state(led_state_t *out)
{
    if (out == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!s_initialized || s_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    *out = s_state;
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t led_controller_run_smoke_test(void)
{
    if (!s_initialized || s_mutex == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_mutex, portMAX_DELAY) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    const led_state_t colors[] = {
        {.power = true, .red = RGB_TEST_LEVEL, .brightness = 100},
        {.power = true, .green = RGB_TEST_LEVEL, .brightness = 100},
        {.power = true, .blue = RGB_TEST_LEVEL, .brightness = 100},
    };

    esp_err_t err = ESP_OK;
    for (size_t i = 0; i < sizeof(colors) / sizeof(colors[0]) && err == ESP_OK; i++) {
        err = write_state(&colors[i]);
        if (err == ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(RGB_TEST_HOLD_MS));
        }
    }
    const led_state_t off = {0};
    const esp_err_t clear_err = write_state(&off);
    s_state = off;
    xSemaphoreGive(s_mutex);

    return err == ESP_OK ? clear_err : err;
}
