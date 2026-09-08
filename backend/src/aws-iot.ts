import {
  DeleteThingCommand,
  DetachPolicyCommand,
  DetachThingPrincipalCommand,
  IoTClient,
  ListAttachedPoliciesCommand,
  ListThingPrincipalsCommand,
  UpdateCertificateCommand,
  type IoTClientConfig,
} from "@aws-sdk/client-iot";
import { IoTDataPlaneClient, PublishCommand, type IoTDataPlaneClientConfig } from "@aws-sdk/client-iot-data-plane";
import { AppError, type DecommissionConfirmation, type DesiredState, type Device } from "./domain.ts";
import type { CommandPublisher, DeviceDecommissioner } from "./ports.ts";

type Sender = { send(command: unknown): Promise<unknown> };

export class AwsIotCommandPublisher implements CommandPublisher {
  private readonly client: Sender;
  private readonly topicRoot: string;

  constructor(client: Sender, topicRoot: string) {
    this.client = client;
    this.topicRoot = validTopicRoot(topicRoot);
  }

  static fromConfig(config: IoTDataPlaneClientConfig, topicRoot: string): AwsIotCommandPublisher {
    return new AwsIotCommandPublisher(new IoTDataPlaneClient(config), topicRoot);
  }

  async publish(device: Device, commandId: string, commandSequence: number, desired: DesiredState): Promise<void> {
    const topic = `${this.topicRoot}/${segment(device.tenantId)}/pools/${segment(device.poolId)}/${segment(device.thingName)}/cmd`;
    await this.client.send(new PublishCommand({
      topic,
      qos: 1,
      retain: false,
      payload: Buffer.from(JSON.stringify({ commandId, commandSequence, ...desired }), "utf8"),
    }));
  }
}

export interface AwsIotDeviceDecommissionerOptions {
  certificateArnPrefix: string;
  policyNamePrefix: string;
  thingNamePrefix: string;
}

export class AwsIotDeviceDecommissioner implements DeviceDecommissioner {
  private readonly client: Sender;
  private readonly options: AwsIotDeviceDecommissionerOptions;
  constructor(client: Sender, options: AwsIotDeviceDecommissionerOptions) {
    this.client = client;
    this.options = options;
    if (!/^arn:aws[a-zA-Z-]*:iot:[a-z0-9-]+:[0-9]{12}:cert\/$/.test(options.certificateArnPrefix)) {
      throw new Error("IOT_CERTIFICATE_ARN_PREFIX is invalid");
    }
    if (!/^[A-Za-z0-9:_-]+$/.test(options.policyNamePrefix)) throw new Error("IOT_POLICY_NAME_PREFIX is invalid");
    if (!/^[A-Za-z0-9:_-]+$/.test(options.thingNamePrefix)) throw new Error("IOT_THING_NAME_PREFIX is invalid");
  }

  static fromConfig(config: IoTClientConfig, options: AwsIotDeviceDecommissionerOptions): AwsIotDeviceDecommissioner {
    return new AwsIotDeviceDecommissioner(new IoTClient(config), options);
  }

  async decommission(device: Device): Promise<DecommissionConfirmation> {
    if (!device.thingName.startsWith(this.options.thingNamePrefix)) {
      throw new AppError("UNEXPECTED_IOT_THING", 409, "Thing is outside the managed project prefix");
    }
    const certificateArn = `${this.options.certificateArnPrefix}${segment(device.certificateId)}`;

    const principalsResult = await ignoreNotFound(() => this.client.send(new ListThingPrincipalsCommand({ thingName: device.thingName }))) as
      | { principals?: string[] }
      | undefined;
    if (!principalsResult?.principals?.includes(certificateArn)) {
      throw new AppError("IOT_BINDING_MISMATCH", 409, "Stored certificate is not attached to the managed Thing");
    }

    let marker: string | undefined;
    const policyNames: string[] = [];
    do {
      const page = await ignoreNotFound(() => this.client.send(new ListAttachedPoliciesCommand({ target: certificateArn, marker }))) as
        | { policies?: { policyName?: string }[]; nextMarker?: string }
        | undefined;
      if (!page) break;
      for (const policy of page.policies ?? []) {
        const name = policy.policyName;
        if (!name?.startsWith(this.options.policyNamePrefix)) {
          throw new AppError("UNEXPECTED_IOT_POLICY", 409, "Certificate has a policy outside the managed project prefix");
        }
        policyNames.push(name);
      }
      marker = page.nextMarker;
    } while (marker);

    await ignoreNotFound(() => this.client.send(new UpdateCertificateCommand({ certificateId: device.certificateId, newStatus: "INACTIVE" })));
    for (const name of policyNames) {
      await ignoreNotFound(() => this.client.send(new DetachPolicyCommand({ policyName: name, target: certificateArn })));
    }

    await ignoreNotFound(() => this.client.send(new DetachThingPrincipalCommand({ thingName: device.thingName, principal: certificateArn })));
    const remainingResult = await ignoreNotFound(() => this.client.send(new ListThingPrincipalsCommand({ thingName: device.thingName }))) as
      | { principals?: string[] }
      | undefined;
    const thingAlreadyMissing = remainingResult === undefined;
    const remaining = remainingResult?.principals ?? [];
    if (remaining.length > 0) {
      throw new AppError("THING_HAS_OTHER_PRINCIPALS", 409, "Thing still has principals outside the released certificate");
    }
    if (!thingAlreadyMissing) await ignoreNotFound(() => this.client.send(new DeleteThingCommand({ thingName: device.thingName })));

    return {
      thingName: device.thingName,
      certificateId: device.certificateId,
      certificateDisabled: true,
      policiesDetached: true,
      thingDeleted: true,
    };
  }
}

function validTopicRoot(value: string): string {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("//")
      || !/^[A-Za-z0-9:_/-]+$/.test(value)) throw new Error("IOT_TOPIC_ROOT is invalid");
  return value;
}

function segment(value: string): string {
  if (!value || !/^[A-Za-z0-9:_-]+$/.test(value)) throw new AppError("INVALID_IOT_ID", 500, "Stored IoT identifier is invalid");
  return value;
}

async function ignoreNotFound<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (errorName(error) === "ResourceNotFoundException") return undefined;
    throw error;
  }
}

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { name?: string }).name : undefined;
}
