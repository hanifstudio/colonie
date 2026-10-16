import { test } from "node:test";
import assert from "node:assert/strict";
import { createCredentialPersistence, migrateComposioCredential } from "./credential-persistence.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";

test("failed Composio migration does not publish an unpersisted in-memory key or remove config", async () => {
  const config = { composio: { apiKey: "ak_synthetic_new_1234" } };
  const credentials = { otherKey: "synthetic" };
  await assert.rejects(migrateComposioCredential(config, credentials, async () => { throw new Error("Encryption unavailable"); }), /Encryption/);
  assert.deepEqual(credentials, { otherKey: "synthetic" });
  assert.equal(config.composio.apiKey, "ak_synthetic_new_1234");
  const migrated = await migrateComposioCredential(config, { composioApiKey: "ak_synthetic_old_5678" }, async () => {});
  assert.equal(migrated.credentials.composioApiKey, "ak_synthetic_new_1234");
  assert.equal(migrated.config.composio.apiKey, "");
});

test("last-key removal needs no encryption and a rejected server commit restores encrypted bytes", async () => {
  const original = Buffer.from("original-encrypted-document");
  let encrypted = original; let encryptCalls = 0;
  const persist = createCredentialPersistence({ writable: () => true, readEncrypted: () => encrypted,
    remove: () => { encrypted = null; }, isAvailable: async () => false,
    encrypt: async () => { encryptCalls++; throw new Error("Unavailable"); }, writeEncrypted: (value) => { encrypted = value; } });
  const state = createSecureCredentialState({ composioApiKey: "synthetic" }, persist);
  await assert.rejects(state.update(() => ({}), async () => { throw new Error("Server rejected removal"); }), /Server rejected/);
  assert.equal(encrypted, original); assert.equal(encryptCalls, 0);
  assert.deepEqual(state.read(), { composioApiKey: "synthetic" });
  await state.update(() => ({}));
  assert.equal(encrypted, null); assert.equal(encryptCalls, 0); assert.deepEqual(state.read(), {});
});

test("cannot erase an unreadable store or lose other keys when encryption fails", async () => {
  const original = Buffer.from("original-encrypted-document");
  let encrypted = original; let writable = false;
  const persist = createCredentialPersistence({ writable: () => writable, readEncrypted: () => encrypted,
    remove: () => { encrypted = null; }, isAvailable: async () => false,
    encrypt: async () => { throw new Error("Unavailable"); }, writeEncrypted: (value) => { encrypted = value; } });
  await assert.rejects(persist({}), /could not be read/); assert.equal(encrypted, original);
  writable = true;
  const state = createSecureCredentialState({ composioApiKey: "synthetic", otherKey: "keep" }, persist);
  await assert.rejects(state.update(() => ({ otherKey: "keep" })), /unavailable/);
  assert.equal(encrypted, original); assert.deepEqual(state.read(), { composioApiKey: "synthetic", otherKey: "keep" });
});
