export type ComposioCredentialSource = "none" | "environment" | "secure-store" | "workspace-settings";
export interface ComposioCredentialStatus {
  revision: string;
  available: boolean;
  source: ComposioCredentialSource;
  origin: "none" | "user-input" | "workspace-migration" | "existing-device-store" | "environment" | "workspace-settings";
  maskedKey: string | null;
  canRemove: boolean;
  storage: "available" | "unreadable" | "migration-pending";
}
/** A credential value is never returned; only an identifying, bounded fragment. */
export function maskedComposioKey(key: string): string {
  const value = key.trim();
  return value.length >= 16 ? `${value.slice(0, 6)}••••••••${value.slice(-4)}` : "••••••••";
}
export function credentialOperationError(cause: unknown, action: "save" | "remove"): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const reason = raw.replace(/^Error invoking remote method ['"]credential:set['"]:\s*(?:Error:\s*)?/, "");
  if (/safeStorage|encryptString|decryptString|operating-system credential store|credential store could not be read/i.test(reason)) {
    return action === "remove"
      ? "The key could not be removed because the macOS credential store is unavailable. The existing configuration is still active."
      : "The key could not be saved because the macOS credential store is unavailable. The existing configuration was kept.";
  }
  return action === "remove" ? `The key could not be removed. ${reason}` : `The key could not be saved. ${reason}`;
}
