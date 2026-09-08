import {
  AttachPolicyCommand,
  DescribeCertificateCommand,
  DescribeThingCommand,
  DetachPolicyCommand,
  IoTClient,
  ListAttachedPoliciesCommand,
  ListThingPrincipalsCommand,
  type IoTClientConfig,
} from "@aws-sdk/client-iot";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { AppError, type BootstrapBinding, type DeviceClaim } from "./domain.ts";
import type { ProvisioningPort } from "./ports.ts";

type Sender = { send(command: unknown): Promise<unknown> };

export interface AwsProvisioningOptions {
  registryTable: string;
  thingNamePrefix: string;
  thingTypeName: string;
  certificateArnPrefix: string;
  bootstrapPolicyName: string;
  runtimePolicyName: string;
}

export class AwsProvisioning implements ProvisioningPort {
  private readonly iot: Sender;
  private readonly registry: Sender;
  private readonly options: AwsProvisioningOptions;

  constructor(
    iot: Sender,
    registry: Sender,
    options: AwsProvisioningOptions,
  ) {
    this.iot = iot;
    this.registry = registry;
    this.options = options;
    if (!options.registryTable || !/^[A-Za-z0-9_.-]{3,255}$/.test(options.registryTable)) throw new Error("registryTable is invalid");
    if (!/^[A-Za-z0-9:_-]+$/.test(options.thingNamePrefix)) throw new Error("thingNamePrefix is invalid");
    if (!/^[A-Za-z0-9:_-]+$/.test(options.thingTypeName)) throw new Error("thingTypeName is invalid");
    if (!/^arn:aws[a-zA-Z-]*:iot:[a-z0-9-]+:[0-9]{12}:cert\/$/.test(options.certificateArnPrefix)) throw new Error("certificateArnPrefix is invalid");
    for (const name of [options.bootstrapPolicyName, options.runtimePolicyName]) {
      if (!/^[A-Za-z0-9:_-]+$/.test(name)) throw new Error("IoT policy name is invalid");
    }
  }

  static fromConfig(config: IoTClientConfig, documentClient: DynamoDBDocumentClient, options: AwsProvisioningOptions): AwsProvisioning {
    return new AwsProvisioning(new IoTClient(config), documentClient, options);
  }

  async verifyBootstrap(claim: DeviceClaim): Promise<BootstrapBinding> {
    const registry = await this.registry.send(new GetCommand({
      TableName: this.options.registryTable,
      Key: { serialHash: claim.serialHash },
      ConsistentRead: true,
    })) as { Item?: Record<string, unknown> };
    const item = registry.Item;
    if (!item || (item.status !== "RESERVED" && item.status !== "BOOTSTRAPPED")
      || item.claimId !== claim.claimId || item.serial !== claim.serial
      || item.ownerId !== claim.ownerId || item.tenantId !== claim.tenantId || item.poolId !== claim.poolId
      || item.nonceHash !== claim.registrationNonceHash) {
      throw new AppError("DEVICE_REGISTRY_INCONSISTENT", 409, "Manufacturing registry does not match the Claim");
    }
    if (item.status === "RESERVED" && typeof item.latestCertificateId !== "string") {
      throw new AppError("PROVISIONING_PENDING", 409, "AWS Fleet provisioning is still in progress");
    }
    if (typeof item.latestCertificateId !== "string") {
      throw new AppError("DEVICE_REGISTRY_INCONSISTENT", 409, "Manufacturing registry has no device certificate binding");
    }
    const certificateId = certificateIdValue(item.latestCertificateId);
    const thingName = `${this.options.thingNamePrefix}${claim.serial}`;
    const certificateArn = `${this.options.certificateArnPrefix}${certificateId}`;

    const thing = await this.iot.send(new DescribeThingCommand({ thingName })) as {
      thingName?: string; thingTypeName?: string; attributes?: Record<string, string>;
    };
    if (thing.thingName !== thingName || thing.thingTypeName !== this.options.thingTypeName
      || thing.attributes?.serial !== claim.serial
      || thing.attributes?.tenant_id !== claim.tenantId
      || thing.attributes?.pool_id !== claim.poolId) {
      throw new AppError("IOT_THING_MISMATCH", 409, "Provisioned Thing does not match the Claim");
    }
    const principals = await this.thingPrincipals(thingName);
    if (principals.length !== 1 || principals[0] !== certificateArn) {
      throw new AppError("IOT_BINDING_MISMATCH", 409, "Thing is not bound to exactly the reserved certificate");
    }
    const certificate = await this.iot.send(new DescribeCertificateCommand({ certificateId })) as {
      certificateDescription?: { certificateId?: string; certificateArn?: string; status?: string };
    };
    if (certificate.certificateDescription?.certificateId !== certificateId
      || certificate.certificateDescription.certificateArn !== certificateArn
      || certificate.certificateDescription.status !== "ACTIVE") {
      throw new AppError("IOT_CERTIFICATE_MISMATCH", 409, "Provisioned certificate is not active or does not match the registry");
    }
    const policies = await this.assertTransitionPolicies(certificateArn);
    if (item.status === "RESERVED"
      && (policies.size !== 1 || !policies.has(this.options.bootstrapPolicyName))) {
      throw new AppError("IOT_POLICY_TRANSITION_INVALID", 409, "Reserved device must still use only the bootstrap policy");
    }
    return { thingName, serial: claim.serial, certificateId };
  }

  async authorizeRuntime(claim: DeviceClaim, binding: BootstrapBinding): Promise<void> {
    const expectedThingName = `${this.options.thingNamePrefix}${claim.serial}`;
    if (claim.status !== "BOOTSTRAPPED" || binding.serial !== claim.serial || binding.thingName !== expectedThingName) {
      throw new AppError("BOOTSTRAP_BINDING_MISMATCH", 409, "Runtime transition requires the durable bootstrap binding");
    }
    const certificateId = certificateIdValue(binding.certificateId);
    const certificateArn = `${this.options.certificateArnPrefix}${certificateId}`;
    const policies = await this.assertTransitionPolicies(certificateArn);
    if (!policies.has(this.options.runtimePolicyName)) {
      await this.iot.send(new AttachPolicyCommand({ policyName: this.options.runtimePolicyName, target: certificateArn }));
    }
    if (policies.has(this.options.bootstrapPolicyName)) {
      await this.iot.send(new DetachPolicyCommand({ policyName: this.options.bootstrapPolicyName, target: certificateArn }));
    }
    const finalPolicies = await this.policyNames(certificateArn);
    if (finalPolicies.size !== 1 || !finalPolicies.has(this.options.runtimePolicyName)) {
      throw new AppError("IOT_POLICY_TRANSITION_INCOMPLETE", 502, "Runtime policy transition was not confirmed");
    }
  }

  private async assertTransitionPolicies(certificateArn: string): Promise<Set<string>> {
    const policies = await this.policyNames(certificateArn);
    if (![...policies].every((name) => name === this.options.bootstrapPolicyName || name === this.options.runtimePolicyName)
      || (!policies.has(this.options.bootstrapPolicyName) && !policies.has(this.options.runtimePolicyName))) {
      throw new AppError("UNEXPECTED_IOT_POLICY", 409, "Certificate policy binding is outside the bootstrap transition");
    }
    return policies;
  }

  private async policyNames(certificateArn: string): Promise<Set<string>> {
    let marker: string | undefined;
    const names = new Set<string>();
    do {
      const page = await this.iot.send(new ListAttachedPoliciesCommand({ target: certificateArn, marker })) as {
        policies?: Array<{ policyName?: string }>; nextMarker?: string;
      };
      for (const policy of page.policies ?? []) if (policy.policyName) names.add(policy.policyName);
      marker = page.nextMarker;
    } while (marker);
    return names;
  }

  private async thingPrincipals(thingName: string): Promise<string[]> {
    let nextToken: string | undefined;
    const principals: string[] = [];
    do {
      const page = await this.iot.send(new ListThingPrincipalsCommand({ thingName, nextToken })) as {
        principals?: string[]; nextToken?: string;
      };
      principals.push(...(page.principals ?? []));
      nextToken = page.nextToken;
    } while (nextToken);
    return principals;
  }
}

function certificateIdValue(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new AppError("INVALID_CERTIFICATE_ID", 409, "Certificate ID is invalid");
  return value.toLowerCase();
}
