import re
import unittest
from pathlib import Path


class LedOutputSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        firmware = Path(__file__).parents[1]
        self.source = (firmware / "main" / "led_controller.c").read_text(encoding="utf-8")
        self.header = (firmware / "main" / "led_controller.h").read_text(encoding="utf-8")
        self.app = (firmware / "main" / "app_main.c").read_text(encoding="utf-8")
        self.kconfig = (firmware / "main" / "Kconfig.projbuild").read_text(encoding="utf-8")
        self.cmake = (firmware / "main" / "CMakeLists.txt").read_text(encoding="utf-8")

    def test_onboard_ws2812_remains_the_default(self) -> None:
        choice = re.search(r"choice MOODLIGHT_LED_OUTPUT(?P<body>[\s\S]*?)endchoice", self.kconfig)
        self.assertIsNotNone(choice)
        self.assertIn("default MOODLIGHT_LED_OUTPUT_ONBOARD_WS2812", choice.group("body"))
        self.assertIn("#define ONBOARD_RGB_GPIO 48", self.source)
        self.assertIn("led_strip_new_rmt_device", self.source)

    def test_external_common_cathode_output_uses_three_configurable_pwm_channels(self) -> None:
        for symbol, default in (
            ("MOODLIGHT_EXTERNAL_LED_RED_GPIO", 4),
            ("MOODLIGHT_EXTERNAL_LED_GREEN_GPIO", 5),
            ("MOODLIGHT_EXTERNAL_LED_BLUE_GPIO", 6),
        ):
            self.assertRegex(
                self.kconfig,
                rf"config {symbol}[\s\S]*?depends on MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE[\s\S]*?default {default}",
            )

        self.assertIn("#ifdef CONFIG_MOODLIGHT_LED_OUTPUT_EXTERNAL_COMMON_CATHODE", self.source)
        self.assertIn("LEDC_TIMER_8_BIT", self.source)
        self.assertIn("EXTERNAL_RGB_PWM_FREQUENCY_HZ 5000", self.source)
        self.assertIn(".flags.output_invert = 0", self.source)
        self.assertIn("gpio_set_level((gpio_num_t)gpios[i], 0)", self.source)
        self.assertIn("configure_external_channel(LEDC_CHANNEL_0, red_gpio)", self.source)
        self.assertIn("configure_external_channel(LEDC_CHANNEL_1, green_gpio)", self.source)
        self.assertIn("configure_external_channel(LEDC_CHANNEL_2, blue_gpio)", self.source)
        self.assertIn("write_external_channel(LEDC_CHANNEL_0, red)", self.source)
        self.assertIn("write_external_channel(LEDC_CHANNEL_1, green)", self.source)
        self.assertIn("write_external_channel(LEDC_CHANNEL_2, blue)", self.source)
        self.assertIn("esp_driver_ledc", self.cmake)

    def test_power_and_brightness_share_the_same_state_contract_for_both_outputs(self) -> None:
        self.assertRegex(
            self.source,
            r"state->power \? \(uint8_t\)\(\(\(uint16_t\)state->red \* state->brightness\) / 100U\) : 0",
        )
        self.assertIn("esp_err_t led_controller_run_smoke_test(void);", self.header)
        self.assertIn("led_controller_run_smoke_test()", self.app)


if __name__ == "__main__":
    unittest.main()
