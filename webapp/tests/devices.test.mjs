import assert from "node:assert/strict";
import test from "node:test";
import { parseDeviceList, toDeviceState } from "../lib/devices.ts";

const device = {
  deviceId: "lamp-a", tenantId: "home-a", poolId: "living", name: "Living lamp",
  lifecycleStatus: "ACTIVE", power: true, red: 1, green: 16, blue: 255,
  brightness: 72,
  pendingDesired: { power: false, red: 255, green: 128, blue: 0, brightness: 40 },
  lastCommandId: "command-2", appliedCommandId: "command-1", version: 1,
};

test("validated API devices map to honest UI state", () => {
  const parsed = parseDeviceList({ devices: [device] });
  assert.deepEqual(toDeviceState(parsed[0]), {
    id: "lamp-a", name: "Living lamp", room: "living", online: null,
    power: true, color: "#0110ff", brightness: 72,
    desiredState: { power: false, color: "#ff8000", brightness: 40 },
    lastCommandId: "command-2", appliedCommandId: "command-1",
  });
});

test("device list rejects invalid state instead of rendering it", () => {
  assert.throws(() => parseDeviceList({ devices: [{ ...device, brightness: 101 }] }), /invalid-number/);
  assert.throws(() => parseDeviceList({ devices: [{ ...device, lifecycleStatus: "UNKNOWN" }] }), /invalid-lifecycle-status/);
  assert.throws(() => parseDeviceList({ devices: [{ ...device, appliedCommandId: "" }] }), /invalid-text/);
  assert.throws(() => parseDeviceList({ devices: [{ ...device, pendingDesired: { ...device.pendingDesired, brightness: 101 } }] }), /invalid-number/);
});
