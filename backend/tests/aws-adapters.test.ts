import assert from "node:assert/strict";
import test from "node:test";
import { AwsIotCommandPublisher, AwsIotDeviceDecommissioner } from "../src/aws-iot.ts";
import { AwsSchedulerAdapter } from "../src/aws-scheduler.ts";
import type { Device } from "../src/domain.ts";
import type { Schedule } from "../src/schedules.ts";

const device: Device = {
  deviceId: "device-a", thingName: "project-lamp-a", ownerId: "user-a", tenantId: "home-a", poolId: "default", serial: "S1",
  certificateId: "cert-a", name: "Lamp", lifecycleStatus: "ACTIVE", power: false, red: 0, green: 0, blue: 0,
  brightness: 0, version: 1,
};

const schedule: Schedule = {
  tenantId: "home-a", scheduleId: "schedule-a", ownerId: "user-a", name: "Morning", targetType: "DEVICE",
  targetId: "device-a", targetCertificateId: "cert-a", enabled: true, timezone: "Asia/Seoul", localTime: "07:05",
  daysOfWeek: [1, 3, 5], desiredState: { power: true, red: 1 }, syncStatus: "PENDING_SYNC", pendingOperation: "UPSERT",
  revision: 2, createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
};

test("IoT publisher uses the device-scoped command topic with QoS 1 and no retained message", async () => {
  const commands: unknown[] = [];
  const publisher = new AwsIotCommandPublisher({ async send(command) { commands.push(command); return {}; } }, "moodlight/dev/tenants");
  await publisher.publish(device, "cmd-a", 7, { power: true, red: 10, green: 20, blue: 30, brightness: 40 });
  const input = (commands[0] as { input: Record<string, unknown> }).input;
  assert.equal(input.topic, "moodlight/dev/tenants/home-a/pools/default/project-lamp-a/cmd");
  assert.equal(input.qos, 1);
  assert.equal(input.retain, false);
  assert.deepEqual(JSON.parse(Buffer.from(input.payload as Uint8Array).toString("utf8")), {
    commandId: "cmd-a", commandSequence: 7, power: true, red: 10, green: 20, blue: 30, brightness: 40,
  });
});

test("decommission disables the certificate, detaches managed policy/principal, then deletes the empty Thing", async () => {
  const names: string[] = [];
  let principalReads = 0;
  const decommissioner = new AwsIotDeviceDecommissioner({
    async send(command) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      names.push(name);
      if (name === "ListAttachedPoliciesCommand") return { policies: [{ policyName: "project-runtime" }] };
      if (name === "ListThingPrincipalsCommand") return { principals: principalReads++ === 0 ? ["arn:aws:iot:ap-northeast-2:123456789012:cert/cert-a"] : [] };
      return {};
    },
  }, {
    certificateArnPrefix: "arn:aws:iot:ap-northeast-2:123456789012:cert/",
    policyNamePrefix: "project-",
    thingNamePrefix: "project-lamp-",
  });
  const result = await decommissioner.decommission(device);
  assert.equal(result.thingDeleted, true);
  assert.deepEqual(names, ["ListThingPrincipalsCommand", "ListAttachedPoliciesCommand", "UpdateCertificateCommand", "DetachPolicyCommand", "DetachThingPrincipalCommand", "ListThingPrincipalsCommand", "DeleteThingCommand"]);
});

test("decommission makes no AWS mutation when the stored certificate is not attached to the managed Thing", async () => {
  const names: string[] = [];
  const decommissioner = new AwsIotDeviceDecommissioner({
    async send(command) {
      const name = (command as { constructor: { name: string } }).constructor.name;
      names.push(name);
      if (name === "ListThingPrincipalsCommand") return { principals: [] };
      return {};
    },
  }, {
    certificateArnPrefix: "arn:aws:iot:ap-northeast-2:123456789012:cert/",
    policyNamePrefix: "project-",
    thingNamePrefix: "project-lamp-",
  });
  await assert.rejects(
    () => decommissioner.decommission(device),
    (error: unknown) => error instanceof Error && error.message.includes("not attached"),
  );
  assert.deepEqual(names, ["ListThingPrincipalsCommand"]);
});

test("decommission rejects a Thing outside the managed project before any AWS call", async () => {
  const names: string[] = [];
  const decommissioner = new AwsIotDeviceDecommissioner({
    async send(command) {
      names.push((command as { constructor: { name: string } }).constructor.name);
      return {};
    },
  }, {
    certificateArnPrefix: "arn:aws:iot:ap-northeast-2:123456789012:cert/",
    policyNamePrefix: "project-",
    thingNamePrefix: "project-lamp-",
  });

  await assert.rejects(
    () => decommissioner.decommission({ ...device, thingName: "another-project-lamp-a" }),
    (error: unknown) => error instanceof Error && error.message.includes("outside the managed project prefix"),
  );
  assert.deepEqual(names, []);
});

test("scheduler creates a deterministic cron target and later deletes it idempotently", async () => {
  const commands: unknown[] = [];
  const client = { async send(command: unknown) {
    commands.push(command);
    if ((command as { constructor: { name: string } }).constructor.name === "GetScheduleCommand") {
      const error = new Error("missing"); error.name = "ResourceNotFoundException"; throw error;
    }
    return {};
  } };
  const adapter = new AwsSchedulerAdapter(client, {
    groupName: "project-dev", namePrefix: "project-dev",
    targetArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:scheduled",
    executionRoleArn: "arn:aws:iam::123456789012:role/scheduler",
  });
  const receipt = await adapter.upsert(schedule);
  assert.match(receipt.schedulerName, /^project-dev-[a-f0-9]{32}$/);
  const create = commands[1] as { input: Record<string, unknown> };
  assert.equal(create.input.ScheduleExpression, "cron(5 7 ? * MON,WED,FRI *)");
  assert.deepEqual(JSON.parse((create.input.Target as { Input: string }).Input), { tenantId: "home-a", scheduleId: "schedule-a", revision: 2, scheduledTime: "<aws.scheduler.scheduled-time>" });
  assert.deepEqual((create.input.Target as { RetryPolicy: unknown }).RetryPolicy, { MaximumEventAgeInSeconds: 120, MaximumRetryAttempts: 3 });
});

test("scheduler ignores stale upsert and delete after a newer remote revision", async () => {
  const commands: unknown[] = [];
  const client = { async send(command: unknown) {
    commands.push(command);
    if ((command as { constructor: { name: string } }).constructor.name === "GetScheduleCommand") {
      return { Target: { Input: JSON.stringify({ tenantId: "home-a", scheduleId: "schedule-a", revision: 3 }) } };
    }
    return {};
  } };
  const adapter = new AwsSchedulerAdapter(client, {
    groupName: "project-dev", namePrefix: "ml-1234567890abcdef",
    targetArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:scheduled",
    executionRoleArn: "arn:aws:iam::123456789012:role/scheduler",
  });
  await adapter.upsert({ ...schedule, revision: 2 });
  await adapter.remove({ ...schedule, revision: 2 });
  assert.deepEqual(commands.map((command) => (command as { constructor: { name: string } }).constructor.name), ["GetScheduleCommand", "GetScheduleCommand"]);
  assert.throws(() => new AwsSchedulerAdapter(client, {
    groupName: "project-dev", namePrefix: "x".repeat(32),
    targetArn: "arn:aws:lambda:ap-northeast-2:123456789012:function:scheduled",
    executionRoleArn: "arn:aws:iam::123456789012:role/scheduler",
  }), /SCHEDULE_NAME_PREFIX/);
});
