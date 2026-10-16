import type { Page } from "playwright";
import type { AcpInputReceipt } from "../../shared/acp.ts";
import { openAppSettings } from "./profile-ui.ts";

type Call = (method: string, path: string, body?: unknown) => Promise<any>;
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(); }
  throw new Error(message);
}
export async function switchConversation(page: Page, threadId: string) {
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.locator(`[data-conversation-row="${threadId}"]`).click();
  // Existing switcher retains the menu briefly to support double-click rename.
  await page.getByRole("textbox", { name: "Search conversations", exact: true }).waitFor({ state: "hidden" });
}

/** One bot, two conversations. All execution/navigation actions use real UI. */
export async function parallelConversationUi(page: Page, call: Call, bot: { id: string; threadId: string; name: string }, capture?: (stage: string) => Promise<void>) {
  const a = bot.threadId;
  const current = async () => (await call("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
  const task = async (id: string) => (await current()).tasks.find((entry: any) => entry.threadId === id);
  const receipts = async (id: string): Promise<AcpInputReceipt[]> => (await call("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${id}`)).receipts;
  const nav = page.locator("[data-conversation-navigation]");
  if (await page.getByRole("button", { name: "Inspect ACP context", exact: true }).count()) throw new Error("Parallel UI started with a developer-only interface");
  await nav.getByRole("button", { name: "New conversation", exact: true }).click();
  await until(async () => (await current()).threadId !== a, "New conversation did not switch away from the original");
  const b = (await current()).threadId as string;
  // Fixture titles make selection/status assertions unambiguous, without AI title calls.
  await call("PATCH", `/api/bots/${bot.id}/tasks/${a}`, { title: "Website copy" });
  await call("PATCH", `/api/bots/${bot.id}/tasks/${b}`, { title: "Client email" });
  await until(async () => (await nav.innerText()).includes("Client email"), "Active conversation title was not shown");
  await page.getByRole("button", { name: `Expand ${bot.name} conversations`, exact: true }).click();
  await page.locator(`[data-sidebar-thread-row="${a}"]`).waitFor();
  await page.locator(`[data-sidebar-thread-row="${b}"]`).waitFor();
  if (await page.getByRole("button", { name: `New folder under ${bot.name}`, exact: true }).count()) throw new Error("Folder creation was exposed in the simple interface");
  await capture?.("default-navigation");
  const send = async (text: string) => {
    const composer = page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true });
    await composer.fill(text); await composer.press("Enter");
  };
  const settled = async (id: string, text: string) => until(async () => {
    const latest = (await receipts(id)).at(-1);
    return !((await task(id)).busy) && latest?.prompt.at(-1)?.type === "text" && (latest.prompt.at(-1) as { text: string }).text === text && latest.status !== "dispatching";
  }, `Conversation ${id} did not settle '${text}'`);
  await send("permission beta");
  await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  await switchConversation(page, a);
  await send("permission alpha");
  await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const rows = page.locator("[data-conversation-row]");
  await rows.filter({ hasText: "Website copy" }).getByText("Needs approval", { exact: false }).waitFor();
  await rows.filter({ hasText: "Client email" }).getByText("Needs approval", { exact: false }).waitFor();
  await capture?.("parallel-approvals");
  await page.keyboard.press("Escape");
  const firstA = (await receipts(a))[0]!;
  const firstB = (await receipts(b))[0]!;
  if (firstA.sessionId === firstB.sessionId) throw new Error("Conversations share a native session");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await settled(a, "permission alpha");
  if (!(await task(b)).busy) throw new Error("Approving one conversation completed the other");
  await switchConversation(page, b);
  await page.getByRole("button", { name: "Deny", exact: true }).click();
  await settled(b, "permission beta");
  await switchConversation(page, a);
  await send("hang");
  await until(async () => (await receipts(a)).at(-1)?.prompt.at(-1)?.type === "text" && (await receipts(a)).at(-1)?.status === "dispatching", "First hang did not dispatch");
  await switchConversation(page, b);
  await send("hang");
  await until(async () => (await receipts(b)).at(-1)?.status === "dispatching", "Second hang did not dispatch");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  if (!(await rows.filter({ hasText: "Website copy" }).innerText()).includes("Working") || !(await rows.filter({ hasText: "Client email" }).innerText()).includes("Working")) throw new Error("Parallel working status is missing");
  await capture?.("parallel-working");
  await page.keyboard.press("Escape");
  await switchConversation(page, a);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await settled(a, "hang");
  if (!(await task(b)).busy || (await receipts(b)).at(-1)?.status !== "dispatching") throw new Error("Stop leaked into the sibling conversation");
  await switchConversation(page, b);
  await page.getByRole("button", { name: /Stop/ }).first().click();
  await settled(b, "hang");
  await switchConversation(page, a); await send("alpha only"); await settled(a, "alpha only");
  await switchConversation(page, b); await send("beta only");
  await switchConversation(page, a); await settled(b, "beta only");
  await until(async () => Boolean((await task(b)).unread), "Background completion did not mark the sibling unread");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  if (!(await page.locator(`[data-conversation-row="${b}"]`).innerText()).includes("Unread")) throw new Error("Unread conversation status is not visible");
  await page.keyboard.press("Escape");
  const transcript = page.getByRole("log", { name: `Conversation with ${bot.name}`, exact: true });
  if ((await transcript.innerText()).includes("beta only")) throw new Error("Sibling transcript leaked into the active chat");
  const finalA = await receipts(a); const finalB = await receipts(b);
  if (finalA.at(-1)?.sessionId !== firstA.sessionId || finalB.at(-1)?.sessionId !== firstB.sessionId) throw new Error("Conversation changed native session during switching");
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  if (!(await page.locator(`[data-conversation-row="${b}"]`).innerText()).includes("beta only")) throw new Error("The conversation's preview is missing");
  await page.keyboard.press("Escape");
  const settings = await openAppSettings(page);
  await settings.locator('[data-settings-page="appearance"]').click();
  await settings.getByRole("switch", { name: "Show threads", exact: true }).click();
  await settings.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.locator(`[data-sidebar-thread-row="${a}"]`).waitFor({ state: "hidden" });
  await switchConversation(page, b); await switchConversation(page, a);
  // Narrow viewport hides the desktop sidebar; the switcher must stay in bounds.
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  const box = await page.getByRole("group", { name: "Conversation list", exact: true }).boundingBox();
  if (!box || box.x < 0 || box.x + box.width > 600) throw new Error("Conversation picker is clipped with the sidebar closed");
  await capture?.("narrow-conversations");
  await page.keyboard.press("Escape");
  await switchConversation(page, b); await switchConversation(page, a);
  await page.setViewportSize(viewport);
  return { a, b, sessionA: firstA.sessionId, sessionB: firstB.sessionId, beforeRestartA: finalA, beforeRestartB: finalB,
    approvalIsolation: true, stopIsolation: true, parallelWorking: true, unreadStatus: true, defaultNavigation: true,
    simpleSidebarList: true, hiddenTreeNavigation: true, narrowNavigation: true };
}

export async function resumedConversationUi(page: Page, call: Call, bot: { id: string; name: string }, result: Awaited<ReturnType<typeof parallelConversationUi>>) {
  await switchConversation(page, result.b);
  const composer = page.getByRole("textbox", { name: `Message ${bot.name}`, exact: true });
  await composer.fill("beta after app restart"); await composer.press("Enter");
  await until(async () => {
    const current = (await call("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id);
    const receipts = (await call("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${result.b}`)).receipts as AcpInputReceipt[];
    return !current.tasks.find((task: any) => task.threadId === result.b)?.busy && receipts.length === result.beforeRestartB.length + 1 && receipts.at(-1)?.status === "completed";
  }, "Sibling conversation did not resume after app restart");
  const finalB = (await call("GET", `/api/bots/${bot.id}/acp-inputs?threadId=${result.b}`)).receipts as AcpInputReceipt[];
  if (finalB.at(-1)?.sessionId !== result.sessionB || finalB.at(-1)?.context?.snapshotHash !== result.beforeRestartB[0]?.context?.snapshotHash) throw new Error("Sibling native session/profile did not survive restart");
  const transcript = await page.getByRole("log", { name: `Conversation with ${bot.name}`, exact: true }).innerText();
  if (transcript.includes("alpha only") || !transcript.includes("beta only")) throw new Error("Restart/switch displayed the wrong transcript");
  await switchConversation(page, result.a);
  return finalB;
}
