import assert from "node:assert/strict";
import test from "node:test";
import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoScheduleRepository } from "../src/dynamodb-schedules.ts";
import type { Schedule } from "../src/schedules.ts";

class FakeClient {
  readonly commands: object[] = [];
  private readonly outputs: unknown[];
  constructor(outputs: unknown[]) { this.outputs = outputs; }
  async send(command: object): Promise<any> {
    this.commands.push(command);
    const result = this.outputs.shift();
    if (result instanceof Error) throw result;
    return result ?? {};
  }
}

test("Dynamo Schedule list paginates by tenant partition without scanning", async () => {
  const client = new FakeClient([
    { Items: [schedule()], LastEvaluatedKey: { tenantId: "home-a", scheduleId: "schedule-a" } },
    { Items: [{ ...schedule(), scheduleId: "schedule-b" }] },
  ]);
  const repository = new DynamoScheduleRepository(client, "ScheduleTable");
  assert.deepEqual((await repository.listSchedules("home-a")).map((item) => item.scheduleId), ["schedule-a", "schedule-b"]);
  assert.equal(client.commands.every((command) => command instanceof QueryCommand), true);
  const second = client.commands[1] as QueryCommand;
  assert.deepEqual(second.input.ExclusiveStartKey, { tenantId: "home-a", scheduleId: "schedule-a" });
});

test("Dynamo pending reconcile discovery queries the sync GSI without Scan", async () => {
  const client = new FakeClient([{ Items: [schedule()] }, { Items: [] }, { Items: [] }]);
  const repository = new DynamoScheduleRepository(client, "ScheduleTable");
  assert.equal((await repository.listSchedulesDue("2026-09-05T00:01:00.000Z", 100)).length, 1);
  assert.equal(client.commands.every((command) => command instanceof QueryCommand), true);
  assert.equal((client.commands[0] as QueryCommand).input.IndexName, "sync-status-updated-index");
  assert.match((client.commands[0] as QueryCommand).input.KeyConditionExpression ?? "", /#syncStatus = :syncStatus/);
});

test("Dynamo Schedule writes and callbacks use revision and state conditions", async () => {
  const client = new FakeClient([
    {},
    { Attributes: { ...schedule(), syncStatus: "ACTIVE", schedulerName: "scheduler-a" } },
    Object.assign(new Error("stale"), { name: "ConditionalCheckFailedException" }),
    {},
  ]);
  const repository = new DynamoScheduleRepository(client, "ScheduleTable");
  await repository.saveSchedule(schedule());
  assert.match((client.commands[0] as PutCommand).input.ConditionExpression ?? "", /attribute_not_exists/);

  assert.equal((await repository.markScheduleActive("home-a", "schedule-a", 1, "scheduler-a"))?.syncStatus, "ACTIVE");
  const update = client.commands[1] as UpdateCommand;
  assert.match(update.input.ConditionExpression ?? "", /#revision = :revision/);
  assert.match(update.input.ConditionExpression ?? "", /#syncStatus = :pending/);
  assert.equal(await repository.markScheduleError("home-a", "schedule-a", 0, "OLD", "later"), undefined);

  assert.equal(await repository.deleteSchedule("home-a", "schedule-a", 1), true);
  const deletion = client.commands[3] as DeleteCommand;
  assert.match(deletion.input.ConditionExpression ?? "", /#pendingOperation = :delete/);
});

test("Dynamo Schedule redrive preserves revision and original operation", async () => {
  const retried = { ...schedule(), syncStatus: "DELETE_PENDING" as const, pendingOperation: "DELETE" as const };
  const client = new FakeClient([{ Attributes: retried }]);
  const repository = new DynamoScheduleRepository(client, "ScheduleTable");

  assert.equal((await repository.markSchedulePending("home-a", "schedule-a", 1, "DELETE"))?.revision, 1);
  const update = client.commands[0] as UpdateCommand;
  assert.match(update.input.ConditionExpression ?? "", /#revision = :revision/);
  assert.match(update.input.ConditionExpression ?? "", /#pendingOperation = :operation/);
  assert.equal(update.input.ExpressionAttributeValues?.[":pending"], "DELETE_PENDING");
  assert.equal(update.input.ExpressionAttributeValues?.[":revision"], 1);
});

function schedule(): Schedule {
  return {
    tenantId: "home-a",
    scheduleId: "schedule-a",
    ownerId: "user-a",
    name: "저녁 조명",
    targetType: "DEVICE",
    targetId: "lamp-a",
    targetCertificateId: "cert-a",
    enabled: true,
    timezone: "Asia/Seoul",
    localTime: "21:00",
    daysOfWeek: [1, 3, 5],
    desiredState: { power: true, brightness: 40 },
    syncStatus: "PENDING_SYNC",
    pendingOperation: "UPSERT",
    revision: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}
