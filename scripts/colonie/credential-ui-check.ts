/** Targeted credential UI check: synthetic key, loopback Composio, no model turns. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { launchVerificationServer } from "../control-omb.ts";
import { mountPreview } from "../testing/preview-fixture.ts";
import { fakeComposio } from "../../server/colonie/connections/testing/fake-composio.ts";

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".devone/browsers");
const { chromium } = await import("playwright");
const evidence = resolve(".devone/evidence"); mkdirSync(evidence, { recursive: true });
const service = await fakeComposio();
const browser = await chromium.launch({ headless: true });
const result: Record<string, unknown> = { simulatedComposio: true, realProviderRequests: 0, modelTurns: 0 };
try {
  for (const external of [false, true]) {
    const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, undefined, ["devone"], undefined, service.origin, external);
    const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__credential.html", title: "Colonie credential UI verification", logLevel: "warn" });
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
      return { status: response.status, value: await response.json() as any };
    };
    try {
      await page.goto(preview.previewUrl);
      await page.getByRole("button", { name: "Connected tools", exact: true }).click();
      const region = page.getByRole("region", { name: "Composio connections", exact: true });
      const panel = region.locator("[data-composio-credential]");
      if (external) {
        await panel.getByText("Provided by the runtime environment", { exact: true }).waitFor();
        if (await panel.getByRole("button", { name: "Remove key", exact: true }).count()) throw new Error("External key incorrectly exposes removal");
        if ((await api("PUT", "/api/config", { composio: { apiKey: "" } })).status !== 409) throw new Error("The backend allowed removal of an external key");
        await page.screenshot({ path: join(evidence, "credential-ui-environment.png"), animations: "disabled" });
        result.externalKey = { sourceVisible: true, removalHiddenAndBlocked: true };
      } else {
        await panel.getByText("Not set up", { exact: true }).waitFor();
        if (await region.getByRole("textbox", { name: "Search Composio apps", exact: true }).count()) throw new Error("App catalog is visible without a key");
        await page.screenshot({ path: join(evidence, "credential-ui-not-set-up.png"), animations: "disabled" });
        await panel.getByLabel("Composio project key", { exact: true }).fill(service.key);
        await panel.getByRole("button", { name: "Save key", exact: true }).click();
        await panel.getByText("From existing workspace settings", { exact: true }).waitFor();
        const masked = await panel.getByTestId("composio-masked-key").innerText();
        if (masked === service.key || !masked.endsWith("only")) throw new Error("Stored key identity is not safely masked");
        await region.getByRole("textbox", { name: "Search Composio apps", exact: true }).waitFor();
        await page.evaluate(() => { (window as any).ogb = { setCredential: async () => { throw new Error("Error invoking remote method 'credential:set': Error: Error while encrypting the text provided to safeStorage.encryptStringAsync."); } }; });
        await panel.getByRole("button", { name: "Remove key", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "could not be removed" }).waitFor();
        if (await panel.getByTestId("composio-masked-key").innerText() !== masked) throw new Error("Failed removal changed the key state");
        await page.screenshot({ path: join(evidence, "credential-ui-failed-remove.png"), animations: "disabled" });
        await page.evaluate(() => { (window as any).ogb.setCredential = async () => { throw new Error("Error invoking remote method 'credential:set': Error: Composio rejected this key (HTTP 401)"); }; });
        await panel.getByRole("button", { name: "Replace key", exact: true }).click();
        await panel.getByLabel("Composio project key", { exact: true }).fill("ak_synthetic_rejected_5678");
        await panel.getByRole("button", { name: "Save key", exact: true }).click();
        await panel.getByRole("alert").filter({ hasText: "HTTP 401" }).waitFor();
        if ((await panel.getByRole("alert").innerText()).includes("macOS")) throw new Error("A rejected key was mislabeled as a Keychain failure");
        await panel.getByRole("button", { name: "Cancel", exact: true }).click();
        await page.evaluate(() => { delete (window as any).ogb; });
        await panel.getByRole("button", { name: "Remove key", exact: true }).click();
        await panel.getByText("Not set up", { exact: true }).waitFor();
        if (await region.getByRole("textbox", { name: "Search Composio apps", exact: true }).count()) throw new Error("Successful removal left the catalog visible");
        result.savedKey = { maskedIdentity: true, sourceVisible: true, failedRemovalPreservesState: true, rejectedKeyReasonPreserved: true, successfulRemovalHidesCatalog: true };
      }
      const status = (await api("GET", "/api/colonie/composio/credential")).value;
      if (JSON.stringify(status).includes(service.key)) throw new Error("Metadata returned a full key");
    } finally { await page.close(); await preview.close(); await fixture.close(); }
  }
  result.ok = true;
} catch (error) { result.ok = false; result.error = (error as Error).message; process.exitCode = 1; }
finally {
  await browser.close(); await service.close();
  writeFileSync(join(evidence, "credential-ui-check.json"), JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result));
