import { createHash } from "node:crypto";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  UpdateScheduleCommand,
  type SchedulerClientConfig,
} from "@aws-sdk/client-scheduler";
import type { Schedule, SchedulerPort } from "./schedules.ts";

type Sender = { send(command: unknown): Promise<unknown> };

export interface AwsSchedulerOptions {
  groupName: string;
  namePrefix: string;
  targetArn: string;
  executionRoleArn: string;
}

export class AwsSchedulerAdapter implements SchedulerPort {
  private readonly client: Sender;
  private readonly options: AwsSchedulerOptions;
  constructor(client: Sender, options: AwsSchedulerOptions) {
    this.client = client;
    this.options = options;
    if (!/^[0-9A-Za-z-_]{1,64}$/.test(options.groupName)) throw new Error("SCHEDULER_GROUP_NAME is invalid");
    if (!/^[0-9A-Za-z-_]{1,31}$/.test(options.namePrefix)) throw new Error("SCHEDULE_NAME_PREFIX is invalid");
    if (!isArn(options.targetArn, "lambda") || !isArn(options.executionRoleArn, "iam")) throw new Error("Scheduler target ARNs are invalid");
  }

  static fromConfig(config: SchedulerClientConfig, options: AwsSchedulerOptions): AwsSchedulerAdapter {
    return new AwsSchedulerAdapter(new SchedulerClient(config), options);
  }

  async upsert(schedule: Schedule): Promise<{ schedulerName: string }> {
    const name = scheduleName(this.options.namePrefix, schedule.tenantId, schedule.scheduleId);
    const common = {
      Name: name,
      GroupName: this.options.groupName,
      ScheduleExpression: cron(schedule.localTime, schedule.daysOfWeek),
      ScheduleExpressionTimezone: schedule.timezone,
      FlexibleTimeWindow: { Mode: "OFF" as const },
      State: schedule.enabled ? "ENABLED" as const : "DISABLED" as const,
      Target: {
        Arn: this.options.targetArn,
        RoleArn: this.options.executionRoleArn,
        Input: JSON.stringify({ tenantId: schedule.tenantId, scheduleId: schedule.scheduleId, revision: schedule.revision, scheduledTime: "<aws.scheduler.scheduled-time>" }),
        RetryPolicy: { MaximumEventAgeInSeconds: 120, MaximumRetryAttempts: 3 },
      },
    };
    const remoteRevision = await this.remoteRevision(name);
    if (remoteRevision !== undefined && remoteRevision > schedule.revision) return { schedulerName: name };
    if (remoteRevision !== undefined) {
      await this.client.send(new UpdateScheduleCommand({ ...common, ClientToken: token("update", schedule) }));
    } else {
      await this.client.send(new CreateScheduleCommand({ ...common, ClientToken: token("create", schedule) }));
    }
    return { schedulerName: name };
  }

  async remove(schedule: Schedule): Promise<void> {
    const name = schedule.schedulerName ?? scheduleName(this.options.namePrefix, schedule.tenantId, schedule.scheduleId);
    const remoteRevision = await this.remoteRevision(name);
    if (remoteRevision === undefined || remoteRevision > schedule.revision) return;
    try {
      await this.client.send(new DeleteScheduleCommand({
        Name: name,
        GroupName: this.options.groupName,
        ClientToken: token("delete", schedule),
      }));
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  private async remoteRevision(name: string): Promise<number | undefined> {
    try {
      const result = await this.client.send(new GetScheduleCommand({ Name: name, GroupName: this.options.groupName })) as {
        Target?: { Input?: string };
      };
      const input = result.Target?.Input;
      if (typeof input !== "string") throw new Error("Existing Scheduler target input is missing");
      const parsed = JSON.parse(input) as { revision?: unknown };
      if (!Number.isInteger(parsed.revision) || (parsed.revision as number) < 1) throw new Error("Existing Scheduler revision is invalid");
      return parsed.revision as number;
    } catch (error) {
      if (notFound(error)) return undefined;
      throw error;
    }
  }
}

function scheduleName(prefix: string, tenantId: string, scheduleId: string): string {
  const suffix = createHash("sha256").update(`${tenantId}\0${scheduleId}`, "utf8").digest("hex").slice(0, 32);
  return `${prefix}-${suffix}`;
}

function token(operation: string, schedule: Schedule): string {
  return createHash("sha256").update(`${operation}\0${schedule.tenantId}\0${schedule.scheduleId}\0${schedule.revision}`, "utf8").digest("hex");
}

function cron(localTime: string, days: number[]): string {
  const [hour, minute] = localTime.split(":");
  const names = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return `cron(${Number(minute)} ${Number(hour)} ? * ${days.map((day) => names[day]).join(",")} *)`;
}

function notFound(error: unknown): boolean {
  return error instanceof ResourceNotFoundException
    || (typeof error === "object" && error !== null && (error as { name?: string }).name === "ResourceNotFoundException");
}

function isArn(value: string, service: string): boolean {
  return new RegExp(`^arn:aws[a-zA-Z-]*:${service}:[^:]*:[0-9]{12}:.+$`).test(value);
}
