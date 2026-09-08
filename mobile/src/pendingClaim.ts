import * as SecureStore from "expo-secure-store";

const PENDING_CLAIM_KEY = "moodlight.pending-device-claim.v1";
type CommitGuard = () => boolean;

let pendingClaimMutation = Promise.resolve();

export type StoredPendingClaim = Readonly<{
  tenantId: string;
  serial: string;
  claimId: string;
  expiresAt: string;
  registrationNonce: string;
}>;

export async function savePendingClaim(claim: StoredPendingClaim, shouldCommit: CommitGuard = () => true): Promise<boolean> {
  validate(claim);
  return mutatePendingClaim(shouldCommit, () => SecureStore.setItemAsync(PENDING_CLAIM_KEY, JSON.stringify({ version: 1, ...claim }), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }));
}

export async function loadPendingClaim(now = Date.now(), shouldCommit: CommitGuard = () => true): Promise<StoredPendingClaim | null> {
  const raw = await SecureStore.getItemAsync(PENDING_CLAIM_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "tenantId", "serial", "claimId", "expiresAt", "registrationNonce"].includes(key))) {
      throw new Error("invalid-pending-claim");
    }
    const claim = {
      tenantId: text(value.tenantId, 128),
      serial: text(value.serial, 128),
      claimId: text(value.claimId, 128),
      expiresAt: isoDate(value.expiresAt),
      registrationNonce: text(value.registrationNonce, 512),
    };
    if (Date.parse(claim.expiresAt) <= now) throw new Error("expired-pending-claim");
    return claim;
  } catch {
    await clearPendingClaim(shouldCommit);
    return null;
  }
}

export async function clearPendingClaim(shouldCommit: CommitGuard = () => true): Promise<void> {
  await mutatePendingClaim(shouldCommit, () => SecureStore.deleteItemAsync(PENDING_CLAIM_KEY));
}

async function mutatePendingClaim(shouldCommit: CommitGuard, mutation: () => Promise<void>): Promise<boolean> {
  let committed = false;
  const current = pendingClaimMutation.then(async () => {
    if (!shouldCommit()) return;
    await mutation();
    committed = true;
  });
  pendingClaimMutation = current.catch(() => {});
  await current;
  return committed;
}

function validate(claim: StoredPendingClaim): void {
  text(claim.tenantId, 128);
  text(claim.serial, 128);
  text(claim.claimId, 128);
  isoDate(claim.expiresAt);
  text(claim.registrationNonce, 512);
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > maxLength) throw new Error("invalid-pending-claim");
  return value;
}

function isoDate(value: unknown): string {
  const result = text(value, 64);
  if (Number.isNaN(Date.parse(result))) throw new Error("invalid-pending-claim");
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}