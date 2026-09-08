import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "../src/dynamodb.ts";
import { AppError, type BootstrapBinding, type Device, type DeviceClaim } from "../src/domain.ts";

const tables = { tenant: "tenant", membership: "membership", pool: "pool", device: "device", deviceClaim: "device-claim", deviceRegistry: "device-registry" };

class FakeClient {
  readonly commands: Array<GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand> = [];
  private readonly outputs: unknown[];
  constructor(outputs: unknown[]) { this.outputs = outputs; }
  async send(command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand | UpdateCommand): Promise<any> {
    this.commands.push(command);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output ?? {};
  }
}

test("membership and paginated device lists use Get and Query without Scan", async () => {
  const client = new FakeClient([
    { Item: { status: "ACTIVE" } },
    { Items: [{ deviceId: "lamp-a" }], LastEvaluatedKey: { tenantId: "home-a", tenantPoolKey: "cursor" } },
    { Item: deviceItem({ deviceId: "lamp-a", thingName: "lamp-a" }) },
    { Items: [{ deviceId: "lamp-b" }] },
    { Item: deviceItem({ deviceId: "lamp-b", thingName: "lamp-b" }) },
  ]);
  const repository = new DynamoRepository(client, tables);

  assert.equal(await repository.hasMembership("user-a", "home-a"), true);
  assert.deepEqual((await repository.listDevices("home-a")).map((item) => item.deviceId), ["lamp-a", "lamp-b"]);
  assert.deepEqual(client.commands.map((command) => command.constructor.name), [
    "GetCommand", "QueryCommand", "GetCommand", "QueryCommand", "GetCommand",
  ]);
  assert.deepEqual((client.commands[3] as QueryCommand).input.ExclusiveStartKey, {
    tenantId: "home-a",
    tenantPoolKey: "cursor",
  });
});

test("Pool lookup uses the Tenant and Pool composite key", async () => {
  const client = new FakeClient([{ Item: { poolId: "living" } }, { Item: undefined }]);
  const repository = new DynamoRepository(client, tables);

  assert.equal(await repository.hasPool("home-a", "living"), true);
  assert.equal(await repository.hasPool("home-a", "missing"), false);
  assert.deepEqual((client.commands[0] as GetCommand).input.Key, { tenantId: "home-a", poolId: "living" });
  assert.equal((client.commands[0] as GetCommand).input.ConsistentRead, true);
});

test("claim creation atomically stores a numeric TTL Claim and serial lock", async () => {
  const client = new FakeClient([{ Item: undefined }, {}]);
  const repository = new DynamoRepository(client, tables);
  await repository.createClaim(claim());

  const transaction = client.commands[1] as TransactWriteCommand;
  assert.equal(transaction.constructor.name, "TransactWriteCommand");
  assert.equal(transaction.input.TransactItems?.length, 2);
  const claimItem = transaction.input.TransactItems?.[0]?.Put?.Item;
  const lockItem = transaction.input.TransactItems?.[1]?.Put?.Item;
  assert.equal(claimItem?.claimKey, "CLAIM#claim-a");
  assert.equal(claimItem?.expiresAt, 1_788_480_060);
  assert.equal(lockItem?.claimKey, "SERIAL#serial-hash");
  assert.equal(lockItem?.expiresAt, 1_788_480_060);
  assert.equal(typeof claimItem?.expiresAt, "number");
  assert.match(transaction.input.TransactItems?.[1]?.Put?.ConditionExpression ?? "", /expiresAt <= :now/);
});

test("claim reads convert DynamoDB TTL seconds back to the domain ISO timestamp", async () => {
  const client = new FakeClient([{ Item: { ...claim(), claimKey: "CLAIM#claim-a", expiresAt: 1_788_480_060 } }]);
  const repository = new DynamoRepository(client, tables);
  assert.equal((await repository.getClaim("claim-a"))?.expiresAt, "2026-09-04T00:01:00.000Z");
});

test("finalize lease is conditionally acquired before external work", async () => {
  const leased = { ...claim(), claimKey: "CLAIM#claim-a", status: "PROVISIONING", expiresAt: 1_788_480_060 };
  const client = new FakeClient([{ Attributes: leased }]);
  const repository = new DynamoRepository(client, tables);

  const result = await repository.acquireFinalizeLease(
    "claim-a",
    "lease-a",
    "2026-09-04T00:00:10.000Z",
    "2026-09-04T00:00:40.000Z",
  );

  assert.equal(result.acquired, true);
  const update = client.commands[0] as UpdateCommand;
  assert.match(update.input.ConditionExpression ?? "", /#status = :pending/);
  assert.match(update.input.ConditionExpression ?? "", /#status = :bootstrapped/);
  assert.match(update.input.UpdateExpression ?? "", /#status = :provisioning/);
  assert.equal(update.input.ExpressionAttributeValues?.[":leaseId"], "lease-a");
});

test("a live finalize lease rejects a concurrent worker before external work", async () => {
  const conflict = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
  const active = { ...claim(), claimKey: "CLAIM#claim-a", status: "PROVISIONING", expiresAt: 1_788_480_060 };
  const client = new FakeClient([conflict, conflict, { Item: active }]);
  const repository = new DynamoRepository(client, tables);

  await assert.rejects(
    () => repository.acquireFinalizeLease("claim-a", "lease-b", "2026-09-04T00:00:10.000Z", "2026-09-04T00:00:40.000Z"),
    (error: unknown) => error instanceof AppError && error.code === "CLAIM_FINALIZE_IN_PROGRESS",
  );
  assert.deepEqual(client.commands.map((command) => command.constructor.name), ["UpdateCommand", "UpdateCommand", "GetCommand"]);
});

test("an expired finalize lease can be taken over after a crashed worker", async () => {
  const conflict = Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });
  const leased = { ...claim(), claimKey: "CLAIM#claim-a", status: "PROVISIONING", expiresAt: 1_788_480_060 };
  const client = new FakeClient([conflict, { Attributes: leased }]);
  const repository = new DynamoRepository(client, tables);

  const result = await repository.acquireFinalizeLease(
    "claim-a",
    "lease-b",
    "2026-09-04T00:00:30.000Z",
    "2026-09-04T00:00:50.000Z",
  );

  assert.equal(result.acquired, true);
  const takeover = client.commands[1] as UpdateCommand;
  assert.match(takeover.input.ConditionExpression ?? "", /#finalizeLeaseExpiresAt <= :nowEpoch/);
  assert.match(takeover.input.ConditionExpression ?? "", /#finalizeResumeStatus = :pending/);
  assert.match(takeover.input.ConditionExpression ?? "", /#finalizeResumeStatus = :bootstrapped/);
});

test("bootstrap durably binds Claim, serial lock, Device, and registry before runtime authorization", async () => {
  const provisioningClaim = {
    ...claim(), claimKey: "CLAIM#claim-a", status: "PROVISIONING", expiresAt: 1_788_480_060,
    finalizeResumeStatus: "CLAIM_PENDING", finalizeLeaseId: "lease-a", finalizeLeaseExpiresAt: 1_788_480_050,
  };
  const client = new FakeClient([
    { Item: provisioningClaim },
    {},
  ]);
  const repository = new DynamoRepository(client, tables);
  const binding: BootstrapBinding = { thingName: "lamp-a", serial: "serial-a", certificateId: "cert-public-id" };
  const result = await repository.bootstrapClaim("claim-a", binding, "lease-a", "2026-09-04T00:00:30.000Z");

  assert.equal(result.claim.status, "BOOTSTRAPPED");
  assert.equal(result.device.lifecycleStatus, "BOOTSTRAPPED");
  assert.equal(result.device.deviceId, "lamp-a");
  const transaction = client.commands[1] as TransactWriteCommand;
  const writes = transaction.input.TransactItems ?? [];
  assert.equal(writes.length, 4);
  assert.match(writes[0]?.Update?.ConditionExpression ?? "", /#expiresAt > :nowEpoch/);
  assert.match(writes[0]?.Update?.ConditionExpression ?? "", /#finalizeLeaseId = :leaseId/);
  assert.match(writes[1]?.Update?.ConditionExpression ?? "", /#claimId = :claimId/);
  assert.match(writes[1]?.Update?.UpdateExpression ?? "", /REMOVE #expiresAt/);
  assert.equal(writes[2]?.Put?.Item?.tenantPoolKey, "POOL#living#DEVICE#lamp-a");
  assert.match(writes[2]?.Put?.ConditionExpression ?? "", /attribute_not_exists\(#deviceId\).*#lifecycleStatus = :revoked/);
  assert.equal(writes[3]?.Update?.TableName, "device-registry");
  assert.match(writes[3]?.Update?.ConditionExpression ?? "", /#latestCertificateId = :certificateId/);
});

test("runtime authorization atomically promotes Claim, Device, and registry", async () => {
  const bootstrappedClaim = {
    ...claim(),
    claimKey: "CLAIM#claim-a",
    status: "BOOTSTRAPPED",
    thingName: "lamp-a",
    claimExpiresAt: 1_788_480_060,
  };
  const client = new FakeClient([
    { Item: bootstrappedClaim },
    { Item: deviceItem({ lifecycleStatus: "BOOTSTRAPPED", claimId: "claim-a" }) },
    {},
  ]);
  const repository = new DynamoRepository(client, tables);
  const result = await repository.authorizeRuntimeClaim(
    "claim-a",
    { thingName: "lamp-a", serial: "serial-a", certificateId: "cert-public-id" },
    "2026-09-04T00:02:00.000Z",
  );

  assert.equal(result.claim.status, "RUNTIME_AUTHORIZED");
  assert.equal(result.device.lifecycleStatus, "RUNTIME_AUTHORIZED");
  assert.equal(result.device.deviceId, "lamp-a");
  const transaction = client.commands[2] as TransactWriteCommand;
  assert.equal(transaction.input.TransactItems?.length, 3);
  assert.deepEqual(transaction.input.TransactItems?.map((item) => item.Update?.TableName), ["device-claim", "device", "device-registry"]);
});

test("a runtime promotion retry returns an already completed binding without another transaction", async () => {
  const completed = {
    ...claim(), claimKey: "CLAIM#claim-a",
    status: "RUNTIME_AUTHORIZED",
    thingName: "lamp-a",
    claimExpiresAt: 1_788_480_060,
    expiresAt: undefined,
  };
  const client = new FakeClient([{ Item: completed }, { Item: deviceItem({ lifecycleStatus: "RUNTIME_AUTHORIZED", claimId: "claim-a" }) }]);
  const repository = new DynamoRepository(client, tables);
  const result = await repository.authorizeRuntimeClaim(
    "claim-a",
    { thingName: "lamp-a", serial: "serial-a", certificateId: "cert-public-id" },
    "2026-09-04T00:00:30.000Z",
  );

  assert.equal(result.claim.status, "RUNTIME_AUTHORIZED");
  assert.deepEqual(client.commands.map((command) => command.constructor.name), ["GetCommand", "GetCommand"]);
});

test("release atomically revokes the Device and old Claim before deleting the serial binding", async () => {
  const client = new FakeClient([
    { Item: deviceItem() },
    { Item: { claimId: "claim-a", deviceId: "lamp-a", thingName: "lamp-a" } },
    {},
  ]);
  const repository = new DynamoRepository(client, tables);
  const result = await repository.revokeDeviceAndReleaseSerial(deviceItem() as Device, "serial-hash", "2026-09-04T00:03:00.000Z");

  const transaction = client.commands[2] as TransactWriteCommand;
  assert.equal(result.device.lifecycleStatus, "REVOKED");
  assert.equal(result.idempotent, false);
  assert.equal(transaction.input.TransactItems?.length, 4);
  assert.match(transaction.input.TransactItems?.[1]?.Update?.UpdateExpression ?? "", /#status = :revoked/);
  assert.match(transaction.input.TransactItems?.[2]?.Delete?.ConditionExpression ?? "", /#claimId = :claimId/);
  const registry = transaction.input.TransactItems?.[3]?.Update;
  assert.equal(registry?.TableName, "device-registry");
  assert.match(registry?.ConditionExpression ?? "", /#status = :runtimeAuthorized/);
  assert.match(registry?.UpdateExpression ?? "", /#status = :reissueRequired/);
  assert.match(registry?.UpdateExpression ?? "", /REMOVE .*#claimId.*#ownerId.*#tenantId.*#poolId.*#nonceHash/);
  assert.match(registry?.UpdateExpression ?? "", /#thingName.*#certificateId.*#latestCertificateId/);
  assert.equal(registry?.ExpressionAttributeValues?.[":reissueRequired"], "REISSUE_REQUIRED");
  assert.equal(registry?.ExpressionAttributeValues?.[":released"], "DEVICE_RELEASED");
  assert.equal(registry?.ExpressionAttributeValues?.[":registrationCodeHash"], undefined);
});

test("reserveCommand atomically allocates one generation-bound sequence and reuses it after a retry", async () => {
  const target = deviceItem() as Device;
  const createdClient = new FakeClient([{ Item: target }, {}]);
  const createdRepository = new DynamoRepository(createdClient, tables);
  assert.deepEqual(
    await createdRepository.reserveCommand(target, "request-a", "command-a", { power: true }),
    { commandId: "command-a", commandSequence: 1, desiredState: { power: true, red: 0, green: 0, blue: 0, brightness: 0 } },
  );
  const transaction = createdClient.commands[1] as TransactWriteCommand;
  assert.equal(transaction.input.TransactItems?.length, 2);
  assert.equal(transaction.input.TransactItems?.[0]?.Put?.Item?.commandSequence, 1);
  assert.equal(typeof transaction.input.TransactItems?.[0]?.Put?.Item?.expiresAt, "number");
  assert.deepEqual(transaction.input.TransactItems?.[0]?.Put?.Item?.desiredState, { power: true, red: 0, green: 0, blue: 0, brightness: 0 });
  assert.match(transaction.input.TransactItems?.[1]?.Update?.ConditionExpression ?? "", /#certificateId = :certificateId/);
  assert.match(transaction.input.TransactItems?.[1]?.Update?.ConditionExpression ?? "", /#commandSequence = :current/);
  assert.match(transaction.input.TransactItems?.[1]?.Update?.UpdateExpression ?? "", /#lastCommandId = :commandId/);
  assert.match(transaction.input.TransactItems?.[1]?.Update?.UpdateExpression ?? "", /#desiredState = :desiredState/);

  const conflict = Object.assign(new Error("duplicate"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });
  const ledger = {
    entityType: "COMMAND", targetDeviceId: "lamp-a", targetCertificateId: "cert-public-id",
    requestId: "request-a", commandId: "command-a", commandSequence: 1, desired: { power: true },
    desiredState: { power: true, red: 0, green: 0, blue: 0, brightness: 0 },
  };
  const retryClient = new FakeClient([{ Item: { ...target, commandSequence: 1 } }, conflict, { Item: ledger }]);
  assert.deepEqual(
    await new DynamoRepository(retryClient, tables).reserveCommand(target, "request-a", "unused", { power: true }),
    { commandId: "command-a", commandSequence: 1, desiredState: { power: true, red: 0, green: 0, blue: 0, brightness: 0 } },
  );
  assert.equal((retryClient.commands[2] as GetCommand).input.ConsistentRead, true);

  const nextClient = new FakeClient([{ Item: { ...target, commandSequence: 1 } }, {}]);
  assert.deepEqual(
    await new DynamoRepository(nextClient, tables).reserveCommand(target, "request-b", "command-b", { power: false }),
    { commandId: "command-b", commandSequence: 2, desiredState: { power: false, red: 0, green: 0, blue: 0, brightness: 0 } },
  );

  const mismatchClient = new FakeClient([{ Item: { ...target, commandSequence: 1 } }, conflict, { Item: ledger }]);
  await assert.rejects(
    () => new DynamoRepository(mismatchClient, tables).reserveCommand(target, "request-a", "unused", { power: false }),
    (error: unknown) => error instanceof AppError && error.code === "REQUEST_ID_REUSED",
  );
});

test("transaction infrastructure failures are not mislabeled as user conflicts", async () => {
  const outage = Object.assign(new Error("throughput unavailable"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }, { Code: "None" }],
  });
  const client = new FakeClient([{ Item: undefined }, outage]);
  const repository = new DynamoRepository(client, tables);
  await assert.rejects(repository.createClaim(claim()), (error: unknown) => error === outage);
});

function claim(): DeviceClaim {
  return {
    claimId: "claim-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: "serial-a",
    serialHash: "serial-hash",
    registrationNonceHash: "nonce-hash",
    status: "CLAIM_PENDING",
    expiresAt: "2026-09-04T00:01:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

function deviceItem(overrides: Partial<Device> = {}): Device & { tenantPoolKey: string } {
  const device: Device = {
    deviceId: "lamp-a",
    thingName: "lamp-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: "serial-a",
    certificateId: "cert-public-id",
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
  return { ...device, tenantPoolKey: `POOL#${device.poolId}#DEVICE#${device.deviceId}` };
}
