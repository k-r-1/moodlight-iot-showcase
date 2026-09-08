import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { GetCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AppError, type DeviceClaim } from "../src/domain.ts";
import { DynamoClaimRegistrar, registrationCodeHash } from "../src/dynamodb-claim-registrar.ts";
import { registrationNonceFor, registrationRecoveryProof } from "../src/claim-secrets.ts";

const SERIAL = "001122334455";
const RAW_CODE = "factory-secret-code-123";

class FakeClient {
  readonly commands: Array<TransactWriteCommand | GetCommand | UpdateCommand> = [];
  private readonly failure: Error | undefined;
  private readonly getItems: Array<Record<string, unknown> | undefined>;
  constructor(failure?: Error, getItems: Array<Record<string, unknown> | undefined> = []) {
    this.failure = failure;
    this.getItems = [...getItems];
  }
  async send(command: TransactWriteCommand | GetCommand | UpdateCommand): Promise<Record<string, unknown>> {
    this.commands.push(command);
    if (command instanceof TransactWriteCommand && this.failure) throw this.failure;
    if (command instanceof GetCommand) return { Item: this.getItems.shift() };
    return {};
  }
}

test("consumes the registry code and creates the Claim and serial lock in one transaction", async () => {
  const client = new FakeClient();
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });

  await registrar.createClaim(claim(), RAW_CODE);

  assert.equal(client.commands.length, 1);
  const command = client.commands[0];
  assert.ok(command instanceof TransactWriteCommand);
  const items = command.input.TransactItems ?? [];
  assert.equal(items.length, 3);
  assert.equal(items[0]?.Update?.TableName, "isolated-device-registry");
  assert.equal(items[0]?.Update?.Key?.serialHash, sha256(SERIAL));
  assert.match(items[0]?.Update?.ConditionExpression ?? "", /#registrationCodeHash = :registrationCodeHash/);
  assert.match(items[0]?.Update?.UpdateExpression ?? "", /REMOVE #registrationCodeHash/);
  assert.equal(items[0]?.Update?.ExpressionAttributeValues?.[":registrationCodeHash"], registrationCodeHash(SERIAL, RAW_CODE));
  assert.equal(items[1]?.Put?.Item?.claimKey, "CLAIM#claim-12345678");
  assert.equal(items[2]?.Put?.Item?.claimKey, `SERIAL#${sha256(SERIAL)}`);
  assert.equal(items[2]?.Put?.Item?.expiresAt, 1788480900);

  const serializedCommand = JSON.stringify(command.input);
  assert.equal(serializedCommand.includes(RAW_CODE), false);
  assert.equal(serializedCommand.includes("registrationNonce-raw"), false);
});

test("fails closed without revealing why a registry transaction was rejected", async () => {
  const failure = Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  const client = new FakeClient(failure);
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });

  await assert.rejects(
    () => registrar.createClaim(claim(), RAW_CODE),
    (error: unknown) => error instanceof AppError
      && error.code === "INVALID_REGISTRATION_CODE"
      && error.status === 403,
  );
  assert.equal(client.commands.length, 2);
});

test("rejects a non-canonical Claim before calling DynamoDB", async () => {
  const client = new FakeClient();
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });

  await assert.rejects(
    () => registrar.createClaim({ ...claim(), serial: "00:11:22:33:44:55" }, RAW_CODE),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_SERIAL",
  );
  assert.equal(client.commands.length, 0);
});

test("recovers the same Claim after a successful write response is lost or a concurrent retry races", async () => {
  const original = claim();
  const expiresAt = 1788480900;
  const failure = Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "TransactionConflict" }],
  });
  const client = new FakeClient(failure, [
    {
      serialHash: original.serialHash,
      serial: original.serial,
      status: "RESERVED",
      claimId: original.claimId,
      ownerId: original.ownerId,
      tenantId: original.tenantId,
      poolId: original.poolId,
      nonceHash: original.registrationNonceHash,
      recoveryProof: registrationRecoveryProof(original, RAW_CODE),
      reservationExpiresAt: expiresAt,
    },
    {
      claimKey: `CLAIM#${original.claimId}`,
      ...original,
      expiresAt,
    },
  ]);
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });
  const retry = {
    ...original,
    claimId: "claim-retry-9999",
    createdAt: "2026-09-04T00:01:00.000Z",
    updatedAt: "2026-09-04T00:01:00.000Z",
    expiresAt: "2026-09-04T00:16:00.000Z",
  };

  assert.deepEqual(await registrar.createClaim(retry, RAW_CODE), original);
  assert.equal(registrationNonceFor(retry, RAW_CODE), registrationNonceFor(original, RAW_CODE));
  assert.equal(client.commands.length, 3);
  assert.ok(client.commands[1] instanceof GetCommand);
  assert.ok(client.commands[2] instanceof GetCommand);
  assert.equal(JSON.stringify(client.commands).includes(RAW_CODE), false);
});

test("does not recover another owner or reveal whether the serial was reserved", async () => {
  const original = claim();
  const failure = Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  const client = new FakeClient(failure, [{
    serialHash: original.serialHash,
    serial: original.serial,
    status: "RESERVED",
    claimId: original.claimId,
    ownerId: original.ownerId,
    tenantId: original.tenantId,
    poolId: original.poolId,
    nonceHash: original.registrationNonceHash,
    recoveryProof: registrationRecoveryProof(original, RAW_CODE),
    reservationExpiresAt: 1788480900,
  }]);
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });

  await assert.rejects(
    () => registrar.createClaim({ ...original, ownerId: "user-b", claimId: "claim-other-9999" }, RAW_CODE),
    (error: unknown) => error instanceof AppError
      && error.code === "INVALID_REGISTRATION_CODE"
      && error.status === 403,
  );
  assert.equal(client.commands.length, 2);
});

test("an expired reservation becomes admin-reissue-required without restoring the consumed code", async () => {
  const original = claim();
  const failure = Object.assign(new Error("transaction cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
  const client = new FakeClient(failure, [{
    serialHash: original.serialHash,
    serial: original.serial,
    status: "RESERVED",
    claimId: original.claimId,
    ownerId: original.ownerId,
    tenantId: original.tenantId,
    poolId: original.poolId,
    nonceHash: original.registrationNonceHash,
    recoveryProof: registrationRecoveryProof(original, RAW_CODE),
    reservationExpiresAt: 1_788_480_900,
  }]);
  const registrar = new DynamoClaimRegistrar(client, {
    deviceRegistry: "isolated-device-registry",
    deviceClaim: "isolated-device-claim",
  });
  const retry = {
    ...original,
    claimId: "claim-retry-9999",
    createdAt: "2026-09-04T00:16:00.000Z",
    updatedAt: "2026-09-04T00:16:00.000Z",
    expiresAt: "2026-09-04T00:31:00.000Z",
  };

  await assert.rejects(
    () => registrar.createClaim(retry, RAW_CODE),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_REGISTRATION_CODE",
  );
  const update = client.commands.find((command) => command instanceof UpdateCommand) as UpdateCommand | undefined;
  assert.ok(update);
  assert.equal(update.input.ExpressionAttributeValues?.[":reissueRequired"], "REISSUE_REQUIRED");
  assert.match(update.input.UpdateExpression ?? "", /REMOVE .*#recoveryProof/);
  assert.doesNotMatch(update.input.UpdateExpression ?? "", /SET .*#registrationCodeHash/);
  assert.match(update.input.ConditionExpression ?? "", /attribute_not_exists\(#registrationCodeHash\)/);
});

function claim(): DeviceClaim {
  const value: DeviceClaim = {
    claimId: "claim-12345678",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: SERIAL,
    serialHash: sha256(SERIAL),
    registrationNonceHash: "",
    status: "CLAIM_PENDING",
    expiresAt: "2026-09-04T00:15:00.000Z",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  value.registrationNonceHash = sha256(registrationNonceFor(value, RAW_CODE));
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
