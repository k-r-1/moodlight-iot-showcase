import { AppError, type BootstrapBinding, type DecommissionConfirmation, type Device, type DeviceClaim, type DesiredState, type DeviceState, type EventUplink, type IngestDisposition, type PersonalTenantBootstrap, type StateUplink, type TelemetryUplink, type TenantContext } from "./domain.ts";

export interface Repository {
  bootstrapPersonalTenant(input: PersonalTenantBootstrap): Promise<TenantContext>;
  hasMembership(userId: string, tenantId: string): Promise<boolean>;
  hasPool(tenantId: string, poolId: string): Promise<boolean>;
  listDevices(tenantId: string): Promise<Device[]>;
  getDevice(deviceId: string): Promise<Device | undefined>;
  /**
   * A durable adapter must atomically create the Claim and SERIAL#{serialHash}
   * lock, rejecting both an active lock and a permanent serial binding left by
   * a completed Claim.
   * The domain ISO timestamp must be stored in DynamoDB's TTL attribute
   * `expiresAt` as a Number containing Unix epoch seconds, then hydrated back
   * to an ISO string on reads.
   */
  createClaim(claim: DeviceClaim): Promise<void>;
  getClaim(claimId: string): Promise<DeviceClaim | undefined>;
  expireClaim(claimId: string, now: string): Promise<DeviceClaim>;
  /**
   * Atomically grants one short-lived lease before any external provisioning
   * call. A live lease must reject contenders; an expired lease may be taken
   * over so a crashed worker does not strand the Claim forever.
   */
  acquireFinalizeLease(claimId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<{ claim: DeviceClaim; acquired: boolean }>;
  /** Releases only the caller's own lease before a durable bootstrap binding exists. */
  releaseFinalizeLease(claimId: string, leaseId: string, now: string): Promise<void>;
  /**
   * Atomically persists the verified Claim, Device, serial lock, and
   * manufacturing registry as BOOTSTRAPPED before any IoT policy mutation.
   * Claim/lock reservation TTL fields must be removed in the same write.
   */
  bootstrapClaim(claimId: string, binding: BootstrapBinding, leaseId: string, now: string): Promise<{ claim: DeviceClaim; device: Device }>;
  /** Atomically exposes an already bootstrapped binding after the idempotent IoT policy transition succeeded. */
  authorizeRuntimeClaim(claimId: string, binding: BootstrapBinding, now: string): Promise<{ claim: DeviceClaim; device: Device }>;
  reserveCommand(device: Device, requestId: string, commandId: string, desired: DesiredState): Promise<{ commandId: string; commandSequence: number; desiredState: DeviceState }>;
  revokeDeviceAndReleaseSerial(device: Device, serialHash: string, now: string): Promise<{ device: Device; idempotent: boolean }>;
}

/** Internal IoT ingestion boundary. It intentionally has no user-auth methods. */
export interface IngestRepository {
  applyState(message: StateUplink): Promise<IngestDisposition>;
  applyTelemetry(message: TelemetryUplink): Promise<IngestDisposition>;
  applyEvent(message: EventUplink): Promise<IngestDisposition>;
}

export interface ProvisioningPort {
  /** Read-only verification of Registry, Thing, certificate, and bootstrap policy binding. */
  verifyBootstrap(claim: DeviceClaim): Promise<BootstrapBinding>;
  /** Idempotently attach runtime policy first, then detach bootstrap policy. */
  authorizeRuntime(claim: DeviceClaim, binding: BootstrapBinding): Promise<void>;
}
/**
 * Manufacturing-registry boundary for Claim creation. A durable adapter must
 * verify and consume the registration code while creating the Claim and its
 * serial lock in one atomic write.
 */
export interface ClaimRegistrar { createClaim(claim: DeviceClaim, registrationCode: string): Promise<DeviceClaim> }
export interface CommandPublisher { publish(device: Device, commandId: string, commandSequence: number, desired: DesiredState): Promise<void> }
export interface DeviceDecommissioner {
  /** Must be idempotent and resolve only after credentials are disabled, managed policies detached, and the Thing deleted. */
  decommission(device: Device): Promise<DecommissionConfirmation>;
}

export class NotConfiguredClaimRegistrar implements ClaimRegistrar {
  async createClaim(_claim: DeviceClaim, _registrationCode: string): Promise<DeviceClaim> {
    throw new AppError("NOT_CONFIGURED", 503, "Device registry is not configured");
  }
}
export class NotConfiguredProvisioning implements ProvisioningPort {
  async verifyBootstrap(_claim: DeviceClaim): Promise<BootstrapBinding> {
    throw new AppError("NOT_CONFIGURED", 503, "AWS IoT provisioning adapter is not configured");
  }
  async authorizeRuntime(_claim: DeviceClaim, _binding: BootstrapBinding): Promise<void> {
    throw new AppError("NOT_CONFIGURED", 503, "AWS IoT provisioning adapter is not configured");
  }
}
export class NotConfiguredCommandPublisher implements CommandPublisher {
  async publish(_device: Device, _commandId: string, _commandSequence: number, _desired: DesiredState): Promise<void> {
    throw new AppError("NOT_CONFIGURED", 503, "AWS IoT command publisher is not configured");
  }
}

export class NotConfiguredDeviceDecommissioner implements DeviceDecommissioner {
  async decommission(_device: Device): Promise<DecommissionConfirmation> {
    throw new AppError("NOT_CONFIGURED", 503, "AWS IoT device decommissioning is not configured");
  }
}
