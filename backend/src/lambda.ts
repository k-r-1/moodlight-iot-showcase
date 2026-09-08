import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoRepository } from "./dynamodb.ts";
import { DynamoClaimRegistrar } from "./dynamodb-claim-registrar.ts";
import { DynamoScheduleRepository } from "./dynamodb-schedules.ts";
import { AwsIotCommandPublisher, AwsIotDeviceDecommissioner } from "./aws-iot.ts";
import { AwsProvisioning } from "./aws-provisioning.ts";
import { AwsSchedulerAdapter } from "./aws-scheduler.ts";
import { createHandler, type ApiRequest, type ApiResponse } from "./handlers.ts";
import {
  NotConfiguredCommandPublisher,
  NotConfiguredDeviceDecommissioner,
  NotConfiguredProvisioning,
  NotConfiguredClaimRegistrar,
} from "./ports.ts";
import { MoodlightService } from "./service.ts";

const MAX_BODY_BYTES = 64 * 1024;

interface HttpApiEvent {
  rawPath?: unknown;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  requestContext?: {
    http?: { method?: unknown };
    authorizer?: { jwt?: { claims?: Record<string, unknown> } };
  };
}

interface HttpApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

type CoreHandler = (request: ApiRequest) => Promise<ApiResponse>;

let runtimeHandler: ((event: HttpApiEvent) => Promise<HttpApiResponse>) | undefined;

export function createApiGatewayHandler(core: CoreHandler) {
  return async (event: HttpApiEvent): Promise<HttpApiResponse> => {
    try {
      const method = event.requestContext?.http?.method;
      const path = event.rawPath;
      if (typeof method !== "string" || typeof path !== "string") {
        return json(400, { error: { code: "INVALID_EVENT", message: "Invalid HTTP API event" } });
      }
      // The unauthenticated OPTIONS route must return success before auth and
      // domain routing. API Gateway appends the configured CORS headers.
      if (method === "OPTIONS") {
        return { statusCode: 204, headers: { "cache-control": "no-store" }, body: "" };
      }

      const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
      const response = await core({
        method,
        path,
        ...(typeof sub === "string" && sub.trim() ? { auth: { userId: sub } } : {}),
        ...(event.queryStringParameters ? { query: event.queryStringParameters } : {}),
        ...(event.body !== undefined && event.body !== null && event.body !== ""
          ? { body: parseBody(event.body, event.isBase64Encoded === true) }
          : {}),
      });
      return json(response.statusCode, response.body);
    } catch (error) {
      if (error instanceof GatewayInputError) {
        return json(error.status, { error: { code: error.code, message: error.message } });
      }
      console.error("api_request_failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return json(500, { error: { code: "INTERNAL_ERROR", message: "Unexpected backend error" } });
    }
  };
}

export async function handler(event: HttpApiEvent): Promise<HttpApiResponse> {
  runtimeHandler ??= createApiGatewayHandler(createRuntimeCore());
  return runtimeHandler(event);
}

function createRuntimeCore(): CoreHandler {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const repository = new DynamoRepository(documentClient, {
    tenant: requiredEnv("TABLE_TENANT"),
    membership: requiredEnv("TABLE_MEMBERSHIP"),
    pool: requiredEnv("TABLE_POOL"),
    device: requiredEnv("TABLE_DEVICE"),
    deviceClaim: requiredEnv("TABLE_DEVICE_CLAIM"),
    ...(process.env.TABLE_DEVICE_REGISTRY?.trim() ? { deviceRegistry: process.env.TABLE_DEVICE_REGISTRY.trim() } : {}),
  });
  const scheduleTable = process.env.TABLE_SCHEDULE?.trim();
  const registryTable = process.env.TABLE_DEVICE_REGISTRY?.trim();
  const iot = optionalGroup(["IOT_DATA_ENDPOINT", "IOT_TOPIC_ROOT"]);
  const provisioning = optionalGroup([
    "IOT_PROVISIONING_THING_NAME_PREFIX",
    "IOT_PROVISIONING_THING_TYPE_NAME",
    "IOT_PROVISIONING_CERTIFICATE_ARN_PREFIX",
    "IOT_PROVISIONING_BOOTSTRAP_POLICY_NAME",
    "IOT_PROVISIONING_RUNTIME_POLICY_NAME",
  ]);
  const iotDecommission = optionalGroup(["IOT_CERTIFICATE_ARN_PREFIX", "IOT_POLICY_NAME_PREFIX", "IOT_THING_NAME_PREFIX"]);
  const schedulerConfig = optionalGroup(["SCHEDULER_GROUP_NAME", "SCHEDULE_NAME_PREFIX", "SCHEDULE_TARGET_ARN", "SCHEDULE_EXECUTION_ROLE_ARN"]);
  const commands = iot ? AwsIotCommandPublisher.fromConfig({ endpoint: endpoint(iot.IOT_DATA_ENDPOINT) }, iot.IOT_TOPIC_ROOT) : new NotConfiguredCommandPublisher();
  const decommissioner = iotDecommission ? AwsIotDeviceDecommissioner.fromConfig({}, {
    certificateArnPrefix: iotDecommission.IOT_CERTIFICATE_ARN_PREFIX,
    policyNamePrefix: iotDecommission.IOT_POLICY_NAME_PREFIX,
    thingNamePrefix: iotDecommission.IOT_THING_NAME_PREFIX,
  }) : new NotConfiguredDeviceDecommissioner();
  const scheduler = schedulerConfig ? AwsSchedulerAdapter.fromConfig({}, {
    groupName: schedulerConfig.SCHEDULER_GROUP_NAME,
    namePrefix: schedulerConfig.SCHEDULE_NAME_PREFIX,
    targetArn: schedulerConfig.SCHEDULE_TARGET_ARN,
    executionRoleArn: schedulerConfig.SCHEDULE_EXECUTION_ROLE_ARN,
  }) : undefined;
  return createHandler(new MoodlightService(
    repository,
    registryTable
      ? new DynamoClaimRegistrar(documentClient, { deviceRegistry: registryTable, deviceClaim: requiredEnv("TABLE_DEVICE_CLAIM") })
      : new NotConfiguredClaimRegistrar(),
    registryTable && provisioning
      ? AwsProvisioning.fromConfig({}, documentClient, {
        registryTable,
        thingNamePrefix: provisioning.IOT_PROVISIONING_THING_NAME_PREFIX,
        thingTypeName: provisioning.IOT_PROVISIONING_THING_TYPE_NAME,
        certificateArnPrefix: provisioning.IOT_PROVISIONING_CERTIFICATE_ARN_PREFIX,
        bootstrapPolicyName: provisioning.IOT_PROVISIONING_BOOTSTRAP_POLICY_NAME,
        runtimePolicyName: provisioning.IOT_PROVISIONING_RUNTIME_POLICY_NAME,
      })
      : new NotConfiguredProvisioning(),
    commands,
    decommissioner,
    scheduleTable ? { scheduleRepository: new DynamoScheduleRepository(documentClient, scheduleTable), ...(scheduler ? { scheduler } : {}) } : {},
  ));
}

function parseBody(body: string, base64Encoded: boolean): unknown {
  const decoded = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  if (Buffer.byteLength(decoded, "utf8") > MAX_BODY_BYTES) {
    throw new GatewayInputError("PAYLOAD_TOO_LARGE", 413, "Request body is too large");
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new GatewayInputError("INVALID_JSON", 400, "Request body must be valid JSON");
  }
}


function optionalGroup<const N extends readonly string[]>(names: N): { [K in N[number]]: string } | undefined {
  const values = names.map((name) => process.env[name]?.trim() ?? "");
  if (values.every((value) => value === "")) return undefined;
  if (values.some((value) => value === "")) throw new Error(`Incomplete environment group: ${names.join(", ")}`);
  return Object.fromEntries(names.map((name, index) => [name, values[index]])) as { [K in N[number]]: string };
}

function endpoint(value: string): string { return value.startsWith("https://") ? value : `https://${value}`; }

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function json(statusCode: number, body: unknown): HttpApiResponse {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

class GatewayInputError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GatewayInputError";
    this.code = code;
    this.status = status;
  }
}
