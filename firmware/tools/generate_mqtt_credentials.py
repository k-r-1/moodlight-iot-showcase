#!/usr/bin/env python3
"""Generate a Git-ignored header for one device's local AWS IoT runtime values."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re


IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
TOPIC_BASE = re.compile(
    r"^[A-Za-z0-9_.:-]+/[A-Za-z0-9_.:-]+/tenants/[A-Za-z0-9_.:-]+/"
    r"pools/[A-Za-z0-9_.:-]+/[A-Za-z0-9_.:-]+$"
)


def private_c_array(name: str, value: bytes) -> str:
    rows = []
    for offset in range(0, len(value) + 1, 12):
        chunk = (value + b"\0")[offset : offset + 12]
        if not chunk:
            break
        rows.append("    " + ", ".join(f"0x{byte:02x}" for byte in chunk) + ",")
    return f"static const char {name}[] = {{\n" + "\n".join(rows) + "\n};\n"


def c_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def read_pem(path: Path, label: str) -> bytes:
    try:
        value = path.read_bytes()
    except OSError as error:
        raise SystemExit(f"Could not read {label}: {error}") from error
    if not value.startswith(b"-----BEGIN ") or b"-----END " not in value:
        raise SystemExit(f"{label} is not a PEM file")
    return value


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True, help="AWS IoT hostname without scheme or port")
    parser.add_argument("--thing-name", required=True)
    parser.add_argument("--topic-base", required=True, help="Topic without /cmd, /state, /tele, or /evt")
    parser.add_argument("--root-ca", required=True, type=Path)
    parser.add_argument("--client-cert", required=True, type=Path)
    parser.add_argument("--private-key", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if "://" in args.endpoint or "/" in args.endpoint or not args.endpoint.strip():
        raise SystemExit("endpoint must be a hostname without scheme, port, or path")
    if not IDENTIFIER.fullmatch(args.thing_name):
        raise SystemExit("thing-name has an invalid MQTT identifier")
    if not TOPIC_BASE.fullmatch(args.topic_base):
        raise SystemExit("topic-base does not match project/env/tenants/.../pools/.../thing")
    if args.topic_base.rsplit("/", 1)[-1] != args.thing_name:
        raise SystemExit("topic-base thing segment must equal thing-name")

    firmware_dir = Path(__file__).resolve().parents[1]
    local_dir = firmware_dir / "local"
    destination = local_dir / "mqtt_credentials.h"
    local_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists():
        raise SystemExit("Local MQTT material already exists; refusing to overwrite it.")

    header = (
        "#pragma once\n\n"
        f"#define MOODLIGHT_MQTT_ENDPOINT {c_string(args.endpoint)}\n"
        f"#define MOODLIGHT_MQTT_THING_NAME {c_string(args.thing_name)}\n"
        f"#define MOODLIGHT_MQTT_TOPIC_BASE {c_string(args.topic_base)}\n\n"
        + private_c_array("MOODLIGHT_MQTT_ROOT_CA_PEM", read_pem(args.root_ca, "root CA"))
        + "\n"
        + private_c_array("MOODLIGHT_MQTT_CLIENT_CERT_PEM", read_pem(args.client_cert, "client certificate"))
        + "\n"
        + private_c_array("MOODLIGHT_MQTT_PRIVATE_KEY_PEM", read_pem(args.private_key, "private key"))
    )
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
        file.write(header)
    print("Created local/mqtt_credentials.h. Secret values were not printed.")


if __name__ == "__main__":
    main()
