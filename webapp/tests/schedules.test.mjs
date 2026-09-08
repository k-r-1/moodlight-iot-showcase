import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptsScheduleResult,
  newScheduleDraft,
  parseScheduleList,
  scheduleWritePayload,
} from "../lib/schedules.ts";

const schedule = {
  scheduleId: "schedule-a", name: "Bedtime", targetType: "DEVICE", targetId: "lamp-a",
  enabled: true, timezone: "Asia/Seoul", localTime: "23:00", daysOfWeek: [1, 2, 3, 4, 5],
  desiredState: { power: true, red: 255, green: 128, blue: 64, brightness: 40 },
  syncStatus: "ACTIVE", revision: 2,
  createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:01:00.000Z",
};

test("schedule parser preserves sync status and revision", () => {
  assert.deepEqual(parseScheduleList({ schedules: [schedule] }), [schedule]);
  assert.throws(() => parseScheduleList({ schedules: [{ ...schedule, syncStatus: "READY" }] }), /invalid-schedule/);
  assert.throws(() => parseScheduleList({ schedules: [{ ...schedule, revision: 0 }] }), /invalid-schedule/);
});

test("write payload contains no token or tenant and normalizes weekdays", () => {
  const payload = scheduleWritePayload({ ...newScheduleDraft({ id: "lamp-a", name: "Lamp", room: "room", online: true, power: false, color: "#010203", brightness: 10 }), name: " Night ", daysOfWeek: [5, 1, 5] });
  assert.deepEqual(payload.daysOfWeek, [1, 5]);
  assert.equal(payload.name, "Night");
  assert.equal("tenantId" in payload, false);
  assert.equal("accessToken" in payload, false);
});

test("mutation result rejects stale revisions, request IDs, and schedule IDs", () => {
  const pending = { requestId: "new", operation: "update", scheduleId: "schedule-a", expectedRevision: 2 };
  assert.equal(acceptsScheduleResult(pending, { requestId: "old", payload: { operation: "update", schedule } }), false);
  assert.equal(acceptsScheduleResult(pending, { requestId: "new", payload: { operation: "update", schedule: { ...schedule, scheduleId: "schedule-b", revision: 3 } } }), false);
  assert.equal(acceptsScheduleResult(pending, { requestId: "new", payload: { operation: "update", schedule } }), false);
  assert.equal(acceptsScheduleResult(pending, { requestId: "new", payload: { operation: "update", schedule: { ...schedule, revision: 3 } } }), true);
});
