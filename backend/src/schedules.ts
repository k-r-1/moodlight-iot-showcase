import { AppError, type DesiredState, type Device } from "./domain.ts";

export type ScheduleSyncStatus = "PENDING_SYNC" | "ACTIVE" | "DELETE_PENDING" | "ERROR";
export type ScheduleOperation = "UPSERT" | "DELETE";

export interface Schedule {
  tenantId: string;
  scheduleId: string;
  ownerId: string;
  name: string;
  targetType: "DEVICE";
  targetId: string;
  targetCertificateId: string;
  enabled: boolean;
  timezone: string;
  localTime: string;
  daysOfWeek: number[];
  desiredState: DesiredState;
  syncStatus: ScheduleSyncStatus;
  pendingOperation: ScheduleOperation;
  revision: number;
  schedulerName?: string;
  retryAt?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduleInput {
  tenantId: string;
  name: string;
  targetType: "DEVICE";
  targetId: string;
  enabled: boolean;
  timezone: string;
  localTime: string;
  daysOfWeek: number[];
  desiredState: DesiredState;
}

export interface UpdateScheduleInput extends Partial<Omit<CreateScheduleInput, "tenantId">> {
  tenantId: string;
  expectedRevision: number;
}

export interface ScheduleExecutionInput {
  tenantId: string;
  scheduleId: string;
  revision: number;
  scheduledTime?: string;
}

export type ScheduleExecutionResult =
  | { status: "PUBLISHED"; commandId: string }
  | { status: "SKIPPED"; reason: "NOT_FOUND" | "STALE_REVISION" | "NOT_ACTIVE" | "DISABLED" | "MEMBERSHIP_INACTIVE" | "DEVICE_INACTIVE" | "TARGET_GENERATION_CHANGED" | "STALE_DELIVERY" };

export interface ScheduleRepository {
  listSchedules(tenantId: string): Promise<Schedule[]>;
  listSchedulesDue(now: string, limit: number): Promise<Schedule[]>;
  getSchedule(tenantId: string, scheduleId: string): Promise<Schedule | undefined>;
  saveSchedule(schedule: Schedule, expectedRevision?: number): Promise<void>;
  markScheduleActive(tenantId: string, scheduleId: string, revision: number, schedulerName: string): Promise<Schedule | undefined>;
  markSchedulePending(tenantId: string, scheduleId: string, revision: number, operation: ScheduleOperation): Promise<Schedule | undefined>;
  markScheduleError(tenantId: string, scheduleId: string, revision: number, failureCode: string, retryAt: string): Promise<Schedule | undefined>;
  deleteSchedule(tenantId: string, scheduleId: string, revision: number): Promise<boolean>;
}

export interface SchedulerPort {
  /** Implementations must be idempotent per revision and put only execution identity fields in the target payload. */
  upsert(schedule: Schedule): Promise<{ schedulerName: string }>;
  remove(schedule: Schedule): Promise<void>;
}

export class NotConfiguredScheduleRepository implements ScheduleRepository {
  private unavailable(): never { throw new AppError("NOT_CONFIGURED", 503, "Schedule repository is not configured"); }
  async listSchedules(_tenantId: string): Promise<Schedule[]> { return this.unavailable(); }
  async listSchedulesDue(_now: string, _limit: number): Promise<Schedule[]> { return this.unavailable(); }
  async getSchedule(_tenantId: string, _scheduleId: string): Promise<Schedule | undefined> { return this.unavailable(); }
  async saveSchedule(_schedule: Schedule, _expectedRevision?: number): Promise<void> { this.unavailable(); }
  async markScheduleActive(_tenantId: string, _scheduleId: string, _revision: number, _schedulerName: string): Promise<Schedule | undefined> { return this.unavailable(); }
  async markSchedulePending(_tenantId: string, _scheduleId: string, _revision: number, _operation: ScheduleOperation): Promise<Schedule | undefined> { return this.unavailable(); }
  async markScheduleError(_tenantId: string, _scheduleId: string, _revision: number, _failureCode: string, _retryAt: string): Promise<Schedule | undefined> { return this.unavailable(); }
  async deleteSchedule(_tenantId: string, _scheduleId: string, _revision: number): Promise<boolean> { return this.unavailable(); }
}

export class NotConfiguredScheduler implements SchedulerPort {
  async upsert(_schedule: Schedule): Promise<{ schedulerName: string }> {
    throw new AppError("NOT_CONFIGURED", 503, "EventBridge Scheduler is not configured");
  }
  async remove(_schedule: Schedule): Promise<void> {
    throw new AppError("NOT_CONFIGURED", 503, "EventBridge Scheduler is not configured");
  }
}

export class InMemoryScheduleRepository implements ScheduleRepository {
  private readonly schedules = new Map<string, Schedule>();

  async listSchedules(tenantId: string): Promise<Schedule[]> {
    return [...this.schedules.values()].filter((item) => item.tenantId === tenantId).map(copy);
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<Schedule | undefined> {
    const item = this.schedules.get(key(tenantId, scheduleId));
    return item ? copy(item) : undefined;
  }

  async listSchedulesDue(now: string, limit: number): Promise<Schedule[]> {
    return [...this.schedules.values()]
      .filter((item) => item.syncStatus === "PENDING_SYNC" || item.syncStatus === "DELETE_PENDING"
        || (item.syncStatus === "ERROR" && (!item.retryAt || item.retryAt <= now)))
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit)
      .map(copy);
  }

  async saveSchedule(schedule: Schedule, expectedRevision?: number): Promise<void> {
    const itemKey = key(schedule.tenantId, schedule.scheduleId);
    const current = this.schedules.get(itemKey);
    if (expectedRevision === undefined ? current !== undefined : current?.revision !== expectedRevision) {
      throw new AppError("SCHEDULE_CONFLICT", 409, "Schedule changed while it was being updated");
    }
    this.schedules.set(itemKey, copy(schedule));
  }

  async markScheduleActive(tenantId: string, scheduleId: string, revision: number, schedulerName: string): Promise<Schedule | undefined> {
    const current = this.schedules.get(key(tenantId, scheduleId));
    if (!current || current.revision !== revision || current.syncStatus !== "PENDING_SYNC" || current.pendingOperation !== "UPSERT") return undefined;
    current.syncStatus = "ACTIVE";
    current.schedulerName = schedulerName;
    delete current.retryAt;
    delete current.failureCode;
    return copy(current);
  }

  async markSchedulePending(tenantId: string, scheduleId: string, revision: number, operation: ScheduleOperation): Promise<Schedule | undefined> {
    const current = this.schedules.get(key(tenantId, scheduleId));
    if (!current || current.revision !== revision || current.syncStatus !== "ERROR" || current.pendingOperation !== operation) return undefined;
    current.syncStatus = current.pendingOperation === "DELETE" ? "DELETE_PENDING" : "PENDING_SYNC";
    delete current.retryAt;
    delete current.failureCode;
    return copy(current);
  }

  async markScheduleError(tenantId: string, scheduleId: string, revision: number, failureCode: string, retryAt: string): Promise<Schedule | undefined> {
    const current = this.schedules.get(key(tenantId, scheduleId));
    if (!current || current.revision !== revision || (current.syncStatus !== "PENDING_SYNC" && current.syncStatus !== "DELETE_PENDING")) return undefined;
    current.syncStatus = "ERROR";
    current.failureCode = failureCode;
    current.retryAt = retryAt;
    return copy(current);
  }

  async deleteSchedule(tenantId: string, scheduleId: string, revision: number): Promise<boolean> {
    const itemKey = key(tenantId, scheduleId);
    const current = this.schedules.get(itemKey);
    if (!current || current.revision !== revision || current.syncStatus !== "DELETE_PENDING" || current.pendingOperation !== "DELETE") return false;
    return this.schedules.delete(itemKey);
  }
}

export function scheduleDevice(device: Device | undefined, ownerId: string, tenantId: string): Device {
  if (!device || device.ownerId !== ownerId || device.tenantId !== tenantId) {
    throw new AppError("DEVICE_NOT_FOUND", 404, "Device not found");
  }
  if (device.lifecycleStatus !== "ACTIVE") throw new AppError("DEVICE_NOT_READY", 409, "Device has not reported its first runtime state");
  return device;
}

const copy = <T>(value: T): T => structuredClone(value);
const key = (tenantId: string, scheduleId: string): string => `${tenantId}\u0000${scheduleId}`;
