import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { AppError, type BootstrapBinding, type DesiredState, type Device, type DeviceClaim, type DeviceState, type EventUplink, type IngestDisposition, type MembershipRole, type PersonalTenantBootstrap, type StateUplink, type TelemetryUplink, type TenantContext } from "./domain.ts";
import type { IngestRepository, Repository } from "./ports.ts";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;
type Item = Record<string, unknown>;

export interface DynamoRepositoryTables {
  tenant: string;
  membership: string;
  pool: string;
  device: string;
  deviceClaim: string;
  deviceRegistry?: string;
}

const CLAIM_PREFIX = "CLAIM#";
const SERIAL_PREFIX = "SERIAL#";
const DEVICE_INDEX = "tenant-pool-devices-index";
const COMMAND_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export class DynamoRepository implements Repository, IngestRepository {
  private readonly client: DocumentClient;
  private readonly tables: DynamoRepositoryTables;

  constructor(
    client: DocumentClient,
    tables: DynamoRepositoryTables,
  ) {
    this.client = client;
    this.tables = tables;
  }

  async bootstrapPersonalTenant(input: PersonalTenantBootstrap): Promise<TenantContext> {
    const existing = await this.activeTenantContext(input.userId);
    if (existing) return existing;
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tables.tenant,
              Item: {
                tenantId: input.tenantId,
                name: input.tenantName,
                createdAt: input.now,
                updatedAt: input.now,
                version: 1,
              },
              ConditionExpression: "attribute_not_exists(#tenantId)",
              ExpressionAttributeNames: { "#tenantId": "tenantId" },
            },
          },
          {
            Put: {
              TableName: this.tables.pool,
              Item: {
                tenantId: input.tenantId,
                poolId: input.poolId,
                name: input.poolName,
                sortOrder: 0,
                createdAt: input.now,
                updatedAt: input.now,
              },
              ConditionExpression: "attribute_not_exists(#tenantId) AND attribute_not_exists(#poolId)",
              ExpressionAttributeNames: { "#tenantId": "tenantId", "#poolId": "poolId" },
            },
          },
          {
            Put: {
              TableName: this.tables.membership,
              Item: {
                userId: input.userId,
                tenantId: input.tenantId,
                role: "OWNER",
                status: "ACTIVE",
                createdAt: input.now,
              },
              ConditionExpression: "attribute_not_exists(#userId) AND attribute_not_exists(#tenantId)",
              ExpressionAttributeNames: { "#userId": "userId", "#tenantId": "tenantId" },
            },
          },
        ],
      }));
      return { tenantId: input.tenantId, poolId: input.poolId, role: "OWNER" };
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
      const raced = await this.activeTenantContext(input.userId);
      if (raced) return raced;
      throw new AppError("TENANT_BOOTSTRAP_CONFLICT", 409, "Personal Tenant could not be created safely");
    }
  }

  async hasMembership(userId: string, tenantId: string): Promise<boolean> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tables.membership,
      Key: { userId, tenantId },
      ConsistentRead: true,
      ProjectionExpression: "#status",
      ExpressionAttributeNames: { "#status": "status" },
    }));
    return result.Item?.status === "ACTIVE";
  }

  async hasPool(tenantId: string, poolId: string): Promise<boolean> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tables.pool,
      Key: { tenantId, poolId },
      ConsistentRead: true,
      ProjectionExpression: "#poolId",
      ExpressionAttributeNames: { "#poolId": "poolId" },
    }));
    return result.Item?.poolId === poolId;
  }

  async listDevices(tenantId: string): Promise<Device[]> {
    const devices: Device[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tables.device,
        IndexName: DEVICE_INDEX,
        KeyConditionExpression: "#tenantId = :tenantId",
        ExpressionAttributeValues: { ":tenantId": tenantId },
        ProjectionExpression: "#deviceId",
        ExpressionAttributeNames: { "#tenantId": "tenantId", "#deviceId": "deviceId" },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      const ids = (page.Items ?? []).map((item) => stringField(item, "deviceId"));
      const rows = await Promise.all(ids.map((deviceId) => this.getDevice(deviceId)));
      devices.push(...rows.filter((item): item is Device => item?.tenantId === tenantId));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return devices;
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tables.device,
      Key: { deviceId },
      ConsistentRead: true,
    }));
    return result.Item ? hydrateDevice(result.Item) : undefined;
  }

  async createClaim(claim: DeviceClaim): Promise<void> {
    const lockKey = serialKey(claim.serialHash);
    const nowEpoch = epochSeconds(claim.createdAt);
    const expiresAt = epochSeconds(claim.expiresAt);
    const currentLock = await this.getItem(this.tables.deviceClaim, { claimKey: lockKey });
    if (currentLock) {
      if ("deviceId" in currentLock) {
        stringField(currentLock, "deviceId");
        throw serialRegistered();
      }
      if (numberField(currentLock, "expiresAt") > nowEpoch) throw serialClaimed();
    }

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tables.deviceClaim,
              Item: serializeClaim(claim),
              ConditionExpression: "attribute_not_exists(#claimKey)",
              ExpressionAttributeNames: { "#claimKey": "claimKey" },
            },
          },
          {
            Put: {
              TableName: this.tables.deviceClaim,
              Item: {
                claimKey: lockKey,
                claimId: claim.claimId,
                serialHash: claim.serialHash,
                expiresAt,
                createdAt: claim.createdAt,
                updatedAt: claim.updatedAt,
              },
              ConditionExpression: "(attribute_not_exists(#claimKey) OR #expiresAt <= :now) AND attribute_not_exists(#deviceId)",
              ExpressionAttributeNames: {
                "#claimKey": "claimKey",
                "#expiresAt": "expiresAt",
                "#deviceId": "deviceId",
              },
              ExpressionAttributeValues: { ":now": nowEpoch },
            },
          },
        ],
      }));
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
      const lock = await this.getItem(this.tables.deviceClaim, { claimKey: lockKey });
      if (lock?.deviceId) throw serialRegistered();
      throw serialClaimed();
    }
  }

  async getClaim(claimId: string): Promise<DeviceClaim | undefined> {
    const item = await this.getItem(this.tables.deviceClaim, { claimKey: claimKey(claimId) });
    return item ? hydrateClaim(item) : undefined;
  }

  async expireClaim(claimId: string, now: string): Promise<DeviceClaim> {
    const nowEpoch = epochSeconds(now);
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.tables.deviceClaim,
        Key: { claimKey: claimKey(claimId) },
        UpdateExpression: "SET #status = :expired, #updatedAt = :now REMOVE #finalizeLeaseId, #finalizeLeaseExpiresAt, #finalizeResumeStatus",
        ConditionExpression: "(#status = :pending OR (#status = :provisioning AND #finalizeResumeStatus = :pending)) AND #expiresAt <= :nowEpoch",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#expiresAt": "expiresAt",
          "#finalizeLeaseId": "finalizeLeaseId",
          "#finalizeLeaseExpiresAt": "finalizeLeaseExpiresAt",
          "#finalizeResumeStatus": "finalizeResumeStatus",
        },
        ExpressionAttributeValues: {
          ":expired": "EXPIRED",
          ":pending": "CLAIM_PENDING",
          ":provisioning": "PROVISIONING",
          ":now": now,
          ":nowEpoch": nowEpoch,
        },
        ReturnValues: "ALL_NEW",
      }));
      if (!result.Attributes) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
      return hydrateClaim(result.Attributes);
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const current = await this.getClaim(claimId);
      if (!current) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
      return current;
    }
  }

  async acquireFinalizeLease(claimId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<{ claim: DeviceClaim; acquired: boolean }> {
    const nowEpoch = epochSeconds(now);
    const leaseExpiresAtEpoch = epochSeconds(leaseExpiresAt);
    const key = { claimKey: claimKey(claimId) };
    const names = {
      "#status": "status",
      "#updatedAt": "updatedAt",
      "#expiresAt": "expiresAt",
      "#claimExpiresAt": "claimExpiresAt",
      "#finalizeLeaseId": "finalizeLeaseId",
      "#finalizeLeaseExpiresAt": "finalizeLeaseExpiresAt",
      "#finalizeResumeStatus": "finalizeResumeStatus",
    };
    const startValues = {
      ":pending": "CLAIM_PENDING",
      ":bootstrapped": "BOOTSTRAPPED",
      ":provisioning": "PROVISIONING",
      ":leaseId": leaseId,
      ":now": now,
      ":nowEpoch": nowEpoch,
      ":leaseExpiresAt": leaseExpiresAtEpoch,
    };
    try {
      const started = await this.client.send(new UpdateCommand({
        TableName: this.tables.deviceClaim,
        Key: key,
        UpdateExpression: "SET #finalizeResumeStatus = #status, #status = :provisioning, #finalizeLeaseId = :leaseId, #finalizeLeaseExpiresAt = :leaseExpiresAt, #updatedAt = :now",
        ConditionExpression: "(#status = :pending AND #expiresAt > :nowEpoch) OR (#status = :bootstrapped AND attribute_exists(#claimExpiresAt))",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: startValues,
        ReturnValues: "ALL_NEW",
      }));
      if (!started.Attributes) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
      return { claim: hydrateClaim(started.Attributes), acquired: true };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    try {
      const recovered = await this.client.send(new UpdateCommand({
        TableName: this.tables.deviceClaim,
        Key: key,
        UpdateExpression: "SET #finalizeLeaseId = :leaseId, #finalizeLeaseExpiresAt = :leaseExpiresAt, #updatedAt = :now",
        ConditionExpression: "#status = :provisioning AND #finalizeLeaseExpiresAt <= :nowEpoch AND ((#finalizeResumeStatus = :pending AND #expiresAt > :nowEpoch) OR (#finalizeResumeStatus = :bootstrapped AND attribute_exists(#claimExpiresAt)))",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: {
          ":provisioning": "PROVISIONING",
          ":pending": "CLAIM_PENDING",
          ":bootstrapped": "BOOTSTRAPPED",
          ":leaseId": leaseId,
          ":now": now,
          ":nowEpoch": nowEpoch,
          ":leaseExpiresAt": leaseExpiresAtEpoch,
        },
        ReturnValues: "ALL_NEW",
      }));
      if (!recovered.Attributes) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
      return { claim: hydrateClaim(recovered.Attributes), acquired: true };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }

    const currentItem = await this.getItem(this.tables.deviceClaim, key);
    if (!currentItem) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    const current = hydrateClaim(currentItem);
    if (current.status === "RUNTIME_AUTHORIZED" || current.status === "ONLINE") {
      return { claim: current, acquired: false };
    }
    if ((current.status === "CLAIM_PENDING" || currentItem.finalizeResumeStatus === "CLAIM_PENDING")
      && epochSeconds(current.expiresAt) <= nowEpoch) throw new AppError("CLAIM_EXPIRED", 410, "Claim has expired");
    if (current.status === "PROVISIONING") {
      throw new AppError("CLAIM_FINALIZE_IN_PROGRESS", 409, "Claim finalization is already in progress");
    }
    throw new AppError("CLAIM_CONFLICT", 409, "Claim changed before finalization started");
  }

  async releaseFinalizeLease(claimId: string, leaseId: string, now: string): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tables.deviceClaim,
        Key: { claimKey: claimKey(claimId) },
        UpdateExpression: "SET #status = #finalizeResumeStatus, #updatedAt = :now REMOVE #finalizeLeaseId, #finalizeLeaseExpiresAt, #finalizeResumeStatus",
        ConditionExpression: "#status = :provisioning AND #finalizeLeaseId = :leaseId AND attribute_exists(#finalizeResumeStatus)",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#finalizeLeaseId": "finalizeLeaseId",
          "#finalizeLeaseExpiresAt": "finalizeLeaseExpiresAt",
          "#finalizeResumeStatus": "finalizeResumeStatus",
        },
        ExpressionAttributeValues: { ":provisioning": "PROVISIONING", ":leaseId": leaseId, ":now": now },
      }));
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
    }
  }

  async bootstrapClaim(claimId: string, binding: BootstrapBinding, leaseId: string, now: string): Promise<{ claim: DeviceClaim; device: Device }> {
    const item = await this.getItem(this.tables.deviceClaim, { claimKey: claimKey(claimId) });
    if (!item) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    const claim = hydrateClaim(item);
    if (claim.status !== "PROVISIONING") throw new AppError("INVALID_CLAIM_STATE", 409, `Cannot bootstrap claim in ${claim.status}`);
    if (binding.serial !== claim.serial) throw new AppError("SERIAL_MISMATCH", 409, "Provisioned serial does not match claim");
    const registryTable = this.registryTable();
    const nowEpoch = epochSeconds(now);
    const expiresAt = epochSeconds(claim.expiresAt);

    if (item.finalizeResumeStatus === "BOOTSTRAPPED") {
      const device = await this.getDevice(binding.thingName);
      if (!device || device.lifecycleStatus !== "BOOTSTRAPPED" || !sameBootstrapBinding(device, claim, binding)) {
        throw new AppError("CLAIM_INCONSISTENT", 409, "Bootstrapped Claim has no matching Device");
      }
      try {
        await this.client.send(new TransactWriteCommand({ TransactItems: [
          { Update: {
            TableName: this.tables.deviceClaim,
            Key: { claimKey: claimKey(claimId) },
            UpdateExpression: "SET #status = :bootstrapped, #updatedAt = :now REMOVE #finalizeLeaseId, #finalizeLeaseExpiresAt, #finalizeResumeStatus",
            ConditionExpression: "#status = :provisioning AND #finalizeResumeStatus = :bootstrapped AND #finalizeLeaseId = :leaseId AND #thingName = :thingName AND #serialHash = :serialHash",
            ExpressionAttributeNames: {
              "#status": "status", "#updatedAt": "updatedAt", "#finalizeLeaseId": "finalizeLeaseId",
              "#finalizeLeaseExpiresAt": "finalizeLeaseExpiresAt", "#finalizeResumeStatus": "finalizeResumeStatus",
              "#thingName": "thingName", "#serialHash": "serialHash",
            },
            ExpressionAttributeValues: {
              ":provisioning": "PROVISIONING", ":bootstrapped": "BOOTSTRAPPED", ":leaseId": leaseId,
              ":thingName": binding.thingName, ":serialHash": claim.serialHash, ":now": now,
            },
          } },
          { ConditionCheck: {
            TableName: this.tables.device,
            Key: { deviceId: binding.thingName },
            ConditionExpression: "#lifecycleStatus = :bootstrapped AND #claimId = :claimId AND #serial = :serial AND #certificateId = :certificateId",
            ExpressionAttributeNames: { "#lifecycleStatus": "lifecycleStatus", "#claimId": "claimId", "#serial": "serial", "#certificateId": "certificateId" },
            ExpressionAttributeValues: { ":bootstrapped": "BOOTSTRAPPED", ":claimId": claimId, ":serial": claim.serial, ":certificateId": binding.certificateId },
          } },
          { ConditionCheck: {
            TableName: this.tables.deviceClaim,
            Key: { claimKey: serialKey(claim.serialHash) },
            ConditionExpression: "#claimId = :claimId AND #deviceId = :deviceId AND #thingName = :thingName AND attribute_not_exists(#expiresAt)",
            ExpressionAttributeNames: { "#claimId": "claimId", "#deviceId": "deviceId", "#thingName": "thingName", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: { ":claimId": claimId, ":deviceId": device.deviceId, ":thingName": binding.thingName },
          } },
          { ConditionCheck: {
            TableName: registryTable,
            Key: { serialHash: claim.serialHash },
            ConditionExpression: "#status = :bootstrapped AND #claimId = :claimId AND #thingName = :thingName AND #certificateId = :certificateId",
            ExpressionAttributeNames: { "#status": "status", "#claimId": "claimId", "#thingName": "thingName", "#certificateId": "certificateId" },
            ExpressionAttributeValues: { ":bootstrapped": "BOOTSTRAPPED", ":claimId": claimId, ":thingName": binding.thingName, ":certificateId": binding.certificateId },
          } },
        ] }));
        return { claim: { ...claim, status: "BOOTSTRAPPED", updatedAt: now }, device };
      } catch (error) {
        if (!isConditionalTransactionConflict(error)) throw error;
        throw new AppError("CLAIM_CONFLICT", 409, "Bootstrapped binding changed while finalization resumed");
      }
    }

    if (item.finalizeResumeStatus !== "CLAIM_PENDING" || expiresAt <= nowEpoch) {
      throw new AppError(expiresAt <= nowEpoch ? "CLAIM_EXPIRED" : "CLAIM_CONFLICT", expiresAt <= nowEpoch ? 410 : 409, "Claim cannot enter bootstrap binding");
    }
    const device = newDevice(claim, binding, "BOOTSTRAPPED");
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.tables.deviceClaim,
          Key: { claimKey: claimKey(claimId) },
          UpdateExpression: "SET #status = :bootstrapped, #thingName = :thingName, #updatedAt = :now, #claimExpiresAt = :expiresAt REMOVE #expiresAt, #finalizeLeaseId, #finalizeLeaseExpiresAt, #finalizeResumeStatus",
          ConditionExpression: "#status = :provisioning AND #finalizeResumeStatus = :pending AND #finalizeLeaseId = :leaseId AND #finalizeLeaseExpiresAt > :nowEpoch AND #expiresAt = :expiresAt AND #expiresAt > :nowEpoch AND #serial = :serial AND #serialHash = :serialHash",
          ExpressionAttributeNames: {
            "#status": "status", "#thingName": "thingName", "#updatedAt": "updatedAt", "#claimExpiresAt": "claimExpiresAt",
            "#expiresAt": "expiresAt", "#serial": "serial", "#serialHash": "serialHash", "#finalizeLeaseId": "finalizeLeaseId",
            "#finalizeLeaseExpiresAt": "finalizeLeaseExpiresAt", "#finalizeResumeStatus": "finalizeResumeStatus",
          },
          ExpressionAttributeValues: {
            ":bootstrapped": "BOOTSTRAPPED", ":provisioning": "PROVISIONING", ":pending": "CLAIM_PENDING",
            ":leaseId": leaseId, ":thingName": binding.thingName, ":now": now, ":nowEpoch": nowEpoch,
            ":expiresAt": expiresAt, ":serial": claim.serial, ":serialHash": claim.serialHash,
          },
        } },
        { Update: {
          TableName: this.tables.deviceClaim,
          Key: { claimKey: serialKey(claim.serialHash) },
          UpdateExpression: "SET #deviceId = :deviceId, #thingName = :thingName, #certificateId = :certificateId, #boundAt = :now REMOVE #expiresAt",
          ConditionExpression: "#claimId = :claimId AND #expiresAt = :expiresAt AND #expiresAt > :nowEpoch AND attribute_not_exists(#deviceId)",
          ExpressionAttributeNames: { "#deviceId": "deviceId", "#thingName": "thingName", "#certificateId": "certificateId", "#boundAt": "boundAt", "#expiresAt": "expiresAt", "#claimId": "claimId" },
          ExpressionAttributeValues: { ":deviceId": device.deviceId, ":thingName": device.thingName, ":certificateId": binding.certificateId, ":now": now, ":nowEpoch": nowEpoch, ":expiresAt": expiresAt, ":claimId": claimId },
        } },
        { Put: {
          TableName: this.tables.device,
          Item: serializeDevice(device),
          ConditionExpression: "attribute_not_exists(#deviceId) OR (#lifecycleStatus = :revoked AND #serial = :serial AND #thingName = :thingName AND #certificateId <> :certificateId)",
          ExpressionAttributeNames: { "#deviceId": "deviceId", "#lifecycleStatus": "lifecycleStatus", "#serial": "serial", "#thingName": "thingName", "#certificateId": "certificateId" },
          ExpressionAttributeValues: { ":revoked": "REVOKED", ":serial": claim.serial, ":thingName": binding.thingName, ":certificateId": binding.certificateId },
        } },
        { Update: {
          TableName: registryTable,
          Key: { serialHash: claim.serialHash },
          UpdateExpression: "SET #status = :bootstrapped, #thingName = :thingName, #certificateId = :certificateId, #bootstrappedAt = :now, #updatedAt = :now REMOVE #reservationExpiresAt",
          ConditionExpression: "#status = :reserved AND #serial = :serial AND #claimId = :claimId AND #ownerId = :ownerId AND #tenantId = :tenantId AND #poolId = :poolId AND #nonceHash = :nonceHash AND #latestCertificateId = :certificateId AND #reservationExpiresAt = :expiresAt AND #reservationExpiresAt > :nowEpoch",
          ExpressionAttributeNames: {
            "#status": "status", "#serial": "serial", "#claimId": "claimId", "#ownerId": "ownerId", "#tenantId": "tenantId",
            "#poolId": "poolId", "#nonceHash": "nonceHash", "#latestCertificateId": "latestCertificateId", "#reservationExpiresAt": "reservationExpiresAt",
            "#thingName": "thingName", "#certificateId": "certificateId", "#bootstrappedAt": "bootstrappedAt", "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":reserved": "RESERVED", ":bootstrapped": "BOOTSTRAPPED", ":serial": claim.serial, ":claimId": claimId,
            ":ownerId": claim.ownerId, ":tenantId": claim.tenantId, ":poolId": claim.poolId, ":nonceHash": claim.registrationNonceHash,
            ":certificateId": binding.certificateId, ":thingName": binding.thingName, ":expiresAt": expiresAt, ":nowEpoch": nowEpoch, ":now": now,
          },
        } },
      ] }));
      return { claim: { ...claim, status: "BOOTSTRAPPED", thingName: binding.thingName, updatedAt: now }, device };
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
      throw new AppError("CLAIM_CONFLICT", 409, "Claim or manufacturing binding changed during bootstrap finalization");
    }
  }

  async authorizeRuntimeClaim(claimId: string, binding: BootstrapBinding, now: string): Promise<{ claim: DeviceClaim; device: Device }> {
    const claim = await this.getClaim(claimId);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    const completed = await this.completedResult(claim);
    if (completed) return completed;
    if (claim.status !== "BOOTSTRAPPED" || claim.thingName !== binding.thingName || claim.serial !== binding.serial) {
      throw new AppError("CLAIM_INCONSISTENT", 409, "Claim is not durably bootstrapped for this binding");
    }
    const device = await this.getDevice(binding.thingName);
    if (!device || device.lifecycleStatus !== "BOOTSTRAPPED" || !sameBootstrapBinding(device, claim, binding)) {
      throw new AppError("CLAIM_INCONSISTENT", 409, "Bootstrapped Claim has no matching Device");
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: this.tables.deviceClaim,
          Key: { claimKey: claimKey(claimId) },
          UpdateExpression: "SET #status = :authorized, #updatedAt = :now",
          ConditionExpression: "#status = :bootstrapped AND #thingName = :thingName AND #serial = :serial AND #serialHash = :serialHash",
          ExpressionAttributeNames: { "#status": "status", "#updatedAt": "updatedAt", "#thingName": "thingName", "#serial": "serial", "#serialHash": "serialHash" },
          ExpressionAttributeValues: { ":bootstrapped": "BOOTSTRAPPED", ":authorized": "RUNTIME_AUTHORIZED", ":thingName": binding.thingName, ":serial": claim.serial, ":serialHash": claim.serialHash, ":now": now },
        } },
        { Update: {
          TableName: this.tables.device,
          Key: { deviceId: device.deviceId },
          UpdateExpression: "SET #lifecycleStatus = :authorized, #version = if_not_exists(#version, :zero) + :one",
          ConditionExpression: "#lifecycleStatus = :bootstrapped AND #claimId = :claimId AND #ownerId = :ownerId AND #tenantId = :tenantId AND #poolId = :poolId AND #serial = :serial AND #thingName = :thingName AND #certificateId = :certificateId",
          ExpressionAttributeNames: { "#lifecycleStatus": "lifecycleStatus", "#claimId": "claimId", "#ownerId": "ownerId", "#tenantId": "tenantId", "#poolId": "poolId", "#serial": "serial", "#thingName": "thingName", "#certificateId": "certificateId", "#version": "version" },
          ExpressionAttributeValues: { ":bootstrapped": "BOOTSTRAPPED", ":authorized": "RUNTIME_AUTHORIZED", ":claimId": claimId, ":ownerId": claim.ownerId, ":tenantId": claim.tenantId, ":poolId": claim.poolId, ":serial": claim.serial, ":thingName": binding.thingName, ":certificateId": binding.certificateId, ":zero": 0, ":one": 1 },
        } },
        { Update: {
          TableName: this.registryTable(),
          Key: { serialHash: claim.serialHash },
          UpdateExpression: "SET #status = :authorized, #runtimeAuthorizedAt = :now, #updatedAt = :now",
          ConditionExpression: "#status = :bootstrapped AND #claimId = :claimId AND #serial = :serial AND #thingName = :thingName AND #certificateId = :certificateId",
          ExpressionAttributeNames: { "#status": "status", "#runtimeAuthorizedAt": "runtimeAuthorizedAt", "#updatedAt": "updatedAt", "#claimId": "claimId", "#serial": "serial", "#thingName": "thingName", "#certificateId": "certificateId" },
          ExpressionAttributeValues: { ":bootstrapped": "BOOTSTRAPPED", ":authorized": "RUNTIME_AUTHORIZED", ":claimId": claimId, ":serial": claim.serial, ":thingName": binding.thingName, ":certificateId": binding.certificateId, ":now": now },
        } },
      ] }));
      return {
        claim: { ...claim, status: "RUNTIME_AUTHORIZED", updatedAt: now },
        device: { ...device, lifecycleStatus: "RUNTIME_AUTHORIZED", version: device.version + 1 },
      };
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
      const current = await this.getClaim(claimId);
      const result = current ? await this.completedResult(current) : undefined;
      if (result) return result;
      throw new AppError("CLAIM_CONFLICT", 409, "Runtime authorization state changed concurrently");
    }
  }

  async revokeDeviceAndReleaseSerial(device: Device, serialHash: string, now: string): Promise<{ device: Device; idempotent: boolean }> {
    const current = await this.getDevice(device.deviceId);
    if (!current) throw new AppError("DEVICE_NOT_FOUND", 404, "Device not found");
    if (!sameBinding(current, device)) throw new AppError("DEVICE_RELEASE_CONFLICT", 409, "Device changed while it was being released");
    if (current.lifecycleStatus === "REVOKED") return { device: current, idempotent: true };
    const lock = await this.getItem(this.tables.deviceClaim, { claimKey: serialKey(serialHash) });
    if (!lock
      || stringField(lock, "deviceId") !== device.deviceId
      || stringField(lock, "thingName") !== device.thingName) {
      const latest = await this.getDevice(device.deviceId);
      if (latest && sameBinding(latest, device) && latest.lifecycleStatus === "REVOKED") {
        return { device: latest, idempotent: true };
      }
      throw new AppError("SERIAL_BINDING_INCONSISTENT", 409, "Device serial binding is inconsistent");
    }
    const claimId = stringField(lock, "claimId");

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tables.device,
              Key: { deviceId: device.deviceId },
              UpdateExpression: "SET #lifecycleStatus = :revoked, #revokedAt = :now, #version = if_not_exists(#version, :zero) + :one",
              ConditionExpression: "#ownerId = :ownerId AND #tenantId = :tenantId AND #serial = :serial AND #thingName = :thingName AND #certificateId = :certificateId AND #lifecycleStatus IN (:authorized, :active)",
              ExpressionAttributeNames: {
                "#lifecycleStatus": "lifecycleStatus",
                "#revokedAt": "revokedAt",
                "#version": "version",
                "#ownerId": "ownerId",
                "#tenantId": "tenantId",
                "#serial": "serial",
                "#thingName": "thingName",
                "#certificateId": "certificateId",
              },
              ExpressionAttributeValues: {
                ":revoked": "REVOKED",
                ":now": now,
                ":zero": 0,
                ":one": 1,
                ":ownerId": device.ownerId,
                ":tenantId": device.tenantId,
                ":serial": device.serial,
                ":thingName": device.thingName,
                ":certificateId": device.certificateId,
                ":authorized": "RUNTIME_AUTHORIZED",
                ":active": "ACTIVE",
              },
            },
          },
          {
            Update: {
              TableName: this.tables.deviceClaim,
              Key: { claimKey: claimKey(claimId) },
              UpdateExpression: "SET #status = :revoked, #updatedAt = :now",
              ConditionExpression: "#status IN (:authorized, :online) AND #ownerId = :ownerId AND #serial = :serial AND #thingName = :thingName",
              ExpressionAttributeNames: {
                "#status": "status",
                "#updatedAt": "updatedAt",
                "#ownerId": "ownerId",
                "#serial": "serial",
                "#thingName": "thingName",
              },
              ExpressionAttributeValues: {
                ":revoked": "REVOKED",
                ":now": now,
                ":authorized": "RUNTIME_AUTHORIZED",
                ":online": "ONLINE",
                ":ownerId": device.ownerId,
                ":serial": device.serial,
                ":thingName": device.thingName,
              },
            },
          },
          {
            Delete: {
              TableName: this.tables.deviceClaim,
              Key: { claimKey: serialKey(serialHash) },
              ConditionExpression: "#claimId = :claimId AND #deviceId = :deviceId AND #thingName = :thingName",
              ExpressionAttributeNames: { "#claimId": "claimId", "#deviceId": "deviceId", "#thingName": "thingName" },
              ExpressionAttributeValues: { ":claimId": claimId, ":deviceId": device.deviceId, ":thingName": device.thingName },
            },
          },
          ...(this.tables.deviceRegistry ? [{
            Update: {
              TableName: this.tables.deviceRegistry,
              Key: { serialHash },
              UpdateExpression: [
                "SET #status = :reissueRequired, #updatedAt = :now, #reissueReason = :released",
                "REMOVE #registrationCodeHash, #claimId, #ownerId, #tenantId, #poolId, #nonceHash,",
                "#reservationExpiresAt, #recoveryProof, #thingName, #certificateId, #latestCertificateId,",
                "#bootstrappedAt, #runtimeAuthorizedAt",
              ].join(" "),
              ConditionExpression: "#status = :runtimeAuthorized AND #serial = :serial AND #claimId = :claimId AND #ownerId = :ownerId AND #tenantId = :tenantId AND #poolId = :poolId AND #thingName = :thingName AND #certificateId = :certificateId AND #latestCertificateId = :certificateId",
              ExpressionAttributeNames: {
                "#status": "status", "#serial": "serial", "#registrationCodeHash": "registrationCodeHash", "#claimId": "claimId",
                "#ownerId": "ownerId", "#tenantId": "tenantId", "#poolId": "poolId", "#nonceHash": "nonceHash",
                "#reservationExpiresAt": "reservationExpiresAt", "#recoveryProof": "recoveryProof", "#thingName": "thingName",
                "#certificateId": "certificateId", "#latestCertificateId": "latestCertificateId", "#bootstrappedAt": "bootstrappedAt",
                "#runtimeAuthorizedAt": "runtimeAuthorizedAt", "#updatedAt": "updatedAt", "#reissueReason": "reissueReason",
              },
              ExpressionAttributeValues: {
                ":runtimeAuthorized": "RUNTIME_AUTHORIZED", ":reissueRequired": "REISSUE_REQUIRED", ":released": "DEVICE_RELEASED",
                ":serial": device.serial, ":claimId": claimId, ":ownerId": device.ownerId, ":tenantId": device.tenantId,
                ":poolId": device.poolId, ":thingName": device.thingName, ":certificateId": device.certificateId, ":now": now,
              },
            },
          }] : []),
        ],
      }));
      return {
        device: { ...current, lifecycleStatus: "REVOKED", revokedAt: now, version: current.version + 1 },
        idempotent: false,
      };
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
      const latest = await this.getDevice(device.deviceId);
      if (latest && sameBinding(latest, device) && latest.lifecycleStatus === "REVOKED") {
        return { device: latest, idempotent: true };
      }
      throw new AppError("DEVICE_RELEASE_CONFLICT", 409, "Device changed while it was being released");
    }
  }

  async reserveCommand(device: Device, requestId: string, commandId: string, desired: DesiredState): Promise<{ commandId: string; commandSequence: number; desiredState: DeviceState }> {
    const ledgerKey = commandKey(device.deviceId, device.certificateId, requestId);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const current = await this.getDevice(device.deviceId);
      if (!current || current.certificateId !== device.certificateId
        || (current.lifecycleStatus !== "RUNTIME_AUTHORIZED" && current.lifecycleStatus !== "ACTIVE")) {
        throw new AppError("DEVICE_COMMAND_CONFLICT", 409, "Device generation changed while reserving command");
      }
      const currentSequence = current.commandSequence ?? 0;
      const commandSequence = currentSequence + 1;
      if (!Number.isSafeInteger(commandSequence)) throw new AppError("COMMAND_SEQUENCE_EXHAUSTED", 409, "Command sequence is exhausted");
      const desiredState = mergeDesiredState(current.desiredState ?? current, desired);
      try {
        await this.client.send(new TransactWriteCommand({
          TransactItems: [
            { Put: {
              TableName: this.tables.device,
              Item: {
                deviceId: ledgerKey, entityType: "COMMAND", targetDeviceId: device.deviceId,
                targetCertificateId: device.certificateId, requestId, commandId, commandSequence,
                expiresAt: Math.floor(Date.now() / 1000) + COMMAND_RETENTION_SECONDS,
                desired: structuredClone(desired),
                desiredState,
              },
              ConditionExpression: "attribute_not_exists(#deviceId)",
              ExpressionAttributeNames: { "#deviceId": "deviceId" },
            } },
            { Update: {
              TableName: this.tables.device,
              Key: { deviceId: device.deviceId },
              UpdateExpression: "SET #commandSequence = :next, #lastCommandId = :commandId, #desiredState = :desiredState, #version = if_not_exists(#version, :zero) + :one",
              ConditionExpression: "#certificateId = :certificateId AND #lifecycleStatus IN (:authorized, :active) AND (attribute_not_exists(#commandSequence) OR #commandSequence = :current)",
              ExpressionAttributeNames: {
                "#certificateId": "certificateId", "#lifecycleStatus": "lifecycleStatus", "#commandSequence": "commandSequence",
                "#lastCommandId": "lastCommandId", "#desiredState": "desiredState", "#version": "version",
              },
              ExpressionAttributeValues: {
                ":certificateId": device.certificateId, ":authorized": "RUNTIME_AUTHORIZED", ":active": "ACTIVE", ":current": currentSequence, ":next": commandSequence,
                ":commandId": commandId, ":desiredState": desiredState, ":zero": 0, ":one": 1,
              },
            } },
          ],
        }));
        return { commandId, commandSequence, desiredState };
      } catch (error) {
        if (!isConditionalTransactionConflict(error)) throw error;
        const result = await this.client.send(new GetCommand({
          TableName: this.tables.device, Key: { deviceId: ledgerKey }, ConsistentRead: true,
        }));
        const stored = result.Item;
        if (stored) {
          if (stored.entityType !== "COMMAND"
            || stored.targetDeviceId !== device.deviceId
            || stored.targetCertificateId !== device.certificateId
            || stored.requestId !== requestId
            || typeof stored.commandId !== "string"
            || !Number.isSafeInteger(stored.commandSequence)
            || !sameDesiredState(stored.desired, desired)) {
            throw new AppError("REQUEST_ID_REUSED", 409, "requestId was already used for a different command");
          }
          return {
            commandId: stored.commandId,
            commandSequence: stored.commandSequence as number,
            desiredState: storedDeviceState(stored.desiredState),
          };
        }
      }
    }
    throw new AppError("COMMAND_RESERVATION_BUSY", 409, "Command reservation must be retried");
  }

  async applyState(message: StateUplink): Promise<IngestDisposition> {
    const current = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, current.lastStateMessageId,
      message.bootStartedAtMs, current.stateBootStartedAtMs,
      message.bootId, current.stateBootId,
      message.stateSequence, current.stateSequence,
    );
    if (disposition !== "APPLIED") return disposition;

    const names: Record<string, string> = {
      "#deviceId": "deviceId",
      "#thingName": "thingName",
      "#tenantId": "tenantId",
      "#poolId": "poolId",
      "#lifecycleStatus": "lifecycleStatus",
      "#version": "version",
      "#power": "power",
      "#red": "red",
      "#green": "green",
      "#blue": "blue",
      "#brightness": "brightness",
      "#lastStateMessageId": "lastStateMessageId",
      "#stateBootId": "stateBootId",
      "#stateBootStartedAtMs": "stateBootStartedAtMs",
      "#stateBootSequence": "stateBootSequence",
      "#stateSequence": "stateSequence",
      "#lastSeenAt": "lastSeenAt",
      ...(message.appliedCommandId ? { "#appliedCommandId": "appliedCommandId" } : {}),
    };
    const values: Record<string, unknown> = {
      ":thingName": message.thingName,
      ":tenantId": message.tenantId,
      ":poolId": message.poolId,
      ":currentLifecycle": current.lifecycleStatus,
      ":zero": 0,
      ":one": 1,
      ":active": "ACTIVE",
      ":power": message.power,
      ":red": message.red,
      ":green": message.green,
      ":blue": message.blue,
      ":brightness": message.brightness,
      ":messageId": message.messageId,
      ":bootId": message.bootId,
      ":bootStartedAtMs": message.bootStartedAtMs,
      ":bootSequence": message.bootSequence,
      ":sequence": message.stateSequence,
      ":receivedAt": message.receivedAt,
      ...(message.appliedCommandId ? { ":appliedCommandId": message.appliedCommandId } : {}),
    };
    const commandIdUpdate = message.appliedCommandId
      ? ", #appliedCommandId = :appliedCommandId"
      : "";
    const deviceUpdate = {
      TableName: this.tables.device,
      Key: { deviceId: message.thingName },
      UpdateExpression: "SET #power = :power, #red = :red, #green = :green, #blue = :blue, #brightness = :brightness, #lastStateMessageId = :messageId, #stateBootId = :bootId, #stateBootStartedAtMs = :bootStartedAtMs, #stateBootSequence = :bootSequence, #stateSequence = :sequence, #lastSeenAt = :receivedAt, #lifecycleStatus = :active, #version = if_not_exists(#version, :zero) + :one" + commandIdUpdate,
      ConditionExpression: "#deviceId = :thingName AND #thingName = :thingName AND #tenantId = :tenantId AND #poolId = :poolId AND #lifecycleStatus = :currentLifecycle AND (attribute_not_exists(#stateBootStartedAtMs) OR #stateBootStartedAtMs < :bootStartedAtMs OR (#stateBootStartedAtMs = :bootStartedAtMs AND #stateBootId = :bootId AND (attribute_not_exists(#stateSequence) OR #stateSequence < :sequence)))",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };

    try {
      if (current.lifecycleStatus === "RUNTIME_AUTHORIZED") {
        if (!current.claimId) throw new AppError("DEVICE_CLAIM_MISSING", 409, "Runtime-authorized device has no Claim binding");
        const claim = await this.getClaim(current.claimId);
        if (!claim || claim.status !== "RUNTIME_AUTHORIZED" || claim.thingName !== current.thingName) {
          throw new AppError("CLAIM_INCONSISTENT", 409, "Runtime-authorized device has no matching Claim");
        }
        await this.client.send(new TransactWriteCommand({
          TransactItems: [
            { Update: deviceUpdate },
            {
              Update: {
                TableName: this.tables.deviceClaim,
                Key: { claimKey: claimKey(current.claimId) },
                UpdateExpression: "SET #status = :online, #updatedAt = :receivedAt",
                ConditionExpression: "#claimId = :claimId AND #thingName = :thingName AND #status = :authorized",
                ExpressionAttributeNames: {
                  "#claimId": "claimId",
                  "#thingName": "thingName",
                  "#status": "status",
                  "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                  ":claimId": current.claimId,
                  ":thingName": current.thingName,
                  ":authorized": "RUNTIME_AUTHORIZED",
                  ":online": "ONLINE",
                  ":receivedAt": message.receivedAt,
                },
              },
            },
          ],
        }));
      } else {
        await this.client.send(new UpdateCommand(deviceUpdate));
      }
      return "APPLIED";
    } catch (error) {
      if (!(current.lifecycleStatus === "RUNTIME_AUTHORIZED" ? isConditionalTransactionConflict(error) : isConditionalFailure(error))) {
        throw error;
      }
      return this.classifyStateConflict(message);
    }
  }

  async applyTelemetry(message: TelemetryUplink): Promise<IngestDisposition> {
    const current = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, current.lastTelemetryMessageId,
      message.bootStartedAtMs, current.telemetryBootStartedAtMs,
      message.bootId, current.telemetryBootId,
      message.telemetrySequence, current.telemetrySequence,
    );
    if (disposition !== "APPLIED") return disposition;
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tables.device,
        Key: { deviceId: message.thingName },
        UpdateExpression: "SET #lastMessageId = :messageId, #bootId = :bootId, #bootStartedAtMs = :bootStartedAtMs, #bootSequence = :bootSequence, #sequence = :sequence, #uptimeSeconds = :uptimeSeconds, #rssi = :rssi, #firmwareVersion = :firmwareVersion, #lastSeenAt = :receivedAt, #version = if_not_exists(#version, :zero) + :one",
        ConditionExpression: "#deviceId = :thingName AND #thingName = :thingName AND #tenantId = :tenantId AND #poolId = :poolId AND #lifecycleStatus IN (:authorized, :active) AND (attribute_not_exists(#bootStartedAtMs) OR #bootStartedAtMs < :bootStartedAtMs OR (#bootStartedAtMs = :bootStartedAtMs AND #bootId = :bootId AND (attribute_not_exists(#sequence) OR #sequence < :sequence)))",
        ExpressionAttributeNames: {
          "#deviceId": "deviceId", "#thingName": "thingName", "#tenantId": "tenantId", "#poolId": "poolId",
          "#lifecycleStatus": "lifecycleStatus", "#version": "version",
          "#lastMessageId": "lastTelemetryMessageId", "#bootId": "telemetryBootId",
          "#bootStartedAtMs": "telemetryBootStartedAtMs", "#bootSequence": "telemetryBootSequence", "#sequence": "telemetrySequence",
          "#uptimeSeconds": "uptimeSeconds", "#rssi": "rssi", "#firmwareVersion": "firmwareVersion", "#lastSeenAt": "lastSeenAt",
        },
        ExpressionAttributeValues: {
          ":thingName": message.thingName, ":tenantId": message.tenantId, ":poolId": message.poolId,
          ":authorized": "RUNTIME_AUTHORIZED", ":active": "ACTIVE", ":zero": 0, ":one": 1,
          ":messageId": message.messageId, ":bootId": message.bootId, ":bootStartedAtMs": message.bootStartedAtMs, ":bootSequence": message.bootSequence,
          ":sequence": message.telemetrySequence, ":uptimeSeconds": message.uptimeSeconds, ":rssi": message.rssi, ":firmwareVersion": message.firmwareVersion,
          ":receivedAt": message.receivedAt,
        },
      }));
      return "APPLIED";
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const latest = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
      const latestDisposition = streamDisposition(
        message.messageId, latest.lastTelemetryMessageId,
        message.bootStartedAtMs, latest.telemetryBootStartedAtMs,
        message.bootId, latest.telemetryBootId,
        message.telemetrySequence, latest.telemetrySequence,
      );
      if (latestDisposition !== "APPLIED") return latestDisposition;
      throw new AppError("UPLINK_CONFLICT", 409, "Telemetry changed concurrently");
    }
  }

  async applyEvent(message: EventUplink): Promise<IngestDisposition> {
    const current = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, current.lastEventMessageId,
      message.bootStartedAtMs, current.eventBootStartedAtMs,
      message.bootId, current.eventBootId,
      message.eventSequence, current.eventSequence,
    );
    if (disposition !== "APPLIED") return disposition;
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tables.device,
        Key: { deviceId: message.thingName },
        UpdateExpression: "SET #lastMessageId = :messageId, #bootId = :bootId, #bootStartedAtMs = :bootStartedAtMs, #bootSequence = :bootSequence, #sequence = :sequence, #eventType = :eventType, #eventAt = :eventAt, #lastSeenAt = :receivedAt, #version = if_not_exists(#version, :zero) + :one",
        ConditionExpression: "#deviceId = :thingName AND #thingName = :thingName AND #tenantId = :tenantId AND #poolId = :poolId AND #lifecycleStatus IN (:authorized, :active) AND (attribute_not_exists(#bootStartedAtMs) OR #bootStartedAtMs < :bootStartedAtMs OR (#bootStartedAtMs = :bootStartedAtMs AND #bootId = :bootId AND (attribute_not_exists(#sequence) OR #sequence < :sequence)))",
        ExpressionAttributeNames: {
          "#deviceId": "deviceId", "#thingName": "thingName", "#tenantId": "tenantId", "#poolId": "poolId",
          "#lifecycleStatus": "lifecycleStatus", "#version": "version",
          "#lastMessageId": "lastEventMessageId", "#bootId": "eventBootId",
          "#bootStartedAtMs": "eventBootStartedAtMs", "#bootSequence": "eventBootSequence", "#sequence": "eventSequence",
          "#eventType": "lastEventType", "#eventAt": "lastEventAt", "#lastSeenAt": "lastSeenAt",
        },
        ExpressionAttributeValues: {
          ":thingName": message.thingName, ":tenantId": message.tenantId, ":poolId": message.poolId,
          ":authorized": "RUNTIME_AUTHORIZED", ":active": "ACTIVE", ":zero": 0, ":one": 1,
          ":messageId": message.messageId, ":bootId": message.bootId, ":bootStartedAtMs": message.bootStartedAtMs, ":bootSequence": message.bootSequence,
          ":sequence": message.eventSequence, ":eventType": message.eventType, ":eventAt": message.occurredAt,
          ":receivedAt": message.receivedAt,
        },
      }));
      return "APPLIED";
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const latest = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
      const latestDisposition = streamDisposition(
        message.messageId, latest.lastEventMessageId,
        message.bootStartedAtMs, latest.eventBootStartedAtMs,
        message.bootId, latest.eventBootId,
        message.eventSequence, latest.eventSequence,
      );
      if (latestDisposition !== "APPLIED") return latestDisposition;
      throw new AppError("UPLINK_CONFLICT", 409, "Event changed concurrently");
    }
  }

  private async classifyStateConflict(message: StateUplink): Promise<IngestDisposition> {
    const latest = await this.getIngestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, latest.lastStateMessageId,
      message.bootStartedAtMs, latest.stateBootStartedAtMs,
      message.bootId, latest.stateBootId,
      message.stateSequence, latest.stateSequence,
    );
    if (disposition !== "APPLIED") return disposition;
    throw new AppError("UPLINK_CONFLICT", 409, "State changed concurrently");
  }

  private async getIngestDevice(thingName: string, tenantId: string, poolId: string): Promise<Device> {
    const device = await this.getDevice(thingName);
    if (!device) throw new AppError("DEVICE_NOT_FOUND", 404, "Uplink device was not found");
    if (device.thingName !== thingName || device.tenantId !== tenantId || device.poolId !== poolId) {
      throw new AppError("UPLINK_IDENTITY_MISMATCH", 409, "Uplink topic identity does not match the Device binding");
    }
    if (device.lifecycleStatus !== "RUNTIME_AUTHORIZED" && device.lifecycleStatus !== "ACTIVE") {
      throw new AppError("DEVICE_NOT_READY", 409, "Device runtime authorization is incomplete");
    }
    return device;
  }

  private registryTable(): string {
    if (!this.tables.deviceRegistry) throw new AppError("NOT_CONFIGURED", 503, "Device registry is not configured");
    return this.tables.deviceRegistry;
  }
  private async activeTenantContext(userId: string): Promise<TenantContext | undefined> {
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(new QueryCommand({
        TableName: this.tables.membership,
        KeyConditionExpression: "#userId = :userId",
        FilterExpression: "#status = :active",
        ProjectionExpression: "#tenantId, #role",
        ExpressionAttributeNames: { "#userId": "userId", "#tenantId": "tenantId", "#role": "role", "#status": "status" },
        ExpressionAttributeValues: { ":userId": userId, ":active": "ACTIVE" },
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      const membership = page.Items?.[0];
      if (membership) {
        const tenantId = stringField(membership, "tenantId");
        const role = membershipRole(membership.role);
        const pools = await this.client.send(new QueryCommand({
          TableName: this.tables.pool,
          KeyConditionExpression: "#tenantId = :tenantId",
          ProjectionExpression: "#poolId",
          ExpressionAttributeNames: { "#tenantId": "tenantId", "#poolId": "poolId" },
          ExpressionAttributeValues: { ":tenantId": tenantId },
          ConsistentRead: true,
          Limit: 1,
        }));
        const pool = pools.Items?.[0];
        if (!pool) throw new AppError("TENANT_BOOTSTRAP_INCONSISTENT", 409, "Active Tenant membership has no Pool");
        return { tenantId, poolId: stringField(pool, "poolId"), role };
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return undefined;
  }

  private async getItem(tableName: string, key: Record<string, unknown>): Promise<Item | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: tableName, Key: key, ConsistentRead: true }));
    return result.Item;
  }

  private async completedResult(claim: DeviceClaim): Promise<{ claim: DeviceClaim; device: Device } | undefined> {
    if (claim.status !== "RUNTIME_AUTHORIZED" && claim.status !== "ONLINE") return undefined;
    const device = claim.thingName ? await this.getDevice(claim.thingName) : undefined;
    if (!device || device.ownerId !== claim.ownerId || device.tenantId !== claim.tenantId || device.serial !== claim.serial) {
      throw new AppError("CLAIM_INCONSISTENT", 409, "Finalized claim has no matching device");
    }
    return { claim, device };
  }
}

function serializeClaim(claim: DeviceClaim): Item {
  return { ...claim, claimKey: claimKey(claim.claimId), expiresAt: epochSeconds(claim.expiresAt) };
}

function hydrateClaim(item: Item): DeviceClaim {
  const expiresAt = typeof item.expiresAt === "number"
    ? numberField(item, "expiresAt")
    : numberField(item, "claimExpiresAt");
  return {
    claimId: stringField(item, "claimId"),
    ownerId: stringField(item, "ownerId"),
    tenantId: stringField(item, "tenantId"),
    poolId: stringField(item, "poolId"),
    serial: stringField(item, "serial"),
    serialHash: stringField(item, "serialHash"),
    registrationNonceHash: stringField(item, "registrationNonceHash"),
    status: stringField(item, "status") as DeviceClaim["status"],
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    createdAt: stringField(item, "createdAt"),
    updatedAt: stringField(item, "updatedAt"),
    ...(typeof item.thingName === "string" ? { thingName: item.thingName } : {}),
    ...(typeof item.failureCode === "string" ? { failureCode: item.failureCode } : {}),
  };
}

function serializeDevice(device: Device): Item {
  return { ...device, tenantPoolKey: `POOL#${device.poolId}#DEVICE#${device.deviceId}` };
}

function hydrateDevice(item: Item): Device {
  return {
    deviceId: stringField(item, "deviceId"),
    thingName: stringField(item, "thingName"),
    ownerId: stringField(item, "ownerId"),
    tenantId: stringField(item, "tenantId"),
    poolId: stringField(item, "poolId"),
    serial: stringField(item, "serial"),
    certificateId: stringField(item, "certificateId"),
    name: stringField(item, "name"),
    lifecycleStatus: stringField(item, "lifecycleStatus") as Device["lifecycleStatus"],
    ...(typeof item.claimId === "string" ? { claimId: item.claimId } : {}),
    power: booleanField(item, "power"),
    red: numberField(item, "red"),
    green: numberField(item, "green"),
    blue: numberField(item, "blue"),
    brightness: numberField(item, "brightness"),
    version: numberField(item, "version"),
    ...(typeof item.lastCommandId === "string" ? { lastCommandId: item.lastCommandId } : {}),
    ...(typeof item.commandSequence === "number" ? { commandSequence: numberField(item, "commandSequence") } : {}),
    ...(item.desiredState !== undefined ? { desiredState: storedDeviceState(item.desiredState) } : {}),
    ...(typeof item.appliedCommandId === "string" ? { appliedCommandId: item.appliedCommandId } : {}),
    ...(typeof item.lastStateMessageId === "string" ? { lastStateMessageId: item.lastStateMessageId } : {}),
    ...(typeof item.stateBootId === "string" ? { stateBootId: item.stateBootId } : {}),
    ...(typeof item.stateBootStartedAtMs === "number" ? { stateBootStartedAtMs: numberField(item, "stateBootStartedAtMs") } : {}),
    ...(typeof item.stateBootSequence === "number" ? { stateBootSequence: numberField(item, "stateBootSequence") } : {}),
    ...(typeof item.stateSequence === "number" ? { stateSequence: numberField(item, "stateSequence") } : {}),
    ...(typeof item.lastTelemetryMessageId === "string" ? { lastTelemetryMessageId: item.lastTelemetryMessageId } : {}),
    ...(typeof item.telemetryBootId === "string" ? { telemetryBootId: item.telemetryBootId } : {}),
    ...(typeof item.telemetryBootStartedAtMs === "number" ? { telemetryBootStartedAtMs: numberField(item, "telemetryBootStartedAtMs") } : {}),
    ...(typeof item.telemetryBootSequence === "number" ? { telemetryBootSequence: numberField(item, "telemetryBootSequence") } : {}),
    ...(typeof item.telemetrySequence === "number" ? { telemetrySequence: numberField(item, "telemetrySequence") } : {}),
    ...(typeof item.uptimeSeconds === "number" ? { uptimeSeconds: numberField(item, "uptimeSeconds") } : {}),
    ...(typeof item.rssi === "number" ? { rssi: numberField(item, "rssi") } : {}),
    ...(typeof item.firmwareVersion === "string" ? { firmwareVersion: item.firmwareVersion } : {}),
    ...(typeof item.lastEventMessageId === "string" ? { lastEventMessageId: item.lastEventMessageId } : {}),
    ...(typeof item.eventBootId === "string" ? { eventBootId: item.eventBootId } : {}),
    ...(typeof item.eventBootStartedAtMs === "number" ? { eventBootStartedAtMs: numberField(item, "eventBootStartedAtMs") } : {}),
    ...(typeof item.eventBootSequence === "number" ? { eventBootSequence: numberField(item, "eventBootSequence") } : {}),
    ...(typeof item.eventSequence === "number" ? { eventSequence: numberField(item, "eventSequence") } : {}),
    ...(typeof item.lastEventType === "string" ? { lastEventType: item.lastEventType } : {}),
    ...(typeof item.lastEventAt === "string" ? { lastEventAt: item.lastEventAt } : {}),
    ...(typeof item.lastSeenAt === "string" ? { lastSeenAt: item.lastSeenAt } : {}),
    ...(typeof item.revokedAt === "string" ? { revokedAt: item.revokedAt } : {}),
  };
}

function newDevice(claim: DeviceClaim, binding: BootstrapBinding, lifecycleStatus: Device["lifecycleStatus"]): Device {
  return {
    deviceId: binding.thingName,
    thingName: binding.thingName,
    ownerId: claim.ownerId,
    tenantId: claim.tenantId,
    poolId: claim.poolId,
    serial: claim.serial,
    certificateId: binding.certificateId,
    name: "새 무드등",
    lifecycleStatus,
    claimId: claim.claimId,
    power: false,
    red: 0,
    green: 0,
    blue: 0,
    brightness: 0,
    version: 1,
  };
}

function sameBootstrapBinding(device: Device, claim: DeviceClaim, binding: BootstrapBinding): boolean {
  return device.claimId === claim.claimId
    && device.ownerId === claim.ownerId
    && device.tenantId === claim.tenantId
    && device.poolId === claim.poolId
    && device.serial === claim.serial
    && device.thingName === binding.thingName
    && device.certificateId === binding.certificateId;
}


function streamDisposition(
  messageId: string,
  lastMessageId: string | undefined,
  bootStartedAtMs: number,
  lastBootStartedAtMs: number | undefined,
  bootId: string,
  lastBootId: string | undefined,
  sequence: number,
  lastSequence: number | undefined,
): IngestDisposition {
  if (messageId === lastMessageId) return "DUPLICATE";
  if (lastBootStartedAtMs === undefined || bootStartedAtMs > lastBootStartedAtMs) return "APPLIED";
  if (bootStartedAtMs < lastBootStartedAtMs || bootId !== lastBootId) return "STALE";
  return lastSequence === undefined || sequence > lastSequence ? "APPLIED" : "STALE";
}
function sameBinding(current: Device, expected: Device): boolean {
  return current.ownerId === expected.ownerId
    && current.tenantId === expected.tenantId
    && current.serial === expected.serial
    && current.thingName === expected.thingName
    && current.certificateId === expected.certificateId;
}

function claimKey(claimId: string): string { return `${CLAIM_PREFIX}${claimId}`; }
function serialKey(serialHash: string): string { return `${SERIAL_PREFIX}${serialHash}`; }

function epochSeconds(iso: string): number {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds)) throw new AppError("INVALID_TIMESTAMP", 500, "Stored timestamp is invalid");
  return Math.floor(milliseconds / 1000);
}

function stringField(item: Item, field: string): string {
  const value = item[field];
  if (typeof value !== "string") throw corrupt(field);
  return value;
}

function membershipRole(value: unknown): MembershipRole {
  if (value === "OWNER" || value === "MEMBER") return value;
  throw corrupt("role");
}

function numberField(item: Item | undefined, field: string, fallback?: number): number {
  const value = item?.[field];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw corrupt(field);
}

function booleanField(item: Item, field: string): boolean {
  const value = item[field];
  if (typeof value !== "boolean") throw corrupt(field);
  return value;
}

function corrupt(field: string): AppError {
  return new AppError("CORRUPT_DATA", 500, `Stored ${field} is invalid`);
}

function isConditionalFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: string }).name === "ConditionalCheckFailedException";
}

function isConditionalTransactionConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null || (error as { name?: string }).name !== "TransactionCanceledException") {
    return false;
  }
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return Array.isArray(reasons)
    && reasons.some((reason) => reason.Code === "ConditionalCheckFailed")
    && reasons.every((reason) => reason.Code === undefined || reason.Code === "None" || reason.Code === "ConditionalCheckFailed");
}

function serialRegistered(): AppError {
  return new AppError("SERIAL_ALREADY_REGISTERED", 409, "This serial is already bound to a device");
}

function serialClaimed(): AppError {
  return new AppError("SERIAL_ALREADY_CLAIMED", 409, "An active claim already holds this serial");
}

function commandKey(deviceId: string, certificateId: string, requestId: string): string {
  return ["COMMAND", deviceId, certificateId, requestId].join("#");
}

function sameDesiredState(value: unknown, desired: DesiredState): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stored = value as DesiredState;
  return stored.power === desired.power
    && stored.red === desired.red
    && stored.green === desired.green
    && stored.blue === desired.blue
    && stored.brightness === desired.brightness;
}

function mergeDesiredState(base: DeviceState, patch: DesiredState): DeviceState {
  return {
    power: patch.power ?? base.power,
    red: patch.red ?? base.red,
    green: patch.green ?? base.green,
    blue: patch.blue ?? base.blue,
    brightness: patch.brightness ?? base.brightness,
  };
}

function storedDeviceState(value: unknown): DeviceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw corrupt("desiredState");
  const state = value as Item;
  const power = state.power;
  const red = state.red;
  const green = state.green;
  const blue = state.blue;
  const brightness = state.brightness;
  if (typeof power !== "boolean" || !byte(red) || !byte(green) || !byte(blue)
    || !Number.isSafeInteger(brightness) || (brightness as number) < 0 || (brightness as number) > 100) {
    throw corrupt("desiredState");
  }
  return { power, red: red as number, green: green as number, blue: blue as number, brightness: brightness as number };
}

function byte(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 255;
}
