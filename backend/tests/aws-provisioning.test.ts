import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type DeviceClaim } from "../src/domain.ts";
import { AwsProvisioning } from "../src/aws-provisioning.ts";

const certificateId = "a".repeat(64);
const certificateArn = `arn:aws:iot:ap-northeast-2:123456789012:cert/${certificateId}`;
const options = {
  registryTable: "moodlight-registry",
  thingNamePrefix: "openiot-test-dev-lamp-",
  thingTypeName: "openiot-test-dev-moodlamp",
  certificateArnPrefix: "arn:aws:iot:ap-northeast-2:123456789012:cert/",
  bootstrapPolicyName: "openiot-test-dev-bootstrap",
  runtimePolicyName: "openiot-test-dev-runtime",
};

class FakeSender {
  readonly commands: unknown[] = [];
  private readonly outputs: unknown[];
  constructor(outputs: unknown[]) { this.outputs = outputs; }
  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    const output = this.outputs.shift();
    if (output instanceof Error) throw output;
    return output ?? {};
  }
}

test("bootstrap verification is read-only and binds Registry, Thing attributes, certificate, and bootstrap policy", async () => {
  const registry = new FakeSender([{ Item: registryItem() }]);
  const iot = new FakeSender([
    { thingName: thingName(), thingTypeName: options.thingTypeName, attributes: { serial: "serial-a", tenant_id: "home-a", pool_id: "living" } },
    { principals: [certificateArn] },
    { certificateDescription: { certificateId, certificateArn, status: "ACTIVE" } },
    { policies: [{ policyName: options.bootstrapPolicyName }] },
  ]);
  const provisioning = new AwsProvisioning(iot, registry, options);

  assert.deepEqual(await provisioning.verifyBootstrap(claim()), {
    thingName: thingName(), serial: "serial-a", certificateId,
  });
  assert.deepEqual(iot.commands.map((command) => command?.constructor.name), [
    "DescribeThingCommand", "ListThingPrincipalsCommand", "DescribeCertificateCommand", "ListAttachedPoliciesCommand",
  ]);
  assert.equal(iot.commands.some((command) => ["AttachPolicyCommand", "DetachPolicyCommand"].includes(command?.constructor.name ?? "")), false);
});

test("reserved Registry rejects a runtime-only certificate and mismatched Thing ownership", async () => {
  const runtimeOnly = new AwsProvisioning(new FakeSender([
    { thingName: thingName(), thingTypeName: options.thingTypeName, attributes: { serial: "serial-a", tenant_id: "home-a", pool_id: "living" } },
    { principals: [certificateArn] },
    { certificateDescription: { certificateId, certificateArn, status: "ACTIVE" } },
    { policies: [{ policyName: options.runtimePolicyName }] },
  ]), new FakeSender([{ Item: registryItem() }]), options);
  await assert.rejects(() => runtimeOnly.verifyBootstrap(claim()), hasCode("IOT_POLICY_TRANSITION_INVALID"));

  const wrongTenant = new AwsProvisioning(new FakeSender([
    { thingName: thingName(), thingTypeName: options.thingTypeName, attributes: { serial: "serial-a", tenant_id: "other", pool_id: "living" } },
  ]), new FakeSender([{ Item: registryItem() }]), options);
  await assert.rejects(() => wrongTenant.verifyBootstrap(claim()), hasCode("IOT_THING_MISMATCH"));
});

test("reserved Registry without a Fleet certificate remains retryable", async () => {
  const item = registryItem();
  delete item.latestCertificateId;
  const provisioning = new AwsProvisioning(new FakeSender([]), new FakeSender([{ Item: item }]), options);

  await assert.rejects(() => provisioning.verifyBootstrap(claim()), hasCode("PROVISIONING_PENDING"));
});

test("runtime authorization attaches runtime first, detaches bootstrap, and is retry-safe", async () => {
  const iot = new FakeSender([
    { policies: [{ policyName: options.bootstrapPolicyName }] },
    {},
    {},
    { policies: [{ policyName: options.runtimePolicyName }] },
  ]);
  const provisioning = new AwsProvisioning(iot, new FakeSender([]), options);
  await provisioning.authorizeRuntime({ ...claim(), status: "BOOTSTRAPPED", thingName: thingName() }, {
    thingName: thingName(), serial: "serial-a", certificateId,
  });

  assert.deepEqual(iot.commands.map((command) => command?.constructor.name), [
    "ListAttachedPoliciesCommand", "AttachPolicyCommand", "DetachPolicyCommand", "ListAttachedPoliciesCommand",
  ]);
  assert.equal((iot.commands[1] as { input?: { target?: string } }).input?.target, certificateArn);

  const retryIot = new FakeSender([
    { policies: [{ policyName: options.runtimePolicyName }] },
    { policies: [{ policyName: options.runtimePolicyName }] },
  ]);
  await new AwsProvisioning(retryIot, new FakeSender([]), options).authorizeRuntime(
    { ...claim(), status: "BOOTSTRAPPED", thingName: thingName() },
    { thingName: thingName(), serial: "serial-a", certificateId },
  );
  assert.deepEqual(retryIot.commands.map((command) => command?.constructor.name), [
    "ListAttachedPoliciesCommand", "ListAttachedPoliciesCommand",
  ]);
});

function claim(): DeviceClaim {
  return {
    claimId: "claim-a", ownerId: "user-a", tenantId: "home-a", poolId: "living",
    serial: "serial-a", serialHash: "serial-hash", registrationNonceHash: "nonce-hash",
    status: "CLAIM_PENDING", expiresAt: "2026-09-07T01:00:00.000Z",
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

function registryItem(): Record<string, unknown> {
  return {
    status: "RESERVED", claimId: "claim-a", ownerId: "user-a", tenantId: "home-a", poolId: "living",
    serial: "serial-a", nonceHash: "nonce-hash", latestCertificateId: certificateId,
  };
}

function thingName(): string { return `${options.thingNamePrefix}serial-a`; }
function hasCode(code: string) {
  return (error: unknown): boolean => error instanceof AppError && error.code === code;
}
