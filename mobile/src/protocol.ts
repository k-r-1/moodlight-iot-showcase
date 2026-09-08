export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_BRIDGE_MESSAGE_BYTES = 16 * 1024;

export type BleAdapterState =
  | "unknown"
  | "unsupported"
  | "unauthorized"
  | "powered-off"
  | "powered-on";

export type ProvisioningStage =
  | "idle"
  | "scanning"
  | "connecting"
  | "wifi"
  | "secure-session"
  | "wifi-connected"
  | "fleet-provisioned"
  | "bootstrapped"
  | "provisioning"
  | "complete"
  | "failed"
  | "cancelled";

export type NearbyDevice = {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: string[];
  model?: string;
  serial?: string;
  protocolVersion?: string;
  provisioningState?: "unregistered" | "bootstrapped" | "registered";
};

export type WifiNetwork = { ssid: string; rssi: number; secure: boolean };
export type ApiDevice = {
  deviceId: string; tenantId: string; poolId: string; name: string;
  lifecycleStatus: "RUNTIME_AUTHORIZED" | "ACTIVE" | "REVOKED";
  power: boolean; red: number; green: number; blue: number; brightness: number;
  pendingDesired?: { power: boolean; red: number; green: number; blue: number; brightness: number };
  lastCommandId?: string;
  appliedCommandId?: string;
  lastSeenAt?: string; online?: boolean; version: number;
};
export type DesiredDeviceState = {
  power?: boolean;
  red?: number;
  green?: number;
  blue?: number;
  brightness?: number;
};
export type AcceptedDeviceCommand = { status: "ACCEPTED"; commandId: string };
export type DeviceClaimStatus = "CLAIM_PENDING" | "BOOTSTRAPPED" | "PROVISIONING" | "RUNTIME_AUTHORIZED" | "ONLINE" | "FAILED" | "EXPIRED" | "REVOKED";
export type SafeDeviceClaim = { claimId: string; status: DeviceClaimStatus };
export type ScheduleSyncStatus = "PENDING_SYNC" | "ACTIVE" | "ERROR" | "DELETE_PENDING";
export type ScheduleOperation = "create" | "update" | "delete" | "retry";
export type ApiSchedule = {
  scheduleId: string;
  name: string;
  targetType: "DEVICE";
  targetId: string;
  enabled: boolean;
  timezone: string;
  localTime: string;
  daysOfWeek: number[];
  desiredState: DesiredDeviceState;
  syncStatus: ScheduleSyncStatus;
  revision: number;
  retryAt?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
};
export type ScheduleWritePayload = {
  name: string;
  targetType: "DEVICE";
  targetId: string;
  enabled: boolean;
  timezone: string;
  localTime: string;
  daysOfWeek: number[];
  desiredState: DesiredDeviceState;
};
export type AuthState =
  | { status: "signed-out" | "loading"; message?: string }
  | { status: "signed-in"; tenantId: string; poolId: string; role: "OWNER" | "MEMBER" }
  | { status: "error"; message: string };
type RequestContext = { requestId: string; attemptId: string };

export type WebToNativeMessage =
  | { type: "bridge.ready" }
  | { type: "app.openSettings" }
  | { type: "auth.status"; requestId: string }
  | { type: "auth.login"; requestId: string }
  | { type: "auth.logout"; requestId: string }
  | { type: "api.devices.list"; requestId: string }
  | { type: "api.devices.state.patch"; requestId: string; payload: { deviceId: string; desired: DesiredDeviceState } }
  | { type: "api.devices.release"; requestId: string; payload: { deviceId: string } }
  | ({ type: "api.deviceClaims.create"; payload: { poolId: string; deviceId: string } } & RequestContext)
  | { type: "api.deviceClaims.resume"; requestId: string }
  | { type: "api.deviceClaims.status"; requestId: string; payload: { claimId: string } }
  | { type: "api.deviceClaims.finalize"; requestId: string; payload: { claimId: string } }
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
  | ({
      type: "wifi.provision";
      payload: {
        deviceId: string;
        ssid: string;
        password: string;
        secure: boolean;

      };
    } & RequestContext);

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
  | { type: "api.devices.state.accepted"; requestId: string; payload: AcceptedDeviceCommand & { deviceId: string } }
  | { type: "api.devices.released"; requestId: string; payload: { deviceId: string; lifecycleStatus: "REVOKED"; idempotent: boolean } }
  | { type: "api.deviceClaims.created"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.deviceClaims.resumed"; requestId: string; payload: { claim: SafeDeviceClaim | null } }
  | { type: "api.deviceClaims.status.result"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.deviceClaims.finalized"; requestId: string; payload: SafeDeviceClaim }
  | { type: "api.schedules.result"; requestId: string; payload: { schedules: ApiSchedule[] } }
  | { type: "api.schedules.mutation.result"; requestId: string; payload: ({ operation: Exclude<ScheduleOperation, "delete">; schedule: ApiSchedule } | { operation: "delete"; scheduleId: string; deleted: true; revision: number }) }
  | ({ type: "ble.scanning"; payload: { active: boolean } } & RequestContext)
  | ({ type: "ble.deviceFound"; payload: NearbyDevice } & RequestContext)
  | ({ type: "ble.connecting"; payload: { deviceId: string } } & RequestContext)
  | ({ type: "ble.connected"; payload: { device: NearbyDevice } } & RequestContext)
  | ({ type: "ble.disconnected"; payload?: { deviceId?: string } } & RequestContext)
  | ({ type: "wifi.networks"; payload: { networks: WifiNetwork[] } } & RequestContext)
  | ({ type: "provision.progress"; payload: { stage: ProvisioningStage; message: string } } & RequestContext)
  | ({ type: "device.bootstrapComplete"; payload: { claimId: string; serial: string; thingName: string } } & RequestContext)
  | ({ type: "bridge.error"; payload: { code: string; message: string; retryable: boolean } } & Partial<RequestContext>);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return unescape(encodeURIComponent(value)).length;
}

function stringField(record: UnknownRecord, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`invalid-${key}`);
  }
  return value;
}

function context(record: UnknownRecord): RequestContext {
  return {
    requestId: stringField(record, "requestId", 128),
    attemptId: stringField(record, "attemptId", 128),
  };
}

export function parseWebMessage(raw: string): WebToNativeMessage {
  if (utf8ByteLength(raw) > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new Error("message-too-large");
  }
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error("message-not-object");
  const type = stringField(value, "type", 64);

  if (type === "bridge.ready" || type === "app.openSettings") {
    exactObjectKeys(value, ["type"]);
    return { type };
  }
  if (type === "auth.status" || type === "auth.login" || type === "auth.logout") {
    exactObjectKeys(value, ["type", "requestId"]);
    return { type, requestId: stringField(value, "requestId", 128) };
  }
  if (type === "api.devices.list") {
    if (value.payload !== undefined || Object.keys(value).some((key) => key !== "type" && key !== "requestId")) throw new Error("invalid-payload");
    return { type, requestId: stringField(value, "requestId", 128) };
  }
  if (type === "api.devices.release") {
    exactObjectKeys(value, ["type", "requestId", "payload"]);
    if (!isRecord(value.payload)) throw new Error("invalid-payload");
    exactObjectKeys(value.payload, ["deviceId"]);
    return { type, requestId: stringField(value, "requestId", 128), payload: { deviceId: stringField(value.payload, "deviceId", 128) } };
  }
  if (type === "api.devices.state.patch") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "requestId" && key !== "payload")) throw new Error("invalid-payload");
    if (!isRecord(value.payload) || Object.keys(value.payload).some((key) => key !== "deviceId" && key !== "desired")) throw new Error("invalid-payload");
    const desiredValue = value.payload.desired;
    if (!isRecord(desiredValue)) throw new Error("invalid-state");
    const keys = Object.keys(desiredValue);
    const allowed = ["power", "red", "green", "blue", "brightness"];
    if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) throw new Error("invalid-state");
    const desired: DesiredDeviceState = {};
    if (Object.hasOwn(desiredValue, "power")) {
      if (typeof desiredValue.power !== "boolean") throw new Error("invalid-power");
      desired.power = desiredValue.power;
    }
    for (const [key, max] of [["red", 255], ["green", 255], ["blue", 255], ["brightness", 100]] as const) {
      if (!Object.hasOwn(desiredValue, key)) continue;
      const item = desiredValue[key];
      if (!Number.isInteger(item) || (item as number) < 0 || (item as number) > max) throw new Error(`invalid-${key}`);
      desired[key] = item as number;
    }
    return {
      type,
      requestId: stringField(value, "requestId", 128),
      payload: { deviceId: stringField(value.payload, "deviceId", 128), desired },
    };
  }
  if (type === "api.schedules.list") {
    exactObjectKeys(value, ["type", "requestId"]);
    return { type, requestId: stringField(value, "requestId", 128) };
  }
  if (type === "api.schedules.create") {
    exactObjectKeys(value, ["type", "requestId", "payload"]);
    return { type, requestId: stringField(value, "requestId", 128), payload: scheduleWrite(value.payload, false) as ScheduleWritePayload };
  }
  if (type === "api.schedules.update") {
    exactObjectKeys(value, ["type", "requestId", "payload"]);
    if (!isRecord(value.payload)) throw new Error("invalid-payload");
    exactObjectKeys(value.payload, ["scheduleId", "expectedRevision", "patch"]);
    const revision = boundedInteger(value.payload.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "expectedRevision");
    const patch = scheduleWrite(value.payload.patch, true);
    if (Object.keys(patch).length === 0) throw new Error("invalid-payload");
    return { type, requestId: stringField(value, "requestId", 128), payload: { scheduleId: stringField(value.payload, "scheduleId", 128), expectedRevision: revision, patch } };
  }
  if (type === "api.schedules.delete" || type === "api.schedules.retry") {
    exactObjectKeys(value, ["type", "requestId", "payload"]);
    if (!isRecord(value.payload)) throw new Error("invalid-payload");
    exactObjectKeys(value.payload, ["scheduleId", "expectedRevision"]);
    return { type, requestId: stringField(value, "requestId", 128), payload: { scheduleId: stringField(value.payload, "scheduleId", 128), expectedRevision: boundedInteger(value.payload.expectedRevision, 1, Number.MAX_SAFE_INTEGER, "expectedRevision") } };
  }
  if (type === "api.deviceClaims.resume") {
    if (Object.keys(value).some((key) => key !== "type" && key !== "requestId")) throw new Error("invalid-payload");
    return { type, requestId: stringField(value, "requestId", 128) };
  }
  if (type === "api.deviceClaims.create") {
    exactObjectKeys(value, ["type", "requestId", "attemptId", "payload"]);
    if (!isRecord(value.payload)) throw new Error("invalid-payload");
    exactObjectKeys(value.payload, ["poolId", "deviceId"]);
    return {
      type,
      ...context(value),
      payload: {
        poolId: stringField(value.payload, "poolId", 128),
        deviceId: stringField(value.payload, "deviceId", 256),
      },
    };
  }
  if (type === "api.deviceClaims.status" || type === "api.deviceClaims.finalize") {
    exactObjectKeys(value, ["type", "requestId", "payload"]);
    if (!isRecord(value.payload)) throw new Error("invalid-payload");
    exactObjectKeys(value.payload, ["claimId"]);
    return { type, requestId: stringField(value, "requestId", 128), payload: { claimId: stringField(value.payload, "claimId", 128) } };
  }
  const ctx = context(value);
  const payload = value.payload;

  switch (type) {
    case "ble.scan": {
      if (payload !== undefined && !isRecord(payload)) throw new Error("invalid-payload");
      const timeout = isRecord(payload) ? payload.timeoutMs : undefined;
      if (timeout !== undefined && (typeof timeout !== "number" || timeout < 1_000 || timeout > 60_000)) {
        throw new Error("invalid-timeout");
      }
      return { type, ...ctx, payload: timeout === undefined ? undefined : { timeoutMs: timeout } };
    }
    case "ble.cancelScan":
      return { type, ...ctx };
    case "ble.connect": {
      if (!isRecord(payload)) throw new Error("invalid-payload");
      return { type, ...ctx, payload: { deviceId: stringField(payload, "deviceId", 256) } };
    }
    case "ble.disconnect": {
      if (payload === undefined) return { type, ...ctx };
      if (!isRecord(payload)) throw new Error("invalid-payload");
      const deviceId = payload.deviceId;
      if (deviceId !== undefined && (typeof deviceId !== "string" || deviceId.length > 256)) {
        throw new Error("invalid-deviceId");
      }
      return { type, ...ctx, payload: deviceId ? { deviceId } : undefined };
    }
    case "wifi.scan": {
      if (!isRecord(payload)) throw new Error("invalid-payload");
      return { type, ...ctx, payload: { deviceId: stringField(payload, "deviceId", 256) } };
    }
    case "wifi.provision": {
      if (!isRecord(payload)) throw new Error("invalid-payload");
      // Legacy fields are accepted for the existing Web build, validated, then discarded.
      // Product registration always uses the Native-held server Claim in App.tsx.
      const allowed = ["deviceId", "ssid", "password", "secure", "claimId", "registrationNonce"];
      if (Object.keys(payload).some((key) => !allowed.includes(key))) throw new Error("invalid-payload");
      if (payload.claimId !== undefined) stringField(payload, "claimId", 128);
      if (payload.registrationNonce !== undefined) stringField(payload, "registrationNonce", 512);
      const password = payload.password;
      const secure = payload.secure;
      if (typeof password !== "string" || password.length > 256) throw new Error("invalid-password");
      if (typeof secure !== "boolean") throw new Error("invalid-secure");
      if (secure && password.length === 0) throw new Error("invalid-password");
      return {
        type,
        ...ctx,
        payload: {
          deviceId: stringField(payload, "deviceId", 256),
          ssid: stringField(payload, "ssid", 128),
          password,
          secure,
        },
      };
    }
    default:
      throw new Error("unsupported-message-type");
  }
}


function exactObjectKeys(value: UnknownRecord, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || Object.keys(value).length !== allowed.length) throw new Error("invalid-payload");
}
function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid-" + name);
  return value as number;
}
function scheduleWrite(value: unknown, partial: boolean): Partial<ScheduleWritePayload> {
  if (!isRecord(value)) throw new Error("invalid-payload");
  const allowed = ["name", "targetType", "targetId", "enabled", "timezone", "localTime", "daysOfWeek", "desiredState"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("invalid-payload");
  if (!partial && Object.keys(value).length !== allowed.length) throw new Error("invalid-payload");
  const result: Partial<ScheduleWritePayload> = {};
  if (value.name !== undefined) result.name = stringField(value, "name", 100);
  if (value.targetType !== undefined) { if (value.targetType !== "DEVICE") throw new Error("invalid-targetType"); result.targetType = "DEVICE"; }
  if (value.targetId !== undefined) result.targetId = stringField(value, "targetId", 128);
  if (value.enabled !== undefined) { if (typeof value.enabled !== "boolean") throw new Error("invalid-enabled"); result.enabled = value.enabled; }
  if (value.timezone !== undefined) {
    const timezone = stringField(value, "timezone", 64);
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { throw new Error("invalid-timezone"); }
    result.timezone = timezone;
  }
  if (value.localTime !== undefined) {
    const localTime = stringField(value, "localTime", 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new Error("invalid-localTime");
    result.localTime = localTime;
  }
  if (value.daysOfWeek !== undefined) {
    if (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.length === 0) throw new Error("invalid-daysOfWeek");
    result.daysOfWeek = [...new Set(value.daysOfWeek.map((day) => boundedInteger(day, 0, 6, "daysOfWeek")))].sort((a, b) => a - b);
  }
  if (value.desiredState !== undefined) result.desiredState = scheduleDesiredState(value.desiredState);
  return result;
}
function scheduleDesiredState(value: unknown): DesiredDeviceState {
  if (!isRecord(value)) throw new Error("invalid-state");
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["power", "red", "green", "blue", "brightness"].includes(key))) throw new Error("invalid-state");
  const desired: DesiredDeviceState = {};
  if (value.power !== undefined) { if (typeof value.power !== "boolean") throw new Error("invalid-power"); desired.power = value.power; }
  for (const [key, max] of [["red", 255], ["green", 255], ["blue", 255], ["brightness", 100]] as const) if (value[key] !== undefined) desired[key] = boundedInteger(value[key], 0, max, key);
  return desired;
}
