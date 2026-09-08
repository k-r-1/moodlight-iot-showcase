from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


FIRMWARE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(FIRMWARE / "tools"))
spec = importlib.util.spec_from_file_location(
    "generate_fleet_credentials", FIRMWARE / "tools" / "generate_fleet_credentials.py"
)
assert spec and spec.loader
TOOL = importlib.util.module_from_spec(spec)
spec.loader.exec_module(TOOL)


class FleetProvisioningSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        main = FIRMWARE / "main"
        self.fleet = (main / "fleet_provisioning.c").read_text(encoding="utf-8")
        self.identity = (main / "fleet_identity.c").read_text(encoding="utf-8")
        self.runtime = (main / "mqtt_runtime.c").read_text(encoding="utf-8")
        self.app = (main / "app_main.c").read_text(encoding="utf-8")
        self.kconfig = (main / "Kconfig.projbuild").read_text(encoding="utf-8")

    def test_fleet_is_default_off_and_requires_security_or_explicit_demo_exception(self) -> None:
        block = self.kconfig.split("config MOODLIGHT_FLEET_PROVISIONING", 1)[1]
        self.assertIn(
            "depends on (SECURE_FLASH_ENC_ENABLED && NVS_ENCRYPTION) || MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS",
            block,
        )
        self.assertIn("default n", block.split("config ", 1)[0])
        demo = self.kconfig.split(
            "config MOODLIGHT_ALLOW_PLAINTEXT_DEMO_CREDENTIALS", 1
        )[1].split("config MOODLIGHT_FLEET_PROVISIONING", 1)[0]
        self.assertIn("default n", demo)
        self.assertIn(
            '#error "Fleet identity storage requires encrypted NVS or the explicit plaintext demo exception"',
            self.identity,
        )
        self.assertIn(
            '#error "Fleet Provisioning requires flash/NVS encryption or the explicit plaintext demo exception"',
            self.fleet,
        )
        self.assertIn("Plaintext demo credentials are enabled", self.fleet)

    def test_claim_binding_and_mac_serial_are_sent_to_register_thing(self) -> None:
        self.assertIn("esp_read_mac(mac, ESP_MAC_WIFI_STA)", self.fleet)
        for field in (
            "SerialNumber",
            "ClaimId",
            "RegistrationNonceHash",
            "AWS::IoT::Certificate::Id",
        ):
            self.assertIn(f'cJSON_AddStringToObject(parameters, "{field}"', self.fleet)
        self.assertNotIn("TenantId", self.fleet)
        self.assertNotIn("PoolId", self.fleet)

    def test_identity_is_persisted_only_after_exact_register_acceptance(self) -> None:
        store = self.fleet.index("fleet_identity_store_issued(")
        register_handler = self.fleet.index("static void handle_register_accepted")
        create_handler = self.fleet.index("static void handle_create_accepted")
        self.assertGreater(store, register_handler)
        self.assertGreater(register_handler, create_handler)
        self.assertIn("strcmp(thing->valuestring, s_expected_thing) != 0", self.fleet)
        self.assertIn('cJSON_GetObjectItemCaseSensitive(root, "deviceConfiguration")', self.fleet)
        self.assertIn('cJSON_GetObjectItemCaseSensitive(configuration, "topicBase")', self.fleet)
        self.assertIn("cJSON_GetArraySize(root) != 2", self.fleet)
        self.assertIn("cJSON_GetArraySize(configuration) != 1", self.fleet)
        self.assertIn("parse_end != payload + length", self.fleet)
        self.assertNotIn("Thing registration rejected: %", self.fleet)
        self.assertNotIn("e->data", self.fleet)
        self.assertIn("mbedtls_platform_zeroize(private_key->valuestring", self.fleet)
        self.assertIn('cJSON_GetObjectItemCaseSensitive(root, "certificateId")', self.fleet)
        self.assertIn("valid_certificate_id(certificate_id->valuestring)", self.fleet)
        self.assertIn("s_device_certificate_id = strdup(certificate_id->valuestring)", self.fleet)

    def test_identity_and_topic_base_are_one_encrypted_nvs_transaction(self) -> None:
        store = self.identity.split("esp_err_t fleet_identity_store_issued", 1)[1]
        store = store.split("esp_err_t fleet_identity_load", 1)[0]
        for key in ("certificate", "private_key", "thing_name", "topic_base"):
            self.assertIn(f'nvs_set_str(handle, "{key}"', store)
        self.assertEqual(store.count("nvs_commit(handle)"), 1)
        self.assertNotIn("fleet_identity_store_topic_base", self.identity)
        self.assertIn("!valid_topic_base(topic_base, thing_name)", store)
        self.assertIn("#define FLEET_TOPIC_BASE_MAX_BYTES 377", self.identity)
        self.assertLess(
            store.index('nvs_set_str(handle, "topic_base"'),
            store.index('nvs_erase_key(handle, "enroll_started"'),
        )
        self.assertLess(
            store.index('nvs_erase_key(handle, "enroll_started"'),
            store.index("nvs_commit(handle)"),
        )

    def test_certificate_creation_is_single_shot_and_registration_reuses_pending_identity(self) -> None:
        self.assertIn("fleet_identity_mark_enrollment_started()", self.fleet)
        self.assertIn("s_create_request_started = true", self.fleet)
        self.assertIn(
            "has_pending_identity() ? FLEET_PHASE_SUBSCRIBE_REGISTER",
            self.fleet,
        )
        self.assertIn(
            "s_create_request_started && !has_pending_identity()",
            self.fleet,
        )
        self.assertIn("fleet_identity_recovery_required()", self.fleet)
        self.assertIn('nvs_erase_key(handle, "enroll_started")', self.identity)

        create_branch = self.fleet.split(
            "if (s_phase == FLEET_PHASE_SUBSCRIBE_CREATE)", 1
        )[1].split("} else {", 1)[0]
        self.assertLess(
            create_branch.index("fleet_identity_mark_enrollment_started()"),
            create_branch.index("esp_mqtt_client_publish(s_client, CREATE_TOPIC"),
        )

        run_attempt = self.fleet.split("static esp_err_t run_attempt(void)", 1)[1]
        run_attempt = run_attempt.split("static void fleet_task", 1)[0]
        self.assertNotIn("clear_pending_identity();", run_attempt)

    def test_runtime_starts_only_from_an_identity_present_before_this_boots_enrollment(self) -> None:
        self.assertIn("fleet_identity_load(&s_fleet_identity, true)", self.runtime)
        fleet_boot = self.app.split("#ifdef CONFIG_MOODLIGHT_FLEET_PROVISIONING", 2)[2]
        fleet_boot = fleet_boot.split("#else", 1)[0]
        self.assertIn("const bool identity_existed_at_boot = fleet_identity_is_issued();", fleet_boot)
        self.assertIn("if (identity_existed_at_boot)", fleet_boot)
        self.assertIn("mqtt_runtime_start_when_network_ready()", fleet_boot)
        self.assertIn("fleet_provisioning_start_when_network_ready()", fleet_boot)
        self.assertIn("Restart only after the server confirms runtime authorization", fleet_boot)
        self.assertLess(
            fleet_boot.index("if (identity_existed_at_boot)"),
            fleet_boot.index("mqtt_runtime_start_when_network_ready()"),
        )
        self.assertIn("FLEET_RETRY_LIMIT 3", self.fleet)

    def test_local_header_generator_is_private_and_refuses_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pem = root / "fixture.pem"
            pem.write_text("-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n")
            key = root / "key.pem"
            key.write_text("-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n")
            args = TOOL.argparse.Namespace(
                endpoint="example-ats.iot.ap-northeast-2.amazonaws.com",
                template_name="moodlight-dev-fleet",
                thing_name_prefix="moodlight-dev-lamp-",
                claim_client_id_prefix="moodlight-dev-claim-",
                topic_root="moodlight/dev/tenants",
                root_ca=pem,
                claim_certificate=pem,
                claim_private_key=key,
            )
            destination = TOOL.generate(args, root)
            self.assertEqual(os.stat(destination).st_mode & 0o777, 0o600)
            text = destination.read_text()
            self.assertIn("MOODLIGHT_FLEET_CLAIM_PRIVATE_KEY_PEM", text)
            with self.assertRaises(SystemExit):
                TOOL.generate(args, root)


if __name__ == "__main__":
    unittest.main()
