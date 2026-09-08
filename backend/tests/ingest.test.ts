import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type DeviceClaim } from "../src/domain.ts";
import { InMemoryRepository } from "../src/in-memory.ts";
import { MoodlightIngestService, parseUplink } from "../src/ingest.ts";

const receivedAt = "2026-09-05T02:00:00.000Z";
const bootStartedAtMs = Date.parse("2026-09-05T01:59:00.000Z");

async function runtimeFixture() {
  const repository = new InMemoryRepository();
  const claim: DeviceClaim = {
    claimId: "claim-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: "serial-a",
    serialHash: "hash-a",
    registrationNonceHash: "nonce-a",
    status: "CLAIM_PENDING",
    expiresAt: "2026-09-05T03:00:00.000Z",
    createdAt: "2026-09-05T01:00:00.000Z",
    updatedAt: "2026-09-05T01:00:00.000Z",
  };
  await repository.createClaim(claim);
  await repository.acquireFinalizeLease("claim-a", "lease-a", "2026-09-05T01:00:30.000Z", "2026-09-05T01:02:30.000Z");
  const binding = {
    thingName: "lamp-a",
    serial: "serial-a",
    certificateId: "cert-a",
  };
  await repository.bootstrapClaim("claim-a", binding, "lease-a", "2026-09-05T01:01:00.000Z");
  await repository.authorizeRuntimeClaim("claim-a", binding, "2026-09-05T01:01:01.000Z");
  return {
    repository,
    ingest: new MoodlightIngestService(repository, () => new Date(receivedAt)),
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    kind: "state",
    tenantId: "home-a",
    poolId: "living",
    thingName: "lamp-a",
    messageId: "state-1",
    bootId: "boot-a",
    bootStartedAtMs,
    bootSequence: 4,
    stateSequence: 1,
    commandId: "command-a",
    power: true,
    red: 10,
    green: 20,
    blue: 30,
    brightness: 80,
    ...overrides,
  };
}

function tele(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tele",
    tenantId: "home-a",
    poolId: "living",
    thingName: "lamp-a",
    messageId: "tele-1",
    bootId: "boot-a",
    bootStartedAtMs,
    bootSequence: 4,
    telemetrySequence: 1,
    uptimeSeconds: 12,
    rssi: -55,
    firmwareVersion: "0.2.0",
    ...overrides,
  };
}

function evt(overrides: Record<string, unknown> = {}) {
  return {
    kind: "evt",
    tenantId: "home-a",
    poolId: "living",
    thingName: "lamp-a",
    messageId: "evt-1",
    bootId: "boot-a",
    bootStartedAtMs,
    bootSequence: 4,
    eventSequence: 1,
    eventType: "BOOT",
    occurredAt: "2026-09-05T01:59:58.000Z",
    ...overrides,
  };
}

test("first runtime state atomically activates the Device and marks its Claim ONLINE", async () => {
  const { repository, ingest } = await runtimeFixture();

  assert.deepEqual(await ingest.ingest(state()), { kind: "state", disposition: "APPLIED" });

  const device = await repository.getDevice("lamp-a");
  const claim = await repository.getClaim("claim-a");
  assert.equal(device?.lifecycleStatus, "ACTIVE");
  assert.equal(claim?.status, "ONLINE");
  assert.equal(device?.claimId, "claim-a");
  assert.equal(device?.appliedCommandId, "command-a");
  assert.equal(device?.lastStateMessageId, "state-1");
  assert.equal(device?.stateBootStartedAtMs, bootStartedAtMs);
  assert.equal(device?.stateBootSequence, 4);
  assert.equal(device?.stateSequence, 1);
  assert.equal(device?.lastSeenAt, receivedAt);
  assert.deepEqual(
    { power: device?.power, red: device?.red, green: device?.green, blue: device?.blue, brightness: device?.brightness },
    { power: true, red: 10, green: 20, blue: 30, brightness: 80 },
  );
});

test("state ingestion uses boot time across NVS sequence reset and rejects late older boots", async () => {
  const { repository, ingest } = await runtimeFixture();
  await ingest.ingest(state());

  assert.equal((await ingest.ingest(state({ power: false }))).disposition, "DUPLICATE");
  assert.equal((await ingest.ingest(state({ messageId: "state-zero", stateSequence: 0, power: false }))).disposition, "STALE");
  assert.equal((await ingest.ingest(state({ messageId: "state-next", stateSequence: 2, commandId: undefined, power: false }))).disposition, "APPLIED");
  assert.equal((await ingest.ingest(state({ messageId: "state-other-id", bootId: "boot-other", stateSequence: 99, power: true }))).disposition, "STALE");
  assert.equal((await ingest.ingest(state({ messageId: "state-old-boot", bootId: "boot-old", bootStartedAtMs: bootStartedAtMs - 1000, bootSequence: 99, stateSequence: 99, power: true }))).disposition, "STALE");
  assert.equal((await ingest.ingest(state({ messageId: "state-new-boot", bootId: "boot-b", bootStartedAtMs: bootStartedAtMs + 1000, bootSequence: 1, stateSequence: 0, power: true }))).disposition, "APPLIED");

  const device = await repository.getDevice("lamp-a");
  assert.equal(device?.power, true);
  assert.equal(device?.stateBootSequence, 1);
  assert.equal(device?.stateBootStartedAtMs, bootStartedAtMs + 1000);
  assert.equal(device?.stateSequence, 0);
  assert.equal(device?.appliedCommandId, "command-a");
});

test("telemetry and events update summaries but cannot complete registration", async () => {
  const { repository, ingest } = await runtimeFixture();

  assert.equal((await ingest.ingest(tele())).disposition, "APPLIED");
  assert.equal((await ingest.ingest(evt())).disposition, "APPLIED");

  const device = await repository.getDevice("lamp-a");
  const claim = await repository.getClaim("claim-a");
  assert.equal(device?.lifecycleStatus, "RUNTIME_AUTHORIZED");
  assert.equal(claim?.status, "RUNTIME_AUTHORIZED");
  assert.equal(device?.uptimeSeconds, 12);
  assert.equal(device?.rssi, -55);
  assert.equal(device?.firmwareVersion, "0.2.0");
  assert.equal(device?.lastEventType, "BOOT");
  assert.equal(device?.lastEventAt, "2026-09-05T01:59:58.000Z");
  assert.equal((await ingest.ingest(tele())).disposition, "DUPLICATE");
  assert.equal((await ingest.ingest(evt({ messageId: "evt-old", eventSequence: 0 }))).disposition, "STALE");
});

test("topic-derived identity mismatch and malformed uplinks are rejected", async () => {
  const { ingest } = await runtimeFixture();

  await expectCode(() => ingest.ingest(state({ tenantId: "other-home" })), "UPLINK_IDENTITY_MISMATCH");
  await expectCode(() => ingest.ingest(state({ brightness: 101 })), "INVALID_UPLINK");
  await expectCode(() => ingest.ingest(state({ bootStartedAtMs: Date.parse(receivedAt) + 5 * 60 * 1000 + 1 })), "INVALID_UPLINK");
  await expectCode(() => ingest.ingest(tele({ bootSequence: undefined })), "INVALID_UPLINK");
  await expectCode(() => ingest.ingest(evt({ extra: "unexpected" })), "INVALID_UPLINK");
});

test("wire commandId is normalized to appliedCommandId and server receive time is authoritative", () => {
  const parsed = parseUplink(state(), receivedAt);
  assert.equal(parsed.kind, "state");
  if (parsed.kind !== "state") assert.fail("expected state");
  assert.equal(parsed.appliedCommandId, "command-a");
  assert.equal(parsed.receivedAt, receivedAt);
  assert.equal("commandId" in parsed, false);
});

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => error instanceof AppError && error.code === code);
}
