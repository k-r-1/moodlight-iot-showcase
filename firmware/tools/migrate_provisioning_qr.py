#!/usr/bin/env python3
"""Migrate the local Security 2 QR schema without printing or changing its secret."""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile


LEGACY_FIELDS = {"ver", "name", "username", "pop", "transport", "security"}
CURRENT_FIELDS = {"name", "username", "password", "transport", "security"}


def main() -> None:
    qr_path = Path(__file__).resolve().parents[1] / "local" / "provisioning-qr.json"
    with qr_path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict) or set(payload) != LEGACY_FIELDS:
        raise SystemExit("Local QR is not the expected legacy schema; refusing to modify it.")
    if payload.get("ver") != "v1" or not isinstance(payload.get("pop"), str):
        raise SystemExit("Local QR legacy values are invalid; refusing to modify it.")

    migrated = {
        "name": payload["name"],
        "username": payload["username"],
        "password": payload["pop"],
        "transport": payload["transport"],
        "security": payload["security"],
    }
    if set(migrated) != CURRENT_FIELDS:
        raise SystemExit("Internal migration error.")

    descriptor, temporary_name = tempfile.mkstemp(prefix=".provisioning-qr-", dir=qr_path.parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(migrated, file, separators=(",", ":"))
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary_path, qr_path)
    finally:
        temporary_path.unlink(missing_ok=True)

    print("Migrated local QR schema without printing or changing credential values.")


if __name__ == "__main__":
    main()
