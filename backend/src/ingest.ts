import { AppError, type EventUplink, type IngestDisposition, type StateUplink, type TelemetryUplink, type UplinkMessage } from "./domain.ts";
import type { IngestRepository } from "./ports.ts";

type RecordValue = Record<string, unknown>;
const MIN_BOOT_TIME_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_BOOT_SKEW_MS = 5 * 60 * 1000;

export interface IngestResult {
  kind: UplinkMessage["kind"];
  disposition: IngestDisposition;
}

export class MoodlightIngestService {
  private readonly repository: IngestRepository;
  private readonly now: () => Date;

  constructor(repository: IngestRepository, now: () => Date = () => new Date()) {
    this.repository = repository;
    this.now = now;
  }

  async ingest(raw: unknown): Promise<IngestResult> {
    const message = parseUplink(raw, this.now().toISOString());
    const disposition = message.kind === "state"
      ? await this.repository.applyState(message)
      : message.kind === "tele"
        ? await this.repository.applyTelemetry(message)
        : await this.repository.applyEvent(message);
    return { kind: message.kind, disposition };
  }
}

export function parseUplink(raw: unknown, receivedAt: string): UplinkMessage {
  const value = record(raw);
  const kind = value.kind;
  const common = {
    tenantId: identifier(value.tenantId, "tenantId"),
    poolId: identifier(value.poolId, "poolId"),
    thingName: identifier(value.thingName, "thingName"),
    messageId: identifier(value.messageId, "messageId"),
    bootId: identifier(value.bootId, "bootId"),
    bootStartedAtMs: bootTime(value.bootStartedAtMs, receivedAt),
    bootSequence: integer(value.bootSequence, "bootSequence", 0, Number.MAX_SAFE_INTEGER),
    receivedAt: timestamp(receivedAt, "receivedAt"),
  };

  if (kind === "state") {
    exactKeys(value, [
      "kind", "tenantId", "poolId", "thingName", "messageId", "bootId", "bootStartedAtMs", "bootSequence",
      "stateSequence", "commandId", "power", "red", "green", "blue", "brightness",
    ]);
    const message: StateUplink = {
      kind,
      ...common,
      stateSequence: integer(value.stateSequence, "stateSequence", 0, Number.MAX_SAFE_INTEGER),
      power: boolean(value.power, "power"),
      red: integer(value.red, "red", 0, 255),
      green: integer(value.green, "green", 0, 255),
      blue: integer(value.blue, "blue", 0, 255),
      brightness: integer(value.brightness, "brightness", 0, 100),
      ...(value.commandId === undefined ? {} : { appliedCommandId: identifier(value.commandId, "commandId") }),
    };
    return message;
  }

  if (kind === "tele") {
    exactKeys(value, [
      "kind", "tenantId", "poolId", "thingName", "messageId", "bootId", "bootStartedAtMs", "bootSequence",
      "telemetrySequence", "uptimeSeconds", "rssi", "firmwareVersion",
    ]);
    const message: TelemetryUplink = {
      kind,
      ...common,
      telemetrySequence: integer(value.telemetrySequence, "telemetrySequence", 0, Number.MAX_SAFE_INTEGER),
      uptimeSeconds: integer(value.uptimeSeconds, "uptimeSeconds", 0, Number.MAX_SAFE_INTEGER),
      rssi: integer(value.rssi, "rssi", -127, 20),
      firmwareVersion: text(value.firmwareVersion, "firmwareVersion", 128),
    };
    return message;
  }

  if (kind === "evt") {
    exactKeys(value, [
      "kind", "tenantId", "poolId", "thingName", "messageId", "bootId", "bootStartedAtMs", "bootSequence",
      "eventSequence", "eventType", "occurredAt",
    ]);
    const message: EventUplink = {
      kind,
      ...common,
      eventSequence: integer(value.eventSequence, "eventSequence", 0, Number.MAX_SAFE_INTEGER),
      eventType: identifier(value.eventType, "eventType", 64),
      occurredAt: timestamp(value.occurredAt, "occurredAt"),
    };
    return message;
  }

  throw invalid("kind");
}

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("payload");
  return value as RecordValue;
}

function exactKeys(value: RecordValue, allowed: string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw invalid("field");
}

function identifier(value: unknown, field: string, max = 128): string {
  const result = text(value, field, max);
  if (!/^[A-Za-z0-9_.:-]+$/.test(result)) throw invalid(field);
  return result;
}

function bootTime(value: unknown, receivedAt: string): number {
  const result = integer(value, "bootStartedAtMs", MIN_BOOT_TIME_MS, Number.MAX_SAFE_INTEGER);
  if (result > Date.parse(receivedAt) + MAX_FUTURE_BOOT_SKEW_MS) throw invalid("bootStartedAtMs");
  return result;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(field);
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw invalid(field);
  return value as number;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(field);
  return value;
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 64 || Number.isNaN(Date.parse(value))) throw invalid(field);
  return value;
}

function invalid(field: string): AppError {
  return new AppError("INVALID_UPLINK", 400, `Invalid uplink ${field}`);
}
