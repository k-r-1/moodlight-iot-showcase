#include "serial_console.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_console.h"
#include "led_controller.h"

#define CONSOLE_MAX_COMMAND_LENGTH 192

static bool parse_uint(const char *text, unsigned long max, uint8_t *out)
{
    if (text == NULL || text[0] == '\0' || text[0] == '-') {
        return false;
    }

    errno = 0;
    char *end = NULL;
    const unsigned long value = strtoul(text, &end, 10);
    if (errno != 0 || end == text || *end != '\0' || value > max) {
        return false;
    }

    *out = (uint8_t)value;
    return true;
}

static void print_state(const led_state_t *state)
{
    printf("power=%s rgb=%u,%u,%u brightness=%u\n",
           state->power ? "on" : "off",
           state->red,
           state->green,
           state->blue,
           state->brightness);
}

static int led_command(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "get") == 0) {
        led_state_t state;
        const esp_err_t err = led_controller_get_state(&state);
        if (err != ESP_OK) {
            printf("ERROR %s\n", esp_err_to_name(err));
            return 1;
        }
        print_state(&state);
        return 0;
    }

    if (argc < 4 || strcmp(argv[1], "set") != 0 || ((argc - 2) % 2) != 0) {
        printf("Usage: led get\n");
        printf("       led set [--power on|off] [--red 0..255] [--green 0..255] [--blue 0..255] [--brightness 0..100]\n");
        return 1;
    }

    led_update_t update = {0};
    for (int i = 2; i < argc; i += 2) {
        const char *option = argv[i];
        const char *value = argv[i + 1];
        uint8_t parsed = 0;

        if (strcmp(option, "--power") == 0 && (update.fields & LED_UPDATE_POWER) == 0) {
            if (strcmp(value, "on") == 0) {
                update.values.power = true;
            } else if (strcmp(value, "off") == 0) {
                update.values.power = false;
            } else {
                printf("ERROR --power must be on or off\n");
                return 1;
            }
            update.fields |= LED_UPDATE_POWER;
        } else if (strcmp(option, "--red") == 0 && (update.fields & LED_UPDATE_RED) == 0 && parse_uint(value, 255, &parsed)) {
            update.values.red = parsed;
            update.fields |= LED_UPDATE_RED;
        } else if (strcmp(option, "--green") == 0 && (update.fields & LED_UPDATE_GREEN) == 0 && parse_uint(value, 255, &parsed)) {
            update.values.green = parsed;
            update.fields |= LED_UPDATE_GREEN;
        } else if (strcmp(option, "--blue") == 0 && (update.fields & LED_UPDATE_BLUE) == 0 && parse_uint(value, 255, &parsed)) {
            update.values.blue = parsed;
            update.fields |= LED_UPDATE_BLUE;
        } else if (strcmp(option, "--brightness") == 0 && (update.fields & LED_UPDATE_BRIGHTNESS) == 0 && parse_uint(value, 100, &parsed)) {
            update.values.brightness = parsed;
            update.fields |= LED_UPDATE_BRIGHTNESS;
        } else {
            printf("ERROR invalid, unknown, or duplicate option: %s\n", option);
            return 1;
        }
    }

    led_state_t applied;
    const esp_err_t err = led_controller_apply(&update, &applied);
    if (err != ESP_OK) {
        printf("ERROR %s\n", esp_err_to_name(err));
        return 1;
    }

    printf("OK ");
    print_state(&applied);
    return 0;
}

esp_err_t serial_console_start(void)
{
    const esp_console_cmd_t led_cmd = {
        .command = "led",
        .help = "Get or update the onboard moodlight LED",
        .hint = NULL,
        .func = &led_command,
    };

    esp_err_t err = esp_console_cmd_register(&led_cmd);
    if (err != ESP_OK) {
        return err;
    }
    esp_console_register_help_command();

    esp_console_repl_config_t repl_config = ESP_CONSOLE_REPL_CONFIG_DEFAULT();
    repl_config.prompt = "moodlight>";
    repl_config.max_cmdline_length = CONSOLE_MAX_COMMAND_LENGTH;

    esp_console_dev_uart_config_t uart_config = ESP_CONSOLE_DEV_UART_CONFIG_DEFAULT();
    esp_console_repl_t *repl = NULL;
    err = esp_console_new_repl_uart(&uart_config, &repl_config, &repl);
    if (err != ESP_OK) {
        return err;
    }
    return esp_console_start_repl(repl);
}
