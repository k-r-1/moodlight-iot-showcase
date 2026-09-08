import { AppError, type AuthContext, type CreateClaimInput, type DesiredState } from "./domain.ts";
import { InMemoryRepository } from "./in-memory.ts";
import {
  NotConfiguredCommandPublisher,
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
} from "./ports.ts";
import { MoodlightService } from "./service.ts";
import type { CreateScheduleInput, Schedule, UpdateScheduleInput } from "./schedules.ts";

export interface ApiRequest {
  method: string;
  path: string;
  auth?: AuthContext;
  query?: Record<string, string | undefined>;
  body?: unknown;
}
export interface ApiResponse { statusCode: number; body: unknown }

export function createDefaultService(): MoodlightService {
  return new MoodlightService(
    new InMemoryRepository(),
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    new NotConfiguredCommandPublisher(),
    new NotConfiguredDeviceDecommissioner(),
  );
}

export interface HandlerOptions { now?: () => Date; onlineFreshnessMs?: number }

export function createHandler(service: MoodlightService = createDefaultService(), options: HandlerOptions = {}) {
  const now = options.now ?? (() => new Date());
  const onlineFreshnessMs = options.onlineFreshnessMs ?? 150_000;
  return async (request: ApiRequest): Promise<ApiResponse> => {
    try {
      if (typeof request.auth?.userId !== "string" || request.auth.userId.trim().length === 0) {
        throw new AppError("UNAUTHENTICATED", 401, "Verified user is required");
      }
      if (request.method === "POST" && request.path === "/session/bootstrap") {
        return success(200, await service.bootstrapTenant(request.auth));
      }
      if (request.method === "GET" && request.path === "/devices") {
        const tenantId = request.query?.tenantId;
        if (!tenantId) throw new AppError("INVALID_INPUT", 400, "tenantId query is required");
        return success(200, { devices: (await service.listDevices(request.auth, tenantId)).map((device) => deviceResponse(device, now(), onlineFreshnessMs)) });
      }
      if (request.method === "POST" && request.path === "/device-claims") {
        const input = objectBody(request.body) as unknown as CreateClaimInput;
        const result = await service.createClaim(request.auth, input);
        return success(201, {
          claimId: result.claim.claimId,
          status: result.claim.status,
          expiresAt: result.claim.expiresAt,
          registrationNonce: result.registrationNonce,
        });
      }
      if (request.method === "GET" && request.path === "/schedules") {
        const tenantId = request.query?.tenantId;
        if (!tenantId) throw new AppError("INVALID_INPUT", 400, "tenantId query is required");
        return success(200, { schedules: (await service.listSchedules(request.auth, tenantId)).map(scheduleResponse) });
      }
      if (request.method === "POST" && request.path === "/schedules") {
        const schedule = await service.createSchedule(request.auth, objectBody(request.body) as unknown as CreateScheduleInput);
        return success(201, scheduleResponse(schedule));
      }
      const scheduleMatch = /^\/schedules\/([^/]+)$/.exec(request.path);
      if (request.method === "GET" && scheduleMatch?.[1]) {
        const tenantId = request.query?.tenantId;
        if (!tenantId) throw new AppError("INVALID_INPUT", 400, "tenantId query is required");
        return success(200, scheduleResponse(await service.getSchedule(request.auth, tenantId, scheduleMatch[1])));
      }
      if (request.method === "PATCH" && scheduleMatch?.[1]) {
        const schedule = await service.updateSchedule(request.auth, scheduleMatch[1], objectBody(request.body) as unknown as UpdateScheduleInput);
        return success(200, scheduleResponse(schedule));
      }
      const scheduleAction = /^\/schedules\/([^/]+)\/(delete|retry|reconcile)$/.exec(request.path);
      if (request.method === "POST" && scheduleAction?.[1] && scheduleAction[2]) {
        const body = objectBody(request.body);
        const tenantId = body.tenantId as string;
        const expectedRevision = body.expectedRevision as number;
        if (scheduleAction[2] === "delete") {
          const result = await service.deleteSchedule(request.auth, tenantId, scheduleAction[1], expectedRevision);
          return success(200, { deleted: true, revision: result.revision });
        }
        const result = scheduleAction[2] === "retry"
          ? await service.retrySchedule(request.auth, tenantId, scheduleAction[1], expectedRevision)
          : await service.reconcileSchedule(request.auth, tenantId, scheduleAction[1], expectedRevision);
        return success(200, result ? scheduleResponse(result) : { deleted: true });
      }
      const claimMatch = /^\/device-claims\/([^/]+)$/.exec(request.path);
      if (request.method === "GET" && claimMatch?.[1]) {
        return success(200, claimResponse(await service.getClaim(request.auth, claimMatch[1])));
      }
      const finalizeMatch = /^\/device-claims\/([^/]+)\/finalize$/.exec(request.path);
      if (request.method === "POST" && finalizeMatch?.[1]) {
        const result = await service.finalizeClaim(request.auth, finalizeMatch[1]);
        return success(200, {
          claimId: result.claim.claimId,
          status: result.claim.status,
          deviceId: result.device.deviceId,
          lifecycleStatus: result.device.lifecycleStatus,
          idempotent: result.idempotent,
        });
      }
      const stateMatch = /^\/devices\/([^/]+)\/state$/.exec(request.path);
      if (request.method === "PATCH" && stateMatch?.[1]) {
        const body = objectBody(request.body);
        const desired = objectBody(body.desired) as DesiredState;
        return success(202, await service.requestState(request.auth, stateMatch[1], body.requestId as string, desired));
      }
      const releaseMatch = /^\/devices\/([^/]+)\/release$/.exec(request.path);
      if (request.method === "POST" && releaseMatch?.[1]) {
        const result = await service.releaseDevice(request.auth, releaseMatch[1]);
        return success(200, {
          deviceId: result.device.deviceId,
          lifecycleStatus: result.device.lifecycleStatus,
          idempotent: result.idempotent,
        });
      }
      throw new AppError("NOT_FOUND", 404, "Route not found");
    } catch (error) {
      if (error instanceof AppError) return { statusCode: error.status, body: { error: { code: error.code, message: error.message } } };
      return { statusCode: 500, body: { error: { code: "INTERNAL_ERROR", message: "Unexpected backend error" } } };
    }
  };
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("INVALID_INPUT", 400, "JSON object body is required");
  return body as Record<string, unknown>;
}

function success(statusCode: number, body: unknown): ApiResponse {
  return { statusCode, body };
}

function claimResponse(claim: { claimId: string; status: string; expiresAt: string; failureCode?: string; thingName?: string }) {
  return {
    claimId: claim.claimId,
    status: claim.status,
    expiresAt: claim.expiresAt,
    ...(claim.failureCode ? { failureCode: claim.failureCode } : {}),
    ...(claim.thingName ? { deviceId: claim.thingName } : {}),
  };
}

function deviceResponse(device: import("./domain.ts").Device, now: Date, onlineFreshnessMs: number) {
  const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : undefined;
  const age = lastSeen === undefined ? undefined : now.getTime() - lastSeen;
  return {
    deviceId: device.deviceId,
    tenantId: device.tenantId,
    poolId: device.poolId,
    name: device.name,
    lifecycleStatus: device.lifecycleStatus,
    online: age === undefined ? null : Number.isFinite(age) && age >= 0 && age <= onlineFreshnessMs,
    power: device.power,
    red: device.red,
    green: device.green,
    blue: device.blue,
    brightness: device.brightness,
    ...(device.desiredState && device.lastCommandId !== device.appliedCommandId
      ? { pendingDesired: device.desiredState }
      : {}),
    ...(device.lastCommandId ? { lastCommandId: device.lastCommandId } : {}),
    ...(device.appliedCommandId ? { appliedCommandId: device.appliedCommandId } : {}),
    ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
    version: device.version,
  };
}

function scheduleResponse(schedule: Schedule) {
  return {
    tenantId: schedule.tenantId,
    scheduleId: schedule.scheduleId,
    name: schedule.name,
    targetType: schedule.targetType,
    targetId: schedule.targetId,
    enabled: schedule.enabled,
    timezone: schedule.timezone,
    localTime: schedule.localTime,
    daysOfWeek: schedule.daysOfWeek,
    desiredState: schedule.desiredState,
    syncStatus: schedule.syncStatus,
    revision: schedule.revision,
    ...(schedule.schedulerName ? { schedulerName: schedule.schedulerName } : {}),
    ...(schedule.retryAt ? { retryAt: schedule.retryAt } : {}),
    ...(schedule.failureCode ? { failureCode: schedule.failureCode } : {}),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}
