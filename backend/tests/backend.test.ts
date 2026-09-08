import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type BootstrapBinding, type DecommissionConfirmation, type Device, type DeviceClaim, type DesiredState } from "../src/domain.ts";
import { createHandler } from "../src/handlers.ts";
import { InMemoryRepository } from "../src/in-memory.ts";
import {
  NotConfiguredCommandPublisher,
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
  type CommandPublisher,
  type DeviceDecommissioner,
  type ProvisioningPort,
  type ClaimRegistrar,
} from "../src/ports.ts";
import { MoodlightService } from "../src/service.ts";
import { registrationNonceFor } from "../src/claim-secrets.ts";

const SERIAL_A = "001122334455";
const SERIAL_B = "001122334456";

class AcceptClaimRegistrar implements ClaimRegistrar {
  private readonly repository: InMemoryRepository;
  constructor(repository: InMemoryRepository) { this.repository = repository; }
  async createClaim(claim: DeviceClaim, registrationCode: string): Promise<DeviceClaim> {
    if (registrationCode !== "valid-code") throw new AppError("INVALID_REGISTRATION_CODE", 403, "Registration code rejected");
    await this.repository.createClaim(claim);
    return claim;
  }
}

class FakeProvisioning implements ProvisioningPort {
  verifyCalls = 0;
  authorizeCalls = 0;
  readonly binding: BootstrapBinding;
  constructor(binding: BootstrapBinding) { this.binding = binding; }
  async verifyBootstrap(_claim: DeviceClaim): Promise<BootstrapBinding> {
    this.verifyCalls += 1;
    return this.binding;
  }
  async authorizeRuntime(_claim: DeviceClaim, _binding: BootstrapBinding): Promise<void> {
    this.authorizeCalls += 1;
  }
}

class FakeDecommissioner implements DeviceDecommissioner {
  calls = 0;
  readonly override: Partial<DecommissionConfirmation>;
  constructor(override: Partial<DecommissionConfirmation> = {}) { this.override = override; }
  async decommission(device: Device): Promise<DecommissionConfirmation> {
    this.calls += 1;
    return {
      thingName: device.thingName,
      certificateId: device.certificateId,
      certificateDisabled: true,
      policiesDetached: true,
      thingDeleted: true,
      ...this.override,
    };
  }
}

class FakePublisher implements CommandPublisher {
  calls: Array<{ deviceId: string; commandId: string; commandSequence: number; desired: DesiredState }> = [];
  async publish(device: Device, commandId: string, commandSequence: number, desired: DesiredState): Promise<void> {
    this.calls.push({ deviceId: device.deviceId, commandId, commandSequence, desired: structuredClone(desired) });
  }
}

function fixture(external?: { provisioning?: ProvisioningPort; publisher?: CommandPublisher; decommissioner?: DeviceDecommissioner }) {
  const repository = new InMemoryRepository();
  repository.addMembership("user-a", "home-a");
  repository.addPool("home-a", "living");
  let current = new Date("2026-09-04T00:00:00.000Z");
  let sequence = 0;
  const service = new MoodlightService(
    repository,
    new AcceptClaimRegistrar(repository),
    external?.provisioning ?? new NotConfiguredProvisioning(),
    external?.publisher ?? new NotConfiguredCommandPublisher(),
    external?.decommissioner ?? new NotConfiguredDeviceDecommissioner(),
    {
      now: () => current,
      id: () => `id-${++sequence}`,
      claimTtlMs: 60_000,
    },
  );
  return { repository, service, setNow: (value: string) => { current = new Date(value); } };
}

async function expectCode(action: () => Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof AppError && error.code === code && error.status === status);
}

test("GET devices checks membership and only returns the requested tenant", async () => {
  const { repository, service } = fixture();
  repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a" }));
  repository.seedDevice(device({ deviceId: "lamp-b", thingName: "lamp-b", tenantId: "home-b", ownerId: "user-b" }));
  repository.seedDevice(device({ deviceId: "lamp-revoked", thingName: "lamp-revoked", lifecycleStatus: "REVOKED" }));
  repository.seedDevice(device({ deviceId: "lamp-staged", thingName: "lamp-staged", lifecycleStatus: "BOOTSTRAPPED" }));

  assert.deepEqual((await service.listDevices({ userId: "user-a" }, "home-a")).map((item) => item.deviceId), ["lamp-a"]);
  await expectCode(() => service.listDevices({ userId: "user-a" }, "home-b"), "FORBIDDEN", 403);
});

test("device response separates registration lifecycle from recent connectivity", async () => {
  const { repository, service } = fixture();
  repository.seedDevice(device({ deviceId: "fresh", thingName: "fresh", lastSeenAt: "2026-09-04T00:00:30.000Z" }));
  repository.seedDevice(device({ deviceId: "stale", thingName: "stale", lastSeenAt: "2026-09-03T23:55:00.000Z" }));
  repository.seedDevice(device({ deviceId: "unknown", thingName: "unknown" }));
  repository.seedDevice(device({
    deviceId: "pending", thingName: "pending", lastCommandId: "cmd-new", appliedCommandId: "cmd-old",
    desiredState: { power: true, red: 1, green: 2, blue: 3, brightness: 40 },
  }));
  repository.seedDevice(device({
    deviceId: "applied", thingName: "applied", lastCommandId: "cmd-same", appliedCommandId: "cmd-same",
    desiredState: { power: true, red: 1, green: 2, blue: 3, brightness: 40 },
  }));
  const response = await createHandler(service, {
    now: () => new Date("2026-09-04T00:01:00.000Z"),
    onlineFreshnessMs: 150_000,
  })({ method: "GET", path: "/devices", auth: { userId: "user-a" }, query: { tenantId: "home-a" } });
  const rows = (response.body as { devices: Array<{ deviceId: string; online: boolean | null; pendingDesired?: unknown }> }).devices;
  assert.equal(rows.find((row) => row.deviceId === "fresh")?.online, true);
  assert.equal(rows.find((row) => row.deviceId === "stale")?.online, false);
  assert.equal(rows.find((row) => row.deviceId === "unknown")?.online, null);
  assert.deepEqual(rows.find((row) => row.deviceId === "pending")?.pendingDesired, { power: true, red: 1, green: 2, blue: 3, brightness: 40 });
  assert.equal(rows.find((row) => row.deviceId === "applied")?.pendingDesired, undefined);
});

test("claim start verifies membership and stores hashes rather than raw registration secrets", async () => {
  const { repository, service } = fixture();
  const created = await service.createClaim(
    { userId: "user-a" },
    { ...claimInput("serial-1"), serial: SERIAL_A.toUpperCase() },
  );
  const stored = await repository.getClaim(created.claim.claimId);

  assert.equal(created.registrationNonce, registrationNonceFor({ ownerId: "user-a", tenantId: "home-a", poolId: "living", serial: SERIAL_A }, "valid-code"));
  assert.equal(stored?.serial, SERIAL_A);
  assert.equal(stored?.status, "CLAIM_PENDING");
  assert.match(stored?.serialHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(stored?.registrationNonceHash ?? "", /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes("valid-code"), false);
  assert.equal(serialized.includes(created.registrationNonce), false);
  await expectCode(
    () => service.createClaim({ userId: "user-a" }, { ...claimInput("serial-2"), tenantId: "home-b" }),
    "FORBIDDEN",
    403,
  );
});

test("claim start rejects a Pool outside the verified Tenant", async () => {
  const { repository, service } = fixture();
  repository.addPool("home-b", "living");

  await expectCode(
    () => service.createClaim({ userId: "user-a" }, { ...claimInput("serial-1"), poolId: "missing" }),
    "POOL_NOT_FOUND",
    404,
  );
});

test("active serial lock rejects a second claim but an expired lock can be replaced", async () => {
  const { service, setNow } = fixture();
  await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await expectCode(() => service.createClaim({ userId: "user-a" }, claimInput("serial-1")), "SERIAL_ALREADY_CLAIMED", 409);
  setNow("2026-09-04T00:01:01.000Z");
  const replacement = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  assert.equal(replacement.claim.status, "CLAIM_PENDING");
});

test("claim status hides another user's claim and marks expiry explicitly", async () => {
  const { repository, service, setNow } = fixture();
  repository.addMembership("user-b", "home-a");
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await expectCode(() => service.getClaim({ userId: "user-b" }, created.claim.claimId), "CLAIM_NOT_FOUND", 404);
  setNow("2026-09-04T00:01:01.000Z");
  assert.equal((await service.getClaim({ userId: "user-a" }, created.claim.claimId)).status, "EXPIRED");
});

test("finalize returns 503 and leaves the claim pending without an AWS adapter", async () => {
  const { service } = fixture();
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await expectCode(() => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId), "NOT_CONFIGURED", 503);
  assert.equal((await service.getClaim({ userId: "user-a" }, created.claim.claimId)).status, "CLAIM_PENDING");
});

test("verified finalize binds one device and retries idempotently", async () => {
  const provisioning = new FakeProvisioning({ thingName: "d-dev-lamp-serial-1", serial: SERIAL_A, certificateId: "cert-public-id" });
  const { service } = fixture({ provisioning });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  const first = await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);
  const retry = await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);

  assert.equal(first.idempotent, false);
  assert.equal(first.claim.status, "RUNTIME_AUTHORIZED");
  assert.equal(first.device.ownerId, "user-a");
  assert.equal(retry.idempotent, true);
  assert.equal(provisioning.verifyCalls, 1);
  assert.equal(provisioning.authorizeCalls, 1);
});

test("failed policy transition leaves a durable BOOTSTRAPPED binding that cannot receive commands and resumes safely", async () => {
  let failAuthorization = true;
  let authorizationCalls = 0;
  const provisioning: ProvisioningPort = {
    async verifyBootstrap(claim) {
      return { thingName: "lamp-final", serial: claim.serial, certificateId: "cert-public-id" };
    },
    async authorizeRuntime() {
      authorizationCalls += 1;
      if (failAuthorization) throw new AppError("IOT_POLICY_TRANSITION_INCOMPLETE", 502, "retry");
    },
  };
  const { repository, service } = fixture({ provisioning, publisher: new FakePublisher() });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));

  await expectCode(() => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId), "IOT_POLICY_TRANSITION_INCOMPLETE", 502);
  assert.equal((await repository.getClaim(created.claim.claimId))?.status, "BOOTSTRAPPED");
  assert.equal((await repository.getDevice("lamp-final"))?.lifecycleStatus, "BOOTSTRAPPED");
  await expectCode(
    () => service.requestState({ userId: "user-a" }, "lamp-final", "request-a", { power: true }),
    "DEVICE_NOT_READY",
    409,
  );

  failAuthorization = false;
  assert.equal((await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId)).claim.status, "RUNTIME_AUTHORIZED");
  assert.equal(authorizationCalls, 2);
});

test("retry converges after IoT policy transition succeeds but the final DynamoDB promotion response fails", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-final", serial: SERIAL_A, certificateId: "cert-public-id" });
  const { repository, service } = fixture({ provisioning });
  const originalPromote = repository.authorizeRuntimeClaim.bind(repository);
  let failOnce = true;
  repository.authorizeRuntimeClaim = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("simulated DynamoDB outage after IoT transition");
    }
    return originalPromote(...args);
  };
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));

  await assert.rejects(() => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId), /simulated DynamoDB outage/);
  assert.equal((await repository.getClaim(created.claim.claimId))?.status, "BOOTSTRAPPED");
  assert.equal((await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId)).claim.status, "RUNTIME_AUTHORIZED");
  assert.equal(provisioning.authorizeCalls, 2);
});

test("concurrent finalize calls allow only one external provisioning operation", async () => {
  let continueProvisioning = (): void => undefined;
  let signalStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const gate = new Promise<void>((resolve) => { continueProvisioning = resolve; });
  let calls = 0;
  const provisioning: ProvisioningPort = {
    async verifyBootstrap(claim) {
      calls += 1;
      signalStarted();
      await gate;
      return { thingName: "lamp-final", serial: claim.serial, certificateId: "cert-public-id" };
    },
    async authorizeRuntime() {},
  };
  const { service } = fixture({ provisioning });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));

  const first = service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);
  await started;
  await expectCode(
    () => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId),
    "CLAIM_FINALIZE_IN_PROGRESS",
    409,
  );
  assert.equal(calls, 1);
  continueProvisioning();
  assert.equal((await first).claim.status, "RUNTIME_AUTHORIZED");
});

test("a completed claim remains completed after its setup TTL passes", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-final", serial: SERIAL_A, certificateId: "cert-public-id" });
  const { service, setNow } = fixture({ provisioning });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);

  setNow("2026-09-04T00:01:01.000Z");
  assert.equal((await service.getClaim({ userId: "user-a" }, created.claim.claimId)).status, "RUNTIME_AUTHORIZED");
  assert.equal((await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId)).idempotent, true);
});

test("an idempotent finalize rejects a Device that no longer matches its Claim", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-final", serial: SERIAL_A, certificateId: "cert-public-id" });
  const { repository, service } = fixture({ provisioning });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  const finalized = await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);
  repository.seedDevice({ ...finalized.device, tenantId: "home-other" });

  await expectCode(
    () => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId),
    "CLAIM_INCONSISTENT",
    409,
  );
});

test("finalize rechecks expiry after the external provisioning operation", async () => {
  let setFixtureNow: (value: string) => void = () => undefined;
  const provisioning: ProvisioningPort = {
    async verifyBootstrap(claim) {
      setFixtureNow("2026-09-04T00:01:01.000Z");
      return { thingName: "lamp-late", serial: claim.serial, certificateId: "cert-public-id" };
    },
    async authorizeRuntime() {},
  };
  const { service, setNow } = fixture({ provisioning });
  setFixtureNow = setNow;
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));

  await expectCode(() => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId), "CLAIM_EXPIRED", 410);
  assert.equal((await service.getClaim({ userId: "user-a" }, created.claim.claimId)).status, "EXPIRED");
});

test("a serial bound to a completed device cannot be claimed again after the setup TTL", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-final", serial: SERIAL_A, certificateId: "cert-public-id" });
  const { service, setNow } = fixture({ provisioning });
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await service.finalizeClaim({ userId: "user-a" }, created.claim.claimId);

  setNow("2026-09-04T00:01:01.000Z");
  await expectCode(
    () => service.createClaim({ userId: "user-a" }, claimInput("serial-1")),
    "SERIAL_ALREADY_REGISTERED",
    409,
  );
});

test("finalize never reuses an existing Thing even when it has the same owner", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-existing", serial: SERIAL_A, certificateId: "cert-new" });
  const { repository, service } = fixture({ provisioning });
  repository.seedDevice(device({ deviceId: "lamp-existing", thingName: "lamp-existing", serial: "another-serial" }));
  const created = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await expectCode(
    () => service.finalizeClaim({ userId: "user-a" }, created.claim.claimId),
    "DEVICE_ALREADY_REGISTERED",
    409,
  );
});

test("claim start rejects a serial already registered in another tenant", async () => {
  const { repository, service } = fixture();
  repository.addMembership("user-a", "home-b");
  repository.addPool("home-b", "living");
  repository.seedDevice(device({ deviceId: "lamp-existing", thingName: "lamp-existing", tenantId: "home-a" }));
  await expectCode(
    () => service.createClaim(
      { userId: "user-a" },
      { ...claimInput("serial-1"), tenantId: "home-b" },
    ),
    "SERIAL_ALREADY_REGISTERED",
    409,
  );
});

test("state PATCH publishes a command but does not pretend the desired state was applied", async () => {
  const publisher = new FakePublisher();
  const { repository, service } = fixture({ publisher });
  repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a", power: false, brightness: 10 }));

  const accepted = await service.requestState({ userId: "user-a" }, "lamp-a", "request-a", { power: true, brightness: 80 });
  const stored = await repository.getDevice("lamp-a");
  assert.deepEqual(accepted, { status: "ACCEPTED", commandId: "id-1" });
  assert.equal(publisher.calls.length, 1);
  assert.equal(publisher.calls[0]?.commandSequence, 1);
  assert.equal(stored?.power, false);
  assert.equal(stored?.brightness, 10);
  assert.equal(stored?.lastCommandId, "id-1");
  assert.deepEqual(stored?.desiredState, { power: true, red: 0, green: 0, blue: 0, brightness: 80 });

  const retry = await service.requestState({ userId: "user-a" }, "lamp-a", "request-a", { brightness: 80, power: true });
  assert.deepEqual(retry, accepted);
  assert.equal(publisher.calls.length, 2);
  assert.equal(publisher.calls[1]?.commandId, "id-1");
  assert.equal(publisher.calls[1]?.commandSequence, 1);
  await expectCode(
    () => service.requestState({ userId: "user-a" }, "lamp-a", "request-a", { power: false }),
    "REQUEST_ID_REUSED",
    409,
  );
});

test("partial state requests merge against the latest durable desired snapshot", async () => {
  const publisher = new FakePublisher();
  const { repository, service } = fixture({ publisher });
  repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a", power: false, brightness: 10 }));
  await service.requestState({ userId: "user-a" }, "lamp-a", "request-a", { brightness: 80 });
  await service.requestState({ userId: "user-a" }, "lamp-a", "request-b", { power: true });
  assert.deepEqual(publisher.calls[1]?.desired, { power: true, red: 0, green: 0, blue: 0, brightness: 80 });
  assert.equal((await repository.getDevice("lamp-a"))?.lastCommandId, "id-2");
});

test("state PATCH accepts only the requestId and nested desired contract", async () => {
  const publisher = new FakePublisher();
  const { repository, service } = fixture({ publisher });
  repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a" }));
  const handler = createHandler(service);

  const accepted = await handler({
    method: "PATCH",
    path: "/devices/lamp-a/state",
    auth: { userId: "user-a" },
    body: { requestId: "request-http", desired: { power: true, red: 12, green: 34, blue: 56 } },
  });
  assert.equal(accepted.statusCode, 202);
  assert.equal(publisher.calls[0]?.desired.red, 12);

  const legacy = await handler({
    method: "PATCH",
    path: "/devices/lamp-a/state",
    auth: { userId: "user-a" },
    body: { power: true },
  });
  assert.equal(legacy.statusCode, 400);
});

test("state PATCH rejects invalid values, other users, and missing command adapters", async () => {
  const local = fixture({ publisher: new FakePublisher() });
  local.repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a" }));
  await expectCode(() => local.service.requestState({ userId: "user-a" }, "lamp-a", "request-a", { brightness: 101 }), "INVALID_STATE", 400);
  await expectCode(() => local.service.requestState({ userId: "user-b" }, "lamp-a", "request-b", { power: true }), "DEVICE_NOT_FOUND", 404);

  const unconfigured = fixture();
  unconfigured.repository.seedDevice(device({ deviceId: "lamp-a", thingName: "lamp-a" }));
  await expectCode(() => unconfigured.service.requestState({ userId: "user-a" }, "lamp-a", "request-c", { power: true }), "NOT_CONFIGURED", 503);
});

test("release requires confirmed decommissioning and keeps the Device bound when integration is unavailable", async () => {
  const provisioning = new FakeProvisioning({ thingName: "lamp-a", serial: SERIAL_A, certificateId: "cert-old" });
  const { repository, service } = fixture({ provisioning });
  const claim = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await service.finalizeClaim({ userId: "user-a" }, claim.claim.claimId);

  await expectCode(() => service.releaseDevice({ userId: "user-a" }, "lamp-a"), "NOT_CONFIGURED", 503);
  assert.equal((await repository.getDevice("lamp-a"))?.lifecycleStatus, "RUNTIME_AUTHORIZED");
  await expectCode(() => service.createClaim({ userId: "user-a" }, claimInput("serial-1")), "SERIAL_ALREADY_REGISTERED", 409);
});

test("owner release is idempotent and requires an administrator to reissue registration before transfer", async () => {
  const decommissioner = new FakeDecommissioner();
  const firstProvisioning = new FakeProvisioning({ thingName: "lamp-a", serial: SERIAL_A, certificateId: "cert-old" });
  const { repository, service } = fixture({ provisioning: firstProvisioning, decommissioner });
  repository.addMembership("user-b", "home-b");
  repository.addPool("home-b", "living");
  const firstClaim = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await service.finalizeClaim({ userId: "user-a" }, firstClaim.claim.claimId);

  await expectCode(() => service.releaseDevice({ userId: "user-b" }, "lamp-a"), "DEVICE_NOT_FOUND", 404);
  const released = await service.releaseDevice({ userId: "user-a" }, "lamp-a");
  const retry = await service.releaseDevice({ userId: "user-a" }, "lamp-a");
  assert.equal(released.device.lifecycleStatus, "REVOKED");
  assert.equal(released.idempotent, false);
  assert.equal(retry.idempotent, true);
  assert.equal(decommissioner.calls, 1);

  await expectCode(
    () => service.createClaim({ userId: "user-a" }, claimInput("serial-1")),
    "REGISTRATION_REISSUE_REQUIRED",
    409,
  );
  assert.equal((await service.getClaim({ userId: "user-a" }, firstClaim.claim.claimId)).status, "REVOKED");
  await expectCode(
    () => service.finalizeClaim({ userId: "user-a" }, firstClaim.claim.claimId),
    "INVALID_CLAIM_STATE",
    409,
  );
});

test("BOOTSTRAPPED device release is rejected before any external IoT mutation", async () => {
  const decommissioner = new FakeDecommissioner();
  const provisioning: ProvisioningPort = {
    async verifyBootstrap(claim) { return { thingName: "lamp-a", serial: claim.serial, certificateId: "cert-old" }; },
    async authorizeRuntime() { throw new AppError("IOT_POLICY_TRANSITION_INCOMPLETE", 502, "retry"); },
  };
  const { service } = fixture({ provisioning, decommissioner });
  const claim = await service.createClaim({ userId: "user-a" }, claimInput("serial-1"));
  await expectCode(() => service.finalizeClaim({ userId: "user-a" }, claim.claim.claimId), "IOT_POLICY_TRANSITION_INCOMPLETE", 502);
  await expectCode(() => service.releaseDevice({ userId: "user-a" }, "lamp-a"), "DEVICE_NOT_READY", 409);
  assert.equal(decommissioner.calls, 0);
});

test("handler maps authentication and unconfigured integration errors to HTTP responses", async () => {
  const { service } = fixture();
  const handler = createHandler(service);
  assert.equal((await handler({ method: "GET", path: "/devices", query: { tenantId: "home-a" } })).statusCode, 401);
  const created = await handler({ method: "POST", path: "/device-claims", auth: { userId: "user-a" }, body: claimInput("serial-1") });
  assert.equal(created.statusCode, 201);
  const claimId = (created.body as { claimId: string }).claimId;
  const finalized = await handler({ method: "POST", path: `/device-claims/${claimId}/finalize`, auth: { userId: "user-a" } });
  assert.deepEqual(finalized, {
    statusCode: 503,
    body: { error: { code: "NOT_CONFIGURED", message: "AWS IoT provisioning adapter is not configured" } },
  });
});

test("handler returns client errors for malformed Claim fields and auth values", async () => {
  const { service } = fixture();
  const handler = createHandler(service);
  const malformedTenant = await handler({
    method: "POST",
    path: "/device-claims",
    auth: { userId: "user-a" },
    body: { ...claimInput("serial-1"), tenantId: 123 },
  });
  assert.equal(malformedTenant.statusCode, 400);
  assert.equal((malformedTenant.body as { error: { code: string } }).error.code, "INVALID_INPUT");

  const malformedCode = await handler({
    method: "POST",
    path: "/device-claims",
    auth: { userId: "user-a" },
    body: { ...claimInput("serial-1"), registrationCode: 123 },
  });
  assert.equal(malformedCode.statusCode, 400);
  assert.equal((malformedCode.body as { error: { code: string } }).error.code, "INVALID_REGISTRATION_CODE");

  const malformedAuth = await handler({
    method: "GET",
    path: "/devices",
    auth: { userId: 123 as unknown as string },
    query: { tenantId: "home-a" },
  });
  assert.equal(malformedAuth.statusCode, 401);
});

test("default handler cannot create Claims without a configured device registry", async () => {
  const repository = new InMemoryRepository();
  repository.addMembership("user-a", "home-a");
  repository.addPool("home-a", "living");
  const handler = createHandler(new MoodlightService(
    repository,
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    new NotConfiguredCommandPublisher(),
    new NotConfiguredDeviceDecommissioner(),
  ));
  const response = await handler({
    method: "POST",
    path: "/device-claims",
    auth: { userId: "user-a" },
    body: claimInput("serial-1"),
  });
  assert.deepEqual(response, {
    statusCode: 503,
    body: { error: { code: "NOT_CONFIGURED", message: "Device registry is not configured" } },
  });
});

test("handler claim status omits nonce hashes, serial hashes, and raw serial", async () => {
  const { service } = fixture();
  const handler = createHandler(service);
  const created = await handler({ method: "POST", path: "/device-claims", auth: { userId: "user-a" }, body: claimInput("serial-1") });
  const claimId = (created.body as { claimId: string }).claimId;
  const status = await handler({ method: "GET", path: `/device-claims/${claimId}`, auth: { userId: "user-a" } });
  assert.deepEqual(status.body, {
    claimId,
    status: "CLAIM_PENDING",
    expiresAt: "2026-09-04T00:01:00.000Z",
  });
});

function claimInput(serial: string) {
  return { tenantId: "home-a", poolId: "living", serial: serial === "serial-2" ? SERIAL_B : SERIAL_A, registrationCode: "valid-code" };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    deviceId: "lamp-a",
    thingName: "lamp-a",
    ownerId: "user-a",
    tenantId: "home-a",
    poolId: "living",
    serial: SERIAL_A,
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
}
