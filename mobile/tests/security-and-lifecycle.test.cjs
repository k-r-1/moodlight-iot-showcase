const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// Run the actual TypeScript implementation with only native hardware modules replaced.
function load(source, mocks = {}) {
  const result = {};
  const compiled = ts.transpileModule(readFileSync(path.join(__dirname, "..", source), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  new Function("require", "exports", compiled.outputText)((name) => mocks[name] ?? require(name), result);
  return result;
}

const navigation = load("src/navigation.ts");
const protocol = load("src/protocol.ts");

test("installed WebView routes every scheme to our gate without opening the OS", () => {
  const decisions = [];
  const { createOnShouldStartLoadWithRequest } = load("node_modules/react-native-webview/src/WebViewShared.tsx", {
    "react-native": { Linking: {
      canOpenURL() { assert.fail("Untrusted navigation must never reach the OS"); },
      openURL() { assert.fail("Untrusted navigation must never open the OS"); },
    } },
    "./WebView.styles": {},
  });
  const gate = createOnShouldStartLoadWithRequest(
    (allowed, url) => decisions.push({ allowed, url }),
    navigation.WEBVIEW_ORIGIN_WHITELIST,
    ({ url }) => navigation.isTrustedWebUrl(url, "https://app.example.com"),
  );
  for (const url of ["https://app.example.com/path", "https://external.test", "intent://external", "mailto:a@example.com", "about:blank"]) {
    gate({ nativeEvent: { url, lockIdentifier: 1 } });
  }
  assert.deepEqual(decisions.map((decision) => decision.allowed), [true, false, false, false, false]);
});

test("navigation permits trusted pages and rejects external origins and active schemes", () => {
  const origin = navigation.webappOrigin("https://app.example.com/start", false);
  for (const url of ["https://app.example.com/", "https://app.example.com:443/devices?next=1"]) {
    assert.equal(navigation.isTrustedWebUrl(url, origin), true, url);
  }
  for (const url of [
    "https://app.example.com.evil.test", "https://evil.test", "http://app.example.com",
    "https://app.example.com:8443", "https://user@app.example.com", "javascript:alert(1)",
    "data:text/html,hello", "file:///secret", "intent://example", "mailto:a@example.com", "about:blank",
  ]) assert.equal(navigation.isTrustedWebUrl(url, origin), false, url);
  assert.equal(navigation.webappOrigin("http://localhost:3210", false), null);
  assert.equal(navigation.webappOrigin("http://localhost:3210", true), "http://localhost:3210");
  assert.equal(navigation.webappOrigin("file:///index.html", true), null);
});

test("embedded handoff WebView permits only its packaged asset tree", () => {
  for (const url of [
    "file:///android_asset/webapp/index.html",
    "file:///android_asset/webapp/_next/static/app.js",
  ]) assert.equal(navigation.isTrustedEmbeddedWebUrl(url), true, url);
  for (const url of [
    "file:///android_asset/secret.txt",
    "file:///android_asset/webapp-evil/index.html",
    "file:///android_asset/webapp/../secret.txt",
    "file:///android_asset/webapp/%2e%2e/secret.txt",
    "file:///android_asset/webapp/%5c..%5csecret.txt",
    "file:////android_asset/webapp/index.html",
    "https://external.test",
    "javascript:alert(1)",
  ]) assert.equal(navigation.isTrustedEmbeddedWebUrl(url), false, url);
  // Modern Android WebMessageListener serializes a file document's opaque
  // origin as the literal string "null". It is accepted only by the embedded
  // message gate; the navigation gate must continue to reject it.
  for (const url of ["null", null, undefined, ""]) {
    assert.equal(navigation.isTrustedEmbeddedWebUrl(url), false, String(url));
    assert.equal(navigation.isTrustedEmbeddedWebMessageUrl(url), true, String(url));
  }
  for (const url of [
    "https://external.test",
    "file:///android_asset/secret.txt",
    "file:///android_asset/webapp/../secret.txt",
  ]) assert.equal(navigation.isTrustedEmbeddedWebMessageUrl(url), false, url);
});

test("Wi-Fi message contract permits an empty password only for an open network", () => {
  const base = {
    type: "wifi.provision",
    requestId: "request",
    attemptId: "attempt",
    payload: {
      deviceId: "device",
      ssid: "Open Wi-Fi",
      password: "",
      secure: false,
      claimId: "claim",
      registrationNonce: "nonce",
    },
  };
  assert.equal(protocol.parseWebMessage(JSON.stringify(base)).payload.password, "");
  assert.throws(() => protocol.parseWebMessage(JSON.stringify({
    ...base,
    payload: { ...base.payload, secure: true },
  })), /invalid-password/);
  const { secure: _secure, ...withoutSecurity } = base.payload;
  assert.throws(() => protocol.parseWebMessage(JSON.stringify({
    ...base,
    payload: withoutSecurity,
  })), /invalid-secure/);
  assert.equal(protocol.parseWebMessage(JSON.stringify({
    ...base,
    payload: { ...base.payload, secure: true, password: "protected" },
  })).payload.password, "protected");
});

function fixture() {
  const events = [];
  const callbacks = [];
  const manager = {
    stopCount: 0, writes: [], connections: [], cancellations: [],
    stopDeviceScan() { this.stopCount++; },
    startDeviceScan(_services, _options, callback) { callbacks.push(callback); return Promise.resolve(); },
    connectToDevice(id) { this.connections.push(id); return Promise.resolve(); },
    cancelDeviceConnection(id) { this.cancellations.push(id); return Promise.resolve(); },
    monitorCharacteristicForDevice() { return { remove() {} }; },
    writeCharacteristicWithResponseForDevice(...args) { this.writes.push(args); return Promise.resolve(); },
    destroy() {},
  };
  const { MoodlightBle } = load("src/ble/MoodlightBle.ts", {
    "react-native": { Platform: { OS: "ios" } },
    "react-native-ble-plx": { BleManager: class { constructor() { return manager; } }, State: {} },
  });
  return { ble: new MoodlightBle((event) => events.push(event), "service"), manager, events, callbacks };
}
const ctx = (attemptId, requestId = attemptId) => ({ attemptId, requestId });



test("Claim binding runs only for the current Security 2 device and ignores stale completion", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    let called = 0;
    assert.equal(await ble.bindClaim(ctx("missing", "claim-bind"), "device-id", async () => { called++; }), false);
    assert.equal(called, 0);
    assert.equal(events.at(-1).payload.code, "CLAIM_BIND_SESSION_MISMATCH");
  } finally { ble.destroy(); }

  const active = fixture();
  try {
    await active.ble.scan(ctx("secure"), 60_000);
    active.callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await active.ble.connect(ctx("secure"), "device-id");
    active.ble.secureConnectionSucceeded(ctx("secure"), selected);
    let finish;
    const nativeAck = new Promise((resolve) => { finish = resolve; });
    const binding = active.ble.bindClaim(ctx("secure", "claim-bind"), "device-id", () => nativeAck);
    assert.equal(active.ble.disconnect(ctx("secure"), "device-id"), true);
    finish();
    assert.equal(await binding, false);
    assert.equal(active.events.some((event) => event.type === "wifi.networks"), false);
  } finally { active.ble.destroy(); }
});

test("Claim binding ACK restores the secure session before Wi-Fi operations", async () => {
  const { ble, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await ble.connect(ctx("secure"), "device-id");
    ble.secureConnectionSucceeded(ctx("secure"), selected);
    let called = 0;
    assert.equal(await ble.bindClaim(ctx("secure", "claim-bind"), "device-id", async () => { called++; }), true);
    assert.equal(called, 1);
    assert.equal(ble.snapshot().payload.stage, "secure-session");
  } finally { ble.destroy(); }
});

test("Wi-Fi provisioning rejects before the current Security 2 session and never invokes native", async () => {
  const { ble, manager, events } = fixture();
  try {
    let called = false;
    await ble.provision(ctx("current"), {
      deviceId: "device-id", ssid: "Home", password: "not-read", secure: true,
    }, async () => { called = true; });
    assert.equal(manager.writes.length, 0);
    assert.equal(called, false);
    assert.equal(events.at(-1).payload.code, "SECURE_SESSION_REQUIRED");
    assert.equal(events.at(-1).requestId, "current");
  } finally {
    ble.destroy();
  }
});

test("Wi-Fi provisioning uses only the current device and preserves response context", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await ble.connect(ctx("secure"), "device-id");
    ble.secureConnectionSucceeded(ctx("secure"), selected);
    let called = 0;
    const payload = {
      deviceId: "device-id", ssid: "Home", secure: true,
      get password() { throw new Error("BLE owner must not inspect the password"); },
    };
    await ble.provision(ctx("secure", "wifi-request"), payload, async () => { called++; });
    assert.equal(called, 1);
    assert.deepEqual(events.slice(-2).map((event) => event.type), ["provision.progress", "provision.progress"]);
    assert.equal(events.at(-1).requestId, "wifi-request");
    assert.equal(events.at(-1).payload.stage, "wifi-connected");
    assert.equal(ble.snapshot().payload.stage, "wifi-connected");
  } finally { ble.destroy(); }
});

test("Wi-Fi failure reasons are preserved but require a new registration attempt", async () => {
  for (const code of ["WIFI_AUTH_FAILED", "WIFI_NOT_FOUND", "WIFI_PROVISION_TIMEOUT"]) {
    const { ble, events, callbacks } = fixture();
    try {
      await ble.scan(ctx("secure"), 60_000);
      callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
      const selected = await ble.connect(ctx("secure"), "device-id");
      ble.secureConnectionSucceeded(ctx("secure"), selected);
      await ble.provision(ctx("secure", code), {
        deviceId: "device-id", ssid: "TestNetwork", password: "not-recorded", secure: true,
      }, async () => {
        throw Object.assign(new Error("native details stay private"), { code });
      });
      assert.equal(events.at(-1).payload.code, code);
      assert.equal(ble.snapshot().payload.stage, "failed");
      assert.equal(ble.snapshot().payload.connectedDevice, null);
    } finally { ble.destroy(); }
  }
});

test("late Wi-Fi provisioning completion cannot revive a disconnected attempt", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await ble.connect(ctx("secure"), "device-id");
    ble.secureConnectionSucceeded(ctx("secure"), selected);
    let finish;
    const nativeCall = new Promise((resolve) => { finish = resolve; });
    const request = ble.provision(ctx("secure", "wifi-request"), {
      deviceId: "device-id", ssid: "Home", password: "not-read", secure: true,
    }, () => nativeCall);
    assert.equal(ble.disconnect(ctx("secure"), "device-id"), true);
    finish();
    await request;
    assert.equal(ble.snapshot().payload.stage, "idle");
    assert.equal(events.some((event) => event.type === "provision.progress" && event.payload.stage === "wifi-connected"), false);
  } finally { ble.destroy(); }
});

test("old scan callbacks and cancellation cannot change a newer scan", async () => {
  const { ble, manager, callbacks } = fixture();
  try {
    await ble.scan(ctx("old"), 60_000);
    await ble.scan(ctx("new"), 60_000);
    const stops = manager.stopCount;
    ble.cancelScan(ctx("old"));
    callbacks[0](new Error("late old scan failure"), null);
    assert.equal(manager.stopCount, stops);
    assert.equal(ble.snapshot().payload.activeAttemptId, "new");
    assert.equal(ble.snapshot().payload.stage, "scanning");
  } finally { ble.destroy(); }
});

test("broad Android scan exposes only the provisioning UUID or Moodlight discovery prefix", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("scan"), 60_000);
    callbacks[0](null, { id: "other", localName: "Headphones", serviceUUIDs: ["other-service"] });
    callbacks[0](null, { id: "named", localName: "Moodlight-A1B2C3", serviceUUIDs: [] });
    callbacks[0](null, { id: "named", localName: "Moodlight-A1B2C3", serviceUUIDs: [] });
    callbacks[0](null, { id: "uuid", localName: null, serviceUUIDs: ["SERVICE"] });
    assert.deepEqual(
      events.filter((event) => event.type === "ble.deviceFound").map((event) => event.payload.id),
      ["named", "uuid"],
    );
  } finally { ble.destroy(); }
});

test("native response type cannot be overwritten by extra fields on a parsed web request", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan({ type: "ble.scan", payload: { timeoutMs: 60_000 }, ...ctx("typed") }, 60_000);
    callbacks[0](null, { id: "target", localName: "Moodlight-Setup", serviceUUIDs: [] });
    assert.deepEqual(events.slice(0, 2).map((event) => event.type), ["ble.scanning", "ble.deviceFound"]);
  } finally { ble.destroy(); }
});

test("scan timeout is armed even when Android keeps the scan-start promise pending", async () => {
  const { ble, manager, events } = fixture();
  manager.startDeviceScan = () => new Promise(() => {});
  try {
    await ble.scan(ctx("pending-scan"), 5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ble.snapshot().payload.stage, "idle");
    assert.equal(events.at(-1).type, "ble.scanning");
    assert.equal(events.at(-1).payload.active, false);
  } finally { ble.destroy(); }
});

test("react-native-ble-plx releases scanning and only hands off a device found in the current attempt", async () => {
  const { ble, manager, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await ble.connect(ctx("secure"), "device-id");
    assert.equal(selected.id, "device-id");
    assert.equal(manager.connections.length, 0);
    assert.equal(manager.writes.length, 0);
    assert.equal(events.at(-1).type, "ble.connecting");
    assert.equal(ble.snapshot().payload.connectedDevice, null);
  } finally { ble.destroy(); }
});

test("a device id not emitted by the current scan cannot reach the secure native handoff", async () => {
  const { ble, manager, events } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    const selected = await ble.connect(ctx("secure"), "unseen-device");
    assert.equal(selected, null);
    assert.equal(manager.connections.length, 0);
    assert.equal(events.at(-1).payload.code, "BLE_DEVICE_NOT_FOUND");
  } finally { ble.destroy(); }
});

test("a selected device is consumed so duplicate connect cannot reopen QR", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    assert.ok(await ble.connect(ctx("secure"), "device-id"));
    assert.equal(await ble.connect(ctx("secure"), "device-id"), null);
    assert.equal(events.at(-1).payload.code, "BLE_DEVICE_NOT_FOUND");
  } finally { ble.destroy(); }
});

test("a stale disconnect cannot claim or tear down the current attempt", async () => {
  const { ble, callbacks } = fixture();
  try {
    await ble.scan(ctx("current"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    assert.equal(ble.disconnect(ctx("old"), "device-id"), false);
    assert.equal(ble.snapshot().payload.activeAttemptId, "current");
    assert.equal(ble.disconnect(ctx("current"), "device-id"), true);
  } finally { ble.destroy(); }
});

test("QR registration secrets stay outside the WebView contract and upstream QR logs are removed", () => {
  const moduleIndex = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "index.ts"), "utf8");
  const nativeModule = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "android", "src", "main", "java", "com", "openiot", "moodlight", "provisioning", "MoodlightSecureProvisioningModule.kt"), "utf8");
  const qrActivity = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "android", "src", "main", "java", "com", "openiot", "moodlight", "provisioning", "ProvisioningQrActivity.kt"), "utf8");
  const upstreamManager = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "ESPProvisionManager.java"), "utf8");
  const upstreamDevice = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "ESPDevice.java"), "utf8");
  const upstreamWifiScanner = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "device_scanner", "WiFiScanner.java"), "utf8");
  const qrConnectSignature = moduleIndex.match(/scanQrAndConnectAndPing\([\s\S]*?\): Promise<PingResult>/)?.[0] ?? "";
  assert.match(qrConnectSignature, /deviceId: string,\s*expectedDeviceName: string,\s*primaryServiceUuid: string/s);
  assert.doesNotMatch(qrConnectSignature, /username: string|password: string/);
  assert.match(moduleIndex, /bindDeviceClaim\(deviceId: string, claimId: string, registrationNonce: string\)/);
  assert.match(moduleIndex, /provisionWifi\(deviceId: string, ssid: string, password: string\)/);
  assert.doesNotMatch(nativeModule, /AsyncFunction\("connectAndPing"\)/);
  assert.match(qrActivity, /REQUIRED_FIELDS = setOf\("transport", "security", "name", "username", "password"\)/);
  assert.match(qrActivity, /WindowManager\.LayoutParams\.FLAG_SECURE/);
  assert.doesNotMatch(qrActivity, /Log\.|println|printStackTrace/);
  assert.doesNotMatch(upstreamManager, /QR Code Data/);
  assert.doesNotMatch(upstreamDevice, /Log\.[a-z]\([^\n]*(?:getSsid\(|\+\s*ssid\b|\+\s*networkName\b)/);
  assert.match(upstreamDevice, /getSsid\(\)\.isValidUtf8\(\)/);
  assert.doesNotMatch(upstreamWifiScanner, /Log\.[a-z]\([^\n]*scanResult\.SSID/);
  assert.match(nativeModule, /advertisedName != credentials\.name/);
  assert.match(nativeModule, /promise\.resolve\(if \(registration == null\)/);
  assert.match(nativeModule, /private fun succeed\([^)]*operation: Long[\s\S]*unregisterEventBus\(\)[\s\S]*promise\.resolve/);
  assert.match(nativeModule, /AsyncFunction\("bindDeviceClaim"\)/);
  assert.match(nativeModule, /current\.sendDataToCustomEndPoint\(CUSTOM_ENDPOINT, requestData/);
  assert.match(nativeModule, /\.put\("type", "claim\.bind"\)[\s\S]*\.put\("claimId", claimId\)[\s\S]*\.put\("registrationNonce", registrationNonce\)/);
  assert.match(nativeModule, /fields == setOf\("type", "version", "claimId", "status"\)/);
  assert.match(nativeModule, /json\.get\("type"\) == "claim\.ack"/);
  assert.match(nativeModule, /json\.get\("claimId"\) == claimId/);
  assert.match(nativeModule, /json\.get\("status"\) == "accepted"/);
  assert.match(nativeModule, /claimBindingRequired = credentials\.productRegistration != null/);
  assert.match(nativeModule, /claimBindingRequired && boundClaimId == null[\s\S]*"CLAIM_BIND_REQUIRED"/);
  assert.match(nativeModule, /REGISTRATION_NONCE = Regex\("\^\[A-Za-z0-9_-\]\{16,512\}\$"\)/);
  assert.doesNotMatch(nativeModule, /promise\.resolve\([^\r\n]*(registrationNonce|requestData)/);
  assert.match(nativeModule, /AsyncFunction\("scanWifiNetworks"\)/);
  assert.match(nativeModule, /current\.scanNetworks\(object : WiFiScanListener/);
  assert.match(nativeModule, /AsyncFunction\("provisionWifi"\)/);
  assert.match(nativeModule, /current\.provision\(ssid, password, object : ProvisionListener/);
  assert.match(nativeModule, /connectedDeviceId != deviceId/);
  assert.match(nativeModule, /passwordBytes !in 0\.\.64/);
  assert.doesNotMatch(nativeModule, /Log\.|println|printStackTrace/);
  assert.match(nativeModule, /wifiProvisionPromise\?\.let[\s\S]*promise\.reject\("BLE_DISCONNECTED"/);
  assert.match(nativeModule, /ssid\.toByteArray\(StandardCharsets\.UTF_8\)\.size > 32/);
  assert.doesNotMatch(nativeModule, /wifiName\?*\.trim\(/);
  assert.match(nativeModule, /sortedByDescending[\s\S]*distinctBy \{ it\["ssid"\] as String \}/);
  assert.match(nativeModule, /private fun failWifiScan[\s\S]*cleanup\(\)[\s\S]*promise\.reject/);
  assert.match(nativeModule, /private fun failWifiProvision[\s\S]*cleanup\(\)[\s\S]*promise\.reject/);
});

test("native async callbacks are bound to the Security 2 session that created them", () => {
  const nativeModule = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "android", "src", "main", "java", "com", "openiot", "moodlight", "provisioning", "MoodlightSecureProvisioningModule.kt"), "utf8");
  const connectionEvent = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "DeviceConnectionEvent.java"), "utf8");
  const espDevice = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "ESPDevice.java"), "utf8");
  const bleTransport = readFileSync(path.join(__dirname, "..", "vendor", "esp-idf-provisioning-android", "src", "main", "java", "com", "espressif", "provisioning", "transport", "BLETransport.java"), "utf8");
  assert.match(nativeModule, /private var generation = 0L/);
  assert.match(nativeModule, /if \(event\.source !== current\) return/);
  assert.match(nativeModule, /connectAndPing\(operation, promise, deviceId/);
  assert.match(nativeModule, /Runnable \{ fail\(operation, promise, code, message\) \}/);
  assert.match(nativeModule, /if \(!isCurrent\(operation, promise, current\)\) return@post/);
  assert.match(nativeModule, /if \(!isCurrentWifiScan\(operation, promise, current\)\) return@post/);
  assert.match(nativeModule, /generation == operation && pendingPromise === promise && device === current/);
  assert.match(nativeModule, /generation == operation && claimBindPromise === promise && device === current/);
  assert.match(nativeModule, /generation == operation && wifiScanPromise === promise && device === current/);
  assert.match(nativeModule, /private fun cleanup\(\) \{\s*generation\+\+/);
  assert.match(connectionEvent, /DeviceConnectionEvent\(short type, Object source\)/);
  assert.match(connectionEvent, /Object getSource\(\)/);
  assert.match(espDevice, /new BLETransport\(context, this\)/);
  assert.match(bleTransport, /DeviceConnectionEvent\(ESPConstants\.EVENT_DEVICE_CONNECTED, eventSource\)/);
  const emittedConnectionEvents = [...`${espDevice}\n${bleTransport}`.matchAll(/new DeviceConnectionEvent\(([^)\n]+)\)/g)];
  assert.ok(emittedConnectionEvents.length > 0);
  for (const [, args] of emittedConnectionEvents) {
    assert.match(args, /,\s*(?:ESPDevice\.this|eventSource)$/);
  }
});

test("Wi-Fi scan requires the current Security 2 device", async () => {
  const { ble, manager, events } = fixture();
  try {
    let called = false;
    await ble.scanWifi(ctx("secure"), "device-id", async () => {
      called = true;
      return [];
    });
    assert.equal(manager.connections.length, 0);
    assert.equal(manager.writes.length, 0);
    assert.equal(called, false);
    assert.equal(events.at(-1).payload.code, "SECURE_SESSION_REQUIRED");
  } finally { ble.destroy(); }
});

test("Wi-Fi scan returns only the current secure session result", async () => {
  const { ble, events, callbacks } = fixture();
  try {
    await ble.scan(ctx("secure"), 60_000);
    callbacks[0](null, { id: "device-id", localName: "Moodlight-Setup", serviceUUIDs: [] });
    const selected = await ble.connect(ctx("secure"), "device-id");
    ble.secureConnectionSucceeded(ctx("secure"), selected);
    await ble.scanWifi(ctx("secure", "wifi-request"), "device-id", async () => [
      { ssid: "Home", rssi: -42, secure: true },
    ]);
    assert.equal(events.at(-1).type, "wifi.networks");
    assert.equal(events.at(-1).requestId, "wifi-request");
    assert.deepEqual(events.at(-1).payload.networks, [{ ssid: "Home", rssi: -42, secure: true }]);
    assert.equal(ble.snapshot().payload.stage, "secure-session");
    await ble.scanWifi(ctx("secure", "wifi-refresh"), "device-id", async () => []);
    assert.equal(events.at(-1).requestId, "wifi-refresh");
  } finally { ble.destroy(); }
});


test("device-list bridge accepts only a token-free typed request", () => {
  assert.deepEqual(protocol.parseWebMessage(JSON.stringify({
    type: "api.devices.list", requestId: "devices-1",
  })), { type: "api.devices.list", requestId: "devices-1" });
  assert.throws(() => protocol.parseWebMessage(JSON.stringify({
    type: "api.devices.list", requestId: "devices-1", accessToken: "must-not-cross-the-bridge",
  })), /invalid-payload/);
});

test("native device-list client validates the response and keeps the token out of its result", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  const sample = {
    deviceId: "lamp-a", tenantId: "home-a", poolId: "living", name: "Lamp",
    lifecycleStatus: "ACTIVE", power: false, red: 10, green: 20, blue: 30,
    brightness: 40,
    pendingDesired: { power: true, red: 200, green: 100, blue: 50, brightness: 60 },
    lastCommandId: "command-pending", appliedCommandId: "command-applied", version: 1,
  };
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, "https://api.example.com/devices?tenantId=home-a");
      assert.equal(init.headers.authorization, "Bearer native-only-token");
      return { ok: true, status: 200, async json() { return { devices: [sample] }; } };
    };
    const result = await api.listDevices({
      apiBaseUrl: "https://api.example.com", accessToken: "native-only-token", tenantId: "home-a",
    });
    assert.deepEqual(result, [sample]);
    assert.equal(JSON.stringify(result).includes("native-only-token"), false);

    global.fetch = async () => ({ ok: true, status: 200, async json() { return { devices: [{ ...sample, red: 999 }] }; } });
    await assert.rejects(() => api.listDevices({
      apiBaseUrl: "https://api.example.com", accessToken: "native-only-token", tenantId: "home-a",
    }), /invalid-device/);
    global.fetch = async () => ({ ok: true, status: 200, async json() { return { devices: [{ ...sample, appliedCommandId: "" }] }; } });
    await assert.rejects(() => api.listDevices({
      apiBaseUrl: "https://api.example.com", accessToken: "native-only-token", tenantId: "home-a",
    }), /invalid-device/);
    global.fetch = async () => ({ ok: true, status: 200, async json() { return { devices: [{ ...sample, pendingDesired: { ...sample.pendingDesired, power: "yes" } }] }; } });
    await assert.rejects(() => api.listDevices({
      apiBaseUrl: "https://api.example.com", accessToken: "native-only-token", tenantId: "home-a",
    }), /invalid-device/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("device-state bridge accepts a bounded token-free patch and rejects stale or extra fields", () => {
  const base = {
    type: "api.devices.state.patch",
    requestId: "state-1",
    payload: {
      deviceId: "lamp-a",
      desired: { power: true, red: 0, green: 255, blue: 12, brightness: 100 },
    },
  };
  assert.deepEqual(protocol.parseWebMessage(JSON.stringify(base)), base);

  for (const desired of [
    {},
    { power: 1 },
    { red: -1 },
    { green: 256 },
    { blue: 1.5 },
    { brightness: 101 },
    { power: true, version: 3 },
  ]) {
    assert.throws(() => protocol.parseWebMessage(JSON.stringify({
      ...base, payload: { ...base.payload, desired },
    })), /invalid-/);
  }

  for (const injected of [
    { ...base, attemptId: "stale-attempt" },
    { ...base, accessToken: "must-not-cross-the-bridge" },
    { ...base, payload: { ...base.payload, tenantId: "home-a" } },
    { ...base, payload: { ...base.payload, accessToken: "must-not-cross-the-bridge" } },
  ]) {
    assert.throws(() => protocol.parseWebMessage(JSON.stringify(injected)), /invalid-payload/);
  }
});

test("native state client encodes the device path and returns only an accepted command id", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  const session = {
    apiBaseUrl: "https://api.example.com/v1/", accessToken: "native-only-token", tenantId: "home-a",
  };
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, "https://api.example.com/v1/devices/lamp%2Fa%20%3F%23%ED%95%9C/state");
      assert.equal(init.method, "PATCH");
      assert.equal(init.headers.authorization, "Bearer native-only-token");
      assert.equal(init.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(init.body), { requestId: "state-request-1", desired: { power: true, red: 12, brightness: 0 } });
      return { status: 202, async json() { return { status: "ACCEPTED", commandId: "command-1" }; } };
    };
    const result = await api.patchDeviceState(
      session,
      "lamp/a ?#한",
      "state-request-1",
      { power: true, red: 12, brightness: 0 },
    );
    assert.deepEqual(result, { status: "ACCEPTED", commandId: "command-1" });
    assert.equal(JSON.stringify(result).includes("native-only-token"), false);

    global.fetch = async () => ({
      status: 202,
      async json() { return { status: "ACCEPTED", commandId: "command-2", accessToken: "leak" }; },
    });
    await assert.rejects(
      () => api.patchDeviceState(session, "lamp-a", "state-request-2", { power: false }),
      /invalid-device-state-response/,
    );

    global.fetch = async () => ({ status: 200, async json() { return { status: "ACCEPTED", commandId: "wrong-http-status" }; } });
    await assert.rejects(
      () => api.patchDeviceState(session, "lamp-a", "state-request-3", { brightness: 50 }),
      (error) => error.code === "device-state-request-failed" && error.status === 200,
    );

    await assert.rejects(
      () => api.patchDeviceState({ ...session, tenantId: "../other" }, "lamp-a", "state-request-4", { power: true }),
      /invalid-api-session/,
    );
    await assert.rejects(
      () => api.patchDeviceState(session, "lamp-a", "", { power: true }),
      /invalid-request-id/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
test("Native state response matches the Web accepted-message contract", () => {
  const protocolSource = readFileSync(path.join(__dirname, "..", "src", "protocol.ts"), "utf8");
  const appSource = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  assert.match(protocolSource, /type: "api\.devices\.state\.accepted"/);
  assert.match(appSource, /type: "api\.devices\.state\.accepted"/);
  assert.match(appSource, /patchDeviceState\(session, message\.payload\.deviceId, message\.requestId, message\.payload\.desired\)/);
  assert.match(appSource, /deviceId: message\.payload\.deviceId, \.\.\.accepted/);
  assert.doesNotMatch(protocolSource, /api\.devices\.state\.result/);
});

test("claim bridge exposes only safe identifiers and rejects QR or token injection", () => {
  assert.deepEqual(protocol.parseWebMessage(JSON.stringify({
    type: "api.deviceClaims.create", requestId: "claim-create", attemptId: "attempt-a",
    payload: { poolId: "living", deviceId: "AA:BB:CC:DD:EE:FF" },
  })), {
    type: "api.deviceClaims.create", requestId: "claim-create", attemptId: "attempt-a",
    payload: { poolId: "living", deviceId: "AA:BB:CC:DD:EE:FF" },
  });
  for (const request of [
    { type: "api.deviceClaims.create", requestId: "x", attemptId: "a", payload: { poolId: "living", deviceId: "d", serial: "serial-a" } },
    { type: "api.deviceClaims.create", requestId: "x", attemptId: "a", payload: { poolId: "living", deviceId: "d", registrationCode: "secret" } },
    { type: "api.deviceClaims.create", requestId: "x", attemptId: "a", payload: { poolId: "living", deviceId: "d", accessToken: "token" } },
    { type: "api.deviceClaims.create", requestId: "x", payload: { poolId: "living", deviceId: "d" } },
    { type: "api.deviceClaims.create", requestId: "x", attemptId: "a", payload: { poolId: "living" } },
    { type: "api.deviceClaims.status", requestId: "x", payload: { claimId: "claim-a", registrationNonce: "nonce" } },
    { type: "api.deviceClaims.finalize", requestId: "x", payload: { claimId: "claim-a" }, attemptId: "stale" },
  ]) {
    assert.throws(() => protocol.parseWebMessage(JSON.stringify(request)), /invalid-payload/);
  }
});

test("legacy Web claim placeholders are discarded before Wi-Fi reaches Native code", () => {
  const parsed = protocol.parseWebMessage(JSON.stringify({
    type: "wifi.provision", requestId: "wifi", attemptId: "attempt",
    payload: {
      deviceId: "device", ssid: "Home", password: "protected", secure: true,
      claimId: "local-fake", registrationNonce: "local-fake-nonce",
    },
  }));
  assert.equal("claimId" in parsed.payload, false);
  assert.equal("registrationNonce" in parsed.payload, false);
  assert.throws(() => protocol.parseWebMessage(JSON.stringify({
    type: "wifi.provision", requestId: "wifi", attemptId: "attempt",
    payload: { ...parsed.payload, registrationCode: "must-not-cross" },
  })), /invalid-payload/);
});

test("native claim client keeps registration secrets in the authenticated API boundary", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  const session = { apiBaseUrl: "https://api.example.com/v1", accessToken: "native-token", tenantId: "home-a" };
  let call = 0;
  try {
    global.fetch = async (url, init) => {
      call++;
      assert.equal(init.headers.authorization, "Bearer native-token");
      if (call === 1) {
        assert.equal(url, "https://api.example.com/v1/device-claims");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), {
          tenantId: "home-a", poolId: "living", serial: "serial-a", registrationCode: "registration-secret-1",
        });
        return { status: 201, async json() { return {
          claimId: "claim/a", status: "CLAIM_PENDING", expiresAt: "2026-09-05T02:00:00.000Z", registrationNonce: "server-nonce",
        }; } };
      }
      if (call === 2) {
        assert.equal(url, "https://api.example.com/v1/device-claims/claim%2Fa");
        assert.equal(init.method, "GET");
        return { status: 200, async json() { return {
          claimId: "claim/a", status: "BOOTSTRAPPED", expiresAt: "2026-09-05T02:00:00.000Z", deviceId: "lamp-a",
        }; } };
      }
      assert.equal(url, "https://api.example.com/v1/device-claims/claim%2Fa/finalize");
      assert.equal(init.method, "POST");
      return { status: 200, async json() { return call === 3 ? {
        claimId: "claim/a", status: "RUNTIME_AUTHORIZED", deviceId: "lamp-a", lifecycleStatus: "RUNTIME_AUTHORIZED", idempotent: false,
      } : {
        claimId: "claim/a", status: "ONLINE", deviceId: "lamp-a", lifecycleStatus: "ACTIVE", idempotent: true,
      }; } };
    };

    const created = await api.createDeviceClaim(session, "living", {
      serial: "serial-a", registrationCode: "registration-secret-1",
    });
    assert.equal(created.registrationNonce, "server-nonce");
    assert.equal(JSON.stringify(created).includes("registration-secret-1"), false);
    assert.equal((await api.getDeviceClaim(session, created.claimId)).status, "BOOTSTRAPPED");
    assert.equal((await api.finalizeDeviceClaim(session, created.claimId)).status, "RUNTIME_AUTHORIZED");
    assert.deepEqual(await api.finalizeDeviceClaim(session, created.claimId), {
      claimId: "claim/a", status: "ONLINE", deviceId: "lamp-a", lifecycleStatus: "ACTIVE", idempotent: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("five-field test QR and seven-field product QR stay explicit and WebView-safe", () => {
  const moduleIndex = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "index.ts"), "utf8");
  const qrActivity = readFileSync(path.join(__dirname, "..", "modules", "moodlight-secure-provisioning", "android", "src", "main", "java", "com", "openiot", "moodlight", "provisioning", "ProvisioningQrActivity.kt"), "utf8");
  const protocolSource = readFileSync(path.join(__dirname, "..", "src", "protocol.ts"), "utf8");
  const appSource = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  assert.match(qrActivity, /PRODUCT_FIELDS = REQUIRED_FIELDS \+ setOf\("serial", "registrationCode"\)/);
  assert.match(qrActivity, /fields != REQUIRED_FIELDS && fields != PRODUCT_FIELDS/);
  assert.match(moduleIndex, /mode: "test"/);
  assert.match(moduleIndex, /mode: "product"; serial: string; registrationCode: string/);
  assert.doesNotMatch(protocolSource, /registrationCode/);
  assert.match(appSource, /productRegistrationRef\.current = null/);
  assert.match(appSource, /SecureProvisioning\.bindDeviceClaim\([\s\S]*claim\.claimId,[\s\S]*claim\.registrationNonce/);
  assert.match(appSource, /if \(!bound\) break;[\s\S]*payload: \{ claimId: claim\.claimId, status: claim\.status \}/);
  assert.doesNotMatch(appSource, /\{ \.\.\.message\.payload, \.\.\.binding \}/);
});


test("auth bridge is token-free and rejects injected credentials", () => {
  for (const type of ["auth.status", "auth.login", "auth.logout"]) {
    assert.deepEqual(protocol.parseWebMessage(JSON.stringify({ type, requestId: "auth-1" })), { type, requestId: "auth-1" });
    assert.throws(() => protocol.parseWebMessage(JSON.stringify({
      type, requestId: "auth-1", accessToken: "must-stay-native",
    })), /invalid-payload/);
  }
  const protocolSource = readFileSync(path.join(__dirname, "..", "src", "protocol.ts"), "utf8");
  const authSource = readFileSync(path.join(__dirname, "..", "src", "auth.ts"), "utf8");
  assert.doesNotMatch(protocolSource, /refreshToken|registrationCode/);
  assert.match(authSource, /usePKCE: true/);
  assert.match(authSource, /WHEN_UNLOCKED_THIS_DEVICE_ONLY/);
  assert.match(authSource, /responseType: AuthSession\.ResponseType\.Code/);
  assert.match(authSource, /path: "auth\/callback"/);
});

test("session bootstrap derives the tenant through the Native bearer boundary", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, "https://api.example.com/v1/session/bootstrap");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer native-token");
      assert.deepEqual(JSON.parse(init.body), {});
      return { status: 200, async json() { return { tenantId: "personal-a", poolId: "default", role: "OWNER" }; } };
    };
    const result = await api.bootstrapApiSession("https://api.example.com/v1/", "native-token");
    assert.deepEqual(result, {
      apiBaseUrl: "https://api.example.com/v1/",
      accessToken: "native-token",
      tenantId: "personal-a",
      poolId: "default",
      role: "OWNER",
    });
    global.fetch = async () => ({ status: 200, async json() {
      return { tenantId: "personal-a", poolId: "default", role: "OWNER", userId: "spoofed" };
    } });
    await assert.rejects(() => api.bootstrapApiSession("https://api.example.com", "native-token"), /invalid-session-bootstrap-response/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("schedule bridge validates a complete token-free write and rejects unsafe fields", () => {
  const create = {
    type: "api.schedules.create",
    requestId: "schedule-1",
    payload: {
      name: "sleep", targetType: "DEVICE", targetId: "lamp-a", enabled: true,
      timezone: "Asia/Seoul", localTime: "23:00", daysOfWeek: [6, 0, 6],
      desiredState: { power: false, brightness: 0 },
    },
  };
  const parsed = protocol.parseWebMessage(JSON.stringify(create));
  assert.deepEqual(parsed.payload.daysOfWeek, [0, 6]);
  for (const invalid of [
    { ...create, accessToken: "token" },
    { ...create, payload: { ...create.payload, tenantId: "other" } },
    { ...create, payload: { ...create.payload, localTime: "24:00" } },
    { ...create, payload: { ...create.payload, daysOfWeek: [7] } },
  ]) assert.throws(() => protocol.parseWebMessage(JSON.stringify(invalid)), /invalid-/);
});

test("native schedule client injects tenant and bearer while returning a safe schedule", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  const session = { apiBaseUrl: "https://api.example.com/v1", accessToken: "native-token", tenantId: "home-a" };
  const schedule = {
    tenantId: "home-a", scheduleId: "schedule-a", name: "sleep", targetType: "DEVICE",
    targetId: "lamp-a", enabled: true, timezone: "Asia/Seoul", localTime: "23:00",
    daysOfWeek: [0, 6], desiredState: { power: false }, syncStatus: "ACTIVE", revision: 1,
    createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z",
  };
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, "https://api.example.com/v1/schedules");
      assert.equal(init.headers.authorization, "Bearer native-token");
      const body = JSON.parse(init.body);
      assert.equal(body.tenantId, "home-a");
      assert.equal(body.accessToken, undefined);
      return { status: 201, async json() { return schedule; } };
    };
    const result = await api.createSchedule(session, {
      name: "sleep", targetType: "DEVICE", targetId: "lamp-a", enabled: true,
      timezone: "Asia/Seoul", localTime: "23:00", daysOfWeek: [0, 6],
      desiredState: { power: false },
    });
    assert.equal(result.scheduleId, "schedule-a");
    assert.equal(JSON.stringify(result).includes("native-token"), false);
  } finally {
    global.fetch = originalFetch;
  }
});


test("device release stays authenticated in Native and validates the revoked result", async () => {
  assert.deepEqual(protocol.parseWebMessage(JSON.stringify({
    type: "api.devices.release", requestId: "release-1", payload: { deviceId: "lamp/a" },
  })), {
    type: "api.devices.release", requestId: "release-1", payload: { deviceId: "lamp/a" },
  });
  assert.throws(() => protocol.parseWebMessage(JSON.stringify({
    type: "api.devices.release", requestId: "release-1",
    payload: { deviceId: "lamp-a", tenantId: "other", accessToken: "leak" },
  })), /invalid-payload/);

  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  try {
    global.fetch = async (url, init) => {
      assert.equal(url, "https://api.example.com/v1/devices/lamp%2Fa/release");
      assert.equal(init.method, "POST");
      assert.equal(init.headers.authorization, "Bearer native-token");
      return { status: 200, async json() {
        return { deviceId: "lamp/a", lifecycleStatus: "REVOKED", idempotent: false };
      } };
    };
    assert.deepEqual(await api.releaseDevice({
      apiBaseUrl: "https://api.example.com/v1/", accessToken: "native-token", tenantId: "home-a",
    }, "lamp/a"), { deviceId: "lamp/a", lifecycleStatus: "REVOKED", idempotent: false });
  } finally {
    global.fetch = originalFetch;
  }
});

test("claim finalize preserves backend retry semantics for Fleet readiness", async () => {
  const api = load("src/api.ts");
  const originalFetch = global.fetch;
  const session = { apiBaseUrl: "https://api.example.com/v1", accessToken: "native-token", tenantId: "home-a" };
  try {
    global.fetch = async () => ({ status: 503, async json() {
      return { error: { code: "NOT_CONFIGURED", message: "adapter missing" } };
    } });
    await assert.rejects(
      () => api.finalizeDeviceClaim(session, "claim-a"),
      (error) => error.code === "NOT_CONFIGURED" && error.status === 503 && error.retryable === false,
    );

    global.fetch = async () => ({ status: 425, async json() {
      return { error: { code: "PROVISIONING_PENDING", message: "Fleet is still provisioning" } };
    } });
    await assert.rejects(
      () => api.finalizeDeviceClaim(session, "claim-a"),
      (error) => error.code === "PROVISIONING_PENDING" && error.status === 425 && error.retryable === true,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("local Claim recovery stays development-only and revalidates ownership through the API", () => {
  const source = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
  assert.match(source, /const LOCAL_RECOVERY_CLAIM_ID = __DEV__ \?/);
  assert.match(source, /getDeviceClaim\(session, LOCAL_RECOVERY_CLAIM_ID\)/);
  assert.match(source, /!pendingClaimRef\.current && LOCAL_RECOVERY_CLAIM_ID/);
});

test("handoff build selects the packaged WebView and explicit local provisioning mode", () => {
  const script = readFileSync(path.join(__dirname, "..", "scripts", "build-android.sh"), "utf8");
  assert.match(script, /handoff\)[\s\S]*export EXPO_PUBLIC_EMBEDDED_WEBAPP=true/);
  assert.match(script, /handoff\)[\s\S]*export EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=true/);
  assert.match(script, /createBundleReleaseJsAndAssets --rerun-tasks/);
  assert.match(script, /debug\)[\s\S]*EXPO_PUBLIC_EMBEDDED_WEBAPP=false[\s\S]*EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false/);
  assert.match(script, /release\)[\s\S]*EXPO_PUBLIC_EMBEDDED_WEBAPP=false[\s\S]*EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false/);
  assert.match(script, /bundle\.includes\("file:\/\/\/android_asset\/webapp\/index\.html"\)/);
  assert.match(script, /bundle\.includes\("http:\/\/localhost:3210"\)/);
});

test("standalone build packages the WebView and keeps the real AWS registration path", () => {
  const script = readFileSync(path.join(__dirname, "..", "scripts", "build-android.sh"), "utf8");
  assert.match(script, /standalone\)[\s\S]*EXPO_PUBLIC_EMBEDDED_WEBAPP=true[\s\S]*EXPO_PUBLIC_LOCAL_PROVISIONING_TEST_MODE=false/);
  assert.match(script, /standalone\)[\s\S]*EXPO_PUBLIC_API_BASE_URL[\s\S]*NEXT_PUBLIC_HARDWARE_TEST_MODE=false/);
  assert.equal(script.includes("\\.auth\\.[a-z0-9-]+\\.amazoncognito\\.com$"), true);
  assert.match(script, /전체 주소가 필요합니다/);
  assert.match(script, /독립 APK에 현재 \$\{name\} 값이 포함되지 않았습니다/);
});
