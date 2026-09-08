import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "../src/dynamodb.ts";
import { createHandler } from "../src/handlers.ts";
import { InMemoryRepository } from "../src/in-memory.ts";
import {
  NotConfiguredCommandPublisher,
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
} from "../src/ports.ts";
import { MoodlightService } from "../src/service.ts";

const tables = {
  tenant: "tenant",
  membership: "membership",
  pool: "pool",
  device: "device",
  deviceClaim: "device-claim",
};

class FakeClient {
  readonly commands: Array<GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand> = [];
  private readonly outputs: unknown[];
  constructor(outputs: unknown[]) { this.outputs = outputs; }
  async send(command: GetCommand | QueryCommand | TransactWriteCommand | UpdateCommand): Promise<any> {
    this.commands.push(command);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output ?? {};
  }
}

test("first-login bootstrap derives one personal Tenant from verified auth and is idempotent", async () => {
  const repository = new InMemoryRepository();
  const handler = createHandler(service(repository));
  const request = {
    method: "POST",
    path: "/session/bootstrap",
    auth: { userId: "verified-sub" },
    body: { userId: "spoofed", tenantId: "spoofed-home" },
  } as const;

  const [first, raced] = await Promise.all([handler(request), handler(request)]);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(raced, first);
  assert.deepEqual(first.body, {
    tenantId: "personal-6dc2e20a8a69360bbea0f76b6c14a347",
    poolId: "default",
    role: "OWNER",
  });
  assert.equal(await repository.hasMembership("verified-sub", (first.body as { tenantId: string }).tenantId), true);
  assert.equal(await repository.hasMembership("spoofed", "spoofed-home"), false);
});

test("bootstrap selects an existing active Membership and preserves its role", async () => {
  const repository = new InMemoryRepository();
  repository.addMembership("verified-sub", "shared-home", "MEMBER");
  const result = await service(repository).bootstrapTenant({ userId: "verified-sub" });
  assert.deepEqual(result, { tenantId: "shared-home", poolId: "default", role: "MEMBER" });
});

test("Dynamo bootstrap creates Tenant, default Pool, and OWNER Membership in one conditional transaction", async () => {
  const client = new FakeClient([{ Items: [] }, {}]);
  const repository = new DynamoRepository(client, tables);
  const result = await repository.bootstrapPersonalTenant(bootstrapInput());

  assert.deepEqual(result, { tenantId: "personal-a", poolId: "default", role: "OWNER" });
  const transaction = client.commands[1] as TransactWriteCommand;
  assert.equal(transaction.input.TransactItems?.length, 3);
  assert.deepEqual(transaction.input.TransactItems?.map((item) => item.Put?.TableName), ["tenant", "pool", "membership"]);
  assert.equal(transaction.input.TransactItems?.[2]?.Put?.Item?.userId, "verified-sub");
  assert.equal(transaction.input.TransactItems?.[2]?.Put?.Item?.role, "OWNER");
  assert.equal(transaction.input.TransactItems?.every((item) => item.Put?.ConditionExpression?.includes("attribute_not_exists")), true);
});

test("Dynamo bootstrap resolves a concurrent conditional loss by re-reading the active Membership", async () => {
  const conflict = Object.assign(new Error("lost race"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }],
  });
  const client = new FakeClient([
    { Items: [] },
    conflict,
    { Items: [{ tenantId: "personal-a", role: "OWNER" }] },
    { Items: [{ poolId: "default" }] },
  ]);
  const result = await new DynamoRepository(client, tables).bootstrapPersonalTenant(bootstrapInput());
  assert.deepEqual(result, { tenantId: "personal-a", poolId: "default", role: "OWNER" });
  assert.deepEqual(client.commands.map((command) => command.constructor.name), [
    "QueryCommand", "TransactWriteCommand", "QueryCommand", "QueryCommand",
  ]);
});

test("Dynamo bootstrap selects an existing active Membership without writing", async () => {
  const client = new FakeClient([
    { Items: [{ tenantId: "shared-home", role: "MEMBER" }] },
    { Items: [{ poolId: "living" }] },
  ]);
  const result = await new DynamoRepository(client, tables).bootstrapPersonalTenant(bootstrapInput());
  assert.deepEqual(result, { tenantId: "shared-home", poolId: "living", role: "MEMBER" });
  assert.equal(client.commands.some((command) => command instanceof TransactWriteCommand), false);
});

function service(repository: InMemoryRepository): MoodlightService {
  return new MoodlightService(
    repository,
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    new NotConfiguredCommandPublisher(),
    new NotConfiguredDeviceDecommissioner(),
    { now: () => new Date("2026-09-04T00:00:00.000Z") },
  );
}

function bootstrapInput() {
  return {
    userId: "verified-sub",
    tenantId: "personal-a",
    poolId: "default",
    tenantName: "내 집",
    poolName: "기본 공간",
    now: "2026-09-04T00:00:00.000Z",
  };
}
