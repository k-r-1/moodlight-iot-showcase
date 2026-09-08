import type { DeviceState } from "./types";

export type DeviceControlDraft = { power: boolean; color: string; brightness: number };
export type DesiredDeviceState = { power: boolean; red: number; green: number; blue: number; brightness: number };
export type PendingDeviceStateRequest = {
  requestId: string;
  deviceId: string;
  desired: DesiredDeviceState;
  accepted: boolean;
  commandId?: string;
};

export function draftFromDevice(device: DeviceState): DeviceControlDraft {
  return { power: device.power, color: device.color, brightness: device.brightness };
}

export function desiredFromDraft(draft: DeviceControlDraft): DesiredDeviceState {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(draft.color);
  if (!match || !Number.isInteger(draft.brightness) || draft.brightness < 0 || draft.brightness > 100) {
    throw new Error("invalid-device-control-draft");
  }
  return {
    power: draft.power,
    red: Number.parseInt(match[1], 16),
    green: Number.parseInt(match[2], 16),
    blue: Number.parseInt(match[3], 16),
    brightness: draft.brightness,
  };
}

export function acceptsStateAccepted(
  pending: PendingDeviceStateRequest | null,
  message: { requestId: string; payload: { deviceId: string } },
): boolean {
  return pending !== null && pending.requestId === message.requestId && pending.deviceId === message.payload.deviceId;
}

export function desiredMatchesDevice(desired: DesiredDeviceState, device: DeviceState): boolean {
  const actual = desiredFromDraft(draftFromDevice(device));
  return Object.entries(desired).every(([key, value]) => actual[key as keyof DesiredDeviceState] === value);
}

export function commandApplied(pending: PendingDeviceStateRequest, device: DeviceState): boolean {
  return pending.accepted
    && typeof pending.commandId === "string"
    && pending.commandId.length > 0
    && device.appliedCommandId === pending.commandId;
}

export function hasPendingDesired(device: DeviceState): boolean {
  return typeof device.lastCommandId === "string"
    && device.lastCommandId.length > 0
    && device.lastCommandId !== device.appliedCommandId
    && device.desiredState !== undefined;
}
