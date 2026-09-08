import type { DeviceState } from "./types";

export type ApiDevice = {
  deviceId: string;
  tenantId: string;
  poolId: string;
  name: string;
  lifecycleStatus: "RUNTIME_AUTHORIZED" | "ACTIVE" | "REVOKED";
  power: boolean;
  red: number;
  green: number;
  blue: number;
  brightness: number;
  pendingDesired?: { power: boolean; red: number; green: number; blue: number; brightness: number };
  lastCommandId?: string;
  appliedCommandId?: string;
  lastSeenAt?: string;
  online?: boolean;
  version: number;
};

export function parseDeviceList(value: unknown): ApiDevice[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { devices?: unknown }).devices)) throw new Error("invalid-device-list");
  return (value as { devices: unknown[] }).devices.map(parseDevice);
}

export function toDeviceState(device: ApiDevice): DeviceState {
  return {
    id: device.deviceId, name: device.name, room: device.poolId, online: device.online ?? null,
    power: device.power,
    color: `#${[device.red, device.green, device.blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
    brightness: device.brightness,
    ...(device.pendingDesired === undefined ? {} : { desiredState: {
      power: device.pendingDesired.power,
      color: rgb(device.pendingDesired),
      brightness: device.pendingDesired.brightness,
    } }),
    ...(device.lastCommandId === undefined ? {} : { lastCommandId: device.lastCommandId }),
    ...(device.appliedCommandId === undefined ? {} : { appliedCommandId: device.appliedCommandId }),
  };
}

function parseDevice(value: unknown): ApiDevice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-device");
  const item = value as Record<string, unknown>;
  const lifecycleStatus = item.lifecycleStatus;
  if (lifecycleStatus !== "RUNTIME_AUTHORIZED" && lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "REVOKED") throw new Error("invalid-lifecycle-status");
  const result: ApiDevice = {
    deviceId: text(item.deviceId, 128), tenantId: text(item.tenantId, 128), poolId: text(item.poolId, 128),
    name: text(item.name, 256), lifecycleStatus, power: bool(item.power), red: integer(item.red, 0, 255),
    green: integer(item.green, 0, 255), blue: integer(item.blue, 0, 255), brightness: integer(item.brightness, 0, 100),
    version: integer(item.version, 0, Number.MAX_SAFE_INTEGER),
  };
  if (item.online !== undefined) result.online = bool(item.online);
  if (item.pendingDesired !== undefined) result.pendingDesired = state(item.pendingDesired);
  if (item.lastCommandId !== undefined) result.lastCommandId = text(item.lastCommandId, 128);
  if (item.appliedCommandId !== undefined) result.appliedCommandId = text(item.appliedCommandId, 128);
  if (item.lastSeenAt !== undefined) {
    const lastSeenAt = text(item.lastSeenAt, 64);
    if (Number.isNaN(Date.parse(lastSeenAt))) throw new Error("invalid-last-seen-at");
    result.lastSeenAt = lastSeenAt;
  }
  return result;
}

function state(value: unknown): { power: boolean; red: number; green: number; blue: number; brightness: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-state");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["power", "red", "green", "blue", "brightness"].includes(key))) {
    throw new Error("invalid-state");
  }
  return {
    power: bool(item.power),
    red: integer(item.red, 0, 255),
    green: integer(item.green, 0, 255),
    blue: integer(item.blue, 0, 255),
    brightness: integer(item.brightness, 0, 100),
  };
}

function rgb(value: { red: number; green: number; blue: number }): string {
  return `#${[value.red, value.green, value.blue].map((item) => item.toString(16).padStart(2, "0")).join("")}`;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("invalid-text");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid-boolean");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid-number");
  return value as number;
}
