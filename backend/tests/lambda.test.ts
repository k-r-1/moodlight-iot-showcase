import assert from "node:assert/strict";
import test from "node:test";
import { createApiGatewayHandler } from "../src/lambda.ts";
import type { ApiRequest, ApiResponse } from "../src/handlers.ts";

test("HTTP API adapter trusts only the JWT authorizer sub", async () => {
  let received: ApiRequest | undefined;
  const adapter = createApiGatewayHandler(async (request): Promise<ApiResponse> => {
    received = request;
    return { statusCode: 200, body: { ok: true } };
  });

  const response = await adapter({
    rawPath: "/devices",
    body: JSON.stringify({ userId: "spoofed-body" }),
    queryStringParameters: { tenantId: "home-a" },
    requestContext: {
      http: { method: "GET" },
      authorizer: { jwt: { claims: { sub: "verified-user" } } },
    },
  });

  assert.equal(received?.auth?.userId, "verified-user");
  assert.equal(received?.query?.tenantId, "home-a");
  assert.deepEqual(JSON.parse(response.body), { ok: true });
  assert.equal(response.headers["cache-control"], "no-store");
});

test("missing JWT claims are passed as unauthenticated instead of trusting request data", async () => {
  let received: ApiRequest | undefined;
  const adapter = createApiGatewayHandler(async (request): Promise<ApiResponse> => {
    received = request;
    return { statusCode: 401, body: { error: { code: "UNAUTHENTICATED" } } };
  });

  await adapter({
    rawPath: "/devices",
    body: JSON.stringify({ auth: { userId: "spoofed" } }),
    requestContext: { http: { method: "GET" } },
  });
  assert.equal(received?.auth, undefined);
});

test("CORS preflight succeeds without JWT and never reaches the domain handler", async () => {
  let calls = 0;
  const adapter = createApiGatewayHandler(async (): Promise<ApiResponse> => {
    calls += 1;
    return { statusCode: 500, body: {} };
  });

  const response = await adapter({
    rawPath: "/devices",
    requestContext: { http: { method: "OPTIONS" } },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, "");
  assert.equal(calls, 0);
});

test("malformed and oversized bodies are rejected before the core handler", async () => {
  let calls = 0;
  const adapter = createApiGatewayHandler(async (): Promise<ApiResponse> => {
    calls += 1;
    return { statusCode: 200, body: {} };
  });

  const malformed = await adapter({
    rawPath: "/device-claims",
    body: "{",
    requestContext: { http: { method: "POST" } },
  });
  const oversized = await adapter({
    rawPath: "/device-claims",
    body: JSON.stringify({ value: "x".repeat(65 * 1024) }),
    requestContext: { http: { method: "POST" } },
  });

  assert.equal(malformed.statusCode, 400);
  assert.equal(oversized.statusCode, 413);
  assert.equal(calls, 0);
});

test("base64 HTTP API bodies are decoded once", async () => {
  let received: ApiRequest | undefined;
  const adapter = createApiGatewayHandler(async (request): Promise<ApiResponse> => {
    received = request;
    return { statusCode: 201, body: {} };
  });
  await adapter({
    rawPath: "/device-claims",
    body: Buffer.from(JSON.stringify({ serial: "serial-a" }), "utf8").toString("base64"),
    isBase64Encoded: true,
    requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub: "user-a" } } } },
  });
  assert.deepEqual(received?.body, { serial: "serial-a" });
});
