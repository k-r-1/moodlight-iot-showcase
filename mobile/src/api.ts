import type { AcceptedDeviceCommand, ApiDevice, ApiSchedule, DesiredDeviceState, ScheduleOperation, ScheduleWritePayload } from "./protocol";

export type AuthenticatedApiSession = Readonly<{
  apiBaseUrl: string;
  accessToken: string;
  tenantId: string;
}>;

export type TenantBootstrap = Readonly<{ tenantId: string; poolId: string; role: "OWNER" | "MEMBER" }>;

export class ApiRequestError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly status: number) {
    super(message);
  }
}

export async function bootstrapApiSession(apiBaseUrl: string, accessToken: string): Promise<AuthenticatedApiSession & TenantBootstrap> {
  const url = publicApiUrl(apiBaseUrl);
  if (!accessToken) throw new Error("invalid-api-session");
  url.pathname = url.pathname.endsWith("/") ? url.pathname + "session/bootstrap" : url.pathname + "/session/bootstrap";
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { authorization: "Bearer " + accessToken, accept: "application/json", "content-type": "application/json" },
    body: "{}",
  });
  if (response.status !== 200) throw await apiRequestError(response, "session-bootstrap-request-failed");
  const value: unknown = await response.json();
  exactKeys(value, ["tenantId", "poolId", "role"], "invalid-session-bootstrap-response");
  if (value.role !== "OWNER" && value.role !== "MEMBER") throw new Error("invalid-session-bootstrap-response");
  return {
    apiBaseUrl,
    accessToken,
    tenantId: responseText(value.tenantId, 128, "invalid-session-bootstrap-response"),
    poolId: responseText(value.poolId, 128, "invalid-session-bootstrap-response"),
    role: value.role,
  };
}

export type ProductRegistration = Readonly<{ serial: string; registrationCode: string }>;
export type ClaimStatus = "CLAIM_PENDING" | "BOOTSTRAPPED" | "PROVISIONING" | "RUNTIME_AUTHORIZED" | "ONLINE" | "FAILED" | "EXPIRED" | "REVOKED";
export type CreatedDeviceClaim = Readonly<{
  claimId: string;
  status: "CLAIM_PENDING";
  expiresAt: string;
  registrationNonce: string;
}>;
export type DeviceClaimStatus = Readonly<{
  claimId: string;
  status: ClaimStatus;
  expiresAt: string;
  failureCode?: string;
  deviceId?: string;
}>;
export type FinalizedDeviceClaim = Readonly<{
  claimId: string;
  status: "RUNTIME_AUTHORIZED" | "ONLINE";
  deviceId: string;
  lifecycleStatus: "RUNTIME_AUTHORIZED" | "ACTIVE";
  idempotent: boolean;
}>;

export async function createDeviceClaim(
  session: AuthenticatedApiSession,
  poolId: string,
  registration: ProductRegistration,
): Promise<CreatedDeviceClaim> {
  const url = apiUrlFor(session);
  const normalizedPoolId = safeId(poolId, "pool-id");
  const serial = safeId(registration.serial, "serial");
  if (!registration.registrationCode || registration.registrationCode.length > 512) throw new Error("invalid-registration-code");
  url.pathname = url.pathname.replace(/\/$/, "") + "/device-claims";
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: apiHeaders(session, true),
    body: JSON.stringify({
      tenantId: session.tenantId,
      poolId: normalizedPoolId,
      serial,
      registrationCode: registration.registrationCode,
    }),
  });
  if (response.status !== 201) throw await apiRequestError(response, "claim-create-request-failed");
  return parseCreatedClaim(await response.json());
}

export async function getDeviceClaim(
  session: AuthenticatedApiSession,
  claimId: string,
): Promise<DeviceClaimStatus> {
  const url = claimUrl(session, claimId);
  const response = await fetch(url.toString(), { method: "GET", headers: apiHeaders(session) });
  if (response.status !== 200) throw await apiRequestError(response, "claim-status-request-failed");
  return parseClaimStatus(await response.json());
}

export async function finalizeDeviceClaim(
  session: AuthenticatedApiSession,
  claimId: string,
): Promise<FinalizedDeviceClaim> {
  const url = claimUrl(session, claimId);
  url.pathname += "/finalize";
  const response = await fetch(url.toString(), { method: "POST", headers: apiHeaders(session, true), body: "{}" });
  if (response.status !== 200) throw await apiRequestError(response, "claim-finalize-request-failed");
  return parseFinalizedClaim(await response.json());
}

export async function listDevices(session: AuthenticatedApiSession): Promise<ApiDevice[]> {
  const endpoint = deviceListEndpointFor(session);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { authorization: "Bearer " + session.accessToken, accept: "application/json" },
  });
  if (response.status !== 200) throw await apiRequestError(response, "device-list-request-failed");
  return parseDeviceList(await response.json());
}

export async function releaseDevice(
  session: AuthenticatedApiSession,
  deviceId: string,
): Promise<{ deviceId: string; lifecycleStatus: "REVOKED"; idempotent: boolean }> {
  const url = apiUrlFor(session);
  url.pathname = (url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname) + "/devices/" + encodeURIComponent(safeId(deviceId, "device-id")) + "/release";
  const response = await fetch(url.toString(), { method: "POST", headers: apiHeaders(session, true), body: "{}" });
  if (response.status !== 200) throw await apiRequestError(response, "device-release-request-failed");
  const value: unknown = await response.json();
  exactKeys(value, ["deviceId", "lifecycleStatus", "idempotent"], "invalid-device-release-response");
  if (value.deviceId !== deviceId || value.lifecycleStatus !== "REVOKED" || typeof value.idempotent !== "boolean") {
    throw new Error("invalid-device-release-response");
  }
  return { deviceId, lifecycleStatus: value.lifecycleStatus, idempotent: value.idempotent };
}

export async function patchDeviceState(
  session: AuthenticatedApiSession,
  deviceId: string,
  requestId: string,
  desired: DesiredDeviceState,
): Promise<AcceptedDeviceCommand> {
  const url = apiUrlFor(session);
  if (!deviceId.trim() || deviceId.length > 128) throw new Error("invalid-device-id");
  const normalizedRequestId = safeId(requestId, "request-id");
  url.pathname = url.pathname.replace(/\/$/, "") + "/devices/" + encodeURIComponent(deviceId) + "/state";
  const response = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      authorization: "Bearer " + session.accessToken,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId: normalizedRequestId, desired }),
  });
  if (response.status !== 202) throw await apiRequestError(response, "device-state-request-failed");
  return parseAcceptedCommand(await response.json());
}


export async function listSchedules(session: AuthenticatedApiSession): Promise<ApiSchedule[]> {
  const url = apiUrlFor(session);
  url.pathname = url.pathname.replace(/\/$/, "") + "/schedules";
  url.searchParams.set("tenantId", session.tenantId);
  const response = await fetch(url.toString(), { method: "GET", headers: apiHeaders(session) });
  if (response.status !== 200) throw await apiRequestError(response, "schedule-list-request-failed");
  const value: unknown = await response.json();
  if (!record(value) || !Array.isArray(value.schedules)) throw new Error("invalid-schedule-list-response");
  return value.schedules.map((item) => parseSchedule(item, session.tenantId));
}
export async function createSchedule(session: AuthenticatedApiSession, payload: ScheduleWritePayload): Promise<ApiSchedule> {
  const url = scheduleBaseUrl(session);
  const response = await fetch(url.toString(), { method: "POST", headers: apiHeaders(session, true), body: JSON.stringify({ tenantId: session.tenantId, ...payload }) });
  if (response.status !== 201) throw await apiRequestError(response, "schedule-create-request-failed");
  return parseSchedule(await response.json(), session.tenantId);
}
export async function updateSchedule(session: AuthenticatedApiSession, scheduleId: string, expectedRevision: number, patch: Partial<ScheduleWritePayload>): Promise<ApiSchedule> {
  const url = scheduleItemUrl(session, scheduleId);
  const response = await fetch(url.toString(), { method: "PATCH", headers: apiHeaders(session, true), body: JSON.stringify({ tenantId: session.tenantId, expectedRevision, ...patch }) });
  if (response.status !== 200) throw await apiRequestError(response, "schedule-update-request-failed");
  return parseSchedule(await response.json(), session.tenantId);
}
export async function scheduleAction(session: AuthenticatedApiSession, operation: Extract<ScheduleOperation, "delete" | "retry">, scheduleId: string, expectedRevision: number): Promise<ApiSchedule | { deleted: true; revision: number }> {
  const url = scheduleItemUrl(session, scheduleId);
  url.pathname += "/" + operation;
  const response = await fetch(url.toString(), { method: "POST", headers: apiHeaders(session, true), body: JSON.stringify({ tenantId: session.tenantId, expectedRevision }) });
  if (response.status !== 200) throw await apiRequestError(response, "schedule-action-request-failed");
  const value: unknown = await response.json();
  if (operation === "delete") {
    exactKeys(value, ["deleted", "revision"], "invalid-schedule-delete-response");
    if (value.deleted !== true) throw new Error("invalid-schedule-delete-response");
    return { deleted: true, revision: integer(value.revision, 1, Number.MAX_SAFE_INTEGER) };
  }
  return parseSchedule(value, session.tenantId);
}
function scheduleBaseUrl(session: AuthenticatedApiSession): URL {
  const url = apiUrlFor(session);
  url.pathname = url.pathname.replace(/\/$/, "") + "/schedules";
  return url;
}
function scheduleItemUrl(session: AuthenticatedApiSession, scheduleId: string): URL {
  const url = scheduleBaseUrl(session);
  url.pathname += "/" + encodeURIComponent(safeId(scheduleId, "schedule-id"));
  return url;
}
function parseSchedule(value: unknown, tenantId: string): ApiSchedule {
  const allowed = ["tenantId", "scheduleId", "name", "targetType", "targetId", "enabled", "timezone", "localTime", "daysOfWeek", "desiredState", "syncStatus", "revision", "schedulerName", "retryAt", "failureCode", "createdAt", "updatedAt"];
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)) || value.tenantId !== tenantId) throw new Error("invalid-schedule-response");
  if (value.targetType !== "DEVICE" || typeof value.enabled !== "boolean") throw new Error("invalid-schedule-response");
  const syncStatus = value.syncStatus;
  if (syncStatus !== "PENDING_SYNC" && syncStatus !== "ACTIVE" && syncStatus !== "ERROR" && syncStatus !== "DELETE_PENDING") throw new Error("invalid-schedule-response");
  if (!Array.isArray(value.daysOfWeek) || value.daysOfWeek.length === 0) throw new Error("invalid-schedule-response");
  const daysOfWeek = [...new Set(value.daysOfWeek.map((day) => integer(day, 0, 6)))].sort((a, b) => a - b);
  const desiredState = parseDesiredState(value.desiredState);
  const result: ApiSchedule = {
    scheduleId: text(value.scheduleId, 128), name: text(value.name, 100), targetType: "DEVICE", targetId: text(value.targetId, 128),
    enabled: value.enabled, timezone: text(value.timezone, 64), localTime: text(value.localTime, 5), daysOfWeek, desiredState, syncStatus,
    revision: integer(value.revision, 1, Number.MAX_SAFE_INTEGER),
    createdAt: isoDate(value.createdAt, "invalid-schedule-response"), updatedAt: isoDate(value.updatedAt, "invalid-schedule-response"),
  };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result.localTime)) throw new Error("invalid-schedule-response");
  try { new Intl.DateTimeFormat("en", { timeZone: result.timezone }).format(); } catch { throw new Error("invalid-schedule-response"); }
  if (value.retryAt !== undefined) result.retryAt = isoDate(value.retryAt, "invalid-schedule-response");
  if (value.failureCode !== undefined) result.failureCode = text(value.failureCode, 128);
  return result;
}
function parseDesiredState(value: unknown): DesiredDeviceState {
  if (!record(value)) throw new Error("invalid-schedule-response");
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["power", "red", "green", "blue", "brightness"].includes(key))) throw new Error("invalid-schedule-response");
  const desired: DesiredDeviceState = {};
  if (value.power !== undefined) desired.power = bool(value.power);
  for (const [key, max] of [["red", 255], ["green", 255], ["blue", 255], ["brightness", 100]] as const) if (value[key] !== undefined) desired[key] = integer(value[key], 0, max);
  return desired;
}

async function apiRequestError(response: Response, fallbackCode: string): Promise<ApiRequestError> {
  let code = fallbackCode;
  let message = "서버 요청을 완료하지 못했어요.";
  try {
    const body: unknown = await response.json();
    if (record(body) && record(body.error)) {
      if (typeof body.error.code === "string" && body.error.code.length <= 128) code = body.error.code;
      if (typeof body.error.message === "string" && body.error.message.length <= 512) message = body.error.message;
    }
  } catch {
    // An invalid error body is still represented by the local fallback.
  }
  const retryable = code !== "NOT_CONFIGURED" && (response.status >= 500 || code === "PROVISIONING_PENDING");
  return new ApiRequestError(code, message, retryable, response.status);
}

function claimUrl(session: AuthenticatedApiSession, claimId: string): URL {
  const url = apiUrlFor(session);
  url.pathname = url.pathname.replace(/\/$/, "") + "/device-claims/" + encodeURIComponent(safeId(claimId, "claim-id"));
  return url;
}

function apiHeaders(session: AuthenticatedApiSession, json = false): Record<string, string> {
  return {
    authorization: "Bearer " + session.accessToken,
    accept: "application/json",
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function safeId(value: string, name: string): string {
  if (!value || value.trim() !== value || value.length > 128) throw new Error(`invalid-${name}`);
  return value;
}

function deviceListEndpointFor(session: AuthenticatedApiSession): string {
  const url = apiUrlFor(session);
  url.pathname = url.pathname.replace(/\/$/, "") + "/devices";
  url.searchParams.set("tenantId", session.tenantId);
  return url.toString();
}

function apiUrlFor(session: AuthenticatedApiSession): URL {
  if (!session.accessToken || !/^[A-Za-z0-9_-]+$/.test(session.tenantId)) throw new Error("invalid-api-session");
  const url = new URL(session.apiBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid-api-session");
  return url;
}

function publicApiUrl(apiBaseUrl: string): URL {
  const url = new URL(apiBaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid-api-session");
  return url;
}

function parseCreatedClaim(value: unknown): CreatedDeviceClaim {
  exactKeys(value, ["claimId", "status", "expiresAt", "registrationNonce"], "invalid-claim-create-response");
  if (value.status !== "CLAIM_PENDING") throw new Error("invalid-claim-create-response");
  return {
    claimId: responseText(value.claimId, 128, "invalid-claim-create-response"),
    status: value.status,
    expiresAt: isoDate(value.expiresAt, "invalid-claim-create-response"),
    registrationNonce: responseText(value.registrationNonce, 512, "invalid-claim-create-response"),
  };
}

function parseClaimStatus(value: unknown): DeviceClaimStatus {
  exactKeys(value, ["claimId", "status", "expiresAt", "failureCode", "deviceId"], "invalid-claim-status-response");
  const status = claimStatus(value.status, "invalid-claim-status-response");
  return {
    claimId: responseText(value.claimId, 128, "invalid-claim-status-response"),
    status,
    expiresAt: isoDate(value.expiresAt, "invalid-claim-status-response"),
    ...(value.failureCode === undefined ? {} : { failureCode: responseText(value.failureCode, 128, "invalid-claim-status-response") }),
    ...(value.deviceId === undefined ? {} : { deviceId: responseText(value.deviceId, 128, "invalid-claim-status-response") }),
  };
}

function parseFinalizedClaim(value: unknown): FinalizedDeviceClaim {
  exactKeys(value, ["claimId", "status", "deviceId", "lifecycleStatus", "idempotent"], "invalid-claim-finalize-response");
  let status: FinalizedDeviceClaim["status"];
  let lifecycleStatus: FinalizedDeviceClaim["lifecycleStatus"];
  if (value.status === "RUNTIME_AUTHORIZED" && value.lifecycleStatus === "RUNTIME_AUTHORIZED") {
    status = value.status;
    lifecycleStatus = value.lifecycleStatus;
  } else if (value.status === "ONLINE" && value.lifecycleStatus === "ACTIVE") {
    status = value.status;
    lifecycleStatus = value.lifecycleStatus;
  } else {
    throw new Error("invalid-claim-finalize-response");
  }
  if (typeof value.idempotent !== "boolean") throw new Error("invalid-claim-finalize-response");
  return {
    claimId: responseText(value.claimId, 128, "invalid-claim-finalize-response"),
    status,
    deviceId: responseText(value.deviceId, 128, "invalid-claim-finalize-response"),
    lifecycleStatus,
    idempotent: value.idempotent,
  };
}

function exactKeys(value: unknown, allowed: string[], code: string): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(code);
}

function responseText(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(code);
  return value;
}

function isoDate(value: unknown, code: string): string {
  const result = responseText(value, 64, code);
  if (Number.isNaN(Date.parse(result))) throw new Error(code);
  return result;
}

function claimStatus(value: unknown, code: string): ClaimStatus {
  const statuses: ClaimStatus[] = ["CLAIM_PENDING", "BOOTSTRAPPED", "PROVISIONING", "RUNTIME_AUTHORIZED", "ONLINE", "FAILED", "EXPIRED", "REVOKED"];
  if (!statuses.includes(value as ClaimStatus)) throw new Error(code);
  return value as ClaimStatus;
}

function parseAcceptedCommand(value: unknown): AcceptedDeviceCommand {
  if (!record(value) || Object.keys(value).some((key) => key !== "status" && key !== "commandId")) {
    throw new Error("invalid-device-state-response");
  }
  if (value.status !== "ACCEPTED") throw new Error("invalid-device-state-response");
  try {
    return { status: value.status, commandId: text(value.commandId, 128) };
  } catch {
    throw new Error("invalid-device-state-response");
  }
}

function parseDeviceList(value: unknown): ApiDevice[] {
  if (!record(value) || !Array.isArray(value.devices)) throw new Error("invalid-device-list-response");
  return value.devices.map(parseDevice);
}

function parseDevice(value: unknown): ApiDevice {
  if (!record(value)) throw new Error("invalid-device");
  const lifecycleStatus = value.lifecycleStatus;
  if (lifecycleStatus !== "RUNTIME_AUTHORIZED" && lifecycleStatus !== "ACTIVE" && lifecycleStatus !== "REVOKED") throw new Error("invalid-device");
  const device: ApiDevice = {
    deviceId: text(value.deviceId, 128), tenantId: text(value.tenantId, 128), poolId: text(value.poolId, 128),
    name: text(value.name, 256), lifecycleStatus, power: bool(value.power), red: integer(value.red, 0, 255),
    green: integer(value.green, 0, 255), blue: integer(value.blue, 0, 255), brightness: integer(value.brightness, 0, 100),
    version: integer(value.version, 0, Number.MAX_SAFE_INTEGER),
  };
  if (value.online !== undefined) device.online = bool(value.online);
  if (value.pendingDesired !== undefined) device.pendingDesired = parseCompleteDeviceState(value.pendingDesired);
  if (value.lastCommandId !== undefined) device.lastCommandId = text(value.lastCommandId, 128);
  if (value.appliedCommandId !== undefined) device.appliedCommandId = text(value.appliedCommandId, 128);
  if (value.lastSeenAt !== undefined) {
    const lastSeenAt = text(value.lastSeenAt, 64);
    if (Number.isNaN(Date.parse(lastSeenAt))) throw new Error("invalid-device");
    device.lastSeenAt = lastSeenAt;
  }
  return device;
}

function parseCompleteDeviceState(value: unknown): { power: boolean; red: number; green: number; blue: number; brightness: number } {
  if (!record(value) || Object.keys(value).some((key) => !["power", "red", "green", "blue", "brightness"].includes(key))) {
    throw new Error("invalid-device");
  }
  return {
    power: bool(value.power),
    red: integer(value.red, 0, 255),
    green: integer(value.green, 0, 255),
    blue: integer(value.blue, 0, 255),
    brightness: integer(value.brightness, 0, 100),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("invalid-device");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("invalid-device");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid-device");
  return value as number;
}
