import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type DesiredState, type Device } from "../src/domain.ts";
import { InMemoryRepository } from "../src/in-memory.ts";
import {
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
  type CommandPublisher,
} from "../src/ports.ts";
import {
  InMemoryScheduleRepository,
  NotConfiguredScheduler,
  type Schedule,
  type SchedulerPort,
} from "../src/schedules.ts";
import { MoodlightService } from "../src/service.ts";

class FakeScheduler implements SchedulerPort {
  readonly upserts: Schedule[] = [];
  readonly removals: Schedule[] = [];

  async upsert(schedule: Schedule): Promise<{ schedulerName: string }> {
    this.upserts.push(structuredClone(schedule));
    return { schedulerName: "scheduler-" + schedule.scheduleId };
  }

  async remove(schedule: Schedule): Promise<void> {
    this.removals.push(structuredClone(schedule));
  }
}

class FakePublisher implements CommandPublisher {
  readonly calls: Array<{ device: Device; commandId: string; commandSequence: number; desired: DesiredState }> = [];

  async publish(device: Device, commandId: string, commandSequence: number, desired: DesiredState): Promise<void> {
    this.calls.push({ device: structuredClone(device), commandId, commandSequence, desired: structuredClone(desired) });
  }
}

function service(
  repository: InMemoryRepository,
  schedules: InMemoryScheduleRepository,
  scheduler: SchedulerPort,
  publisher: CommandPublisher = new FakePublisher(),
): MoodlightService {
  let sequence = 0;
  return new MoodlightService(
    repository,
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    publisher,
    new NotConfiguredDeviceDecommissioner(),
    {
      id: () => "generated-" + ++sequence,
      now: () => new Date("2026-09-05T00:00:00.000Z"),
      scheduleRepository: schedules,
      scheduler,
    },
  );
}

test("pending Schedule operations redrive the same revision", async () => {
  const repository = new InMemoryRepository();
  const schedules = new InMemoryScheduleRepository();
  const scheduler = new FakeScheduler();
  repository.addMembership("user-a", "home-a");
  repository.seedDevice(device());
  await schedules.saveSchedule(schedule({ revision: 7, syncStatus: "PENDING_SYNC" }));

  const moodlight = service(repository, schedules, scheduler);
  const active = await moodlight.reconcileSchedule({ userId: "user-a" }, "home-a", "schedule-a", 7);
  assert.equal(active?.revision, 7);
  assert.equal(active?.syncStatus, "ACTIVE");
  assert.equal(scheduler.upserts[0]?.revision, 7);

  await schedules.saveSchedule(schedule({
    scheduleId: "schedule-delete",
    revision: 3,
    syncStatus: "DELETE_PENDING",
    pendingOperation: "DELETE",
  }));
  const removed = await moodlight.reconcileSchedule({ userId: "user-a" }, "home-a", "schedule-delete", 3);
  assert.equal(removed, undefined);
  assert.equal(scheduler.removals[0]?.revision, 3);
  assert.equal(await schedules.getSchedule("home-a", "schedule-delete"), undefined);
});

test("scheduled execution publishes only for the active bound device generation", async () => {
  const repository = new InMemoryRepository();
  const schedules = new InMemoryScheduleRepository();
  const publisher = new FakePublisher();
  repository.addMembership("user-a", "home-a");
  repository.seedDevice(device());
  await schedules.saveSchedule(schedule({ syncStatus: "ACTIVE" }));
  const moodlight = service(repository, schedules, new FakeScheduler(), publisher);

  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1, scheduledTime: "2026-09-05T12:00:00Z" }),
    { status: "PUBLISHED", commandId: "generated-1" },
  );
  assert.deepEqual(publisher.calls[0]?.desired, { power: true, red: 0, green: 0, blue: 0, brightness: 40 });
  assert.equal(publisher.calls[0]?.commandSequence, 1);
  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1, scheduledTime: "2026-09-05T12:00:00Z" }),
    { status: "PUBLISHED", commandId: "generated-1" },
  );

  assert.equal(publisher.calls[1]?.commandSequence, 1);

  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1, scheduledTime: "2026-09-04T23:58:29Z" }),
    { status: "SKIPPED", reason: "STALE_DELIVERY" },
  );
  assert.equal(publisher.calls.length, 2);

  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 2 }),
    { status: "SKIPPED", reason: "STALE_REVISION" },
  );

  repository.seedDevice(device({ certificateId: "cert-new" }));
  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1 }),
    { status: "SKIPPED", reason: "TARGET_GENERATION_CHANGED" },
  );
  assert.equal(publisher.calls.length, 2);
});

test("scheduled execution fails closed for inactive schedule, device, or membership", async () => {
  const repository = new InMemoryRepository();
  const schedules = new InMemoryScheduleRepository();
  repository.addMembership("user-a", "home-a");
  repository.seedDevice(device());
  const moodlight = service(repository, schedules, new FakeScheduler());

  await schedules.saveSchedule(schedule());
  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1 }),
    { status: "SKIPPED", reason: "NOT_ACTIVE" },
  );

  await schedules.saveSchedule(schedule({ syncStatus: "ACTIVE", enabled: false }), 1);
  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1 }),
    { status: "SKIPPED", reason: "DISABLED" },
  );

  await schedules.saveSchedule(schedule({ syncStatus: "ACTIVE" }), 1);
  repository.seedDevice(device({ lifecycleStatus: "RUNTIME_AUTHORIZED" }));
  assert.deepEqual(
    await moodlight.executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1 }),
    { status: "SKIPPED", reason: "DEVICE_INACTIVE" },
  );

  const noMembershipRepository = new InMemoryRepository();
  noMembershipRepository.seedDevice(device());
  const noMembershipSchedules = new InMemoryScheduleRepository();
  await noMembershipSchedules.saveSchedule(schedule({ syncStatus: "ACTIVE" }));
  assert.deepEqual(
    await service(noMembershipRepository, noMembershipSchedules, new FakeScheduler())
      .executeSchedule({ tenantId: "home-a", scheduleId: "schedule-a", revision: 1 }),
    { status: "SKIPPED", reason: "MEMBERSHIP_INACTIVE" },
  );
});

test("release cleanup retries failed deletion on the same revision", async () => {
  const repository = new InMemoryRepository();
  const schedules = new InMemoryScheduleRepository();
  repository.addMembership("user-a", "home-a");
  repository.seedDevice(device({ lifecycleStatus: "REVOKED" }));
  await schedules.saveSchedule(schedule({ syncStatus: "ACTIVE" }));

  const unavailable = service(repository, schedules, new NotConfiguredScheduler());
  await assert.rejects(
    () => unavailable.releaseDevice({ userId: "user-a" }, "lamp-a"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_CONFIGURED",
  );
  const failed = await schedules.getSchedule("home-a", "schedule-a");
  assert.equal(failed?.syncStatus, "ERROR");
  assert.equal(failed?.pendingOperation, "DELETE");
  assert.equal(failed?.revision, 2);

  const scheduler = new FakeScheduler();
  const retry = service(repository, schedules, scheduler);
  assert.equal((await retry.releaseDevice({ userId: "user-a" }, "lamp-a")).idempotent, true);
  assert.equal(scheduler.removals[0]?.revision, 2);
  assert.equal(await schedules.getSchedule("home-a", "schedule-a"), undefined);
});

function schedule(overrides: Partial<Schedule> = {}): Schedule {
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
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
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
