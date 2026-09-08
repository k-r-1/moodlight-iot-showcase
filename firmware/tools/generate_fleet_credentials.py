#!/usr/bin/env python3
"""Create one Git-ignored Fleet claim header without printing secrets."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import re

from generate_mqtt_credentials import c_string, private_c_array, read_pem


NAME = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
TEMPLATE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,36}$")
TOPIC_ROOT = re.compile(r"^[A-Za-z0-9_.:-]+/[A-Za-z0-9_.:-]+/tenants$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--template-name", required=True)
    parser.add_argument("--thing-name-prefix", required=True)
    parser.add_argument("--claim-client-id-prefix", required=True)
    parser.add_argument("--topic-root", required=True)
    parser.add_argument("--root-ca", required=True, type=Path)
    parser.add_argument("--claim-certificate", required=True, type=Path)
    parser.add_argument("--claim-private-key", required=True, type=Path)
    return parser.parse_args()


def generate(args: argparse.Namespace, firmware_dir: Path) -> Path:
    if "://" in args.endpoint or "/" in args.endpoint or not args.endpoint.strip():
        raise SystemExit("endpoint must be a hostname without scheme, port, or path")
    if not TEMPLATE_NAME.fullmatch(args.template_name):
        raise SystemExit("template-name is invalid or longer than 36 characters")
    if not NAME.fullmatch(args.thing_name_prefix) or len(args.thing_name_prefix) + 12 > 128:
        raise SystemExit("thing-name-prefix cannot form a valid 128-byte Thing name")
    if not NAME.fullmatch(args.claim_client_id_prefix) or len(args.claim_client_id_prefix) + 12 > 128:
        raise SystemExit("claim-client-id-prefix cannot form a valid 128-byte client ID")
    if not TOPIC_ROOT.fullmatch(args.topic_root):
        raise SystemExit("topic-root must match project/environment/tenants")

    local_dir = firmware_dir / "local"
    destination = local_dir / "fleet_credentials.h"
    local_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists():
        raise SystemExit("Local Fleet material already exists; refusing to overwrite it.")

    header = (
        "#pragma once\n\n"
        f"#define MOODLIGHT_FLEET_ENDPOINT {c_string(args.endpoint)}\n"
        f"#define MOODLIGHT_FLEET_TEMPLATE_NAME {c_string(args.template_name)}\n"
        f"#define MOODLIGHT_FLEET_THING_NAME_PREFIX {c_string(args.thing_name_prefix)}\n"
        f"#define MOODLIGHT_FLEET_CLAIM_CLIENT_ID_PREFIX {c_string(args.claim_client_id_prefix)}\n\n"
        f"#define MOODLIGHT_FLEET_TOPIC_ROOT {c_string(args.topic_root)}\n\n"
        + private_c_array("MOODLIGHT_FLEET_ROOT_CA_PEM", read_pem(args.root_ca, "root CA"))
        + "\n"
        + private_c_array(
            "MOODLIGHT_FLEET_CLAIM_CERT_PEM",
            read_pem(args.claim_certificate, "claim certificate"),
        )
        + "\n"
        + private_c_array(
            "MOODLIGHT_FLEET_CLAIM_PRIVATE_KEY_PEM",
            read_pem(args.claim_private_key, "claim private key"),
        )
    )
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
        file.write(header)
    return destination


def main() -> None:
    destination = generate(parse_args(), Path(__file__).resolve().parents[1])
    print(f"Created {destination.parent.name}/{destination.name}; secret values were not printed.")


if __name__ == "__main__":
    main()
