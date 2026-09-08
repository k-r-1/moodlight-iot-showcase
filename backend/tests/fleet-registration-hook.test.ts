import assert from "node:assert/strict";
import test from "node:test";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createFleetRegistrationHook } from "../src/fleet-registration-hook.ts";

const config = {
  registryTable: "moodlight-device-registry",
  templateArn: "arn:aws:iot:ap-northeast-2:123456789012:provisioningtemplate/moodlight-fleet",
  claimCertificateId: "a".repeat(64),
  clientIdPrefix: "openiot-moodlight-demo-test-dev-claim-",
};

class FakeClient {
  readonly commands: UpdateCommand[] = [];
  private readonly failure: Error | undefined;
  constructor(failure?: Error) { this.failure = failure; }
  async send(command: UpdateCommand): Promise<Record<string, unknown>> {
    this.commands.push(command);
    if (this.failure) throw this.failure;
    return { Attributes: { tenantId: "tenant-a", poolId: "living" } };
  }
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    templateArn: config.templateArn,
    claimCertificateId: config.claimCertificateId,
    certificateId: "b".repeat(64),
    clientId: `${config.clientIdPrefix}001122334455`,
    parameters: {
      SerialNumber: "001122334455",
      ClaimId: "claim-12345678",
      RegistrationNonceHash: "c".repeat(64),
      "AWS::IoT::Certificate::Id": "b".repeat(64),
    },
    ...overrides,
  };
}

test("allows one exact reserved device request and stores no raw secret", async () => {
  const client = new FakeClient();
  const response = await createFleetRegistrationHook(client, config)(event());
  assert.deepEqual(response, {
    allowProvisioning: true,
    parameterOverrides: {
      SerialNumber: "001122334455",
      TenantId: "tenant-a",
      PoolId: "living",
    },
  });
  const command = client.commands[0];
  assert.ok(command);
  assert.equal(command.input.TableName, "moodlight-device-registry");
  assert.equal(command.input.Key?.serialHash, "a9b2ad6f4919c2ddcc2e04825227372ce079c0fe392d636d293d9f048a2c7926");
  const serialized = JSON.stringify(command.input);
  assert.equal(serialized.includes("registrationCode"), false);
  assert.match(command.input.ConditionExpression ?? "", /#reservationExpiresAt > :nowEpoch/);
  assert.match(command.input.ConditionExpression ?? "", /#latestCertificateId = :certificateId/);
  assert.match(command.input.UpdateExpression ?? "", /#attemptCount = if_not_exists\(#attemptCount, :one\)/);
  assert.doesNotMatch(command.input.UpdateExpression ?? "", /#attemptCount.*\+/);
  assert.equal(command.input.ReturnValues, "ALL_NEW");
});

test("fails closed when the registry has no server-owned tenant or pool", async () => {
  class MissingScopeClient extends FakeClient {
    override async send(command: UpdateCommand): Promise<Record<string, unknown>> {
      this.commands.push(command);
      return { Attributes: { tenantId: "tenant-a" } };
    }
  }
  const client = new MissingScopeClient();
  assert.deepEqual(await createFleetRegistrationHook(client, config)(event()), { allowProvisioning: false });
  assert.equal(client.commands.length, 1);
});

for (const [name, patch] of [
  ["wrong template", { templateArn: "arn:wrong" }],
  ["wrong claim certificate", { claimCertificateId: "d".repeat(64) }],
  ["wrong client id", { clientId: "another-project-001122334455" }],
  ["unknown parameter", { parameters: { ...event().parameters, TenantId: "attacker" } }],
  ["certificate mismatch", { parameters: { ...event().parameters, "AWS::IoT::Certificate::Id": "e".repeat(64) } }],
] as const) {
  test(`denies ${name}`, async () => {
    const client = new FakeClient();
    assert.deepEqual(await createFleetRegistrationHook(client, config)(event(patch)), { allowProvisioning: false });
    assert.equal(client.commands.length, 0);
  });
}

test("fails closed when the registry condition or AWS call fails", async () => {
  const client = new FakeClient(Object.assign(new Error("conditional failure"), { name: "ConditionalCheckFailedException" }));
  assert.deepEqual(await createFleetRegistrationHook(client, config)(event()), { allowProvisioning: false });
  assert.equal(client.commands.length, 1);
});

test("pins the first certificate and makes the same-certificate retry non-consuming", async () => {
  const client = new FakeClient();
  const hook = createFleetRegistrationHook(client, config);

  assert.equal((await hook(event())).allowProvisioning, true);
  assert.equal((await hook(event())).allowProvisioning, true);
  assert.equal(client.commands.length, 2);
  for (const command of client.commands) {
    assert.match(command.input.ConditionExpression ?? "", /attribute_not_exists\(#latestCertificateId\) OR #latestCertificateId = :certificateId/);
    assert.match(command.input.UpdateExpression ?? "", /#attemptCount = if_not_exists\(#attemptCount, :one\)/);
    assert.doesNotMatch(command.input.UpdateExpression ?? "", /#attemptCount.*\+/);
  }
});
