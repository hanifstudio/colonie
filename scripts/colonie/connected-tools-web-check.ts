import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchVerificationServer } from "../control-colonie.ts";
import { mountPreview } from "../testing/preview-fixture.ts";
import { fakeComposio } from "../../server/colonie/connections/testing/fake-composio.ts";
import { configureConnectedToolsUi, connectedToolPermissionUi } from "./connected-tools-ui.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".colonie-dev/browsers");
const { chromium } = await import("playwright");
const service = await fakeComposio();
const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["colonie"], undefined, service.origin);
const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__connected-tools.html", title: "Colonie connected tools verification", logLevel: "warn" });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const evidence = resolve(".colonie-dev/evidence"); mkdirSync(evidence, { recursive: true });
const result: Record<string, unknown> = { fixture: fixture.info, simulatedComposio: true, renderer: true, credentialStorage: "Existing private server config path (web)" };
const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const value = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(value)}`); return value as any;
};
try {
  const bot = (await api("GET", "/api/bots")).bots[0];
  await api("PATCH", `/api/bots/${bot.id}`, { name: "Claude", modelSelection: { instanceId: "claude-acp", model: "agent-default" }, computer: "off" });
  await page.goto(preview.previewUrl);
  await page.getByRole("textbox", { name: "Message Claude", exact: true }).waitFor();
  await configureConnectedToolsUi(page, { agentName: "Claude", fakeKey: service.key, includeLocal: true, capture: async (stage) => { await page.screenshot({ path: join(evidence, `connected-tools-web-${stage}.png`), animations: "disabled" }); } });
  const wait = async (text: string) => {
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
      const receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
      const current = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
      if (!current.busy && receipts.at(-1)?.prompt.at(-1)?.text === text && receipts.at(-1).status === "completed") return receipts;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Connected tool turn did not complete");
  };
  await connectedToolPermissionUi(page, { agentName: "Claude", server: "colonie_composio", tool: "HACKERNEWS_READ", behavior: "allow", wait });
  if (service.calls.length !== 1) throw new Error("The normal UI did not execute the Composio fixture tool");
  const publicConfig = await api("GET", "/api/config");
  if (JSON.stringify(publicConfig).includes(service.key)) throw new Error("Credential was returned by public config");
  result.receipts = (await api("GET", `/api/bots/${bot.id}/acp-inputs`)).receipts;
  result.credentialsWriteOnly = true; result.toolAccessSavedThroughUi = true; result.ok = !errors.length;
  await page.screenshot({ path: join(evidence, "connected-tools-web-chat.png"), animations: "disabled" });
} catch (error) {
  result.ok = false; result.error = (error as Error).message; process.exitCode = 1;
  result.body = await page.locator("body").innerText().catch(() => "unavailable");
  await page.screenshot({ path: join(evidence, "connected-tools-web-failure.png") }).catch(() => {});
} finally {
  result.errors = errors; writeFileSync(join(evidence, "connected-tools-web-check.json"), JSON.stringify(result, null, 2));
  await browser.close(); await preview.close(); await fixture.close(); await service.close();
}
console.log(JSON.stringify({ ok: result.ok, error: result.error, evidence: join(evidence, "connected-tools-web-check.json") }));
