import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWorkspaceCredentialVault,
  workspaceCredentialEnvironment,
  workspaceCredentialsFile,
} from "./colonie-workspaces-credentials.mjs";

const roots = [];
function workspaceRoot() {
  const root = mkdtempSync(join(tmpdir(), "colonie-vault-"));
  roots.push(root);
  return join(root, "workspace");
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A stand-in for Electron's safeStorage: real bytes for real files, no OS. */
function fakeSafeStorage({ available = true, failEncrypt = false, failDecrypt = false } = {}) {
  return {
    isAsyncEncryptionAvailable: () => available,
    encryptStringAsync: async (text) => {
      if (failEncrypt) throw new Error("keychain is busy");
      // Not encryption, but enough to prove the vault stores ciphertext bytes
      // rather than the secret itself.
      return Buffer.concat([Buffer.from("safe:"), Buffer.from(Buffer.from(text, "utf8").toString("base64"))]);
    },
    decryptStringAsync: async (buffer) => {
      if (failDecrypt || !buffer.subarray(0, 5).equals(Buffer.from("safe:"))) throw new Error("keychain is busy");
      return Buffer.from(buffer.subarray(5).toString("utf8"), "base64").toString("utf8");
    },
  };
}

test("a workspace vault lives inside its own root, never in the app's store", () => {
  const root = workspaceRoot();
  assert.equal(workspaceCredentialsFile(root), join(root, "credentials.bin"));
  assert.throws(() => workspaceCredentialsFile("relative"), /data directory/);
  assert.throws(() => workspaceCredentialsFile("/tmp/a\nb"), /data directory/);
  assert.throws(() => createWorkspaceCredentialVault({ root, safeStorage: {} }), /operating-system credential store/);
  const vault = createWorkspaceCredentialVault({ root, safeStorage: fakeSafeStorage() });
  assert.equal(vault.file, join(root, "credentials.bin"));
  assert.ok(!vault.file.includes("userData"));
});

test("secrets are encrypted at rest and read back one workspace at a time", async () => {
  const root = workspaceRoot();
  const vault = createWorkspaceCredentialVault({ root, safeStorage: fakeSafeStorage() });
  assert.deepEqual(await vault.read(), { status: "empty", credentials: {} });

  await vault.save({ composioApiKey: "ak_workspace_one", xaiApiKey: "xai-one" });
  const onDisk = readFileSync(vault.file);
  assert.equal(onDisk.includes(Buffer.from("ak_workspace_one")), false, "the key is not plaintext on disk");
  assert.equal(statSync(vault.file).mode & 0o777, 0o600);
  assert.deepEqual(await vault.read(), { status: "ok", credentials: { composioApiKey: "ak_workspace_one", xaiApiKey: "xai-one" } });

  // A second workspace's vault cannot see the first one's secrets.
  const other = createWorkspaceCredentialVault({ root: workspaceRoot(), safeStorage: fakeSafeStorage() });
  assert.deepEqual(await other.read(), { status: "empty", credentials: {} });

  // Emptying removes the file: absent means "saved nothing", not "lost".
  await vault.save({});
  assert.equal(existsSync(vault.file), false);
});

test("an unavailable store is ignorance, never emptiness, and never overwrites", async () => {
  const root = workspaceRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "credentials.bin");
  writeFileSync(file, Buffer.from("safe:{\"xaiApiKey\":\"older\"}"), { mode: 0o600 });
  const previous = readFileSync(file);

  const unavailable = createWorkspaceCredentialVault({ root, safeStorage: fakeSafeStorage({ failDecrypt: true }), readDelays: [1] });
  const result = await unavailable.read();
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.credentials, {});
  assert.equal(unavailable.status(), "unavailable");
  await assert.rejects(unavailable.save({ xaiApiKey: "newer" }), /could not be read/);
  assert.deepEqual(readFileSync(file), previous, "a failed save leaves the working configuration alone");

  // A successful read still refuses to save when the store says it is unavailable.
  const notAvailable = createWorkspaceCredentialVault({ root: workspaceRoot(), safeStorage: fakeSafeStorage({ available: false }), readDelays: [] });
  await notAvailable.read();
  await assert.rejects(notAvailable.save({ xaiApiKey: "x" }), /credential store is unavailable/);
});

test("rollback restores the previous encrypted bytes without re-encrypting", async () => {
  const root = workspaceRoot();
  const vault = createWorkspaceCredentialVault({ root, safeStorage: fakeSafeStorage() });
  await vault.save({ xaiApiKey: "first" });
  const firstBytes = readFileSync(vault.file);
  await vault.save({ xaiApiKey: "second" });
  await vault.save({ xaiApiKey: "second" }, { rollback: true });
  assert.deepEqual(readFileSync(vault.file), firstBytes);
  assert.deepEqual((await vault.read()).credentials, { xaiApiKey: "first" });
});

test("a damaged vault is unavailable, never an empty workspace", async () => {
  const root = workspaceRoot();
  const vault = createWorkspaceCredentialVault({ root, safeStorage: fakeSafeStorage() });
  await vault.save({ xaiApiKey: "x" });
  writeFileSync(vault.file, Buffer.from("safe:not json"), { mode: 0o600 });
  assert.equal((await vault.read()).status, "unavailable");
});

test("only this workspace's secrets reach its server child's environment", () => {
  assert.deepEqual(workspaceCredentialEnvironment(null), {});
  assert.deepEqual(workspaceCredentialEnvironment({}), {});
  const env = workspaceCredentialEnvironment({
    xaiApiKey: "xai-one",
    boxToken: "box-one",
    composioApiKey: "ak_workspace_one",
    // A field this build does not know must not become an environment variable.
    anthropicApiKey: "provider-key",
  });
  assert.deepEqual(env, {
    XAI_API_KEY: "xai-one",
    BOX_TOKEN: "box-one",
    COMPOSIO_API_KEY: "ak_workspace_one",
    COLONIE_COMPOSIO_CREDENTIAL_SOURCE: "workspace-vault",
    COLONIE_COMPOSIO_CREDENTIAL_ORIGIN: "local-workspace",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});
