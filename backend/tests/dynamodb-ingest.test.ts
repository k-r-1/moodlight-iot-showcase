import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "../src/dynamodb.ts";
import type { Device, EventUplink, StateUplink, TelemetryUplink } from "../src/domain.ts";

const tables = { tenant: "tenant", membership: "membership", pool: "pool", device: "device", deviceClaim: "device-claim" };

class FakeClient {
  readonly commands: Array<GetCommand | TransactWriteCommand | UpdateCommand> = [];
  private readonly outputs: unknown[];
  constructor(outputs: unknown[]) { this.outputs = outputs; }
  async send(command: GetCommand | TransactWriteCommand | UpdateCommand): Promise<any> {
    this.commands.push(command);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output ?? {};
  }
}

test("Dynamo first state atomically activates Device and marks its bound Claim ONLINE", async () => {
  const client = new FakeClient([
    { Item: device({ lifecycleStatus: "RUNTIME_AUTHORIZED", claimId: "claim-a" }) },
    { Item: claimItem() },
    {},
  ]);
  const repository = new DynamoRepository(client, tables);

  assert.equal(await repository.applyState(state()), "APPLIED");

  assert.deepEqual(client.commands.map((command) => command.constructor.name), ["GetCommand", "GetCommand", "TransactWriteCommand"]);
  const transaction = client.commands[2] as TransactWriteCommand;
  const writes = transaction.input.TransactItems ?? [];
  assert.equal(writes.length, 2);
  assert.match(writes[0]?.Update?.ConditionExpression ?? "", /#tenantId = :tenantId/);
  assert.match(writes[0]?.Update?.ConditionExpression ?? "", /#stateBootStartedAtMs < :bootStartedAtMs/);
  assert.match(writes[0]?.Update?.UpdateExpression ?? "", /#lifecycleStatus = :active/);
  assert.equal(writes[0]?.Update?.ExpressionAttributeValues?.[":appliedCommandId"], "command-a");
  assert.deepEqual(writes[1]?.Update?.Key, { claimKey: "CLAIM#claim-a" });
  assert.match(writes[1]?.Update?.ConditionExpression ?? "", /#status = :authorized/);
  assert.equal(writes[1]?.Update?.ExpressionAttributeValues?.[":online"], "ONLINE");
});

test("Dynamo state duplicate is a read-only no-op", async () => {
  const current = device({
    lastStateMessageId: "state-a",
    stateBootId: "boot-a",
    stateBootSequence: 2,
    stateSequence: 5,
  });
  const client = new FakeClient([{ Item: current }]);
  const repository = new DynamoRepository(client, tables);

  assert.equal(await repository.applyState(state()), "DUPLICATE");
  assert.deepEqual(client.commands.map((command) => command.constructor.name), ["GetCommand"]);
});

test("Dynamo conditional race is classified as duplicate after a consistent re-read", async () => {
  const conflict = Object.assign(new Error("lost update"), { name: "ConditionalCheckFailedException" });
  const before = device({ version: 1 });
  const after = device({
    version: 2,
    lastStateMessageId: "state-a",
    stateBootId: "boot-a",
    stateBootSequence: 2,
    stateSequence: 5,
  });
  const client = new FakeClient([{ Item: before }, conflict, { Item: after }]);
  const repository = new DynamoRepository(client, tables);

  assert.equal(await repository.applyState(state()), "DUPLICATE");
  assert.deepEqual(client.commands.map((command) => command.constructor.name), ["GetCommand", "UpdateCommand", "GetCommand"]);
});

function claimItem() {
  return {
    claimKey: "CLAIM#claim-a",
    claimId: "claim-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: "serial-a",
    serialHash: "hash-a",
    registrationNonceHash: "nonce-a",
    status: "RUNTIME_AUTHORIZED",
    thingName: "lamp-a",
    claimExpiresAt: 1_788_480_060,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:30.000Z",
  };
}
test("Dynamo state without commandId preserves the last applied command", async () => {
  const client = new FakeClient([{ Item: device({ appliedCommandId: "command-old" }) }, {}]);
  const repository = new DynamoRepository(client, tables);
  const withoutCommand = { ...state() };
  delete withoutCommand.appliedCommandId;

  assert.equal(await repository.applyState(withoutCommand), "APPLIED");
  const update = client.commands[1] as UpdateCommand;
  assert.doesNotMatch(update.input.UpdateExpression ?? "", /REMOVE #appliedCommandId/);
  assert.equal(update.input.ExpressionAttributeNames?.["#appliedCommandId"], undefined);
  assert.equal(update.input.ExpressionAttributeValues?.[":appliedCommandId"], undefined);
});

test("Dynamo telemetry and event updates use independent atomic stream ordering", async () => {
  const client = new FakeClient([{ Item: device() }, {}, { Item: device() }, {}]);
  const repository = new DynamoRepository(client, tables);
  const telemetry: TelemetryUplink = {
    kind: "tele", tenantId: "home-a", poolId: "living", thingName: "lamp-a",
    messageId: "tele-a", bootId: "boot-a", bootStartedAtMs: Date.parse("2026-09-05T01:59:00.000Z"), bootSequence: 2, telemetrySequence: 4,
    uptimeSeconds: 30, rssi: -60, firmwareVersion: "0.2.0", receivedAt: "2026-09-05T02:00:00.000Z",
  };
  const event: EventUplink = {
    kind: "evt", tenantId: "home-a", poolId: "living", thingName: "lamp-a",
    messageId: "evt-a", bootId: "boot-a", bootStartedAtMs: Date.parse("2026-09-05T01:59:00.000Z"), bootSequence: 2, eventSequence: 3,
    eventType: "BOOT", occurredAt: "2026-09-05T01:59:59.000Z", receivedAt: "2026-09-05T02:00:00.000Z",
  };

  assert.equal(await repository.applyTelemetry(telemetry), "APPLIED");
  assert.equal(await repository.applyEvent(event), "APPLIED");

  const teleUpdate = client.commands[1] as UpdateCommand;
  const eventUpdate = client.commands[3] as UpdateCommand;
  assert.match(teleUpdate.input.ConditionExpression ?? "", /attribute_not_exists\(#bootStartedAtMs\)/);
  assert.equal(teleUpdate.input.ExpressionAttributeNames?.["#sequence"], "telemetrySequence");
  assert.equal(teleUpdate.input.ExpressionAttributeValues?.[":uptimeSeconds"], 30);
  assert.equal(teleUpdate.input.ExpressionAttributeValues?.[":rssi"], -60);
  assert.equal(eventUpdate.input.ExpressionAttributeNames?.["#sequence"], "eventSequence");
  assert.equal(eventUpdate.input.ExpressionAttributeValues?.[":eventType"], "BOOT");
});
function state(): StateUplink {
  return {
    kind: "state",
    tenantId: "home-a",
    poolId: "living",
    thingName: "lamp-a",
    messageId: "state-a",
    bootId: "boot-a",
    bootStartedAtMs: Date.parse("2026-09-05T01:59:00.000Z"),
    bootSequence: 2,
    stateSequence: 5,
    appliedCommandId: "command-a",
    power: true,
    red: 1,
    green: 2,
    blue: 3,
    brightness: 90,
    receivedAt: "2026-09-05T02:00:00.000Z",
  };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    deviceId: "lamp-a",
    thingName: "lamp-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: "serial-a",
    certificateId: "cert-a",
    name: "무드등",
    lifecycleStatus: "ACTIVE",
    power: false,
    red: 0,
    green: 0,
    blue: 0,
    brightness: 0,
    version: 1,
    ...overrides,
  };
}
