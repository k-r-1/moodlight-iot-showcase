import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { acceptsNativeResponse, bleBlockReason, isCurrentAttempt, wifiFailureKind } from "../lib/registration.ts";

test("BLE adapter states distinguish permission and powered-off recovery", () => {
  assert.equal(bleBlockReason("unauthorized"), "permission");
  assert.equal(bleBlockReason("powered-off"), "powered-off");
  assert.equal(bleBlockReason("powered-on"), null);
});

test("Wi-Fi failures keep distinct safe recovery guidance", () => {
  assert.equal(wifiFailureKind("WIFI_AUTH_FAILED"), "auth");
  assert.equal(wifiFailureKind("WIFI_NOT_FOUND"), "network");
  assert.equal(wifiFailureKind("WIFI_PROVISION_TIMEOUT"), "other");
});

test("same attempt must still match the latest request for that operation", () => {
  const pending = new Map([["wifi.scan", "scan-new"]]);
  const response = { type: "wifi.networks", attemptId: "attempt-a", requestId: "scan-old", payload: { networks: [] } };
  assert.equal(acceptsNativeResponse(response, "attempt-a", pending), false);
  assert.equal(acceptsNativeResponse({ ...response, requestId: "scan-new" }, "attempt-a", pending), true);
  assert.equal(pending.has("wifi.scan"), false);
  assert.equal(acceptsNativeResponse({ ...response, requestId: "scan-new" }, "attempt-a", pending), false);
});

test("multi-event scan remains pending until scanning stops", () => {
  const pending = new Map([["ble.scan", "scan-a"]]);
  const context = { attemptId: "a", requestId: "scan-a" };
  assert.equal(acceptsNativeResponse({ ...context, type: "ble.deviceFound", payload: { id: "one" } }, "a", pending), true);
  assert.equal(pending.has("ble.scan"), true);
  assert.equal(acceptsNativeResponse({ ...context, type: "ble.scanning", payload: { active: false } }, "a", pending), true);
  assert.equal(pending.has("ble.scan"), false);
});

test("leaving or restarting registration rejects late responses and timers", () => {
  const pending = new Map([["ble.connect", "connect-a"]]);
  const response = { type: "ble.connected", attemptId: "attempt-a", requestId: "connect-a", payload: {} };
  assert.equal(acceptsNativeResponse(response, null, pending), false);
  assert.equal(acceptsNativeResponse(response, "attempt-b", pending), false);
  assert.equal(isCurrentAttempt(null, "attempt-a"), false);
  assert.equal(isCurrentAttempt("attempt-b", "attempt-a"), false);
});

test("a known request ID cannot be used for an unrelated event type", () => {
  const pending = new Map([["ble.scan", "request-a"]]);
  assert.equal(acceptsNativeResponse({ type: "device.bootstrapComplete", attemptId: "a", requestId: "request-a", payload: {} }, "a", pending), false);
});

test("unscoped adapter events work but stale scoped errors are ignored", () => {
  assert.equal(acceptsNativeResponse({ type: "ble.state", payload: { state: "powered-on" } }, null, new Map()), true);
  assert.equal(acceptsNativeResponse({ type: "bridge.error", attemptId: "old", requestId: "old", payload: {} }, "new", new Map()), false);
});

test("Wi-Fi connected is terminal for the local provisioning request", () => {
  const pending = new Map([["wifi.provision", "wifi-a"]]);
  const response = {
    type: "provision.progress",
    attemptId: "attempt-a",
    requestId: "wifi-a",
    payload: { stage: "wifi-connected", message: "connected" },
  };
  assert.equal(acceptsNativeResponse(response, "attempt-a", pending), true);
  assert.equal(pending.has("wifi.provision"), false);
});

test("pending Claim resume responses stay outside BLE attempt matching", () => {
  assert.equal(acceptsNativeResponse({
    type: "api.deviceClaims.resumed",
    requestId: "resume-1",
    payload: { claim: { claimId: "claim-a", status: "CLAIM_PENDING" } },
  }, "registration-new", new Map()), false);
});

test("Claim completion waits for ONLINE and logout invalidates pending work", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /message\.payload\.status === "RUNTIME_AUTHORIZED"[\s\S]*requestClaimStatus\(1_500\)/);
  assert.match(source, /message\.payload\.status === "ONLINE"[\s\S]*completeServerRegistration\(\)/);
  assert.doesNotMatch(source, /message\.payload\.status === "RUNTIME_AUTHORIZED" \|\| message\.payload\.status === "ONLINE"\)[\s\S]{0,80}completeServerRegistration/);
  assert.match(source, /RUNTIME_AUTHORIZED[\s\S]{0,500}무드등 전원을 껐다 켜면 운영 연결을 시작/);
  assert.match(source, /status === "signed-out"[\s\S]*authGenerationRef\.current \+= 1[\s\S]*clearControlRequest\(\)[\s\S]*clearScheduleMutation\(\)[\s\S]*cleanupProvisioning\(\)/);
});

test("Fleet polling keeps one waiting screen and offers status retry instead of BLE rescan", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const finalize = source.slice(source.indexOf("function finalizeClaim"), source.indexOf("function completeServerRegistration"));
  assert.doesNotMatch(finalize, /setStage\("bootstrapped"\)/);
  assert.match(finalize, /setStage\("wifi-connected"\)/);
  assert.match(source, /finalizeFailed && message\.payload\.retryable && claimIdRef\.current[\s\S]*setFleetRetryAvailable\(true\)/);
  assert.match(source, /등록 상태 다시 확인/);
  assert.match(source, /claim\.status === "CLAIM_PENDING"[\s\S]{0,500}finalizeClaim\(claim\.claimId\)/);
});
