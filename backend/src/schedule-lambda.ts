import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AwsIotCommandPublisher } from "./aws-iot.ts";
import { AwsSchedulerAdapter } from "./aws-scheduler.ts";
import { DynamoScheduleRepository } from "./dynamodb-schedules.ts";
import { DynamoRepository } from "./dynamodb.ts";
import { NotConfiguredClaimRegistrar, NotConfiguredDeviceDecommissioner, NotConfiguredProvisioning } from "./ports.ts";
import type { ScheduleExecutionInput, ScheduleExecutionResult } from "./schedules.ts";
import { MoodlightService } from "./service.ts";

export type ScheduleLambdaEvent = (ScheduleExecutionInput & { action?: "EXECUTE" | "RECONCILE" }) | { action: "RECONCILE_DUE"; limit?: number };
type Result = ScheduleExecutionResult | { status: "RECONCILED" } | { status: "RECONCILED_DUE"; attempted: number; failed: number };

export function createScheduleLambdaHandler(service: Pick<MoodlightService, "executeSchedule" | "reconcilePendingSchedule" | "reconcileDueSchedules">) {
  return async (event: ScheduleLambdaEvent): Promise<Result> => {
    if (event.action === "RECONCILE_DUE") {
      const result = await service.reconcileDueSchedules(event.limit);
      return { status: "RECONCILED_DUE", ...result };
    }
    if (event.action === "RECONCILE") {
      await service.reconcilePendingSchedule(event);
      return { status: "RECONCILED" };
    }
    return service.executeSchedule(event);
  };
}

let runtimeHandler: ReturnType<typeof createScheduleLambdaHandler> | undefined;

export async function handler(event: ScheduleLambdaEvent): Promise<Result> {
  runtimeHandler ??= createRuntimeHandler();
  return runtimeHandler(event);
}

function createRuntimeHandler() {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const repository = new DynamoRepository(documentClient, {
    tenant: requiredEnv("TABLE_TENANT"), membership: requiredEnv("TABLE_MEMBERSHIP"), pool: requiredEnv("TABLE_POOL"),
    device: requiredEnv("TABLE_DEVICE"), deviceClaim: requiredEnv("TABLE_DEVICE_CLAIM"),
  });
  const scheduleRepository = new DynamoScheduleRepository(documentClient, requiredEnv("TABLE_SCHEDULE"));
  const commands = AwsIotCommandPublisher.fromConfig(
    { endpoint: endpoint(requiredEnv("IOT_DATA_ENDPOINT")) },
    requiredEnv("IOT_TOPIC_ROOT"),
  );
  const scheduler = AwsSchedulerAdapter.fromConfig({}, {
    groupName: requiredEnv("SCHEDULER_GROUP_NAME"), namePrefix: requiredEnv("SCHEDULE_NAME_PREFIX"),
    targetArn: requiredEnv("SCHEDULE_TARGET_ARN"), executionRoleArn: requiredEnv("SCHEDULE_EXECUTION_ROLE_ARN"),
  });
  return createScheduleLambdaHandler(new MoodlightService(
    repository, new NotConfiguredClaimRegistrar(), new NotConfiguredProvisioning(), commands,
    new NotConfiguredDeviceDecommissioner(), { scheduleRepository, scheduler },
  ));
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function endpoint(value: string): string { return value.startsWith("https://") ? value : `https://${value}`; }
