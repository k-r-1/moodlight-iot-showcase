import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


TOOL_PATH = Path(__file__).resolve().parents[1] / "tools" / "generate_product_registration.py"
SPEC = importlib.util.spec_from_file_location("product_registration", TOOL_PATH)
assert SPEC and SPEC.loader
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)


class ProductRegistrationToolTest(unittest.TestCase):
    def test_builds_seven_field_qr_and_hash_only_seed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "security.json"
            source.write_text(json.dumps({
                "name": "Moodlight-A1B2C3",
                "username": "ml-user",
                "password": "security-two-password",
                "transport": "ble",
                "security": 2,
            }), encoding="utf-8")
            output = root / "private"
            qr_path, seed_path = TOOL.generate("A1B2C3D4E5F6", source, output)

            qr = json.loads(qr_path.read_text(encoding="utf-8"))
            seed = json.loads(seed_path.read_text(encoding="utf-8"))
            self.assertEqual(qr["serial"], "a1b2c3d4e5f6")
            self.assertEqual(set(qr), TOOL.BLE_FIELDS | {"serial", "registrationCode"})
            self.assertEqual(seed["serial"], {"S": qr["serial"]})
            self.assertEqual(seed["registrationCodeHash"], {"S": TOOL.registration_code_hash(qr["serial"], qr["registrationCode"])})
            self.assertEqual(seed["codeVersion"], {"N": "1"})
            self.assertEqual(seed["version"], {"N": "1"})
            self.assertNotIn(qr["registrationCode"], seed_path.read_text(encoding="utf-8"))
            self.assertEqual(stat.S_IMODE(qr_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(seed_path.stat().st_mode), 0o600)

            with self.assertRaises(FileExistsError):
                TOOL.generate("a1b2c3d4e5f6", source, output)

    def test_rejects_noncanonical_serial(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "security.json"
            source.write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                TOOL.generate("serial-a", source, root / "out")

    def test_cleanup_never_deletes_a_file_created_by_another_writer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "security.json"
            source.write_text(json.dumps({
                "name": "Moodlight-A1B2C3",
                "username": "ml-user",
                "password": "security-two-password",
                "transport": "ble",
                "security": 2,
            }), encoding="utf-8")
            output = root / "private"
            original_write = TOOL.write_private

            def race(path: Path, payload: object) -> None:
                if path.name == "device-registry-seed.json":
                    path.write_text("foreign\n", encoding="utf-8")
                    raise FileExistsError(path)
                original_write(path, payload)

            with mock.patch.object(TOOL, "write_private", side_effect=race):
                with self.assertRaises(FileExistsError):
                    TOOL.generate("a1b2c3d4e5f6", source, output)

            self.assertFalse((output / "product-registration-qr.json").exists())
            self.assertEqual((output / "device-registry-seed.json").read_text(encoding="utf-8"), "foreign\n")


if __name__ == "__main__":
    unittest.main()
