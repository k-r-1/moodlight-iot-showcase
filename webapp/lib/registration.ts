import type { NativeToWebMessage, WebToNativeMessage } from "./bridge";
import type { BleAdapterState } from "./types";

export type RegistrationRequest = Exclude<WebToNativeMessage, { type: "bridge.ready" | "app.openSettings" | "auth.status" | "auth.login" | "auth.logout" | "api.devices.list" | "api.devices.state.patch" | "api.devices.release" | "api.deviceClaims.create" | "api.deviceClaims.status" | "api.deviceClaims.finalize" | "api.schedules.list" | "api.schedules.create" | "api.schedules.update" | "api.schedules.delete" | "api.schedules.retry" }>;
export type PendingRequests = Map<RegistrationRequest["type"], string>;
export type WifiFailureKind = "auth" | "network" | "other";
export type BleBlockReason = "permission" | "powered-off" | null;

export function bleBlockReason(state: BleAdapterState): BleBlockReason {
  if (state === "unauthorized") return "permission";
  if (state === "powered-off") return "powered-off";
  return null;
}

export function wifiFailureKind(code: string): WifiFailureKind {
  if (code === "WIFI_AUTH_FAILED") return "auth";
  if (code === "WIFI_NOT_FOUND") return "network";
  return "other";
}

const requestForResponse: Partial<Record<NativeToWebMessage["type"], RegistrationRequest["type"][]>> = {
  "ble.scanning": ["ble.scan", "ble.cancelScan"],
  "ble.deviceFound": ["ble.scan"],
  "ble.connecting": ["ble.connect"],
  "ble.connected": ["ble.connect"],
  "ble.disconnected": ["ble.disconnect"],
  "wifi.networks": ["wifi.scan"],
  "provision.progress": ["wifi.provision"],
  "device.bootstrapComplete": ["wifi.provision"],
};

export function isCurrentAttempt(active: string | null, received: string): boolean {
  return active !== null && active === received;
}

export function acceptsNativeResponse(message: NativeToWebMessage, active: string | null, pending: PendingRequests): boolean {
  // API responses use their own request lifecycle and never enter registration matching.
  if (message.type === "auth.state" || message.type === "api.devices.result" || message.type === "api.devices.state.accepted" || message.type === "api.devices.released" || message.type === "api.deviceClaims.created" || message.type === "api.deviceClaims.resumed" || message.type === "api.deviceClaims.status.result" || message.type === "api.deviceClaims.finalized" || message.type === "api.schedules.result" || message.type === "api.schedules.mutation.result") return false;
  // Startup/adapter events have no registration context. Scoped errors must match both IDs.
  if (!("attemptId" in message) && !("requestId" in message)) return true;
  if (!message.attemptId || !message.requestId || !isCurrentAttempt(active, message.attemptId)) return false;
  const requestType = message.type === "bridge.error"
    ? [...pending.entries()].find(([, requestId]) => requestId === message.requestId)?.[0]
    : (requestForResponse[message.type] ?? []).find((type) => pending.get(type) === message.requestId);
  if (!requestType) return false;

  const terminal = message.type === "bridge.error" ||
    message.type === "ble.connected" ||
    message.type === "ble.disconnected" ||
    message.type === "wifi.networks" ||
    message.type === "device.bootstrapComplete" ||
    (message.type === "provision.progress" && message.payload.stage === "wifi-connected") ||
    (message.type === "ble.scanning" && !message.payload.active) ||
    (message.type === "provision.progress" && (message.payload.stage === "failed" || message.payload.stage === "cancelled"));
  if (terminal) pending.delete(requestType);
  return true;
}
