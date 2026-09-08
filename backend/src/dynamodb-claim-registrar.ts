import { createHash } from "node:crypto";
import { GetCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { AppError, type DeviceClaim } from "./domain.ts";
import type { ClaimRegistrar } from "./ports.ts";
import { canonicalSerial } from "./serial.ts";
import { registrationNonceFor, registrationRecoveryProof } from "./claim-secrets.ts";

type DocumentClient = Pick<DynamoDBDocumentClient, "send">;

export interface ClaimRegistrarTables {
  deviceRegistry: string;
  deviceClaim: string;
}

const REGISTRATION_CODE_DOMAIN = "moodlight-registration-code-v1\0";

/** Hash used by the offline manufacturing import and the online Claim path. */
export function registrationCodeHash(serial: string, registrationCode: string): string {
  return sha256(`${REGISTRATION_CODE_DOMAIN}${canonicalSerial(serial)}\0${registrationCode}`);
}

export class DynamoClaimRegistrar implements ClaimRegistrar {
  private readonly client: DocumentClient;
  private readonly tables: ClaimRegistrarTables;

  constructor(
    client: DocumentClient,
    tables: ClaimRegistrarTables,
  ) {
    this.client = client;
    this.tables = tables;
  }

  async createClaim(claim: DeviceClaim, registrationCode: string): Promise<DeviceClaim> {
    const serial = canonicalSerial(claim.serial);
    if (serial !== claim.serial || claim.serialHash !== sha256(serial)) {
      throw new AppError("INVALID_SERIAL", 400, "Claim serial is not canonical");
    }
    if (typeof registrationCode !== "string" || registrationCode.length === 0 || registrationCode.length > 512) {
      throw new AppError("INVALID_REGISTRATION_CODE", 400, "registrationCode is required");
    }

    const codeHash = registrationCodeHash(serial, registrationCode);
    const recoveryProof = registrationRecoveryProof(claim, registrationCode);
    const expiresAt = epochSeconds(claim.expiresAt);
    const nowEpoch = epochSeconds(claim.createdAt);

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tables.deviceRegistry,
              Key: { serialHash: claim.serialHash },
              UpdateExpression: [
                "SET #status = :reserved, #claimId = :claimId, #ownerId = :ownerId,",
                "#tenantId = :tenantId, #poolId = :poolId, #nonceHash = :nonceHash,",
                "#reservationExpiresAt = :expiresAt, #updatedAt = :updatedAt,",
                "#recoveryProof = :recoveryProof",
                "REMOVE #registrationCodeHash",
              ].join(" "),
              ConditionExpression: [
                "#status = :available",
                "#serial = :serial",
                "#registrationCodeHash = :registrationCodeHash",
                "attribute_not_exists(#claimId)",
              ].join(" AND "),
              ExpressionAttributeNames: {
                "#status": "status",
                "#serial": "serial",
                "#registrationCodeHash": "registrationCodeHash",
                "#claimId": "claimId",
                "#ownerId": "ownerId",
                "#tenantId": "tenantId",
                "#poolId": "poolId",
                "#nonceHash": "nonceHash",
                "#reservationExpiresAt": "reservationExpiresAt",
                "#updatedAt": "updatedAt",
                "#recoveryProof": "recoveryProof",
              },
              ExpressionAttributeValues: {
                ":available": "AVAILABLE",
                ":reserved": "RESERVED",
                ":serial": serial,
                ":registrationCodeHash": codeHash,
                ":claimId": claim.claimId,
                ":ownerId": claim.ownerId,
                ":tenantId": claim.tenantId,
                ":poolId": claim.poolId,
                ":nonceHash": claim.registrationNonceHash,
                ":expiresAt": expiresAt,
                ":updatedAt": claim.updatedAt,
                ":recoveryProof": recoveryProof,
              },
            },
          },
          {
            Put: {
              TableName: this.tables.deviceClaim,
              Item: serializeClaim(claim, expiresAt),
              ConditionExpression: "attribute_not_exists(#claimKey)",
              ExpressionAttributeNames: { "#claimKey": "claimKey" },
            },
          },
          {
            Put: {
              TableName: this.tables.deviceClaim,
              Item: {
                claimKey: `SERIAL#${claim.serialHash}`,
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
      return claim;
    } catch (error) {
      if (!isRecoverableTransactionFailure(error)) throw error;
      const recovered = await this.recoverClaim(claim, registrationCode, nowEpoch);
      if (recovered) return recovered;
      if (!isConditionalTransactionConflict(error)) throw error;
      // Do not reveal whether a serial exists, a code was wrong, or the unit
      // has already been claimed. Those states all fail closed at this edge.
      throw new AppError("INVALID_REGISTRATION_CODE", 403, "Device registration was rejected");
    }
  }

  private async recoverClaim(candidate: DeviceClaim, registrationCode: string, nowEpoch: number): Promise<DeviceClaim | undefined> {
    const proof = registrationRecoveryProof(candidate, registrationCode);
    const expectedNonceHash = sha256(registrationNonceFor(candidate, registrationCode));
    const registry = (await this.client.send(new GetCommand({
      TableName: this.tables.deviceRegistry,
      Key: { serialHash: candidate.serialHash },
      ConsistentRead: true,
    }))).Item;
    if (!registry
      || registry.status !== "RESERVED"
      || registry.serial !== candidate.serial
      || registry.ownerId !== candidate.ownerId
      || registry.tenantId !== candidate.tenantId
      || registry.poolId !== candidate.poolId
      || registry.recoveryProof !== proof
      || registry.nonceHash !== expectedNonceHash
      || typeof registry.claimId !== "string"
      || typeof registry.reservationExpiresAt !== "number") return undefined;
    if (registry.reservationExpiresAt <= nowEpoch) {
      await this.markReissueRequired(candidate, proof, registry.reservationExpiresAt, nowEpoch);
      return undefined;
    }

    const item = (await this.client.send(new GetCommand({
      TableName: this.tables.deviceClaim,
      Key: { claimKey: `CLAIM#${registry.claimId}` },
      ConsistentRead: true,
    }))).Item;
    if (!item
      || item.claimId !== registry.claimId
      || item.ownerId !== candidate.ownerId
      || item.tenantId !== candidate.tenantId
      || item.poolId !== candidate.poolId
      || item.serial !== candidate.serial
      || item.serialHash !== candidate.serialHash
      || item.registrationNonceHash !== expectedNonceHash
      || item.status !== "CLAIM_PENDING"
      || item.expiresAt !== registry.reservationExpiresAt
      || typeof item.createdAt !== "string"
      || typeof item.updatedAt !== "string") return undefined;
    return {
      claimId: item.claimId,
      ownerId: item.ownerId,
      tenantId: item.tenantId,
      poolId: item.poolId,
      serial: item.serial,
      serialHash: item.serialHash,
      registrationNonceHash: item.registrationNonceHash,
      status: "CLAIM_PENDING",
      expiresAt: new Date(item.expiresAt * 1000).toISOString(),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }

  private async markReissueRequired(candidate: DeviceClaim, proof: string, reservationExpiresAt: number, nowEpoch: number): Promise<void> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tables.deviceRegistry,
        Key: { serialHash: candidate.serialHash },
        UpdateExpression: [
          "SET #status = :reissueRequired, #updatedAt = :updatedAt, #reissueReason = :expired",
          "REMOVE #claimId, #ownerId, #tenantId, #poolId, #nonceHash,",
          "#reservationExpiresAt, #recoveryProof",
        ].join(" "),
        ConditionExpression: [
          "#status = :reserved",
          "#serial = :serial",
          "#recoveryProof = :recoveryProof",
          "#reservationExpiresAt = :reservationExpiresAt",
          "#reservationExpiresAt <= :nowEpoch",
          "attribute_not_exists(#registrationCodeHash)",
        ].join(" AND "),
        ExpressionAttributeNames: {
          "#status": "status",
          "#serial": "serial",
          "#registrationCodeHash": "registrationCodeHash",
          "#claimId": "claimId",
          "#ownerId": "ownerId",
          "#tenantId": "tenantId",
          "#poolId": "poolId",
          "#nonceHash": "nonceHash",
          "#reservationExpiresAt": "reservationExpiresAt",
          "#recoveryProof": "recoveryProof",
          "#updatedAt": "updatedAt",
          "#reissueReason": "reissueReason",
        },
        ExpressionAttributeValues: {
          ":reserved": "RESERVED",
          ":reissueRequired": "REISSUE_REQUIRED",
          ":expired": "RESERVATION_EXPIRED",
          ":serial": candidate.serial,
          ":recoveryProof": proof,
          ":reservationExpiresAt": reservationExpiresAt,
          ":nowEpoch": nowEpoch,
          ":updatedAt": candidate.createdAt,
        },
      }));
    } catch (error) {
      if (!isConditionalTransactionConflict(error)) throw error;
    }
  }
}

function serializeClaim(claim: DeviceClaim, expiresAt: number): Record<string, unknown> {
  return {
    claimKey: `CLAIM#${claim.claimId}`,
    claimId: claim.claimId,
    ownerId: claim.ownerId,
    tenantId: claim.tenantId,
    poolId: claim.poolId,
    serial: claim.serial,
    serialHash: claim.serialHash,
    registrationNonceHash: claim.registrationNonceHash,
    status: claim.status,
    expiresAt,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

function epochSeconds(value: string): number {
  const epoch = Math.floor(new Date(value).getTime() / 1000);
  if (!Number.isSafeInteger(epoch)) throw new AppError("INVALID_TIMESTAMP", 500, "Invalid domain timestamp");
  return epoch;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isConditionalTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  return reasons?.some((reason) => reason.Code === "ConditionalCheckFailed") === true;
}

function isRecoverableTransactionFailure(error: unknown): boolean {
  return error instanceof Error
    && (error.name === "ConditionalCheckFailedException" || error.name === "TransactionCanceledException");
}
