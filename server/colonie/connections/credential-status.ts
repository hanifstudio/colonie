import type { AppConfig } from "../../config.ts";
import { createHmac, randomBytes } from "node:crypto";
import { maskedComposioKey, type ComposioCredentialStatus } from "../../../shared/composio-credential.ts";

/** Pure metadata projection. No filesystem or provider requests. */
const revisionSalt = randomBytes(32);
export function composioCredentialStatus(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): ComposioCredentialStatus {
  const key = cfg.composio?.apiKey?.trim() ?? "";
  const hint = env.COLONIE_COMPOSIO_CREDENTIAL_SOURCE;
  const injected = env.COMPOSIO_API_KEY?.trim();
  const source = !key ? "none" : key === injected
    ? hint === "secure-store" || hint === "workspace-settings" ? hint : "environment"
    : "workspace-settings";
  const storage = env.OMB_CREDENTIAL_STORE === "unavailable" ? "unreadable"
    : env.COLONIE_COMPOSIO_MIGRATION_PENDING === "1" ? "migration-pending" : "available";
  const storedOrigin = env.COLONIE_COMPOSIO_CREDENTIAL_ORIGIN;
  const origin = source === "none" || source === "environment" ? source : source === "secure-store"
    ? storedOrigin === "user-input" || storedOrigin === "workspace-migration" ? storedOrigin : "existing-device-store"
    : storedOrigin === "user-input" ? "user-input" : "workspace-settings";
  return { revision: createHmac("sha256", revisionSalt).update(JSON.stringify([key, source, origin, storage])).digest("hex"),
    available: Boolean(key), source, origin, maskedKey: key ? maskedComposioKey(key) : null,
    canRemove: Boolean(key) && source !== "environment" && storage !== "unreadable", storage };
}
