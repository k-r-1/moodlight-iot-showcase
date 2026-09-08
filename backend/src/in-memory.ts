import { AppError, type BootstrapBinding, type DesiredState, type Device, type DeviceClaim, type DeviceState, type EventUplink, type IngestDisposition, type MembershipRole, type PersonalTenantBootstrap, type StateUplink, type TelemetryUplink, type TenantContext } from "./domain.ts";
import type { IngestRepository, Repository } from "./ports.ts";

const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryRepository implements Repository, IngestRepository {
  private readonly memberships = new Map<string, { userId: string; tenantId: string; role: MembershipRole; status: "ACTIVE" | "REVOKED" }>();
  private readonly tenants = new Set<string>();
  private readonly pools = new Set<string>();
  private readonly devices = new Map<string, Device>();
  private readonly claims = new Map<string, DeviceClaim>();
  private readonly serialLocks = new Map<string, string>();
  private readonly deviceRegistry = new Map<string, { status: "RESERVED" | "BOOTSTRAPPED" | "RUNTIME_AUTHORIZED" | "REISSUE_REQUIRED"; claimId?: string; serial: string; nonceHash?: string; thingName?: string; certificateId?: string }>();
  private readonly finalizeLeases = new Map<string, { leaseId: string; leaseExpiresAt: string; resumeStatus: "CLAIM_PENDING" | "BOOTSTRAPPED" }>();
  private readonly commandReservations = new Map<string, { commandId: string; commandSequence: number; desired: DesiredState; desiredState: DeviceState }>();

  addMembership(userId: string, tenantId: string, role: MembershipRole = "OWNER"): void {
    this.memberships.set(`${userId}\u0000${tenantId}`, { userId, tenantId, role, status: "ACTIVE" });
    this.tenants.add(tenantId);
    this.pools.add(`${tenantId}\u0000default`);
  }

  addPool(tenantId: string, poolId: string): void {
    this.tenants.add(tenantId);
    this.pools.add(`${tenantId}\u0000${poolId}`);
  }

  seedDevice(device: Device): void {
    this.devices.set(device.deviceId, copy(device));
  }

  async bootstrapPersonalTenant(input: PersonalTenantBootstrap): Promise<TenantContext> {
    const existing = [...this.memberships.values()]
      .filter((membership) => membership.userId === input.userId && membership.status === "ACTIVE")
      .sort((left, right) => left.tenantId < right.tenantId ? -1 : left.tenantId > right.tenantId ? 1 : 0)[0];
    if (existing) {
      const poolId = [...this.pools]
        .filter((key) => key.startsWith(`${existing.tenantId}\u0000`))
        .map((key) => key.split("\u0000")[1])
        .filter((value): value is string => value !== undefined)
        .sort()[0];
      if (!poolId) throw new AppError("TENANT_BOOTSTRAP_INCONSISTENT", 409, "Active Tenant membership has no Pool");
      return { tenantId: existing.tenantId, poolId, role: existing.role };
    }
    const membershipKey = `${input.userId}\u0000${input.tenantId}`;
    const poolKey = `${input.tenantId}\u0000${input.poolId}`;
    if (this.tenants.has(input.tenantId) || this.pools.has(poolKey) || this.memberships.has(membershipKey)) {
      throw new AppError("TENANT_BOOTSTRAP_CONFLICT", 409, "Personal Tenant could not be created safely");
    }
    this.tenants.add(input.tenantId);
    this.pools.add(poolKey);
    this.memberships.set(membershipKey, { userId: input.userId, tenantId: input.tenantId, role: "OWNER", status: "ACTIVE" });
    return { tenantId: input.tenantId, poolId: input.poolId, role: "OWNER" };
  }

  async hasMembership(userId: string, tenantId: string): Promise<boolean> {
    return this.memberships.get(`${userId}\u0000${tenantId}`)?.status === "ACTIVE";
  }

  async hasPool(tenantId: string, poolId: string): Promise<boolean> {
    return this.pools.has(`${tenantId}\u0000${poolId}`);
  }

  async listDevices(tenantId: string): Promise<Device[]> {
    return [...this.devices.values()].filter((device) => device.tenantId === tenantId).map(copy);
  }

  async getDevice(deviceId: string): Promise<Device | undefined> {
    const device = this.devices.get(deviceId);
    return device ? copy(device) : undefined;
  }

  async createClaim(claim: DeviceClaim): Promise<void> {
    if (this.deviceRegistry.get(claim.serialHash)?.status === "REISSUE_REQUIRED") {
      throw new AppError("REGISTRATION_REISSUE_REQUIRED", 409, "Registration code must be reissued by an administrator");
    }
    if ([...this.devices.values()].some((device) => device.serial === claim.serial && device.lifecycleStatus !== "REVOKED")) {
      throw new AppError("SERIAL_ALREADY_REGISTERED", 409, "This serial is already bound to a device");
    }
    const existingClaimId = this.serialLocks.get(claim.serialHash);
    const existing = existingClaimId ? this.claims.get(existingClaimId) : undefined;
    if (existing && Date.parse(existing.expiresAt) > Date.parse(claim.createdAt)
      && existing.status !== "FAILED" && existing.status !== "EXPIRED") {
      throw new AppError("SERIAL_ALREADY_CLAIMED", 409, "An active claim already holds this serial");
    }
    this.claims.set(claim.claimId, copy(claim));
    this.serialLocks.set(claim.serialHash, claim.claimId);
    this.deviceRegistry.set(claim.serialHash, {
      status: "RESERVED",
      claimId: claim.claimId,
      serial: claim.serial,
      nonceHash: claim.registrationNonceHash,
    });
  }

  async getClaim(claimId: string): Promise<DeviceClaim | undefined> {
    const claim = this.claims.get(claimId);
    return claim ? copy(claim) : undefined;
  }

  async expireClaim(claimId: string, now: string): Promise<DeviceClaim> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    claim.status = "EXPIRED";
    claim.updatedAt = now;
    this.finalizeLeases.delete(claimId);
    if (this.serialLocks.get(claim.serialHash) === claimId) this.serialLocks.delete(claim.serialHash);
    return copy(claim);
  }

  async acquireFinalizeLease(claimId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<{ claim: DeviceClaim; acquired: boolean }> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    if (claim.status === "RUNTIME_AUTHORIZED" || claim.status === "ONLINE") return { claim: copy(claim), acquired: false };
    const currentLease = this.finalizeLeases.get(claimId);
    const expires = claim.status === "CLAIM_PENDING"
      || (claim.status === "PROVISIONING" && currentLease?.resumeStatus === "CLAIM_PENDING");
    if (expires && Date.parse(claim.expiresAt) <= Date.parse(now)) {
      claim.status = "EXPIRED";
      claim.updatedAt = now;
      this.finalizeLeases.delete(claimId);
      if (this.serialLocks.get(claim.serialHash) === claimId) this.serialLocks.delete(claim.serialHash);
      throw new AppError("CLAIM_EXPIRED", 410, "Claim has expired");
    }
    if (claim.status === "PROVISIONING" && currentLease && Date.parse(currentLease.leaseExpiresAt) > Date.parse(now)) {
      throw new AppError("CLAIM_FINALIZE_IN_PROGRESS", 409, "Claim finalization is already in progress");
    }
    const resumeStatus = claim.status === "PROVISIONING"
      ? currentLease?.resumeStatus
      : claim.status === "CLAIM_PENDING" || claim.status === "BOOTSTRAPPED" ? claim.status : undefined;
    if (!resumeStatus) throw new AppError("INVALID_CLAIM_STATE", 409, `Cannot finalize claim in ${claim.status}`);
    claim.status = "PROVISIONING";
    claim.updatedAt = now;
    this.finalizeLeases.set(claimId, { leaseId, leaseExpiresAt, resumeStatus });
    return { claim: copy(claim), acquired: true };
  }

  async releaseFinalizeLease(claimId: string, leaseId: string, now: string): Promise<void> {
    const claim = this.claims.get(claimId);
    const lease = this.finalizeLeases.get(claimId);
    if (!claim || claim.status !== "PROVISIONING" || lease?.leaseId !== leaseId) return;
    claim.status = lease.resumeStatus;
    claim.updatedAt = now;
    this.finalizeLeases.delete(claimId);
  }

  async bootstrapClaim(claimId: string, binding: BootstrapBinding, leaseId: string, now: string): Promise<{ claim: DeviceClaim; device: Device }> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    if (claim.status !== "PROVISIONING") {
      throw new AppError("INVALID_CLAIM_STATE", 409, `Cannot bootstrap claim in ${claim.status}`);
    }
    const lease = this.finalizeLeases.get(claimId);
    if (!lease || lease.leaseId !== leaseId || Date.parse(lease.leaseExpiresAt) <= Date.parse(now)) {
      throw new AppError("CLAIM_FINALIZE_LEASE_LOST", 409, "Claim finalization lease was lost");
    }
    if (lease.resumeStatus === "CLAIM_PENDING" && Date.parse(claim.expiresAt) <= Date.parse(now)) {
      claim.status = "EXPIRED";
      claim.updatedAt = now;
      if (this.serialLocks.get(claim.serialHash) === claimId) this.serialLocks.delete(claim.serialHash);
      throw new AppError("CLAIM_EXPIRED", 410, "Claim has expired");
    }
    if (this.serialLocks.get(claim.serialHash) !== claimId) {
      throw new AppError("SERIAL_LOCK_LOST", 409, "Claim no longer owns the serial lock");
    }
    if (binding.serial !== claim.serial) throw new AppError("SERIAL_MISMATCH", 409, "Provisioned serial does not match claim");
    const registry = this.deviceRegistry.get(claim.serialHash);
    if (!registry || registry.claimId !== claimId || registry.serial !== claim.serial || registry.nonceHash !== claim.registrationNonceHash) {
      throw new AppError("DEVICE_REGISTRY_INCONSISTENT", 409, "Manufacturing registry binding is inconsistent");
    }
    if (lease.resumeStatus === "BOOTSTRAPPED") {
      const existing = claim.thingName ? this.devices.get(claim.thingName) : undefined;
      if (!existing || existing.lifecycleStatus !== "BOOTSTRAPPED" || !sameBootstrapBinding(existing, claim, binding)
        || registry.status !== "BOOTSTRAPPED" || registry.thingName !== binding.thingName || registry.certificateId !== binding.certificateId) {
        throw new AppError("CLAIM_INCONSISTENT", 409, "Bootstrapped claim has no matching durable binding");
      }
      claim.status = "BOOTSTRAPPED";
      claim.updatedAt = now;
      this.finalizeLeases.delete(claimId);
      return { claim: copy(claim), device: copy(existing) };
    }
    if ([...this.devices.values()].some((device) => device.serial === claim.serial && device.lifecycleStatus !== "REVOKED")) {
      throw new AppError("SERIAL_ALREADY_REGISTERED", 409, "This serial is already bound to a device");
    }
    const existing = this.devices.get(binding.thingName);
    if (existing && (existing.lifecycleStatus !== "REVOKED" || existing.serial !== claim.serial)) {
      throw new AppError("DEVICE_ALREADY_REGISTERED", 409, "Thing is already bound to a device");
    }
    if (existing?.certificateId === binding.certificateId) {
      throw new AppError("CERTIFICATE_ALREADY_REVOKED", 409, "A revoked certificate cannot be reused");
    }
    const device: Device = {
      deviceId: binding.thingName,
      thingName: binding.thingName,
      ownerId: claim.ownerId,
      tenantId: claim.tenantId,
      poolId: claim.poolId,
      serial: claim.serial,
      certificateId: binding.certificateId,
      name: "새 무드등",
      lifecycleStatus: "BOOTSTRAPPED",
      claimId: claim.claimId,
      power: false,
      red: 0,
      green: 0,
      blue: 0,
      brightness: 0,
      version: 1,
    };
    this.devices.set(device.deviceId, copy(device));
    claim.status = "BOOTSTRAPPED";
    claim.thingName = device.thingName;
    claim.updatedAt = now;
    registry.status = "BOOTSTRAPPED";
    registry.thingName = device.thingName;
    registry.certificateId = device.certificateId;
    this.finalizeLeases.delete(claimId);
    return { claim: copy(claim), device: copy(device) };
  }

  async authorizeRuntimeClaim(claimId: string, binding: BootstrapBinding, now: string): Promise<{ claim: DeviceClaim; device: Device }> {
    const claim = this.claims.get(claimId);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", 404, "Claim not found");
    const device = claim.thingName ? this.devices.get(claim.thingName) : undefined;
    if ((claim.status === "RUNTIME_AUTHORIZED" || claim.status === "ONLINE") && device && sameBootstrapBinding(device, claim, binding)) {
      return { claim: copy(claim), device: copy(device) };
    }
    const registry = this.deviceRegistry.get(claim.serialHash);
    if (claim.status !== "BOOTSTRAPPED" || !device || device.lifecycleStatus !== "BOOTSTRAPPED"
      || !sameBootstrapBinding(device, claim, binding) || registry?.status !== "BOOTSTRAPPED"
      || registry.thingName !== binding.thingName || registry.certificateId !== binding.certificateId) {
      throw new AppError("CLAIM_INCONSISTENT", 409, "Bootstrapped binding changed before runtime authorization");
    }
    claim.status = "RUNTIME_AUTHORIZED";
    claim.updatedAt = now;
    device.lifecycleStatus = "RUNTIME_AUTHORIZED";
    device.version += 1;
    registry.status = "RUNTIME_AUTHORIZED";
    return { claim: copy(claim), device: copy(device) };
  }

  async revokeDeviceAndReleaseSerial(device: Device, serialHash: string, now: string): Promise<{ device: Device; idempotent: boolean }> {
    const current = this.devices.get(device.deviceId);
    if (!current) throw new AppError("DEVICE_NOT_FOUND", 404, "Device not found");
    if (!sameBinding(current, device)) throw new AppError("DEVICE_RELEASE_CONFLICT", 409, "Device changed while it was being released");
    if (current.lifecycleStatus === "REVOKED") return { device: copy(current), idempotent: true };

    const claim = [...this.claims.values()].find((item) =>
      item.serialHash === serialHash
      && item.thingName === current.thingName
      && (item.status === "RUNTIME_AUTHORIZED" || item.status === "ONLINE"));
    if (!claim || this.serialLocks.get(serialHash) !== claim.claimId) {
      throw new AppError("SERIAL_BINDING_INCONSISTENT", 409, "Device serial binding is inconsistent");
    }
    const registry = this.deviceRegistry.get(serialHash);
    if (!registry || registry.status !== "RUNTIME_AUTHORIZED" || registry.claimId !== claim.claimId
      || registry.thingName !== current.thingName || registry.certificateId !== current.certificateId) {
      throw new AppError("DEVICE_REGISTRY_INCONSISTENT", 409, "Device registry binding is inconsistent");
    }

    claim.status = "REVOKED";
    claim.updatedAt = now;
    current.lifecycleStatus = "REVOKED";
    current.revokedAt = now;
    current.version += 1;
    this.serialLocks.delete(serialHash);
    this.deviceRegistry.set(serialHash, { status: "REISSUE_REQUIRED", serial: current.serial });
    return { device: copy(current), idempotent: false };
  }

  async reserveCommand(device: Device, requestId: string, commandId: string, desired: DesiredState): Promise<{ commandId: string; commandSequence: number; desiredState: DeviceState }> {
    const key = [device.deviceId, device.certificateId, requestId].join("\u0000");
    const current = this.commandReservations.get(key);
    if (current) {
      if (!sameDesiredState(current.desired, desired)) {
        throw new AppError("REQUEST_ID_REUSED", 409, "requestId was already used for a different command");
      }
      return { commandId: current.commandId, commandSequence: current.commandSequence, desiredState: copy(current.desiredState) };
    }
    const storedDevice = this.devices.get(device.deviceId);
    if (!storedDevice || storedDevice.certificateId !== device.certificateId
      || (storedDevice.lifecycleStatus !== "RUNTIME_AUTHORIZED" && storedDevice.lifecycleStatus !== "ACTIVE")) {
      throw new AppError("DEVICE_COMMAND_CONFLICT", 409, "Device generation changed while reserving command");
    }
    const commandSequence = (storedDevice.commandSequence ?? 0) + 1;
    if (!Number.isSafeInteger(commandSequence)) throw new AppError("COMMAND_SEQUENCE_EXHAUSTED", 409, "Command sequence is exhausted");
    const base = storedDevice.desiredState ?? storedDevice;
    const desiredState: DeviceState = {
      power: desired.power ?? base.power,
      red: desired.red ?? base.red,
      green: desired.green ?? base.green,
      blue: desired.blue ?? base.blue,
      brightness: desired.brightness ?? base.brightness,
    };
    storedDevice.commandSequence = commandSequence;
    storedDevice.lastCommandId = commandId;
    storedDevice.desiredState = copy(desiredState);
    storedDevice.version += 1;
    this.commandReservations.set(key, { commandId, commandSequence, desired: copy(desired), desiredState: copy(desiredState) });
    return { commandId, commandSequence, desiredState };
  }

  async applyState(message: StateUplink): Promise<IngestDisposition> {
    const device = this.ingestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, device.lastStateMessageId,
      message.bootStartedAtMs, device.stateBootStartedAtMs,
      message.bootId, device.stateBootId,
      message.stateSequence, device.stateSequence,
    );
    if (disposition !== "APPLIED") return disposition;

    let claim: DeviceClaim | undefined;
    if (device.lifecycleStatus === "RUNTIME_AUTHORIZED") {
      if (!device.claimId) throw new AppError("DEVICE_CLAIM_MISSING", 409, "Runtime-authorized device has no Claim binding");
      claim = this.claims.get(device.claimId);
      if (!claim || claim.status !== "RUNTIME_AUTHORIZED" || claim.thingName !== device.thingName) {
        throw new AppError("CLAIM_INCONSISTENT", 409, "Runtime-authorized device has no matching Claim");
      }
    }

    Object.assign(device, {
      power: message.power,
      red: message.red,
      green: message.green,
      blue: message.blue,
      brightness: message.brightness,
      lastStateMessageId: message.messageId,
      stateBootId: message.bootId,
      stateBootStartedAtMs: message.bootStartedAtMs,
      stateBootSequence: message.bootSequence,
      stateSequence: message.stateSequence,
      lastSeenAt: message.receivedAt,
      lifecycleStatus: "ACTIVE" as const,
      version: device.version + 1,
    });
    if (message.appliedCommandId) device.appliedCommandId = message.appliedCommandId;
    if (claim) {
      claim.status = "ONLINE";
      claim.updatedAt = message.receivedAt;
    }
    return "APPLIED";
  }

  async applyTelemetry(message: TelemetryUplink): Promise<IngestDisposition> {
    const device = this.ingestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, device.lastTelemetryMessageId,
      message.bootStartedAtMs, device.telemetryBootStartedAtMs,
      message.bootId, device.telemetryBootId,
      message.telemetrySequence, device.telemetrySequence,
    );
    if (disposition !== "APPLIED") return disposition;
    Object.assign(device, {
      lastTelemetryMessageId: message.messageId,
      telemetryBootId: message.bootId,
      telemetryBootStartedAtMs: message.bootStartedAtMs,
      telemetryBootSequence: message.bootSequence,
      telemetrySequence: message.telemetrySequence,
      uptimeSeconds: message.uptimeSeconds,
      rssi: message.rssi,
      firmwareVersion: message.firmwareVersion,
      lastSeenAt: message.receivedAt,
      version: device.version + 1,
    });
    return "APPLIED";
  }

  async applyEvent(message: EventUplink): Promise<IngestDisposition> {
    const device = this.ingestDevice(message.thingName, message.tenantId, message.poolId);
    const disposition = streamDisposition(
      message.messageId, device.lastEventMessageId,
      message.bootStartedAtMs, device.eventBootStartedAtMs,
      message.bootId, device.eventBootId,
      message.eventSequence, device.eventSequence,
    );
    if (disposition !== "APPLIED") return disposition;
    Object.assign(device, {
      lastEventMessageId: message.messageId,
      eventBootId: message.bootId,
      eventBootStartedAtMs: message.bootStartedAtMs,
      eventBootSequence: message.bootSequence,
      eventSequence: message.eventSequence,
      lastEventType: message.eventType,
      lastEventAt: message.occurredAt,
      lastSeenAt: message.receivedAt,
      version: device.version + 1,
    });
    return "APPLIED";
  }

  private ingestDevice(thingName: string, tenantId: string, poolId: string): Device {
    const device = this.devices.get(thingName);
    if (!device) throw new AppError("DEVICE_NOT_FOUND", 404, "Uplink device was not found");
    if (device.thingName !== thingName || device.tenantId !== tenantId || device.poolId !== poolId) {
      throw new AppError("UPLINK_IDENTITY_MISMATCH", 409, "Uplink topic identity does not match the Device binding");
    }
    if (device.lifecycleStatus !== "RUNTIME_AUTHORIZED" && device.lifecycleStatus !== "ACTIVE") {
      throw new AppError("DEVICE_NOT_READY", 409, "Device runtime authorization is incomplete");
    }
    return device;
  }
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

function sameDesiredState(left: DesiredState, right: DesiredState): boolean {
  return left.power === right.power
    && left.red === right.red
    && left.green === right.green
    && left.blue === right.blue
    && left.brightness === right.brightness;
}
