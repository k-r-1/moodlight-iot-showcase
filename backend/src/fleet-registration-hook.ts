import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { canonicalSerial } from "./serial.ts";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

interface FleetHookEvent {
  claimCertificateId?: unknown;
  certificateId?: unknown;
  templateArn?: unknown;
  clientId?: unknown;
  parameters?: unknown;
}

interface FleetHookResponse {
  allowProvisioning: boolean;
  parameterOverrides?: Record<string, string>;
}

interface HookConfig {
  registryTable: string;
  templateArn: string;
  claimCertificateId: string;
  clientIdPrefix: string;
}

const ALLOWED_PARAMETER_KEYS = new Set([
  "SerialNumber",
  "ClaimId",
  "RegistrationNonceHash",
  "AWS::IoT::Certificate::Id",
]);
const ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CERTIFICATE_ID_PATTERN = /^[a-f0-9]{64}$/i;

export function createFleetRegistrationHook(client: DocumentClient, config: HookConfig) {
  return async (event: FleetHookEvent): Promise<FleetHookResponse> => {
    try {
      const request = validate(event, config);
      const nowEpoch = Math.floor(Date.now() / 1000);
      const reserved = await client.send(new UpdateCommand({
        TableName: config.registryTable,
        Key: { serialHash: sha256(request.serial) },
        UpdateExpression: "SET #latestCertificateId = if_not_exists(#latestCertificateId, :certificateId), #attemptCount = if_not_exists(#attemptCount, :one), #updatedAt = :updatedAt",
        ConditionExpression: [
          "#status = :reserved",
          "#serial = :serial",
          "#claimId = :claimId",
          "#nonceHash = :nonceHash",
          "#reservationExpiresAt > :nowEpoch",
          "(attribute_not_exists(#latestCertificateId) OR #latestCertificateId = :certificateId)",
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#status": "status",
          "#serial": "serial",
          "#claimId": "claimId",
          "#nonceHash": "nonceHash",
          "#reservationExpiresAt": "reservationExpiresAt",
          "#latestCertificateId": "latestCertificateId",
          "#attemptCount": "attemptCount",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":reserved": "RESERVED",
          ":serial": request.serial,
          ":claimId": request.claimId,
          ":nonceHash": request.nonceHash,
          ":certificateId": request.certificateId,
          ":nowEpoch": nowEpoch,
          ":updatedAt": new Date(nowEpoch * 1000).toISOString(),
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      })) as { Attributes?: Record<string, unknown> };
      const tenantId = runtimeSegment(reserved.Attributes?.tenantId);
      const poolId = runtimeSegment(reserved.Attributes?.poolId);
      return {
        allowProvisioning: true,
        parameterOverrides: {
          SerialNumber: request.serial,
          TenantId: tenantId,
          PoolId: poolId,
        },
      };
    } catch (error) {
      // Fleet events may include certificate material and binding hashes. Never
      // log the event or field values; only the safe error category is emitted.
      console.warn("fleet_registration_denied", {
        reason: error instanceof HookValidationError ? error.code : "REGISTRY_CONDITION_FAILED",
      });
      return { allowProvisioning: false };
    }
  };
}

function validate(event: FleetHookEvent, config: HookConfig) {
  if (text(event.templateArn) !== config.templateArn) throw new HookValidationError("TEMPLATE_MISMATCH");
  if (text(event.claimCertificateId) !== config.claimCertificateId) throw new HookValidationError("CLAIM_CERTIFICATE_MISMATCH");
  const certificateId = text(event.certificateId);
  if (!CERTIFICATE_ID_PATTERN.test(certificateId)) throw new HookValidationError("INVALID_CERTIFICATE_ID");
  if (!record(event.parameters)) throw new HookValidationError("INVALID_PARAMETERS");
  const keys = Object.keys(event.parameters);
  if (keys.some((key) => !ALLOWED_PARAMETER_KEYS.has(key))) throw new HookValidationError("EXTRA_PARAMETER");

  const serial = canonicalSerial(text(event.parameters.SerialNumber));
  const claimId = text(event.parameters.ClaimId);
  const nonceHash = text(event.parameters.RegistrationNonceHash);
  const parameterCertificateId = text(event.parameters["AWS::IoT::Certificate::Id"]);
  if (!ID_PATTERN.test(claimId)) throw new HookValidationError("INVALID_CLAIM_ID");
  if (!SHA256_PATTERN.test(nonceHash)) throw new HookValidationError("INVALID_NONCE_HASH");
  if (parameterCertificateId !== certificateId) throw new HookValidationError("CERTIFICATE_PARAMETER_MISMATCH");
  if (text(event.clientId) !== `${config.clientIdPrefix}${serial}`) throw new HookValidationError("CLIENT_ID_MISMATCH");
  return { serial, claimId, nonceHash, certificateId };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function runtimeSegment(value: unknown): string {
  const candidate = text(value);
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(candidate)) {
    throw new HookValidationError("INVALID_REGISTRY_SCOPE");
  }
  return candidate;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HookValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let runtimeHook: ((event: FleetHookEvent) => Promise<FleetHookResponse>) | undefined;

export async function handler(event: FleetHookEvent): Promise<FleetHookResponse> {
  runtimeHook ??= createFleetRegistrationHook(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    {
      registryTable: requiredEnv("TABLE_DEVICE_REGISTRY"),
      templateArn: requiredEnv("FLEET_TEMPLATE_ARN"),
      claimCertificateId: requiredEnv("FLEET_CLAIM_CERTIFICATE_ID"),
      clientIdPrefix: requiredEnv("FLEET_CLAIM_CLIENT_ID_PREFIX"),
    },
  );
  return runtimeHook(event);
}
