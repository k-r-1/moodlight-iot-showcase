import { desiredFromDraft, type DesiredDeviceState } from "./device-control.ts";
import type { DeviceState } from "./types.ts";

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
  desiredState: Partial<DesiredDeviceState>;
  syncStatus: ScheduleSyncStatus;
  revision: number;
  retryAt?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleDraft = {
  name: string;
  targetId: string;
  enabled: boolean;
  timezone: string;
  localTime: string;
  daysOfWeek: number[];
  power: boolean;
  color: string;
  brightness: number;
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

export type PendingScheduleMutation = {
  requestId: string;
  operation: ScheduleOperation;
  scheduleId: string | null;
  expectedRevision?: number;
};

export const weekdays = ["일", "월", "화", "수", "목", "금", "토"] as const;

export function newScheduleDraft(device?: DeviceState): ScheduleDraft {
  return {
    name: "조명 예약",
    targetId: device?.id ?? "",
    enabled: true,
    timezone: "Asia/Seoul",
    localTime: "23:00",
    daysOfWeek: [1, 2, 3, 4, 5],
    power: true,
    color: device?.color ?? "#ff9f68",
    brightness: device?.brightness ?? 50,
  };
}

export function scheduleWritePayload(draft: ScheduleDraft): ScheduleWritePayload {
  const name = draft.name.trim();
  const timezone = draft.timezone.trim();
  if (!name || name.length > 100 || !/^[A-Za-z0-9_-]+$/.test(draft.targetId)) throw new Error("invalid-schedule-draft");
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(draft.localTime) || draft.daysOfWeek.length === 0) throw new Error("invalid-schedule-draft");
  try {
    if (!timezone || timezone.length > 64) throw new RangeError();
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch {
    throw new Error("invalid-schedule-draft");
  }
  const daysOfWeek = [...new Set(draft.daysOfWeek)].sort((left, right) => left - right);
  if (daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error("invalid-schedule-draft");
  return {
    name,
    targetType: "DEVICE",
    targetId: draft.targetId,
    enabled: draft.enabled,
    timezone,
    localTime: draft.localTime,
    daysOfWeek,
    desiredState: desiredFromDraft({ power: draft.power, color: draft.color, brightness: draft.brightness }),
  };
}

export function parseScheduleList(value: unknown): ApiSchedule[] {
  if (!record(value) || !Array.isArray(value.schedules)) throw new Error("invalid-schedule-list");
  return value.schedules.map(parseSchedule);
}

export function parseSchedule(value: unknown): ApiSchedule {
  if (!record(value)) throw new Error("invalid-schedule");
  const syncStatus = value.syncStatus;
  if (syncStatus !== "PENDING_SYNC" && syncStatus !== "ACTIVE" && syncStatus !== "ERROR" && syncStatus !== "DELETE_PENDING") throw new Error("invalid-schedule");
  if (value.targetType !== "DEVICE") throw new Error("invalid-schedule");
  const daysOfWeek = integerArray(value.daysOfWeek, 0, 6);
  if (daysOfWeek.length === 0) throw new Error("invalid-schedule");
  const schedule: ApiSchedule = {
    scheduleId: text(value.scheduleId, 128),
    name: text(value.name, 100),
    targetType: "DEVICE",
    targetId: text(value.targetId, 128),
    enabled: bool(value.enabled),
    timezone: timezone(value.timezone),
    localTime: localTime(value.localTime),
    daysOfWeek,
    desiredState: desired(value.desiredState),
    syncStatus,
    revision: integer(value.revision, 1, Number.MAX_SAFE_INTEGER),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
  };
  if (value.retryAt !== undefined) schedule.retryAt = timestamp(value.retryAt);
  if (value.failureCode !== undefined) schedule.failureCode = text(value.failureCode, 128);
  return schedule;
}

export function acceptsScheduleResult(
  pending: PendingScheduleMutation | null,
  response: { requestId: string; payload: { operation: ScheduleOperation; schedule?: ApiSchedule; scheduleId?: string; revision?: number } },
): boolean {
  if (!pending || response.requestId !== pending.requestId || response.payload.operation !== pending.operation) return false;
  const responseId = response.payload.schedule?.scheduleId ?? response.payload.scheduleId ?? null;
  if (pending.scheduleId !== null && responseId !== pending.scheduleId) return false;
  const revision = response.payload.schedule?.revision ?? response.payload.revision;
  return pending.expectedRevision === undefined || (Number.isInteger(revision) && (revision as number) > pending.expectedRevision);
}

export function scheduleDays(days: number[]): string {
  return days.length === 7 ? "매일" : days.map((day) => weekdays[day]).join("·");
}

function desired(value: unknown): Partial<DesiredDeviceState> {
  if (!record(value)) throw new Error("invalid-schedule");
  const result: Partial<DesiredDeviceState> = {};
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["power", "red", "green", "blue", "brightness"].includes(key))) throw new Error("invalid-schedule");
  if (value.power !== undefined) result.power = bool(value.power);
  for (const key of ["red", "green", "blue"] as const) if (value[key] !== undefined) result[key] = integer(value[key], 0, 255);
  if (value.brightness !== undefined) result.brightness = integer(value.brightness, 0, 100);
  return result;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, max: number): string { if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error("invalid-schedule"); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("invalid-schedule"); return value; }
function integer(value: unknown, min: number, max: number): number { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error("invalid-schedule"); return value as number; }
function integerArray(value: unknown, min: number, max: number): number[] { if (!Array.isArray(value)) throw new Error("invalid-schedule"); return [...new Set(value.map((item) => integer(item, min, max)))].sort((a, b) => a - b); }
function localTime(value: unknown): string { const result = text(value, 5); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) throw new Error("invalid-schedule"); return result; }
function timezone(value: unknown): string { const result = text(value, 64); try { new Intl.DateTimeFormat("en", { timeZone: result }).format(); } catch { throw new Error("invalid-schedule"); } return result; }
function timestamp(value: unknown): string { const result = text(value, 64); if (Number.isNaN(Date.parse(result))) throw new Error("invalid-schedule"); return result; }
