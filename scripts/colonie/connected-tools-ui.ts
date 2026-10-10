import type { Page } from "playwright";
import { resolve } from "node:path";

/** Ordinary app settings and bot profile; no developer inspector is involved. */
export async function configureConnectedToolsUi(page: Page, options: { agentName: string; fakeKey?: string; includeLocal: boolean; capture(stage: string): Promise<void> }) {
  // The Composio project key lives in Settings; the app catalog and Custom MCP
  // live in the Apps panel the puzzle opens.
  await page.getByRole("button", { name: "You", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const connectionsSection = settings.locator('[data-settings-section="connections"]');
if (await connectionsSection.count()) await connectionsSection.click();
  else await settings.locator('[data-settings-page="ai"]').click();
  const composio = settings.getByRole("region", { name: "Composio project key", exact: true });
  if (options.fakeKey) {
    await composio.getByLabel("Composio project key", { exact: true }).fill(options.fakeKey);
    await composio.getByRole("button", { name: "Save key", exact: true }).click();
    await composio.getByTestId("composio-masked-key").waitFor({ timeout: 60_000 });
  }
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  const apps = page.getByRole("dialog", { name: "Apps", exact: true });
  const search = apps.getByRole("textbox", { name: "Search apps", exact: true }).first();
  await search.waitFor({ timeout: 60_000 });
  await search.fill("hacker");
  await apps.getByText(/Hacker\s*News/i, { exact: true }).waitFor({ timeout: 60_000 });
  if (options.includeLocal) {
    const custom = apps.getByRole("region", { name: "Your MCP servers", exact: true });
    await custom.getByRole("button", { name: "Paste config", exact: true }).click();
    await custom.getByRole("textbox", { name: "Paste config", exact: true }).fill(JSON.stringify({ mcpServers: { custom_local: { command: process.execPath, args: [resolve("server/colonie/connections/testing/stdio-tool.ts")], env: { CUSTOM_FIXTURE_VALUE: "synthetic" } } } }));
    await custom.getByRole("button", { name: "Add servers", exact: true }).click();
    const row = custom.locator("div.rounded-2xl").filter({ has: page.locator("[data-mcp-row]") }).filter({ hasText: "custom_local" }).last();
    await row.getByRole("button", { name: "Test", exact: true }).click();
    await row.getByText(/Connected.*read_fixture/).waitFor();
    await row.getByRole("switch").click();
  }
  await options.capture("connections-settings");
  await apps.getByRole("button", { name: "Close plugins", exact: true }).click();
  await page.getByRole("button", { name: `Open ${options.agentName}'s profile`, exact: true }).click();
  const profile = page.locator("aside[role=dialog]");
  const access = profile.getByRole("region", { name: "Bot connected tools", exact: true });
  await access.getByRole("textbox", { name: "Find apps for this bot", exact: true }).fill("hacker");
  await access.getByRole("checkbox", { name: /Hacker\s*News/i }).check({ timeout: 60_000 });
  if (options.includeLocal) await access.getByRole("checkbox", { name: "custom_local", exact: true }).check();
  await access.getByRole("button", { name: "Save tool access", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector('section[aria-label="Bot connected tools"] fieldset') as HTMLFieldSetElement | null)?.disabled);
  await options.capture("bot-tool-access");
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
}

export async function connectedToolPermissionUi(page: Page, options: { agentName: string; server: string; tool: string; behavior: "allow" | "deny"; wait(text: string): Promise<unknown> }) {
  const text = `mcp call ${options.server} ${options.tool} {}`;
  const composer = page.getByRole("textbox", { name: `Message ${options.agentName}`, exact: true });
  await composer.fill(text); await composer.press("Enter");
  await page.getByRole("button", { name: options.behavior === "allow" ? "Allow once" : "Deny", exact: true }).click({ timeout: 30_000 });
  await options.wait(text);
}
