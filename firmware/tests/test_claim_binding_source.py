import unittest
from pathlib import Path


class ClaimBindingSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        firmware = Path(__file__).parents[1]
        self.binding = (firmware / "main" / "claim_binding.c").read_text(encoding="utf-8")
        self.provisioning = (firmware / "main" / "provisioning.c").read_text(encoding="utf-8")

    def test_security2_custom_endpoint_accepts_exact_claim_bind_v1(self) -> None:
        for field in ("type", "version", "claimId", "registrationNonce"):
            self.assertIn(f'"{field}"', self.binding)
        self.assertIn('strcmp(item->valuestring, "claim.bind")', self.binding)
        self.assertIn('seen != (SEEN_TYPE | SEEN_VERSION | SEEN_CLAIM_ID | SEEN_NONCE)', self.binding)
        self.assertIn('(seen & field) != 0', self.binding)

    def test_ack_matches_mobile_contract_and_nonce_plaintext_is_not_persisted(self) -> None:
        self.assertIn('"claim.ack"', self.binding)
        self.assertIn('"accepted"', self.binding)
        self.assertIn('mbedtls_sha256', self.binding)
        self.assertIn('nvs_set_blob(handle, "nonce_hash"', self.binding)
        self.assertNotIn('nvs_set_str(handle, "registrationNonce"', self.binding)

    def test_existing_ping_probe_and_optional_custom_data_path_remain(self) -> None:
        self.assertIn("{'p', 'i', 'n', 'g'}", self.provisioning)
        self.assertIn("{'p', 'o', 'n', 'g'}", self.provisioning)
        self.assertIn('claim_binding_handle(', self.provisioning)
        self.assertIn('wifi_prov_mgr_endpoint_register(', self.provisioning)


if __name__ == "__main__":
    unittest.main()
