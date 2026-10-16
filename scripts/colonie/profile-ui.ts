import type { Page } from "playwright";

/** Shared recipe: ordinary profile edits without opening the developer inspector. */
export async function editProfileThroughUi(page: Page, agentName: string) {
  if (await page.getByRole("button", { name: "Inspect ACP context", exact: true }).count()) throw new Error("Developer inspector is visible by default");
  await page.getByRole("button", { name: `Open ${agentName}'s profile`, exact: true }).click();
  const profile = page.locator("aside[role=dialog]");
  await profile.getByRole("textbox", { name: "Job", exact: true }).fill("Context verifier");
  await profile.getByRole("textbox", { name: "About this bot", exact: true }).fill("Verify default personalization in this disposable workspace.");
  await profile.getByRole("textbox", { name: "Instructions", exact: true }).fill("Your standing verification label is CONTEXT_SOUL_471. When asked for it, use that label.");
  if (await profile.getByText(/ACP|SHA-256|SOUL\.md/).count()) throw new Error("Technical context details leaked into the simple profile");
  await profile.getByRole("button", { name: "Close settings", exact: true }).click();
}

export async function openAppSettings(page: Page) {
  await page.keyboard.press("Escape");
  const direct = page.getByRole("button", { name: "App settings", exact: true });
  if (await direct.count()) await direct.click();
  else {
    await page.getByRole("button", { name: "You", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  }
  return page.getByRole("dialog", { name: "Settings", exact: true });
}

export async function editSharedInstructionsThroughUi(page: Page, text: string) {
  const settings = await openAppSettings(page);
  await settings.getByRole("textbox", { name: "Instructions for all bots", exact: true }).fill(text);
  await settings.getByRole("button", { name: "Save shared instructions", exact: true }).click();
  await settings.getByRole("status").filter({ hasText: "Saved for new conversations." }).waitFor();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
}

/** The developer deliberately opts in via real Settings; no feature activation. */
export async function enableDeveloperInspector(page: Page) {
  const settings = await openAppSettings(page);
  await settings.locator('[data-settings-page="general"], [data-settings-section="general"]').click();
  const advanced = settings.getByRole("switch", { name: "Advanced mode", exact: true });
  if (await advanced.getAttribute("aria-checked") !== "true") await advanced.click();
  const tools = settings.getByRole("switch", { name: "Developer tools", exact: true });
  if (await tools.getAttribute("aria-checked") !== "true") await tools.click();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.getByRole("button", { name: "Inspect ACP context", exact: true }).waitFor();
}
