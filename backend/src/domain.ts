export type ClaimStatus = "CLAIM_PENDING" | "BOOTSTRAPPED" | "PROVISIONING" | "RUNTIME_AUTHORIZED" | "ONLINE" | "FAILED" | "EXPIRED" | "REVOKED";
export type DeviceLifecycle = "BOOTSTRAPPED" | "RUNTIME_AUTHORIZED" | "ACTIVE" | "REVOKED";

export interface AuthContext { userId: string }
export type MembershipRole = "OWNER" | "MEMBER";
export interface TenantContext { tenantId: string; poolId: string; role: MembershipRole }
export interface PersonalTenantBootstrap {
  userId: string;
  tenantId: string;
  poolId: string;
  tenantName: string;
  poolName: string;
  now: string;
}
export interface DeviceState { power: boolean; red: number; green: number; blue: number; brightness: number }
export interface DesiredState { power?: boolean; red?: number; green?: number; blue?: number; brightness?: number }

export interface Device extends DeviceState {
  deviceId: string;
  thingName: string;
  ownerId: string;
  tenantId: string;
  poolId: string;
  serial: string;
  certificateId: string;
  name: string;
  lifecycleStatus: DeviceLifecycle;
  claimId?: string;
  lastCommandId?: string;
  commandSequence?: number;
  /** Latest requested complete control state; observed state fields above remain the app read model. */
  desiredState?: DeviceState;
  appliedCommandId?: string;
  lastStateMessageId?: string;
  stateBootId?: string;
  stateBootStartedAtMs?: number;
  stateBootSequence?: number;
  stateSequence?: number;
  lastTelemetryMessageId?: string;
  telemetryBootId?: string;
  telemetryBootStartedAtMs?: number;
  telemetryBootSequence?: number;
  telemetrySequence?: number;
  uptimeSeconds?: number;
  rssi?: number;
  firmwareVersion?: string;
  lastEventMessageId?: string;
  eventBootId?: string;
  eventBootStartedAtMs?: number;
  eventBootSequence?: number;
  eventSequence?: number;
  lastEventType?: string;
  lastEventAt?: string;
  lastSeenAt?: string;
  revokedAt?: string;
  version: number;
}

export interface UplinkIdentity {
  tenantId: string;
  poolId: string;
  thingName: string;
  messageId: string;
  bootId: string;
  bootStartedAtMs: number;
  bootSequence: number;
  receivedAt: string;
}

export interface StateUplink extends UplinkIdentity, DeviceState {
  kind: "state";
  stateSequence: number;
  appliedCommandId?: string;
}

export interface TelemetryUplink extends UplinkIdentity {
  kind: "tele";
  telemetrySequence: number;
  uptimeSeconds: number;
  rssi: number;
  firmwareVersion: string;
}

export interface EventUplink extends UplinkIdentity {
  kind: "evt";
  eventSequence: number;
  eventType: string;
  occurredAt: string;
}

export type UplinkMessage = StateUplink | TelemetryUplink | EventUplink;
export type IngestDisposition = "APPLIED" | "DUPLICATE" | "STALE";

export interface DeviceClaim {
  claimId: string;
  ownerId: string;
  tenantId: string;
  poolId: string;
  serial: string;
  serialHash: string;
  registrationNonceHash: string;
  status: ClaimStatus;
  thingName?: string;
  failureCode?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BootstrapBinding { thingName: string; serial: string; certificateId: string }
export interface DecommissionConfirmation {
  thingName: string;
  certificateId: string;
  certificateDisabled: boolean;
  policiesDetached: boolean;
  thingDeleted: boolean;
}
export interface CreateClaimInput { tenantId: string; poolId: string; serial: string; registrationCode: string }

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
  }
}
