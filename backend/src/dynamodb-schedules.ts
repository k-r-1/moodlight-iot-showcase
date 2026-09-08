import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AppError } from "./domain.ts";
import type { Schedule, ScheduleOperation, ScheduleRepository } from "./schedules.ts";

type Client = Pick<DynamoDBDocumentClient, "send">;
type Item = Record<string, unknown>;
const SYNC_INDEX = "sync-status-updated-index";

export class DynamoScheduleRepository implements ScheduleRepository {
  private readonly client: Client;
  private readonly tableName: string;

  constructor(client: Client, tableName: string) {
    this.client = client;
    this.tableName = tableName;
  }

  async listSchedules(tenantId: string): Promise<Schedule[]> {
    const schedules: Schedule[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#tenantId = :tenantId",
        ExpressionAttributeNames: { "#tenantId": "tenantId" },
        ExpressionAttributeValues: { ":tenantId": tenantId },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      schedules.push(...(page.Items ?? []).map(hydrate));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return schedules;
  }

  async listSchedulesDue(now: string, limit: number): Promise<Schedule[]> {
    const due: Schedule[] = [];
    for (const status of ["PENDING_SYNC", "DELETE_PENDING", "ERROR"] as const) {
      let cursor: Record<string, unknown> | undefined;
      do {
        const page = await this.client.send(new QueryCommand({
          TableName: this.tableName,
          IndexName: SYNC_INDEX,
          KeyConditionExpression: "#syncStatus = :syncStatus AND #updatedAt <= :now",
          ExpressionAttributeNames: { "#syncStatus": "syncStatus", "#updatedAt": "updatedAt" },
          ExpressionAttributeValues: { ":syncStatus": status, ":now": now },
          Limit: limit,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }));
        due.push(...(page.Items ?? []).map(hydrate).filter((item) => item.syncStatus !== "ERROR" || !item.retryAt || item.retryAt <= now));
        cursor = due.length >= limit ? undefined : page.LastEvaluatedKey;
      } while (cursor);
      if (due.length >= limit) break;
    }
    return due.slice(0, limit);
  }

  async getSchedule(tenantId: string, scheduleId: string): Promise<Schedule | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { tenantId, scheduleId }, ConsistentRead: true }));
    return result.Item ? hydrate(result.Item) : undefined;
  }

  async saveSchedule(schedule: Schedule, expectedRevision?: number): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: schedule,
        ConditionExpression: expectedRevision === undefined ? "attribute_not_exists(#scheduleId)" : "#revision = :expectedRevision",
        ExpressionAttributeNames: expectedRevision === undefined ? { "#scheduleId": "scheduleId" } : { "#revision": "revision" },
        ...(expectedRevision === undefined ? {} : { ExpressionAttributeValues: { ":expectedRevision": expectedRevision } }),
      }));
    } catch (error) {
      if (conditional(error)) throw new AppError("SCHEDULE_CONFLICT", 409, "Schedule changed while it was being updated");
      throw error;
    }
  }

  async markScheduleActive(tenantId: string, scheduleId: string, revision: number, schedulerName: string): Promise<Schedule | undefined> {
    return this.updateResult(new UpdateCommand({
      TableName: this.tableName,
      Key: { tenantId, scheduleId },
      UpdateExpression: "SET #syncStatus = :active, #schedulerName = :schedulerName REMOVE #retryAt, #failureCode",
      ConditionExpression: "#revision = :revision AND #syncStatus = :pending AND #pendingOperation = :upsert",
      ExpressionAttributeNames: { "#revision": "revision", "#syncStatus": "syncStatus", "#pendingOperation": "pendingOperation", "#schedulerName": "schedulerName", "#retryAt": "retryAt", "#failureCode": "failureCode" },
      ExpressionAttributeValues: { ":revision": revision, ":pending": "PENDING_SYNC", ":upsert": "UPSERT", ":active": "ACTIVE", ":schedulerName": schedulerName },
      ReturnValues: "ALL_NEW",
    }));
  }

  async markSchedulePending(tenantId: string, scheduleId: string, revision: number, operation: ScheduleOperation): Promise<Schedule | undefined> {
    return this.updateResult(new UpdateCommand({
      TableName: this.tableName,
      Key: { tenantId, scheduleId },
      UpdateExpression: "SET #syncStatus = :pending REMOVE #retryAt, #failureCode",
      ConditionExpression: "#revision = :revision AND #syncStatus = :error AND #pendingOperation = :operation",
      ExpressionAttributeNames: {
        "#revision": "revision",
        "#syncStatus": "syncStatus",
        "#pendingOperation": "pendingOperation",
        "#retryAt": "retryAt",
        "#failureCode": "failureCode",
      },
      ExpressionAttributeValues: { ":revision": revision, ":error": "ERROR", ":operation": operation, ":pending": operation === "DELETE" ? "DELETE_PENDING" : "PENDING_SYNC" },
      ReturnValues: "ALL_NEW",
    }));
  }

  async markScheduleError(tenantId: string, scheduleId: string, revision: number, failureCode: string, retryAt: string): Promise<Schedule | undefined> {
    return this.updateResult(new UpdateCommand({
      TableName: this.tableName,
      Key: { tenantId, scheduleId },
      UpdateExpression: "SET #syncStatus = :error, #failureCode = :failureCode, #retryAt = :retryAt",
      ConditionExpression: "#revision = :revision AND #syncStatus IN (:pending, :deletePending)",
      ExpressionAttributeNames: { "#revision": "revision", "#syncStatus": "syncStatus", "#failureCode": "failureCode", "#retryAt": "retryAt" },
      ExpressionAttributeValues: { ":revision": revision, ":pending": "PENDING_SYNC", ":deletePending": "DELETE_PENDING", ":error": "ERROR", ":failureCode": failureCode, ":retryAt": retryAt },
      ReturnValues: "ALL_NEW",
    }));
  }

  async deleteSchedule(tenantId: string, scheduleId: string, revision: number): Promise<boolean> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { tenantId, scheduleId },
        ConditionExpression: "#revision = :revision AND #syncStatus = :deletePending AND #pendingOperation = :delete",
        ExpressionAttributeNames: { "#revision": "revision", "#syncStatus": "syncStatus", "#pendingOperation": "pendingOperation" },
        ExpressionAttributeValues: { ":revision": revision, ":deletePending": "DELETE_PENDING", ":delete": "DELETE" },
      }));
      return true;
    } catch (error) {
      if (conditional(error)) return false;
      throw error;
    }
  }

  private async updateResult(command: UpdateCommand): Promise<Schedule | undefined> {
    try {
      const result = await this.client.send(command);
      return result.Attributes ? hydrate(result.Attributes) : undefined;
    } catch (error) {
      if (conditional(error)) return undefined;
      throw error;
    }
  }
}

function hydrate(item: Item): Schedule {
  if (typeof item.tenantId !== "string" || typeof item.scheduleId !== "string" || typeof item.ownerId !== "string"
    || typeof item.name !== "string" || item.targetType !== "DEVICE" || typeof item.targetId !== "string"
    || typeof item.targetCertificateId !== "string" || item.targetCertificateId.length === 0
    || typeof item.enabled !== "boolean" || typeof item.timezone !== "string" || typeof item.localTime !== "string"
    || !Array.isArray(item.daysOfWeek) || item.daysOfWeek.some((day) => !Number.isInteger(day))
    || typeof item.desiredState !== "object" || item.desiredState === null || Array.isArray(item.desiredState)
    || !syncStatus(item.syncStatus) || !operation(item.pendingOperation) || typeof item.revision !== "number"
    || !Number.isInteger(item.revision) || item.revision < 1
    || typeof item.createdAt !== "string" || typeof item.updatedAt !== "string") {
    throw new AppError("CORRUPT_DATA", 500, "Stored Schedule is invalid");
  }
  return structuredClone(item) as unknown as Schedule;
}

function syncStatus(value: unknown): value is Schedule["syncStatus"] {
  return value === "PENDING_SYNC" || value === "ACTIVE" || value === "DELETE_PENDING" || value === "ERROR";
}

function operation(value: unknown): value is Schedule["pendingOperation"] {
  return value === "UPSERT" || value === "DELETE";
}

function conditional(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "ConditionalCheckFailedException";
}
