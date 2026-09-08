import assert from "node:assert/strict";
import test from "node:test";
import { AppError, type Device } from "../src/domain.ts";
import { createHandler } from "../src/handlers.ts";
import { InMemoryRepository } from "../src/in-memory.ts";
import {
  NotConfiguredCommandPublisher,
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
} from "../src/ports.ts";
import { InMemoryScheduleRepository, NotConfiguredScheduler, scheduleDevice, type Schedule, type SchedulerPort } from "../src/schedules.ts";
import { MoodlightService } from "../src/service.ts";

class FakeScheduler implements SchedulerPort {
  upserts: Schedule[] = [];
  removals: Schedule[] = [];

  async upsert(schedule: Schedule): Promise<{ schedulerName: string }> {
    this.upserts.push(structuredClone(schedule));
    return { schedulerName: `schedule-${schedule.scheduleId}` };
  }

  async remove(schedule: Schedule): Promise<void> {
    this.removals.push(structuredClone(schedule));
  }
}

class RevisionRaceRepository extends InMemoryScheduleRepository {
  private raced = false;

  override async markScheduleActive(tenantId: string, scheduleId: string, revision: number, schedulerName: string): Promise<Schedule | undefined> {
    if (revision === 2 && !this.raced) {
      this.raced = true;
      const current = await this.getSchedule(tenantId, scheduleId);
      assert.ok(current);
      await this.saveSchedule({ ...current, name: "revision-3", revision: 3, updatedAt: "2026-09-04T00:03:00.000Z" }, 2);
      return undefined;
    }
    return super.markScheduleActive(tenantId, scheduleId, revision, schedulerName);
  }
}

function fixture(scheduler: SchedulerPort = new FakeScheduler()) {
  const repository = new InMemoryRepository();
  const schedules = new InMemoryScheduleRepository();
  repository.addMembership("user-a", "home-a");
  repository.addMembership("user-b", "home-a");
  repository.seedDevice(device());
  let sequence = 0;
  let current = new Date("2026-09-04T00:00:00.000Z");
  const service = new MoodlightService(
    repository,
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    new NotConfiguredCommandPublisher(),
    new NotConfiguredDeviceDecommissioner(),
    {
      id: () => `schedule-${++sequence}`,
      now: () => current,
      scheduleRepository: schedules,
      scheduler,
    },
  );
  return { repository, schedules, service, setNow: (value: string) => { current = new Date(value); } };
}

test("Schedule CRUD checks tenant membership and device ownership", async () => {
  const scheduler = new FakeScheduler();
  const { service } = fixture(scheduler);
  const created = await service.createSchedule({ userId: "user-a" }, scheduleInput());

  assert.equal(created.syncStatus, "ACTIVE");
  assert.equal(created.revision, 1);
  assert.equal((scheduler.upserts[0] as Schedule).targetCertificateId, "cert-a");
  assert.deepEqual(created.daysOfWeek, [1, 3, 5]);
  assert.equal((await service.listSchedules({ userId: "user-b" }, "home-a")).length, 1);
  await assert.rejects(
    () => service.updateSchedule({ userId: "user-b" }, created.scheduleId, { tenantId: "home-a", expectedRevision: 1, name: "침실" }),
    isError("SCHEDULE_NOT_FOUND", 404),
  );

  const updated = await service.updateSchedule(
    { userId: "user-a" },
    created.scheduleId,
    { tenantId: "home-a", expectedRevision: 1, name: "침실", localTime: "22:30" },
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, "침실");
  assert.equal(updated.syncStatus, "ACTIVE");
  await assert.rejects(
    () => service.updateSchedule({ userId: "user-a" }, created.scheduleId, { tenantId: "home-a", expectedRevision: 1, name: "stale" }),
    isError("SCHEDULE_CONFLICT", 409),
  );

  assert.deepEqual(await service.deleteSchedule({ userId: "user-a" }, "home-a", created.scheduleId, 2), { revision: 3 });
  assert.equal(scheduler.removals[0]?.revision, 3);
  await assert.rejects(
    () => service.getSchedule({ userId: "user-a" }, "home-a", created.scheduleId),
    isError("SCHEDULE_NOT_FOUND", 404),
  );
});

test("Schedule targets are limited to devices that completed the first runtime state", () => {
  assert.throws(
    () => scheduleDevice({ ...device(), lifecycleStatus: "RUNTIME_AUTHORIZED" }, "user-a", "home-a"),
    isError("DEVICE_NOT_READY", 409),
  );
  assert.equal(scheduleDevice(device(), "user-a", "home-a").deviceId, "lamp-a");
});

test("failed Schedule sync is retryable and stale callbacks cannot overwrite a newer revision", async () => {
  const { schedules, service } = fixture(new NotConfiguredScheduler());
  await assert.rejects(
    () => service.createSchedule({ userId: "user-a" }, scheduleInput()),
    isError("NOT_CONFIGURED", 503),
  );
  const failed = (await schedules.listSchedules("home-a"))[0];
  assert.equal(failed?.syncStatus, "ERROR");
  assert.equal(failed?.failureCode, "NOT_CONFIGURED");
  assert.equal(failed?.retryAt, "2026-09-04T00:01:00.000Z");

  const retryService = fixtureWithStore(schedules, new FakeScheduler());
  const active = await retryService.retrySchedule({ userId: "user-a" }, "home-a", failed!.scheduleId, 1);
  assert.equal(active?.revision, 1);
  assert.equal(active?.syncStatus, "ACTIVE");
  assert.equal(await retryService.completeScheduleSync("home-a", failed!.scheduleId, 1, "old-callback"), false);
  assert.equal((await schedules.getSchedule("home-a", failed!.scheduleId))?.schedulerName, `schedule-${failed!.scheduleId}`);

  const reconciled = await retryService.reconcileSchedule({ userId: "user-a" }, "home-a", failed!.scheduleId, 1);
  assert.equal(reconciled?.revision, 2);
  assert.equal(reconciled?.syncStatus, "ACTIVE");
});

test("a lost revision-2 callback redrives revision 3 so the external schedule converges", async () => {
  const schedules = new RevisionRaceRepository();
  const scheduler = new FakeScheduler();
  const service = fixtureWithStore(schedules, scheduler);
  const created = await service.createSchedule({ userId: "user-a" }, scheduleInput());

  const converged = await service.updateSchedule(
    { userId: "user-a" },
    created.scheduleId,
    { tenantId: "home-a", expectedRevision: 1, name: "revision-2" },
  );

  assert.equal(converged.revision, 3);
  assert.equal(converged.name, "revision-3");
  assert.equal(converged.syncStatus, "ACTIVE");
  assert.deepEqual(scheduler.upserts.map((item) => item.revision), [1, 2, 3]);
});

test("Schedule handler exposes safe response fields and action routes", async () => {
  const { service } = fixture();
  const handler = createHandler(service);
  const created = await handler({ method: "POST", path: "/schedules", auth: { userId: "user-a" }, body: scheduleInput() });
  assert.equal(created.statusCode, 201);
  assert.equal("ownerId" in (created.body as Record<string, unknown>), false);
  const scheduleId = (created.body as { scheduleId: string }).scheduleId;
  const removed = await handler({
    method: "POST",
    path: `/schedules/${scheduleId}/delete`,
    auth: { userId: "user-a" },
    body: { tenantId: "home-a", expectedRevision: 1 },
  });
  assert.deepEqual(removed, { statusCode: 200, body: { deleted: true, revision: 2 } });
});

function fixtureWithStore(schedules: InMemoryScheduleRepository, scheduler: SchedulerPort): MoodlightService {
  const repository = new InMemoryRepository();
  repository.addMembership("user-a", "home-a");
  repository.seedDevice(device());
  return new MoodlightService(
    repository,
    new NotConfiguredClaimRegistrar(),
    new NotConfiguredProvisioning(),
    new NotConfiguredCommandPublisher(),
    new NotConfiguredDeviceDecommissioner(),
    { scheduleRepository: schedules, scheduler, now: () => new Date("2026-09-04T00:02:00.000Z") },
  );
}

function scheduleInput() {
  return {
    tenantId: "home-a",
    name: "저녁 조명",
    targetType: "DEVICE" as const,
    targetId: "lamp-a",
    enabled: true,
    timezone: "Asia/Seoul",
    localTime: "21:00",
    daysOfWeek: [5, 1, 3, 1],
    desiredState: { power: true, brightness: 40 },
  };
}

function device(): Device {
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
  };
}

function isError(code: string, status: number) {
  return (error: unknown) => error instanceof AppError && error.code === code && error.status === status;
}
