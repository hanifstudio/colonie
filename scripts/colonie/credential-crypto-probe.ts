/** Isolated synthetic encryption roundtrip; never reads an existing credential. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { freePortBlock } from "../../server/testing/ports.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

const root = mkdtempSync(join(tmpdir(), "colonie-crypto-probe-"));
const data = join(root, "data"); mkdirSync(data);
writeFileSync(join(data, "config.json"), JSON.stringify({ language: "en", defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
  instances: { "codex-acp": { driver: "codex-acp", config: { cli: process.execPath, args: [resolve("server/devone/testing/fake-agent.ts")] }, environment: { DEVONE_FAKE_STATE: join(root, "fake.json") } } } }), { mode: 0o600 });
const port = await freePortBlock([0, 1]);
const systemKeychain = process.argv.includes("--system-keychain");
const freshCryptoName = process.argv.includes("--fresh-crypto-name");
const fixtureName = `Colonie Credential Fixture ${crypto.randomUUID()}`;
const env = { ...process.env, ...(!systemKeychain ? { HOME: root, USERPROFILE: root } : {}), OMB_DATA_DIR: data, COLONIE_USER_DATA: join(root, "profile"), OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_START_URL; delete env.COMPOSIO_API_KEY;
const app = await _electron.launch({ executablePath: resolve("release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie"), args: [], env, timeout: 30_000 });
try {
  const result = await app.evaluate(async ({ app, safeStorage }, { plaintext, fixtureName, systemKeychain, freshCryptoName }) => {
    // Crypto is initialized lazily; use an isolated fixture name before probing.
    if (freshCryptoName) app.setName(fixtureName);
    const result: Record<string, unknown> = { syntheticOnly: true, isolatedDataAndProfile: true, systemKeychain, freshCryptoName, cryptoName: app.getName() };
    result.asyncAvailable = await safeStorage.isAsyncEncryptionAvailable();
    try {
      const buffer = await safeStorage.encryptStringAsync(plaintext);
      const clear = await safeStorage.decryptStringAsync(buffer);
      result.asyncRoundtrip = clear.result === plaintext;
    } catch (error) { result.asyncRoundtrip = false; result.asyncError = (error as Error).message; }
    result.syncAvailable = safeStorage.isEncryptionAvailable();
    try {
      const buffer = safeStorage.encryptString(plaintext);
      result.syncRoundtrip = safeStorage.decryptString(buffer) === plaintext;
      try { result.asyncReadsSync = (await safeStorage.decryptStringAsync(buffer)).result === plaintext; }
      catch { result.asyncReadsSync = false; }
    } catch (error) { result.syncRoundtrip = false; result.syncError = (error as Error).message; }
    return result;
  }, { plaintext: `colonie_synthetic_${crypto.randomUUID()}`, fixtureName, systemKeychain, freshCryptoName });
  const evidence = resolve(".devone/evidence"); mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `credential-crypto-probe${systemKeychain ? freshCryptoName ? "-system-keychain-fresh-name" : "-system-keychain-existing-name" : ""}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  const child = app.process();
  let timer!: ReturnType<typeof setTimeout>;
  await Promise.race([app.close(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 8000); })]).finally(() => clearTimeout(timer));
  await waitForExit(child, { signal: "SIGTERM" }); rmSync(root, { recursive: true, force: true });
}
