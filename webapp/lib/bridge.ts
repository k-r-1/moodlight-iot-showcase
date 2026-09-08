import type { ApiDevice } from "./devices";
import type { DesiredDeviceState } from "./device-control";
import type { ApiSchedule, ScheduleOperation, ScheduleWritePayload } from "./schedules";
import type { BleAdapterState, NearbyDevice, ProvisioningStage, WifiNetwork } from "./types";

export type AuthState =
  | { status: "signed-out" | "loading"; message?: string }
  | { status: "signed-in"; tenantId: string; poolId: string; role: "OWNER" | "MEMBER" }
  | { status: "error"; message: string };
export type DeviceClaimStatus = "CLAIM_PENDING" | "BOOTSTRAPPED" | "PROVISIONING" | "RUNTIME_AUTHORIZED" | "ONLINE" | "FAILED" | "EXPIRED" | "REVOKED";
export type SafeDeviceClaim = { claimId: string; status: DeviceClaimStatus };
type RequestContext = { requestId: string; attemptId: string };

export type WebToNativeMessage =
  | { type: "bridge.ready" }
  | { type: "app.openSettings" }
  | { type: "auth.status"; requestId: string }
  | { type: "auth.login"; requestId: string }
  | { type: "auth.logout"; requestId: string }
  | { type: "api.devices.list"; requestId: string }
  | ({ type: "api.deviceClaims.create"; payload: { poolId: string; deviceId: string } } & RequestContext)
  | { type: "api.deviceClaims.resume"; requestId: string }
  | { type: "api.deviceClaims.status"; requestId: string; payload: { claimId: string } }
  | { type: "api.deviceClaims.finalize"; requestId: string; payload: { claimId: string } }
  | { type: "api.devices.state.patch"; requestId: string; payload: { deviceId: string; desired: DesiredDeviceState } }
  | { type: "api.devices.release"; requestId: string; payload: { deviceId: string } }
  | { type: "api.schedules.list"; requestId: string }
  | { type: "api.schedules.create"; requestId: string; payload: ScheduleWritePayload }
  | { type: "api.schedules.update"; requestId: string; payload: { scheduleId: string; expectedRevision: number; patch: Partial<ScheduleWritePayload> } }
  | { type: "api.schedules.delete"; requestId: string; payload: { scheduleId: string; expectedRevision: number } }
  | { type: "api.schedules.retry"; requestId: string; payload: { scheduleId: string; expectedRevision: number } }
  | ({ type: "ble.scan"; payload?: { timeoutMs?: number } } & RequestContext)
  | ({ type: "ble.cancelScan" } & RequestContext)
  | ({ type: "ble.connect"; payload: { deviceId: string } } & RequestContext)
  | ({ type: "ble.disconnect"; payload?: { deviceId?: string } } & RequestContext)
  | ({ type: "wifi.scan"; payload: { deviceId: string } } & RequestContext)
  | {
      type: "wifi.provision";
      requestId: string;
      attemptId: string;
      payload: {
        deviceId: string;
        ssid: string;
        password: string;
        secure: boolean;
      };
    };

export type NativeToWebMessage =
  | { type: "bridge.hello"; payload: { platform: "ios" | "android" | "web"; bleAvailable: boolean } }
  | {
      type: "bridge.snapshot";
      payload: {
        bleState: BleAdapterState;
        connectedDevice: NearbyDevice | null;
        activeAttemptId: string | null;
        stage: ProvisioningStage;
      };
    }
  | { type: "ble.state"; payload: { state: BleAdapterState } }
  | { type: "auth.state"; requestId?: string; payload: AuthState }
  | { type: "api.devices.result"; requestId: string; payload: { devices: ApiDevice[] } }
  | { type: "api.deviceClaims.created"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.deviceClaims.resumed"; requestId: string; payload: { claim: SafeDeviceClaim | null } }
  | { type: "api.deviceClaims.status.result"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.deviceClaims.finalized"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.devices.state.accepted"; requestId: string; payload: { deviceId: string; status: "ACCEPTED"; commandId: string } }
  | { type: "api.devices.released"; requestId: string; payload: { deviceId: string; lifecycleStatus: "REVOKED"; idempotent: boolean } }
  | { type: "api.schedules.result"; requestId: string; payload: { schedules: ApiSchedule[] } }
  | { type: "api.schedules.mutation.result"; requestId: string; payload: ({ operation: Exclude<ScheduleOperation, "delete">; schedule: ApiSchedule } | { operation: "delete"; scheduleId: string; deleted: true; revision: number }) }
  | ({ type: "ble.scanning"; payload: { active: boolean } } & RequestContext)
  | ({ type: "ble.deviceFound"; payload: NearbyDevice } & RequestContext)
  | ({ type: "ble.connecting"; payload: { deviceId: string } } & RequestContext)
  | ({ type: "ble.connected"; payload: { device: NearbyDevice } } & RequestContext)
  | ({ type: "ble.disconnected"; payload?: { deviceId?: string } } & RequestContext)
  | ({ type: "wifi.networks"; payload: { networks: WifiNetwork[] } } & RequestContext)
  | ({ type: "provision.progress"; payload: { stage: ProvisioningStage; message: string } } & RequestContext)
  | ({
      type: "device.bootstrapComplete";
      payload: { claimId: string; serial: string; thingName: string };
    } & RequestContext)
  | ({ type: "bridge.error"; payload: { code: string; message: string; retryable: boolean } } & Partial<RequestContext>);

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (data: string) => void };
    __moodlightBridge?: { dispatch: (message: NativeToWebMessage) => void };
  }
}

export function postToNative(message: WebToNativeMessage): boolean {
  if (typeof window === "undefined" || !window.ReactNativeWebView) return false;
  window.ReactNativeWebView.postMessage(JSON.stringify(message));
  return true;
}

export function isNativeApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.ReactNativeWebView);
}
