#!/usr/bin/env python3
"""Combine one board's BLE QR with a one-time product registration code."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
from datetime import datetime, timezone


SERIAL_PATTERN = re.compile(r"^[a-f0-9]{12}$")
CODE_DOMAIN = "moodlight-registration-code-v1\0"
BLE_FIELDS = {"name", "username", "password", "transport", "security"}


def registration_code_hash(serial: str, code: str) -> str:
    return hashlib.sha256(f"{CODE_DOMAIN}{serial}\0{code}".encode()).hexdigest()


def write_private(path: Path, payload: object) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, separators=(",", ":"))
        file.write("\n")


def generate(serial_value: str, security_qr_path: Path, output_dir: Path) -> tuple[Path, Path]:
    serial = serial_value.strip().lower()
    if not SERIAL_PATTERN.fullmatch(serial):
        raise ValueError("serial must be the 12 lowercase/uppercase hex digits of the Wi-Fi STA MAC")

    security_qr = json.loads(security_qr_path.read_text(encoding="utf-8"))
    if not isinstance(security_qr, dict) or set(security_qr) != BLE_FIELDS:
        raise ValueError("Security 2 QR must contain exactly name, username, password, transport, security")
    if security_qr.get("security") != 2 or security_qr.get("transport") != "ble":
        raise ValueError("Only the verified BLE Security 2 QR can be extended")

    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    product_qr_path = output_dir / "product-registration-qr.json"
    registry_seed_path = output_dir / "device-registry-seed.json"
    if product_qr_path.exists() or registry_seed_path.exists():
        raise FileExistsError("Registration output already exists; refusing to overwrite it")

    registration_code = secrets.token_urlsafe(32)
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    product_qr = {
        **security_qr,
        "serial": serial,
        "registrationCode": registration_code,
    }
    registry_seed = {
        "serialHash": {"S": hashlib.sha256(serial.encode()).hexdigest()},
        "serial": {"S": serial},
        "model": {"S": "moodlight-esp32s3-devkitc-1-n16r8"},
        "codeVersion": {"N": "1"},
        "registrationCodeHash": {"S": registration_code_hash(serial, registration_code)},
        "status": {"S": "AVAILABLE"},
        "createdAt": {"S": created_at},
        "updatedAt": {"S": created_at},
        "version": {"N": "1"},
    }

    written: list[Path] = []
    try:
        write_private(product_qr_path, product_qr)
        written.append(product_qr_path)
        write_private(registry_seed_path, registry_seed)
        written.append(registry_seed_path)
    except BaseException:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return product_qr_path, registry_seed_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True, help="Wi-Fi STA MAC as 12 hex digits without separators")
    parser.add_argument("--security-qr", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    generate(args.serial, args.security_qr, args.output_dir)
    print("Created private product QR and DynamoDB AttributeValue seed. Values were not printed.")


if __name__ == "__main__":
    main()
