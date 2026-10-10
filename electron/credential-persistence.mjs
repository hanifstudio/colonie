/** OS encryption only. Rollback restores original encrypted bytes without re-encryption. */
export function createCredentialPersistence({ writable, readEncrypted, remove, isAvailable, encrypt, writeEncrypted }) {
  let checkpoint = null;
  return async (credentials, { rollback = false } = {}) => {
    if (!writable()) throw new Error("The credential store could not be read on this launch, so credentials cannot be saved");
    if (rollback) {
      if (checkpoint === null) await remove();
      else await writeEncrypted(checkpoint);
      return;
    }
    const previous = await readEncrypted();
    if (Object.keys(credentials).length === 0) {
      await remove(); checkpoint = previous; return;
    }
    if (!(await isAvailable())) throw new Error("The operating-system credential store is unavailable");
    const encrypted = await encrypt(JSON.stringify(credentials));
    await writeEncrypted(encrypted); checkpoint = previous;
  };
}

/** Migration commits memory only after encrypted persistence succeeds. */
export async function migrateComposioCredential(config, credentials, persist) {
  const nextConfig = structuredClone(config);
  let nextCredentials = structuredClone(credentials);
  const key = nextConfig?.composio?.apiKey;
  if (typeof key !== "string" || !key.trim().startsWith("ak_")) return { config: nextConfig, credentials: nextCredentials, changed: false };
  if (nextCredentials.composioApiKey !== key.trim()) {
    nextCredentials = { ...nextCredentials, composioApiKey: key.trim(), composioCredentialOrigin: "workspace-migration" };
    await persist(nextCredentials);
  }
  nextConfig.composio.apiKey = "";
  return { config: nextConfig, credentials: nextCredentials, changed: true };
}
