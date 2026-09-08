import { AppError } from "./domain.ts";

/** Canonical device serial: Wi-Fi STA MAC, without separators, lowercase. */
export const CANONICAL_SERIAL_PATTERN = /^[a-f0-9]{12}$/;

export function canonicalSerial(value: unknown): string {
  if (typeof value !== "string") throw invalidSerial();
  const normalized = value.trim().toLowerCase();
  if (!CANONICAL_SERIAL_PATTERN.test(normalized)) throw invalidSerial();
  return normalized;
}

function invalidSerial(): AppError {
  return new AppError("INVALID_SERIAL", 400, "serial must be a 12-character hexadecimal device identifier");
}
