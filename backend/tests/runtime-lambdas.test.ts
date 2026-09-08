import assert from "node:assert/strict";
import test from "node:test";
import { createIngestLambdaHandler } from "../src/ingest-lambda.ts";
import { createScheduleLambdaHandler } from "../src/schedule-lambda.ts";

test("Ingest Lambda delegates the IoT Rule payload without an HTTP/auth wrapper", async () => {
  const event = { kind: "state" };
  const handler = createIngestLambdaHandler({ async ingest(value) { assert.equal(value, event); return { kind: "state", disposition: "APPLIED" }; } });
  assert.deepEqual(await handler(event), { kind: "state", disposition: "APPLIED" });
});

test("Schedule Lambda separates execution from trusted pending reconciliation", async () => {
  const calls: string[] = [];
  const handler = createScheduleLambdaHandler({
    async executeSchedule() { calls.push("execute"); return { status: "SKIPPED", reason: "NOT_FOUND" }; },
    async reconcilePendingSchedule() { calls.push("reconcile"); return undefined; },
    async reconcileDueSchedules() { calls.push("due"); return { attempted: 2, failed: 1 }; },
  });
  assert.deepEqual(await handler({ tenantId: "t", scheduleId: "s", revision: 1 }), { status: "SKIPPED", reason: "NOT_FOUND" });
  assert.deepEqual(await handler({ action: "RECONCILE", tenantId: "t", scheduleId: "s", revision: 1 }), { status: "RECONCILED" });
  assert.deepEqual(await handler({ action: "RECONCILE_DUE" }), { status: "RECONCILED_DUE", attempted: 2, failed: 1 });
  assert.deepEqual(calls, ["execute", "reconcile", "due"]);
});
