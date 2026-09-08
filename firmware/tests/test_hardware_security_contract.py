from __future__ import annotations

import csv
from pathlib import Path
import unittest


FIRMWARE = Path(__file__).resolve().parents[1]


class HardwareSecurityContractTest(unittest.TestCase):
    def test_nvs_key_partition_preserves_existing_layout(self) -> None:
        rows = []
        with (FIRMWARE / "partitions.csv").open(newline="", encoding="utf-8") as source:
            for row in csv.reader(line for line in source if not line.lstrip().startswith("#")):
                if row:
                    rows.append([value.strip() for value in row])

        by_name = {row[0]: row for row in rows}
        self.assertEqual(by_name["nvs"][3:5], ["0x9000", "0x6000"])
        self.assertEqual(by_name["phy_init"][3:5], ["0xf000", "0x1000"])
        self.assertEqual(by_name["factory"][3:5], ["0x10000", "2M"])
        self.assertEqual(
            by_name["nvs_keys"],
            ["nvs_keys", "data", "nvs_keys", "0x210000", "0x1000", "encrypted"],
        )

    def test_irreversible_security_features_stay_out_of_default_build(self) -> None:
        defaults = (FIRMWARE / "sdkconfig.defaults").read_text(encoding="utf-8")
        for option in (
            "CONFIG_SECURE_FLASH_ENC_ENABLED=y",
            "CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE=y",
            "CONFIG_NVS_ENCRYPTION=y",
            "CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC=y",
            "CONFIG_MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS=y",
        ):
            self.assertNotIn(option, defaults)


if __name__ == "__main__":
    unittest.main()
