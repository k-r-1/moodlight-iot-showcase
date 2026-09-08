const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

function load(source, mocks = {}) {
  const result = {};
  const compiled = ts.transpileModule(readFileSync(path.join(__dirname, "..", source), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  new Function("require", "exports", compiled.outputText)((name) => mocks[name] ?? require(name), result);
  return result;
}

class ApiRequestError extends Error {
  constructor(code, message, retryable, status) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function loadSession() {
  return load("src/session.ts", { "./api": { ApiRequestError } });
}

test("401 refreshes once and retries the same operation with the new session", async () => {
  const { createAuthenticatedRequestRunner } = loadSession();
  const oldSession = { accessToken: "old" };
  const newSession = { accessToken: "new" };
  let current = oldSession;
  let refreshes = 0;
  let attempts = 0;
  const run = createAuthenticatedRequestRunner({
    getSession: () => current,
    refreshSession: async () => { refreshes++; current = newSession; return newSession; },
    onAuthenticationExpired: () => assert.fail("session should recover"),
  });

  const result = await run(async (session) => {
    attempts++;
    if (session === oldSession) throw new ApiRequestError("UNAUTHENTICATED", "expired", false, 401);
    return session.accessToken;
  });

  assert.equal(result, "new");
  assert.equal(refreshes, 1);
  assert.equal(attempts, 2);
});

test("concurrent 401 responses share one refresh and a late response uses the current session", async () => {
  const { createAuthenticatedRequestRunner } = loadSession();
  const oldSession = { accessToken: "old" };
  const newSession = { accessToken: "new" };
  let current = oldSession;
  let refreshes = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const run = createAuthenticatedRequestRunner({
    getSession: () => current,
    refreshSession: async () => { refreshes++; await refreshGate; current = newSession; return newSession; },
    onAuthenticationExpired: () => assert.fail("session should recover"),
  });
  const request = async (session) => {
    if (session === oldSession) throw new ApiRequestError("UNAUTHENTICATED", "expired", false, 401);
    return session.accessToken;
  };
  const first = run(request);
  const second = run(request);
  releaseRefresh();
  assert.deepEqual(await Promise.all([first, second]), ["new", "new"]);
  assert.equal(refreshes, 1);

  let lateAttempts = 0;
  const late = await run(async (session) => {
    lateAttempts++;
    return session.accessToken;
  });
  assert.equal(late, "new");
  assert.equal(lateAttempts, 1);
  assert.equal(refreshes, 1);
});

test("a second 401 expires the session without a third request", async () => {
  const { AuthenticationExpiredError, createAuthenticatedRequestRunner } = loadSession();
  const oldSession = { accessToken: "old" };
  const newSession = { accessToken: "new" };
  let current = oldSession;
  let attempts = 0;
  let expired = 0;
  const run = createAuthenticatedRequestRunner({
    getSession: () => current,
    refreshSession: async () => { current = newSession; return newSession; },
    onAuthenticationExpired: async () => { expired++; current = null; },
  });
  await assert.rejects(() => run(async () => {
    attempts++;
    throw new ApiRequestError("UNAUTHENTICATED", "expired", false, 401);
  }), AuthenticationExpiredError);
  assert.equal(attempts, 2);
  assert.equal(expired, 1);
});

test("non-401 failures are never refreshed or replayed", async () => {
  const { createAuthenticatedRequestRunner } = loadSession();
  let attempts = 0;
  let refreshes = 0;
  const expected = new ApiRequestError("FORBIDDEN", "forbidden", false, 403);
  const run = createAuthenticatedRequestRunner({
    getSession: () => ({ accessToken: "valid" }),
    refreshSession: async () => { refreshes++; return null; },
    onAuthenticationExpired: () => assert.fail("403 must not expire auth"),
  });
  await assert.rejects(() => run(async () => { attempts++; throw expected; }), (error) => error === expected);
  assert.equal(attempts, 1);
  assert.equal(refreshes, 0);
});

function secureStoreHarness(initial = null) {
  let stored = initial;
  let deletes = 0;
  const module = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value, options) { assert.equal(options.keychainAccessible, "device-only"); stored = value; },
    async deleteItemAsync() { deletes++; stored = null; },
  };
  return { module, value: () => stored, deletes: () => deletes };
}

test("pending Claim survives restart in SecureStore without registrationCode or tokens", async () => {
  const store = secureStoreHarness();
  const claims = load("src/pendingClaim.ts", { "expo-secure-store": store.module });
  const pending = {
    tenantId: "home-a", serial: "serial-a", claimId: "claim-a",
    expiresAt: "2099-01-01T00:00:00.000Z", registrationNonce: "nonce-a",
  };
  await claims.savePendingClaim(pending);
  assert.deepEqual(await claims.loadPendingClaim(Date.parse("2098-01-01T00:00:00.000Z")), pending);
  assert.equal(store.value().includes("registrationCode"), false);
  assert.equal(store.value().includes("accessToken"), false);
  assert.equal(store.value().includes("refreshToken"), false);
});

test("expired or malformed pending Claims are deleted instead of restored", async () => {
  for (const raw of [
    JSON.stringify({ version: 1, tenantId: "home-a", serial: "serial-a", claimId: "claim-a", expiresAt: "2020-01-01T00:00:00.000Z", registrationNonce: "nonce" }),
    JSON.stringify({ version: 1, tenantId: "home-a", serial: "serial-a", claimId: "claim-a", expiresAt: "2099-01-01T00:00:00.000Z", registrationNonce: "nonce", accessToken: "leak" }),
    "not-json",
  ]) {
    const store = secureStoreHarness(raw);
    const claims = load("src/pendingClaim.ts", { "expo-secure-store": store.module });
    assert.equal(await claims.loadPendingClaim(Date.parse("2026-01-01T00:00:00.000Z")), null);
    assert.equal(store.deletes(), 1);
  }
});

test("Cognito refresh rotates tokens but preserves stored credentials on transient errors", async () => {
  class TokenError extends Error { constructor(code) { super(code); this.code = code; } }
  const store = secureStoreHarness("refresh-old");
  let mode = "rotate";
  const authSession = {
    makeRedirectUri: () => "openiot-moodlight://auth/callback",
    TokenError,
    async refreshAsync() {
      if (mode === "network") throw new Error("offline");
      if (mode === "invalid") throw new TokenError("invalid_grant");
      return { accessToken: "access-new", refreshToken: "refresh-new" };
    },
  };
  const auth = load("src/auth.ts", { "expo-auth-session": authSession, "expo-secure-store": store.module });
  const config = { clientId: "client", redirectUri: "callback", discovery: {} };
  assert.deepEqual(await auth.refreshCognitoSession(config), { accessToken: "access-new", refreshToken: "refresh-new" });
  assert.equal(store.value(), "refresh-new");

  mode = "network";
  await assert.rejects(() => auth.refreshCognitoSession(config), /offline/);
  assert.equal(store.value(), "refresh-new");

  mode = "invalid";
  assert.equal(await auth.refreshCognitoSession(config), null);
  assert.equal(store.value(), null);
});

test("API and bridge preserve 401 while keeping Claim secrets Native-only", async () => {
  const api = load("src/api.ts");
  const protocol = load("src/protocol.ts");
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ status: 401, async json() { return { error: { code: "UNAUTHENTICATED", message: "expired" } }; } });
    await assert.rejects(
      () => api.listDevices({ apiBaseUrl: "https://api.example.com", accessToken: "expired", tenantId: "home-a" }),
      (error) => error instanceof api.ApiRequestError && error.status === 401 && error.code === "UNAUTHENTICATED",
    );
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(protocol.parseWebMessage(JSON.stringify({ type: "api.deviceClaims.resume", requestId: "resume-1" })), {
    type: "api.deviceClaims.resume", requestId: "resume-1",
  });
  for (const injected of [
    { type: "api.deviceClaims.resume", requestId: "resume-1", accessToken: "token" },
    { type: "api.deviceClaims.resume", requestId: "resume-1", registrationNonce: "nonce" },
    { type: "api.deviceClaims.resume", requestId: "resume-1", registrationCode: "secret" },
  ]) assert.throws(() => protocol.parseWebMessage(JSON.stringify(injected)), /invalid-payload/);
});

test("logout generation prevents a late Cognito exchange from restoring the refresh token", async () => {
  let releaseExchange;
  const exchange = new Promise((resolve) => { releaseExchange = resolve; });
  const store = secureStoreHarness("refresh-old");
  const authSession = {
    makeRedirectUri: () => "openiot-moodlight://auth/callback",
    ResponseType: { Code: "code" },
    AuthRequest: class {
      constructor() { this.codeVerifier = "verifier"; }
      async promptAsync() { return { type: "success", params: { code: "authorization-code" } }; }
    },
    exchangeCodeAsync: async () => exchange,
  };
  const auth = load("src/auth.ts", { "expo-auth-session": authSession, "expo-secure-store": store.module });
  const config = { clientId: "client", redirectUri: "callback", discovery: {} };
  let current = true;
  const signIn = auth.signInWithCognito(config, () => current);
  await Promise.resolve();
  await auth.clearCognitoSession(() => true);
  current = false;
  releaseExchange({ accessToken: "access-new", refreshToken: "refresh-new" });
  assert.equal(await signIn, null);
  assert.equal(store.value(), null);
});

test("pending Claim writes and logout deletion are serialized so a late write cannot resurrect it", async () => {
  let releaseWrite;
  let stored = null;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const secureStore = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
    async getItemAsync() { return stored; },
    async setItemAsync(_key, value) { await writeGate; stored = value; },
    async deleteItemAsync() { stored = null; },
  };
  const claims = load("src/pendingClaim.ts", { "expo-secure-store": secureStore });
  const pending = {
    tenantId: "home-a", serial: "serial-a", claimId: "claim-a",
    expiresAt: "2099-01-01T00:00:00.000Z", registrationNonce: "nonce-a",
  };
  const write = claims.savePendingClaim(pending);
  await Promise.resolve();
  const logout = claims.clearPendingClaim();
  releaseWrite();
  assert.equal(await write, true);
  await logout;
  assert.equal(stored, null);
});

test("generation guards skip stale pending Claim mutations", async () => {
  const store = secureStoreHarness();
  const claims = load("src/pendingClaim.ts", { "expo-secure-store": store.module });
  const saved = await claims.savePendingClaim({
    tenantId: "home-a", serial: "serial-a", claimId: "claim-a",
    expiresAt: "2099-01-01T00:00:00.000Z", registrationNonce: "nonce-a",
  }, () => false);
  assert.equal(saved, false);
  assert.equal(store.value(), null);
});
