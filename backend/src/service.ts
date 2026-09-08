import { createHash, randomUUID } from "node:crypto";
import { registrationNonceFor } from "./claim-secrets.ts";
import { AppError, type AuthContext, type CreateClaimInput, type DesiredState, type Device, type DeviceClaim, type TenantContext } from "./domain.ts";
import type { ClaimRegistrar, CommandPublisher, DeviceDecommissioner, ProvisioningPort, Repository } from "./ports.ts";
import { canonicalSerial } from "./serial.ts";
import {
  NotConfiguredScheduleRepository,
  NotConfiguredScheduler,
  scheduleDevice,
  type CreateScheduleInput,
  type Schedule,
  type ScheduleExecutionInput,
  type ScheduleExecutionResult,
  type ScheduleOperation,
  type ScheduleRepository,
  type SchedulerPort,
  type UpdateScheduleInput,
} from "./schedules.ts";

export interface ServiceOptions {
  now?: () => Date;
  id?: () => string;
  claimTtlMs?: number;
  finalizeLeaseMs?: number;
  scheduleRepository?: ScheduleRepository;
  scheduler?: SchedulerPort;
}

const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const maxScheduleDeliveryDelayMs = 90_000;

export class MoodlightService {
  private readonly repository: Repository;
  private readonly claimRegistrar: ClaimRegistrar;
  private readonly provisioning: ProvisioningPort;
  private readonly commands: CommandPublisher;
  private readonly decommissioner: DeviceDecommissioner;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly claimTtlMs: number;
  private readonly finalizeLeaseMs: number;
  private readonly schedules: ScheduleRepository;
  private readonly scheduler: SchedulerPort;
  private readonly schedulesConfigured: boolean;

  constructor(
    repository: Repository,
    claimRegistrar: ClaimRegistrar,
    provisioning: ProvisioningPort,
    commands: CommandPublisher,
    decommissioner: DeviceDecommissioner,
    options: ServiceOptions = {},
  ) {
    this.repository = repository;
    this.claimRegistrar = claimRegistrar;
    this.provisioning = provisioning;
    this.commands = commands;
    this.decommissioner = decommissioner;
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.claimTtlMs = options.claimTtlMs ?? 15 * 60_000;
    this.finalizeLeaseMs = options.finalizeLeaseMs ?? 2 * 60_000;
    this.schedules = options.scheduleRepository ?? new NotConfiguredScheduleRepository();
    this.scheduler = options.scheduler ?? new NotConfiguredScheduler();
    this.schedulesConfigured = options.scheduleRepository !== undefined;
  }

  async bootstrapTenant(auth: AuthContext): Promise<TenantContext> {
    const userId = verifiedUserId(auth);
    return this.repository.bootstrapPersonalTenant({
      userId,
      tenantId: `personal-${hash(userId).slice(0, 32)}`,
      poolId: "default",
      tenantName: "내 집",
      poolName: "기본 공간",
      now: this.now().toISOString(),
    });
  }

  async listDevices(auth: AuthContext, tenantId: string): Promise<Device[]> {
    await this.requireMembership(auth, tenantId);
    return (await this.repository.listDevices(tenantId))
      .filter((device) => device.lifecycleStatus === "ACTIVE");
  }

  async createClaim(auth: AuthContext, input: CreateClaimInput): Promise<{ claim: DeviceClaim; registrationNonce: string }> {
    const tenantId = requiredId(input.tenantId, "tenantId");
    const poolId = requiredId(input.poolId, "poolId");
    const serial = canonicalSerial(input.serial);
    if (typeof input.registrationCode !== "string" || input.registrationCode.length === 0 || input.registrationCode.length > 512) {
      throw new AppError("INVALID_REGISTRATION_CODE", 400, "registrationCode is required");
    }
    await this.requireMembership(auth, tenantId);
    if (!await this.repository.hasPool(tenantId, poolId)) {
      throw new AppError("POOL_NOT_FOUND", 404, "Pool not found in Tenant");
    }
    const now = this.now();
    const claimId = this.id();
    const registrationNonce = registrationNonceFor({ ownerId: auth.userId, tenantId, poolId, serial }, input.registrationCode);
    const claim: DeviceClaim = {
      claimId,
      ownerId: auth.userId,
      tenantId,
      poolId,
      serial,
      serialHash: hash(serial),
      registrationNonceHash: hash(registrationNonce),
      status: "CLAIM_PENDING",
      expiresAt: new Date(now.getTime() + this.claimTtlMs).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const registeredClaim = await this.claimRegistrar.createClaim(claim, input.registrationCode);
    return { claim: registeredClaim, registrationNonce };
  }

  async getClaim(auth: AuthContext, claimId: string): Promise<DeviceClaim> {
    const claim = await this.ownedClaim(auth, claimId);
    if (claim.status === "CLAIM_PENDING" && isExpired(claim, this.now())) {
      return this.repository.expireClaim(claim.claimId, this.now().toISOString());
    }
    return claim;
  }

  async finalizeClaim(auth: AuthContext, claimId: string): Promise<{ claim: DeviceClaim; device: Device; idempotent: boolean }> {
    const claim = await this.ownedClaim(auth, claimId);
    if (claim.status === "RUNTIME_AUTHORIZED" || claim.status === "ONLINE") {
      const device = claim.thingName ? await this.repository.getDevice(claim.thingName) : undefined;
      if (!device
        || device.ownerId !== claim.ownerId
        || device.tenantId !== claim.tenantId
        || device.serial !== claim.serial) {
        throw new AppError("CLAIM_INCONSISTENT", 409, "Finalized claim has no matching device");
      }
      return { claim, device, idempotent: true };
    }
    if (claim.status === "CLAIM_PENDING" && isExpired(claim, this.now())) {
      await this.repository.expireClaim(claim.claimId, this.now().toISOString());
      throw new AppError("CLAIM_EXPIRED", 410, "Claim has expired");
    }
    if (claim.status !== "CLAIM_PENDING" && claim.status !== "BOOTSTRAPPED" && claim.status !== "PROVISIONING") {
      throw new AppError("INVALID_CLAIM_STATE", 409, `Cannot finalize claim in ${claim.status}`);
    }
    const leaseId = this.id();
    const leaseStart = this.now();
    const lease = await this.repository.acquireFinalizeLease(
      claim.claimId,
      leaseId,
      leaseStart.toISOString(),
      new Date(leaseStart.getTime() + this.finalizeLeaseMs).toISOString(),
    );
    if (!lease.acquired) {
      const device = lease.claim.thingName ? await this.repository.getDevice(lease.claim.thingName) : undefined;
      if (!device
        || device.ownerId !== lease.claim.ownerId
        || device.tenantId !== lease.claim.tenantId
        || device.serial !== lease.claim.serial) {
        throw new AppError("CLAIM_INCONSISTENT", 409, "Finalized claim has no matching device");
      }
      return { claim: lease.claim, device, idempotent: true };
    }
    let bootstrapped = false;
    try {
      const binding = await this.provisioning.verifyBootstrap(lease.claim);
      const staged = await this.repository.bootstrapClaim(claim.claimId, binding, leaseId, this.now().toISOString());
      bootstrapped = true;
      await this.provisioning.authorizeRuntime(staged.claim, binding);
      const result = await this.repository.authorizeRuntimeClaim(claim.claimId, binding, this.now().toISOString());
      return { ...result, idempotent: false };
    } catch (error) {
      if (!bootstrapped) await this.repository.releaseFinalizeLease(claim.claimId, leaseId, this.now().toISOString());
      throw error;
    }
  }

  async requestState(auth: AuthContext, deviceId: string, requestIdValue: string, desired: DesiredState): Promise<{ status: "ACCEPTED"; commandId: string }> {
    const requestId = requiredId(requestIdValue, "requestId");
    validateDesiredState(desired);
    const device = await this.repository.getDevice(deviceId);
    if (!device || device.ownerId !== auth.userId) throw new AppError("DEVICE_NOT_FOUND", 404, "Device not found");
    await this.requireMembership(auth, device.tenantId);
    if (device.lifecycleStatus !== "ACTIVE") throw new AppError("DEVICE_NOT_READY", 409, "Device has not reported its first runtime state");
    const reservation = await this.repository.reserveCommand(device, requestId, this.id(), desired);
    await this.commands.publish(device, reservation.commandId, reservation.commandSequence, reservation.desiredState);
    return { status: "ACCEPTED", commandId: reservation.commandId };
  }

  async releaseDevice(auth: AuthContext, deviceId: string): Promise<{ device: Device; idempotent: boolean }> {
    const normalizedDeviceId = requiredId(deviceId, "deviceId");
    const device = await this.repository.getDevice(normalizedDeviceId);
    if (!device || device.ownerId !== auth.userId) throw new AppError("DEVICE_NOT_FOUND", 404, "Device not found");
    await this.requireMembership(auth, device.tenantId);
    if (device.lifecycleStatus === "REVOKED") {
      await this.cleanupReleasedDeviceSchedules(device);
      return { device, idempotent: true };
    }
    if (device.lifecycleStatus !== "RUNTIME_AUTHORIZED" && device.lifecycleStatus !== "ACTIVE") {
      throw new AppError("DEVICE_NOT_READY", 409, "Device runtime authorization is incomplete");
    }

    const confirmation = await this.decommissioner.decommission(device);
    if (confirmation.thingName !== device.thingName
      || confirmation.certificateId !== device.certificateId
      || confirmation.certificateDisabled !== true
      || confirmation.policiesDetached !== true
      || confirmation.thingDeleted !== true) {
      throw new AppError("DECOMMISSION_NOT_CONFIRMED", 502, "Device credentials were not fully decommissioned");
    }
    const result = await this.repository.revokeDeviceAndReleaseSerial(device, hash(device.serial), this.now().toISOString());
    await this.cleanupReleasedDeviceSchedules(result.device);
    return result;
  }

  async listSchedules(auth: AuthContext, tenantIdValue: string): Promise<Schedule[]> {
    const tenantId = requiredId(tenantIdValue, "tenantId");
    await this.requireMembership(auth, tenantId);
    return this.schedules.listSchedules(tenantId);
  }

  async getSchedule(auth: AuthContext, tenantIdValue: string, scheduleIdValue: string): Promise<Schedule> {
    const tenantId = requiredId(tenantIdValue, "tenantId");
    const scheduleId = requiredId(scheduleIdValue, "scheduleId");
    await this.requireMembership(auth, tenantId);
    const schedule = await this.schedules.getSchedule(tenantId, scheduleId);
    if (!schedule) throw new AppError("SCHEDULE_NOT_FOUND", 404, "Schedule not found");
    return schedule;
  }

  async createSchedule(auth: AuthContext, input: CreateScheduleInput): Promise<Schedule> {
    const tenantId = requiredId(input.tenantId, "tenantId");
    await this.requireMembership(auth, tenantId);
    const normalized = normalizeScheduleInput(input);
    const target = scheduleDevice(await this.repository.getDevice(normalized.targetId), auth.userId, tenantId);
    const now = this.now().toISOString();
    const schedule: Schedule = {
      tenantId,
      scheduleId: this.id(),
      ownerId: auth.userId,
      ...normalized,
      targetCertificateId: target.certificateId,
      syncStatus: "PENDING_SYNC",
      pendingOperation: "UPSERT",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.schedules.saveSchedule(schedule);
    const synced = await this.syncSchedule(schedule);
    if (!synced) throw new AppError("INTERNAL_ERROR", 500, "Schedule disappeared during synchronization");
    return synced;
  }

  async updateSchedule(auth: AuthContext, scheduleIdValue: string, input: UpdateScheduleInput): Promise<Schedule> {
    const current = await this.ownedSchedule(auth, input.tenantId, scheduleIdValue);
    requireRevision(input.expectedRevision, current.revision);
    const normalized = normalizeScheduleInput({ ...current, ...input });
    const target = scheduleDevice(await this.repository.getDevice(normalized.targetId), auth.userId, current.tenantId);
    const next: Schedule = {
      ...current,
      ...normalized,
      targetCertificateId: target.certificateId,
      syncStatus: "PENDING_SYNC",
      pendingOperation: "UPSERT",
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    delete next.retryAt;
    delete next.failureCode;
    await this.schedules.saveSchedule(next, current.revision);
    const synced = await this.syncSchedule(next);
    if (!synced) throw new AppError("INTERNAL_ERROR", 500, "Schedule disappeared during synchronization");
    return synced;
  }

  async deleteSchedule(auth: AuthContext, tenantIdValue: string, scheduleIdValue: string, expectedRevision: number): Promise<{ revision: number }> {
    const current = await this.ownedSchedule(auth, tenantIdValue, scheduleIdValue);
    requireRevision(expectedRevision, current.revision);
    const pending: Schedule = {
      ...current,
      syncStatus: "DELETE_PENDING",
      pendingOperation: "DELETE",
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    delete pending.retryAt;
    delete pending.failureCode;
    await this.schedules.saveSchedule(pending, current.revision);
    await this.syncSchedule(pending);
    return { revision: pending.revision };
  }

  async retrySchedule(auth: AuthContext, tenantIdValue: string, scheduleIdValue: string, expectedRevision: number): Promise<Schedule | undefined> {
    const current = await this.ownedSchedule(auth, tenantIdValue, scheduleIdValue);
    if (current.syncStatus !== "ERROR") throw new AppError("INVALID_SCHEDULE_STATE", 409, "Only a failed Schedule can be retried");
    requireRevision(expectedRevision, current.revision);
    return this.redriveSchedule(current);
  }

  async reconcileSchedule(auth: AuthContext, tenantIdValue: string, scheduleIdValue: string, expectedRevision: number): Promise<Schedule | undefined> {
    const current = await this.ownedSchedule(auth, tenantIdValue, scheduleIdValue);
    requireRevision(expectedRevision, current.revision);
    if (current.syncStatus === "PENDING_SYNC" || current.syncStatus === "DELETE_PENDING") {
      return this.syncSchedule(current);
    }
    if (current.syncStatus === "ERROR") return this.redriveSchedule(current);
    return this.resyncSchedule(current);
  }

  /** Internal retry entry point for a trusted Lambda event; no user identity is accepted here. */
  async reconcilePendingSchedule(input: ScheduleExecutionInput): Promise<Schedule | undefined> {
    const tenantId = requiredId(input.tenantId, "tenantId");
    const scheduleId = requiredId(input.scheduleId, "scheduleId");
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new AppError("INVALID_INPUT", 400, "revision is invalid");
    const current = await this.schedules.getSchedule(tenantId, scheduleId);
    if (!current || current.revision !== input.revision) return current;
    if (current.syncStatus === "PENDING_SYNC" || current.syncStatus === "DELETE_PENDING") return this.syncSchedule(current);
    if (current.syncStatus === "ERROR") return this.redriveSchedule(current);
    return current;
  }

  async reconcileDueSchedules(limit = 100): Promise<{ attempted: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError("INVALID_INPUT", 400, "limit is invalid");
    const due = await this.schedules.listSchedulesDue(this.now().toISOString(), limit);
    let failed = 0;
    for (const schedule of due) {
      try {
        await this.reconcilePendingSchedule(schedule);
      } catch {
        failed += 1;
      }
    }
    return { attempted: due.length, failed };
  }

  async completeScheduleSync(tenantId: string, scheduleId: string, revision: number, schedulerName: string): Promise<boolean> {
    return (await this.schedules.markScheduleActive(tenantId, scheduleId, revision, schedulerName)) !== undefined;
  }

  async completeScheduleDelete(tenantId: string, scheduleId: string, revision: number): Promise<boolean> {
    return this.schedules.deleteSchedule(tenantId, scheduleId, revision);
  }

  async failScheduleSync(tenantId: string, scheduleId: string, revision: number, failureCode: string): Promise<boolean> {
    const retryAt = new Date(this.now().getTime() + 60_000).toISOString();
    return (await this.schedules.markScheduleError(tenantId, scheduleId, revision, failureCode, retryAt)) !== undefined;
  }

  async executeSchedule(input: ScheduleExecutionInput): Promise<ScheduleExecutionResult> {
    const tenantId = requiredId(input.tenantId, "tenantId");
    const scheduleId = requiredId(input.scheduleId, "scheduleId");
    if (!Number.isInteger(input.revision) || input.revision < 1) {
      throw new AppError("INVALID_INPUT", 400, "revision is invalid");
    }
    const schedule = await this.schedules.getSchedule(tenantId, scheduleId);
    if (!schedule) return { status: "SKIPPED", reason: "NOT_FOUND" };
    if (schedule.revision !== input.revision) return { status: "SKIPPED", reason: "STALE_REVISION" };
    if (schedule.syncStatus !== "ACTIVE" || schedule.pendingOperation !== "UPSERT") {
      return { status: "SKIPPED", reason: "NOT_ACTIVE" };
    }
    if (!schedule.enabled) return { status: "SKIPPED", reason: "DISABLED" };
    if (!(await this.repository.hasMembership(schedule.ownerId, tenantId))) {
      return { status: "SKIPPED", reason: "MEMBERSHIP_INACTIVE" };
    }
    const device = await this.repository.getDevice(schedule.targetId);
    if (!device || device.lifecycleStatus !== "ACTIVE"
      || device.ownerId !== schedule.ownerId || device.tenantId !== tenantId) {
      return { status: "SKIPPED", reason: "DEVICE_INACTIVE" };
    }
    if (device.certificateId !== schedule.targetCertificateId) {
      return { status: "SKIPPED", reason: "TARGET_GENERATION_CHANGED" };
    }
    const scheduledTime = input.scheduledTime;
    if (scheduledTime !== undefined && !Number.isFinite(Date.parse(scheduledTime))) {
      throw new AppError("INVALID_INPUT", 400, "scheduledTime is invalid");
    }
    if (scheduledTime !== undefined && this.now().getTime() - Date.parse(scheduledTime) > maxScheduleDeliveryDelayMs) {
      return { status: "SKIPPED", reason: "STALE_DELIVERY" };
    }
    const generatedCommandId = this.id();
    const reservation = scheduledTime
      ? await this.repository.reserveCommand(
        device,
        "schedule-" + hash([schedule.scheduleId, schedule.revision, scheduledTime].join("\0")),
        generatedCommandId,
        schedule.desiredState,
      )
      : await this.repository.reserveCommand(device, "schedule-" + hash([schedule.scheduleId, schedule.revision, generatedCommandId].join("\0")), generatedCommandId, schedule.desiredState);
    await this.commands.publish(device, reservation.commandId, reservation.commandSequence, reservation.desiredState);
    return { status: "PUBLISHED", commandId: reservation.commandId };
  }

  private async redriveSchedule(current: Schedule): Promise<Schedule | undefined> {
    const pending = await this.schedules.markSchedulePending(
      current.tenantId,
      current.scheduleId,
      current.revision,
      current.pendingOperation,
    );
    if (!pending) throw new AppError("SCHEDULE_CONFLICT", 409, "Schedule changed while it was retried");
    return this.syncSchedule(pending);
  }

  private async resyncSchedule(current: Schedule): Promise<Schedule | undefined> {
    const operation: ScheduleOperation = current.pendingOperation === "DELETE" ? "DELETE" : "UPSERT";
    const pending: Schedule = {
      ...current,
      syncStatus: operation === "DELETE" ? "DELETE_PENDING" : "PENDING_SYNC",
      pendingOperation: operation,
      revision: current.revision + 1,
      updatedAt: this.now().toISOString(),
    };
    delete pending.retryAt;
    delete pending.failureCode;
    await this.schedules.saveSchedule(pending, current.revision);
    return this.syncSchedule(pending);
  }

  private async cleanupReleasedDeviceSchedules(device: Device): Promise<void> {
    if (!this.schedulesConfigured) return;
    const matches = (await this.schedules.listSchedules(device.tenantId))
      .filter((schedule) => schedule.targetId === device.deviceId
        && schedule.targetCertificateId === device.certificateId);
    const pending: Schedule[] = [];
    for (const schedule of matches) {
      if (schedule.syncStatus === "DELETE_PENDING") {
        pending.push(schedule);
        continue;
      }
      if (schedule.syncStatus === "ERROR" && schedule.pendingOperation === "DELETE") {
        const redrive = await this.schedules.markSchedulePending(
          schedule.tenantId,
          schedule.scheduleId,
          schedule.revision,
          "DELETE",
        );
        if (redrive) pending.push(redrive);
        continue;
      }
      const deletion: Schedule = {
        ...schedule,
        syncStatus: "DELETE_PENDING",
        pendingOperation: "DELETE",
        revision: schedule.revision + 1,
        updatedAt: this.now().toISOString(),
      };
      delete deletion.retryAt;
      delete deletion.failureCode;
      await this.schedules.saveSchedule(deletion, schedule.revision);
      pending.push(deletion);
    }

    let failure: unknown;
    for (const schedule of pending) {
      try {
        await this.syncSchedule(schedule);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  }

  private async syncSchedule(schedule: Schedule): Promise<Schedule | undefined> {
    try {
      if (schedule.pendingOperation === "DELETE") {
        await this.scheduler.remove(schedule);
      } else {
        const receipt = await this.scheduler.upsert(schedule);
        const active = await this.schedules.markScheduleActive(schedule.tenantId, schedule.scheduleId, schedule.revision, receipt.schedulerName);
        if (!active) return this.convergeLatestSchedule(schedule);
        return active;
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "SCHEDULE_CONFLICT") throw error;
      const failureCode = error instanceof AppError ? error.code : "SCHEDULER_SYNC_FAILED";
      await this.failScheduleSync(schedule.tenantId, schedule.scheduleId, schedule.revision, failureCode);
      throw error;
    }
    if (!(await this.schedules.deleteSchedule(schedule.tenantId, schedule.scheduleId, schedule.revision))) {
      return this.convergeLatestSchedule(schedule);
    }
    return undefined;
  }

  private async convergeLatestSchedule(stale: Schedule): Promise<Schedule | undefined> {
    const latest = await this.schedules.getSchedule(stale.tenantId, stale.scheduleId);
    if (!latest || latest.revision <= stale.revision) throw new AppError("SCHEDULE_CONFLICT", 409, "Schedule synchronization lost its revision");
    if (latest.syncStatus === "PENDING_SYNC" || latest.syncStatus === "DELETE_PENDING") return this.syncSchedule(latest);
    if (latest.syncStatus === "ERROR") return this.redriveSchedule(latest);
    await this.scheduler.upsert(latest);
    return latest;
  }

  private async ownedSchedule(auth: AuthContext, tenantIdValue: string, scheduleIdValue: string): Promise<Schedule> {
    const tenantId = requiredId(tenantIdValue, "tenantId");
    const scheduleId = requiredId(scheduleIdValue, "scheduleId");
    await this.requireMembership(auth, tenantId);
    const schedule = await this.schedules.getSchedule(tenantId, scheduleId);
    if (!schedule || schedule.ownerId !== auth.userId) throw new AppError("SCHEDULE_NOT_FOUND", 404, "Schedule not found");
    return schedule;
  }

  private async ownedClaim(auth: AuthContext, claimId: string): Promise<DeviceClaim> {
    const claim = await this.repository.getClaim(claimId);
    if (!claim || claim.ownerId !== auth.userId) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    await this.requireMembership(auth, claim.tenantId);
    return claim;
  }

  private async requireMembership(auth: AuthContext, tenantId: string): Promise<void> {
    if (!auth.userId) throw new AppError("UNAUTHENTICATED", 401, "Verified user is required");
    if (!(await this.repository.hasMembership(auth.userId, tenantId))) {
      throw new AppError("FORBIDDEN", 403, "Tenant membership is required");
    }
  }
}

function requiredId(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new AppError("INVALID_INPUT", 400, `${name} is invalid`);
  }
  return normalized;
}

function isExpired(claim: DeviceClaim, now: Date): boolean {
  return Date.parse(claim.expiresAt) <= now.getTime();
}


function validateDesiredState(value: DesiredState): void {
  const entries = Object.entries(value);
  if (entries.length === 0) throw new AppError("INVALID_STATE", 400, "At least one state field is required");
  const allowed = new Set(["power", "red", "green", "blue", "brightness"]);
  for (const [key, item] of entries) {
    if (!allowed.has(key)) throw new AppError("INVALID_STATE", 400, `Unknown state field: ${key}`);
    if (key === "power" ? typeof item !== "boolean" : !Number.isInteger(item)) {
      throw new AppError("INVALID_STATE", 400, `${key} has an invalid type`);
    }
    if (["red", "green", "blue"].includes(key) && ((item as number) < 0 || (item as number) > 255)) {
      throw new AppError("INVALID_STATE", 400, `${key} is outside 0..255`);
    }
    if (key === "brightness" && ((item as number) < 0 || (item as number) > 100)) {
      throw new AppError("INVALID_STATE", 400, "brightness is outside 0..100");
    }
  }
}

function normalizeScheduleInput(input: CreateScheduleInput): Omit<CreateScheduleInput, "tenantId"> {
  const targetId = requiredId(input.targetId, "targetId");
  if (input.targetType !== "DEVICE") throw new AppError("INVALID_SCHEDULE", 400, "Only DEVICE schedules are supported");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 100) throw new AppError("INVALID_SCHEDULE", 400, "name is invalid");
  if (typeof input.enabled !== "boolean") throw new AppError("INVALID_SCHEDULE", 400, "enabled must be a boolean");
  const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "";
  try {
    if (!timezone || timezone.length > 64) throw new RangeError();
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new AppError("INVALID_SCHEDULE", 400, "timezone must be a valid IANA timezone");
  }
  const localTime = typeof input.localTime === "string" ? input.localTime : "";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(localTime)) throw new AppError("INVALID_SCHEDULE", 400, "localTime must be HH:mm");
  if (!Array.isArray(input.daysOfWeek) || input.daysOfWeek.length === 0
    || input.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    throw new AppError("INVALID_SCHEDULE", 400, "daysOfWeek must contain weekdays 0..6");
  }
  const daysOfWeek = [...new Set(input.daysOfWeek)].sort((left, right) => left - right);
  if (!input.desiredState || typeof input.desiredState !== "object" || Array.isArray(input.desiredState)) {
    throw new AppError("INVALID_STATE", 400, "desiredState must be an object");
  }
  const desiredState = structuredClone(input.desiredState);
  validateDesiredState(desiredState);
  return { name, targetType: "DEVICE", targetId, enabled: input.enabled, timezone, localTime, daysOfWeek, desiredState };
}

function requireRevision(value: unknown, current: number): void {
  if (!Number.isInteger(value) || value !== current) {
    throw new AppError("SCHEDULE_CONFLICT", 409, "Schedule changed while it was being updated");
  }
}

function verifiedUserId(auth: AuthContext): string {
  const userId = typeof auth.userId === "string" ? auth.userId.trim() : "";
  if (!userId || userId.length > 256) throw new AppError("UNAUTHENTICATED", 401, "Verified user is required");
  return userId;
}
