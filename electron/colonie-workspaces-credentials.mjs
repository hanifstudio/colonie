// Per-Local-workspace credential vault.
//
// The app's own vault is one OS-encrypted file whose path comes from
// userData (CREDENTIALS_FILE in electron/main.mjs). A Local workspace is a
// separate account-scoped boundary, so it must not read or write that file:
// every workspace keeps its own `credentials.bin` inside its own data root and
// inherits nothing from another workspace's or the app's store.
//
// The encryption and the empty-versus-unavailable distinction are not
// reinvented here: readSecureCredentials and createCredentialPersistence
// already own both, and main.mjs supplies safeStorage to them. This module only
// binds those to one workspace root.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createCredentialPersistence } from "./credential-persistence.mjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { workspaceCredentialEnv } from "./workspace-credentials.mjs";

const VAULT_NAME = "credentials.bin";
const MAX_ROOT = 4096;

function validRoot(root) {
  return typeof root === "string" && root.length > 0 && root.length <= MAX_ROOT && isAbsolute(root) && !/[\r\n\0]/.test(root);
}

/** The one file a Local workspace's secrets live in: inside its own root, and
 * nowhere else. A caller cannot point this at the app's global vault. */
export function workspaceCredentialsFile(root) {
  if (!validRoot(root)) throw new Error("A Local workspace vault needs a data directory.");
  return join(root, VAULT_NAME);
}

/** Bind the OS-encrypted store to one workspace root.
 *
 * `safeStorage` is Electron's: `isAsyncEncryptionAvailable`,
 * `encryptStringAsync`, `decryptStringAsync`. `status()` keeps "empty" and
 * "unavailable" apart, because a keychain hiccup must never read as "this
 * workspace has no secrets" (that is what makes a caller register a fresh
 * workspace over a real one). */
export function createWorkspaceCredentialVault({ root, safeStorage, log = () => {}, readDelays, sleep } = {}) {
  const file = workspaceCredentialsFile(root);
  if (!safeStorage?.isAsyncEncryptionAvailable || !safeStorage?.encryptStringAsync || !safeStorage?.decryptStringAsync) {
    throw new Error("A Local workspace vault needs the operating-system credential store.");
  }
  let unavailable = false;

  const load = () => readSecureCredentials({
    exists: () => existsSync(file),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => readFileSync(file),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    sleep: sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ...(readDelays ? { delays: readDelays } : {}),
  });

  async function read() {
    const result = await load();
    unavailable = result.status === "unavailable";
    if (unavailable) {
      // Deliberately loud and deliberately secret-free.
      log(`local workspace credential store unreadable (${result.error}); saved keys are not loaded this launch`);
    }
    return result;
  }

  const save = createCredentialPersistence({
    writable: () => !unavailable,
    readEncrypted: () => (existsSync(file) ? readFileSync(file) : null),
    remove: () => rmSync(file, { force: true }),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptStringAsync(text),
    writeEncrypted: (encrypted) => {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, encrypted, { mode: 0o600 });
      renameSync(temporary, file);
    },
  });

  return {
    file,
    root,
    status: () => (unavailable ? "unavailable" : "ok"),
    read,
    /** Empty credentials remove the file; a failure keeps the previous bytes. */
    save: (credentials, options) => save(credentials, options),
  };
}

/** The environment this workspace's own secrets may enter its server child
 * through — the same per-secret env names the app already uses, and nothing
 * from another workspace's or the app's vault. */
export function workspaceCredentialEnvironment(credentials) {
  const env = workspaceCredentialEnv(credentials);
  const composio = credentials?.composioApiKey;
  if (typeof composio === "string" && composio) {
    env.COMPOSIO_API_KEY = composio;
    env.COLONIE_COMPOSIO_CREDENTIAL_SOURCE = "workspace-vault";
    env.COLONIE_COMPOSIO_CREDENTIAL_ORIGIN = "local-workspace";
  }
  return env;
}
