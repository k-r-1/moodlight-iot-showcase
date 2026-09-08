import unittest
from pathlib import Path


class MqttRuntimeSourceTest(unittest.TestCase):
    def setUp(self) -> None:
        firmware = Path(__file__).parents[1]
        self.source = (firmware / "main" / "mqtt_runtime.c").read_text(encoding="utf-8")
        self.app = (firmware / "main" / "app_main.c").read_text(encoding="utf-8")
        self.kconfig = (firmware / "main" / "Kconfig.projbuild").read_text(encoding="utf-8")
        self.cmake = (firmware / "main" / "CMakeLists.txt").read_text(encoding="utf-8")
        self.gitignore = (firmware / ".gitignore").read_text(encoding="utf-8")

    def test_runtime_is_disabled_until_local_credentials_are_supplied(self) -> None:
        self.assertIn('config MOODLIGHT_MQTT_RUNTIME', self.kconfig)
        runtime_block = self.kconfig.split('config MOODLIGHT_MQTT_RUNTIME', 1)[1]
        self.assertIn('default n', runtime_block.split('config ', 1)[0])
        self.assertIn('if(CONFIG_MOODLIGHT_MQTT_RUNTIME)', self.cmake)
        self.assertIn('local/mqtt_credentials.h is missing', self.cmake)
        self.assertIn('local/', self.gitignore)
        self.assertIn('MQTT runtime is disabled by Kconfig.', self.app)

    def test_command_parser_is_exact_and_bounded(self) -> None:
        self.assertIn('#define MQTT_COMMAND_MAX_BYTES 512', self.source)
        self.assertIn('cJSON_ParseWithLengthOpts', self.source)
        self.assertIn('goto invalid;', self.source)
        self.assertIn('(seen & field) != 0', self.source)
        self.assertIn('command->update.fields == 0', self.source)
        for field in ('commandId', 'commandSequence', 'power', 'red', 'green', 'blue', 'brightness'):
            self.assertIn(f'"{field}"', self.source)

    def test_applied_command_is_persisted_and_restored_as_one_record(self) -> None:
        self.assertIn('#define MQTT_APPLIED_COMMAND_KEY "applied_cmd"', self.source)
        self.assertIn('mqtt_applied_command_record_t', self.source)
        self.assertIn('record.command_sequence = command->command_sequence', self.source)
        self.assertIn('strcpy(record.command_id, command->command_id)', self.source)
        for field in ('record.power', 'record.red', 'record.green', 'record.blue', 'record.brightness'):
            self.assertIn(field, self.source)
        self.assertIn('nvs_set_blob(s_nvs, MQTT_APPLIED_COMMAND_KEY', self.source)
        self.assertIn('nvs_get_blob(s_nvs, MQTT_APPLIED_COMMAND_KEY', self.source)
        self.assertIn('restore_applied_command()', self.source)
        self.assertIn('led_controller_apply(&update, &applied)', self.source)
        self.assertNotIn('nvs_set_u64(s_nvs, "cmd_seq"', self.source)

    def test_qos1_retry_republishes_state_but_conflicts_and_stale_sequences_fail(self) -> None:
        self.assertIn('command.command_sequence == s_last_command_sequence', self.source)
        self.assertIn('strcmp(command.command_id, s_last_command_id) == 0', self.source)
        self.assertIn('publish_state(command.command_id)', self.source)
        self.assertIn('command.command_sequence < s_last_command_sequence', self.source)
        self.assertIn('COMMAND_SEQUENCE_REJECTED', self.source)
        self.assertIn('publish_state(s_has_last_command_sequence ? s_last_command_id : NULL)', self.source)

    def test_device_subscribes_only_to_its_command_topic(self) -> None:
        self.assertIn('build_topic(s_command_topic, sizeof(s_command_topic), "cmd")', self.source)
        self.assertIn('esp_mqtt_client_subscribe(s_client, s_command_topic, 1)', self.source)
        self.assertIn('topic_equals(event, s_command_topic)', self.source)
        self.assertNotIn('shadow/name/control', self.source)

    def test_state_telemetry_and_event_match_backend_wire_fields(self) -> None:
        for field in (
            'kind', 'messageId', 'bootId', 'bootStartedAtMs', 'bootSequence', 'stateSequence', 'commandId',
            'power', 'red', 'green', 'blue', 'brightness', 'telemetrySequence',
            'uptimeSeconds', 'rssi', 'firmwareVersion', 'eventSequence', 'eventType', 'occurredAt',
        ):
            self.assertIn(f'"{field}"', self.source)
        self.assertIn('publish_state(command.command_id)', self.source)
        self.assertIn('publish_event("BOOT")', self.source)
        self.assertIn('CONFIG_MOODLIGHT_MQTT_TELEMETRY_INTERVAL_SECONDS', self.source)

    def test_boot_sequence_and_mutual_tls_are_configured_without_logging_secrets(self) -> None:
        self.assertIn('nvs_get_u64(s_nvs, "boot_seq"', self.source)
        self.assertIn('nvs_set_u64(s_nvs, "boot_seq", s_boot_sequence)', self.source)
        self.assertIn('esp_netif_sntp_sync_wait', self.source)
        self.assertIn('"bootStartedAtMs"', self.source)
        self.assertIn('MQTT_TRANSPORT_OVER_SSL', self.source)
        self.assertIn('MOODLIGHT_MQTT_ROOT_CA_PEM', self.source)
        self.assertIn('MOODLIGHT_MQTT_CLIENT_CERT_PEM', self.source)
        self.assertIn('MOODLIGHT_MQTT_PRIVATE_KEY_PEM', self.source)
        self.assertNotIn('ESP_LOG_BUFFER', self.source)

    def test_runtime_waits_for_ip_and_retries_clock_sync_without_duplicate_start(self) -> None:
        self.assertIn('mqtt_runtime_start_when_network_ready()', self.app)
        self.assertNotIn('mqtt_runtime_start();', self.app)
        self.assertIn('IP_EVENT_STA_GOT_IP', self.source)
        self.assertIn('IP_EVENT_STA_LOST_IP', self.source)
        self.assertIn('xEventGroupWaitBits', self.source)
        self.assertIn('MQTT_START_RETRY_MS', self.source)
        self.assertIn('s_network_start_registered', self.source)
        self.assertLess(
            self.source.index('esp_netif_sntp_sync_wait'),
            self.source.index('initialize_sequences();'),
        )


if __name__ == "__main__":
    unittest.main()
