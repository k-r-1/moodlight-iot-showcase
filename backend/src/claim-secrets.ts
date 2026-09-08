import { createHash } from "node:crypto";

interface ClaimSecretContext {
  ownerId: string;
  tenantId: string;
  poolId: string;
  serial: string;
}

export function registrationNonceFor(context: ClaimSecretContext, registrationCode: string): string {
  return digest("moodlight-registration-nonce-v1\0", context, registrationCode, "base64url");
}

export function registrationRecoveryProof(context: ClaimSecretContext, registrationCode: string): string {
  return digest("moodlight-registration-recovery-v1\0", context, registrationCode, "hex");
}

function digest(
  domain: string,
  context: ClaimSecretContext,
  registrationCode: string,
  encoding: "base64url" | "hex",
): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update(context.ownerId, "utf8").update("\0")
    .update(context.tenantId, "utf8").update("\0")
    .update(context.poolId, "utf8").update("\0")
    .update(context.serial, "utf8").update("\0")
    .update(registrationCode, "utf8")
    .digest(encoding);
}
