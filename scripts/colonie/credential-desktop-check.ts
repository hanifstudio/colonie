/** Targeted packaged save/restart/remove with a synthetic key; zero model turns. */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ElectronApplication, Page } from "playwright";
import { _electron } from "playwright";
import { fakeComposio } from "../../server/colonie/connections/testing/fake-composio.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";

const root = mkdtempSync(join(tmpdir(), "colonie-credential-desktop-"));
const data = join(root, "data"); const profile = join(root, "profile"); mkdirSync(data);
const service = await fakeComposio();
const migration = process.argv.includes("--migration");
const port = await freePortBlock([0, 1]);
writeFileSync(join(data, "config.json"), JSON.stringify({ language: "en", onboarding: { completedAt: new Date().toISOString(), version: 1, hintsSeen: ["tour.composer", "tour.model", "tour.computer", "tour.computer-browser", "tour.tools", "tour.apps", "tour.apps-panel", "tour.automations", "tour.automations-page", "tour.done"] },
  defaultModelSelection: { instanceId: "codex-acp", model: "agent-default" },
  ...(migration ? { composio: { apiKey: service.key } } : {}),
  instances: { "codex-acp": { driver: "codex-acp", config: { cli: process.execPath, args: [resolve("server/devone/testing/fake-agent.ts")] }, environment: { DEVONE_FAKE_STATE: join(root, "fake.json") } } } }), { mode: 0o600 });
// HOME is inherited solely for the OS Keychain; all app credentials/data are new fixture files.
const env = { ...process.env, OMB_DATA_DIR: data, COLONIE_USER_DATA: profile, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
  OMB_COMPOSIO_API: `${service.origin}/api/v3.1`, OMB_COMPOSIO_TOOLKITS_API: `${service.origin}/api/v3` };
  delete env.COMPOSIO_API_KEY; delete env.COLONIE_COMPOSIO_CREDENTIAL_SOURCE; delete env.COLONIE_COMPOSIO_CREDENTIAL_ORIGIN; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_START_URL;
delete env.OMB_COMPOSIO_BROKER_URL; delete env.OMB_COMPOSIO_BROKER_TOKEN;
const evidence = resolve(".devone/evidence"); mkdirSync(evidence, { recursive: true });
const result: Record<string, unknown> = { syntheticOnly: true, isolatedDataAndProfile: true, setup: migration ? "existing workspace key migration" : "normal user key entry", keychainHome: "inherited OS context", realProviderRequests: 0, modelTurns: 0 };
let app: ElectronApplication | undefined; let page: Page | undefined;
async function close() {
  if (!app) return;
  const child = app.process(); let timer!: ReturnType<typeof setTimeout>;
  try { await Promise.race([app.close(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 8000); })]); }
  finally { clearTimeout(timer); await waitForExit(child, { signal: "SIGTERM" }); app = undefined; }
}
async function launch() {
  app = await _electron.launch({ executablePath: resolve("release/colonie/mac-arm64/Colonie.app/Contents/MacOS/Colonie"), args: [], env, timeout: 30_000 });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    page = app.windows().find((window) => /^http:\/\/127\.0\.0\.1:\d+\//.test(window.url()));
    if (page) break; await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) throw new Error("The isolated packaged renderer did not open");
  await page.getByRole("button", { name: "Connected tools", exact: true }).click();
  return page.getByRole("region", { name: "Composio connections", exact: true });
}
async function fixtureCredentialNames(file: string): Promise<string[]> {
  if (!existsSync(file)) return [];
  return app!.evaluate(async ({ safeStorage }, bytes) => {
    // Only this fixture's newly generated document; return field names, never values.
    const clear = await safeStorage.decryptStringAsync(Buffer.from(bytes));
    return Object.keys(JSON.parse(clear.result));
  }, [...readFileSync(file)]);
}
try {
  let region = await launch();
  let panel = region.locator("[data-composio-credential]");
  if (!migration) {
    await panel.getByText("Not set up", { exact: true }).waitFor();
    if (await region.getByRole("textbox", { name: "Search Composio apps", exact: true }).count()) throw new Error("Catalog visible without a key");
    await panel.getByLabel("Composio project key", { exact: true }).fill(service.key);
    await panel.getByRole("button", { name: "Save key", exact: true }).click();
  }
  await panel.getByText("Saved on this device", { exact: true }).waitFor({ timeout: 20_000 });
  await panel.getByText(migration ? "Imported from existing workspace settings" : "Entered in the app", { exact: true }).waitFor();
  const encryptedPath = join(profile, "credentials.bin");
  if (!existsSync(encryptedPath) || readFileSync(encryptedPath).includes(Buffer.from(service.key))) throw new Error("Key was not persisted as an encrypted document");
  if (readFileSync(join(data, "config.json"), "utf8").includes(service.key)) throw new Error("Desktop key leaked into plaintext config");
  result.encryptedSave = true;
  await page!.screenshot({ path: join(evidence, "credential-desktop-saved.png"), animations: "disabled" });
  await close(); page = undefined;
  region = await launch(); panel = region.locator("[data-composio-credential]");
  await panel.getByText("Saved on this device", { exact: true }).waitFor({ timeout: 20_000 });
  await panel.getByText(migration ? "Imported from existing workspace settings" : "Entered in the app", { exact: true }).waitFor();
  if (!(await panel.getByTestId("composio-masked-key").innerText()).endsWith("only")) throw new Error("Restart did not retain masked credential identity");
  result.persistedAfterFullRestart = true;
  const beforeRemoval = await fixtureCredentialNames(encryptedPath);
  await panel.getByRole("button", { name: "Remove key", exact: true }).click();
  await panel.getByText("Not set up", { exact: true }).waitFor();
  const remaining = await fixtureCredentialNames(encryptedPath);
  if (remaining.includes("composioApiKey")) throw new Error("Removal left the Composio key in encrypted storage");
  if (beforeRemoval.filter((name) => !["composioApiKey", "composioCredentialOrigin"].includes(name)).some((name) => !remaining.includes(name))) throw new Error("Removal discarded unrelated credential fields");
  if (!remaining.length && existsSync(encryptedPath)) throw new Error("An empty credential document was not removed");
  if (await region.getByRole("textbox", { name: "Search Composio apps", exact: true }).count()) throw new Error("Removal left the app catalog visible");
  result.composioKeyRemoved = true; result.otherCredentialFieldsPreserved = true; result.remainingFieldNames = remaining;
  await page!.screenshot({ path: join(evidence, "credential-desktop-removed.png"), animations: "disabled" });
  await close(); page = undefined;
  region = await launch();
  await region.locator("[data-composio-credential]").getByText("Not set up", { exact: true }).waitFor();
  result.removalSurvivedRestart = true; result.ok = true;
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  if (page) {
    result.body = await page.locator("body").innerText().catch(() => "unavailable");
    await page.screenshot({ path: join(evidence, "credential-desktop-failure.png") }).catch(() => {});
  }
} finally {
  await close(); await service.close(); rmSync(root, { recursive: true, force: true });
  writeFileSync(join(evidence, `credential-desktop${migration ? "-migration" : ""}-check.json`), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
