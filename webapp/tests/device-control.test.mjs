import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  acceptsStateAccepted,
  commandApplied,
  desiredFromDraft,
  desiredMatchesDevice,
  draftFromDevice,
  hasPendingDesired,
} from "../lib/device-control.ts";

const device = {
  id: "lamp-a", name: "Living lamp", room: "living", online: true,
  power: false, color: "#0110ff", brightness: 72,
};

test("control draft converts to desired state without changing actual state", () => {
  const draft = { ...draftFromDevice(device), power: true, color: "#ff8060", brightness: 40 };
  assert.deepEqual(desiredFromDraft(draft), {
    power: true, red: 255, green: 128, blue: 96, brightness: 40,
  });
  assert.equal(device.power, false);
  assert.equal(device.color, "#0110ff");
});

test("pending desired is distinct from the last observed device state", () => {
  const pending = {
    ...device,
    desiredState: { power: true, color: "#ff8060", brightness: 40 },
    lastCommandId: "command-new",
    appliedCommandId: "command-old",
  };
  assert.equal(hasPendingDesired(pending), true);
  assert.equal(pending.power, false);
  assert.equal(hasPendingDesired({ ...pending, appliedCommandId: "command-new" }), false);
});

test("accepted response must match the latest request and device", () => {
  const pending = {
    requestId: "state-new", deviceId: "lamp-a", accepted: false,
    desired: desiredFromDraft({ power: true, color: "#ffffff", brightness: 50 }),
  };
  assert.equal(acceptsStateAccepted(pending, { requestId: "state-old", payload: { deviceId: "lamp-a" } }), false);
  assert.equal(acceptsStateAccepted(pending, { requestId: "state-new", payload: { deviceId: "lamp-b" } }), false);
  assert.equal(acceptsStateAccepted(pending, { requestId: "state-new", payload: { deviceId: "lamp-a" } }), true);
});

test("matching state values do not confirm a different or uncorrelated command", () => {
  const desired = desiredFromDraft({ power: true, color: "#ff8060", brightness: 40 });
  const matchingValues = { ...device, power: true, color: "#ff8060", brightness: 40 };
  const accepted = {
    requestId: "state-new", deviceId: "lamp-a", desired, accepted: true, commandId: "command-new",
  };

  assert.equal(desiredMatchesDevice(desired, matchingValues), true);
  assert.equal(commandApplied(accepted, matchingValues), false);
  assert.equal(commandApplied(accepted, { ...matchingValues, appliedCommandId: "command-old" }), false);
  assert.equal(commandApplied({ ...accepted, accepted: false }, { ...matchingValues, appliedCommandId: "command-new" }), false);
  assert.equal(commandApplied({ ...accepted, commandId: undefined }, { ...matchingValues, appliedCommandId: "command-new" }), false);
  assert.equal(commandApplied(accepted, { ...matchingValues, appliedCommandId: "command-new" }), true);
});

test("device detail previews a draft without replacing observed device state", () => {
  const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /const controlPreview = !demoMode && controlChanged \? shownControl : null/);
  assert.match(source, /color=\{controlPreview\?\.color \?\? selected\.color\}/);
  assert.match(source, /변경 미리보기/);
  assert.match(source, /현재 기기 상태: \{selected\.power \? "켜짐" : "꺼짐"\}/);
});
