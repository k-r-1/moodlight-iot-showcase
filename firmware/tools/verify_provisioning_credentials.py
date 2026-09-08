#!/usr/bin/env python3
"""Verify that a Security 2 header and QR JSON belong to the same device."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys


def load_srp6a():
    idf_path = os.environ.get("IDF_PATH")
    if not idf_path:
        raise SystemExit("IDF_PATH is missing. Run this tool inside the ESP-IDF environment.")
    module_path = Path(idf_path) / "tools" / "esp_prov" / "security" / "srp6a.py"
    sys.path.insert(0, str(module_path.parents[1]))
    spec = importlib.util.spec_from_file_location("esp_prov_srp6a", module_path)
    if spec is None or spec.loader is None:
        raise SystemExit("ESP-IDF SRP6a implementation was not found.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_c_array(header: str, name: str) -> bytes:
    match = re.search(
        rf"static const uint8_t {re.escape(name)}\[\] = \{{(.*?)\}};",
        header,
        re.DOTALL,
    )
    if not match:
        raise SystemExit(f"{name} is missing from the header.")
    return bytes(int(value, 16) for value in re.findall(r"0x([0-9a-fA-F]{2})", match.group(1)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("header", type=Path)
    parser.add_argument("qr_json", type=Path)
    args = parser.parse_args()

    header = args.header.read_text(encoding="utf-8")
    payload = json.loads(args.qr_json.read_text(encoding="utf-8"))
    expected_fields = {"name", "username", "password", "transport", "security"}
    if set(payload) != expected_fields or payload["transport"] != "ble" or payload["security"] != 2:
        raise SystemExit("QR JSON does not have the expected five-field Security 2 schema.")

    service_match = re.search(r'#define MOODLIGHT_PROV_SERVICE_NAME "([^"]+)"', header)
    if not service_match:
        raise SystemExit("Provisioning service name is missing from the header.")

    salt = parse_c_array(header, "MOODLIGHT_PROV_SALT")
    actual_verifier = parse_c_array(header, "MOODLIGHT_PROV_VERIFIER")
    srp6a = load_srp6a()
    modulus, generator = srp6a.get_ng(srp6a.NG_3072)
    verifier_value = pow(
        generator,
        srp6a.calculate_x(hashlib.sha512, salt, payload["username"], payload["password"]),
        modulus,
    )
    expected_verifier = srp6a.long_to_bytes(verifier_value)
    android_compatible = hashlib.sha512(
        f'{payload["username"]}:{payload["password"]}'.encode()
    ).digest()[0] != 0

    name_matches = service_match.group(1) == payload["name"]
    verifier_matches = actual_verifier == expected_verifier
    print(
        json.dumps(
            {
                "schemaValid": True,
                "serviceNameMatches": name_matches,
                "srp6aVerifierMatches": verifier_matches,
                "androidCompatible": android_compatible,
            }
        )
    )
    if not (name_matches and verifier_matches and android_compatible):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
