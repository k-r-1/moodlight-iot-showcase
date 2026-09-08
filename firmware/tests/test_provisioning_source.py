import re
import unittest
from pathlib import Path


class ProvisioningSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        firmware = Path(__file__).parents[1]
        self.source = (firmware / "main" / "provisioning.c").read_text(encoding="utf-8")
        self.kconfig = (firmware / "main" / "Kconfig.projbuild").read_text(encoding="utf-8")

    def test_credential_failure_resets_provisioning_state(self) -> None:
        match = re.search(
            r"case WIFI_PROV_CRED_FAIL:(?P<body>[\s\S]*?)case WIFI_PROV_CRED_SUCCESS:",
            self.source,
        )
        self.assertIsNotNone(match)
        body = match.group("body")
        self.assertIn("wifi_prov_mgr_reset_sm_state_on_failure()", body)
        self.assertRegex(body, r"if \(reset_err != ESP_OK\)")
        self.assertIn("esp_err_to_name(reset_err)", body)

    def test_long_press_resets_only_wifi_at_runtime(self) -> None:
        self.assertIn("err = start_reprovision_button()", self.source)
        self.assertLess(self.source.index("err = start_reprovision_button()"), self.source.index("if (provisioned)"))
        self.assertIn("wifi_prov_mgr_reset_provisioning()", self.source)
        self.assertNotIn("nvs_flash_erase", self.source)
        self.assertLess(self.source.index("wifi_prov_mgr_reset_provisioning()"), self.source.index("esp_restart()"))
        self.assertIn("while (gpio_get_level(button_gpio) == 0)", self.source)
        self.assertRegex(self.kconfig, r"config MOODLIGHT_WIFI_REPROVISION_BUTTON_GPIO[\s\S]*?default 0")
        self.assertRegex(self.kconfig, r"config MOODLIGHT_WIFI_REPROVISION_HOLD_MS[\s\S]*?default 5000")


if __name__ == "__main__":
    unittest.main()
