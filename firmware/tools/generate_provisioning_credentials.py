#!/usr/bin/env python3
"""Generate one board's local ESP-IDF Security 2 provisioning material."""

from __future__ import annotations

import json
import hashlib
import importlib.util
import os
from pathlib import Path
import secrets
import sys


def find_esp_prov() -> Path:
    idf_path = os.environ.get("IDF_PATH")
    if not idf_path:
        raise SystemExit("IDF_PATH is missing. Run this tool inside the ESP-IDF environment.")
    esp_prov = Path(idf_path) / "tools" / "esp_prov"
    if not esp_prov.is_dir():
        raise SystemExit("ESP-IDF esp_prov tools were not found under IDF_PATH.")
    return esp_prov


def c_array(name: str, value: bytes) -> str:
    rows = []
    for offset in range(0, len(value), 12):
        row = ", ".join(f"0x{byte:02x}" for byte in value[offset : offset + 12])
        rows.append(f"    {row},")
    return f"static const uint8_t {name}[] = {{\n" + "\n".join(rows) + "\n};\n"


def write_private(path: Path, content: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        file.write(content)


def is_android_srp_compatible(username: str, password: str) -> bool:
    """Avoid an upstream generator edge case that drops a leading hash byte."""
    inner_hash = hashlib.sha512(f"{username}:{password}".encode()).digest()
    return inner_hash[0] != 0


def main() -> None:
    esp_prov = find_esp_prov()
    sys.path.insert(0, str(esp_prov))
    module_path = esp_prov / "security" / "srp6a.py"
    spec = importlib.util.spec_from_file_location("esp_prov_srp6a", module_path)
    if spec is None or spec.loader is None:
        raise SystemExit("ESP-IDF SRP6a credential generator could not be loaded.")
    srp6a = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(srp6a)

    firmware_dir = Path(__file__).resolve().parents[1]
    local_dir = firmware_dir / "local"
    header_path = local_dir / "provisioning_credentials.h"
    qr_path = local_dir / "provisioning-qr.json"
    local_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    if header_path.exists() or qr_path.exists():
        raise SystemExit("Local provisioning material already exists; refusing to overwrite it.")

    while True:
        username = f"ml-{secrets.token_hex(8)}"
        password = secrets.token_urlsafe(24)
        if is_android_srp_compatible(username, password):
            break
    service_name = f"Moodlight-{secrets.token_hex(3).upper()}"
    salt, verifier = srp6a.generate_salt_and_verifier(username, password, len_s=16)

    header = (
        "#pragma once\n\n"
        "#include <stdint.h>\n\n"
        f'#define MOODLIGHT_PROV_SERVICE_NAME "{service_name}"\n\n'
        + c_array("MOODLIGHT_PROV_SALT", salt)
        + "\n"
        + c_array("MOODLIGHT_PROV_VERIFIER", verifier)
    )
    qr_payload = json.dumps(
        {
            "name": service_name,
            "username": username,
            "password": password,
            "transport": "ble",
            "security": 2,
        },
        separators=(",", ":"),
    )

    try:
        write_private(header_path, header)
        write_private(qr_path, qr_payload + "\n")
    except BaseException:
        header_path.unlink(missing_ok=True)
        qr_path.unlink(missing_ok=True)
        raise

    print("Created private local provisioning material. Values were not printed.")


if __name__ == "__main__":
    main()
