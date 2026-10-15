// Renderer journeys for the platform shell, driven end to end against a fake
// client: sign up -> choose Cloud -> create a bot -> chat; private human DM
// selection; invitation continuation through auth; Local creation through the
// native bridge; and a send failure that keeps the typed message.
//
// happy-dom is bootstrapped inside this node-environment file rather than via
// `@vitest-environment`, because the shared setup imports `server/message-db.ts`
// (`node:sqlite`), which a client environment cannot bundle. Import order is
// load-bearing: the DOM globals must exist before React DOM is imported.
import { Window } from "happy-dom";

const testWindow = new Window({ url: "https://app.test/" });
const globals = globalThis as unknown as Record<string, unknown>;
const setGlobal = (key: string, value: unknown) => {
  if (value === undefined) return;
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
};
setGlobal("window", testWindow);
setGlobal("document", testWindow.document);
setGlobal("navigator", testWindow.navigator);
setGlobal("location", testWindow.location);
setGlobal("history", testWindow.history);
setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
for (const key of [
  "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent",
  "CustomEvent", "KeyboardEvent", "PointerEvent", "SVGElement", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver",
]) {
  setGlobal(key, (testWindow as unknown as Record<string, unknown>)[key] ?? globals[key]);
}

import { act, createElement, type ReactNode } from "react";
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Animation and layout need a real browser; the Playwright fixture exercises
// them. Keep these DOM tests focused on account/conversation behavior.
vi.mock("@/components/BloubAvatar", async (original) => ({ ...await original<object>(), BloubAvatar: () => null }));
import { PlatformApp } from "./PlatformApp";
import { WorkspaceShell } from "./WorkspaceShell";

import { forgetLinkState, localWorkspaceBridge, rememberLinkState, takeLinkState } from "@/lib/colonie-platform";
import {
  PlatformApiError,
  type LocalWorkspaceSummary, type PlatformBot, type PlatformClient,
  type PlatformComposioStatus, type PlatformConnectionLink, type PlatformConversation, type PlatformInvitation,
  type PlatformMember, type PlatformMessage, type PlatformWorkspace,
} from "@/lib/colonie-platform";

// ── fake client ────────────────────────────────────────────────────────────

interface FakeOptions {
  session?: { user: PlatformAccount } | null;
  workspaces?: PlatformWorkspace[];
  members?: PlatformMember[];
  bots?: PlatformBot[];
  conversations?: PlatformConversation[];
  conversationsById?: Record<string, PlatformMessage[]>;
  failSend?: boolean;
  composio?: Partial<PlatformComposioStatus>;
  links?: PlatformConnectionLink[];
  /** Reject setComposioKey with this Composio error code. */
  rejectKeyWith?: string;
}

type PlatformAccount = { id: string; email: string; name: string };

const ACCOUNT: PlatformAccount = { id: "acc-me", email: "me@example.com", name: "Me Person" };
const SELF: PlatformMember = { accountId: "acc-me", role: "owner", displayName: "Me Person", email: "me@example.com", principalId: "p-me", joinedAt: "" };
const OTHER: PlatformMember = { accountId: "acc-sam", role: "member", displayName: "Sam Rivers", email: "sam@example.com", principalId: "p-sam", joinedAt: "" };
const KIM: PlatformMember = { accountId: "acc-kim", role: "member", displayName: "Kim Lee", email: "kim@example.com", principalId: "p-kim", joinedAt: "" };
const BOT: PlatformBot = { id: "bot-atlas", workspaceId: "w1", principalId: "p-atlas", name: "Atlas", purpose: "Drafting", createdAt: "" };

function workspace(overrides: Partial<PlatformWorkspace> = {}): PlatformWorkspace {
  return { id: "w1", name: "My Team", kind: "cloud", ownerAccountId: "acc-me", myRole: "owner", createdAt: "", ...overrides };
}

function humanDm(): PlatformConversation {
  return {
    id: "c-human", workspaceId: "w1", kind: "dm", createdByPrincipalId: "p-me", createdAt: "",
    participants: [
      { principalId: "p-me", kind: "human", displayName: "Me Person", accountId: "acc-me" },
      { principalId: "p-sam", kind: "human", displayName: "Sam Rivers", accountId: "acc-sam" },
    ],
    lastReadSequence: 0, lastSequence: 0, unreadCount: 0,
  };
}

function linkFixture(overrides: Partial<PlatformConnectionLink> = {}): PlatformConnectionLink {
  return {
    id: "link-1", workspaceId: "w1", audience: "personal", toolkit: "gmail", status: "pending",
    userId: "svc-1", ownedByMe: true, createdAt: "", updatedAt: "", ...overrides,
  };
}

function botDmConversation(): PlatformConversation {
  return {
    id: "c-bot", workspaceId: "w1", kind: "dm", createdByPrincipalId: "p-me", createdAt: "",
    participants: [
      { principalId: "p-me", kind: "human", displayName: "Me Person", accountId: "acc-me" },
      { principalId: "p-atlas", kind: "bot", displayName: "Atlas", botId: "bot-atlas" },
    ],
    lastReadSequence: 0, lastSequence: 0, unreadCount: 0,
  };
}

function messageFixture(id: string, body: string, sequence: number, overrides: Partial<PlatformMessage> = {}): PlatformMessage {
  return {
    id, workspaceId: "w1", conversationId: "c-bot", senderPrincipalId: "p-atlas", senderKind: "bot",
    senderName: "Atlas", sequence, body, createdAt: new Date(0).toISOString(), ...overrides,
  };
}

function groupConversation(): PlatformConversation {
  return {
    id: "c-group", workspaceId: "w1", kind: "group", title: "Team Sync", createdByPrincipalId: "p-me", createdAt: "",
    participants: [
      { principalId: "p-me", kind: "human", displayName: "Me Person", accountId: "acc-me" },
      { principalId: "p-sam", kind: "human", displayName: "Sam Rivers", accountId: "acc-sam" },
    ],
    lastReadSequence: 0, lastSequence: 0, unreadCount: 0,
  };
}

function makeFake(options: FakeOptions = {}) {
  const workspaces = options.workspaces ?? [];
  const members = options.members ?? [SELF];
  const bots = options.bots ?? [];
  const conversations = options.conversations ?? [];
  const messages: Record<string, PlatformMessage[]> = options.conversationsById ?? {};
  /** Test controls for the reload path (a gate and an injected failure). */
  const control = { getConversationError: null as unknown, gateFor: null as string | null, gate: null as Promise<void> | null, gateSendFor: null as string | null, gateSend: null as Promise<void> | null, listMessagesError: null as unknown };
  /** Earlier pages, keyed by conversation id. */
  const earlierPages: Record<string, PlatformMessage[]> = {};
  /** Mutable Composio status, so provisioning is observable. */
  const composioState: Partial<PlatformComposioStatus> = { ...options.composio };
  const subscribers: Array<(event: { type: string }, sequence: number) => void> = [];
  const calls = {
    signUp: [] as unknown[], signIn: [] as unknown[], acceptInvitation: [] as string[],
    createWorkspace: [] as unknown[], openDm: [] as unknown[], createBot: [] as unknown[], sendMessage: [] as unknown[],
    recoverAccount: [] as unknown[], addGroupMember: [] as unknown[], removeGroupMember: [] as unknown[],
    setComposioKey: [] as string[], connectApp: [] as unknown[], completeAppConnection: [] as unknown[],
    provisionComposio: [] as string[], listMessages: [] as unknown[],
  };

  function find(id: string): PlatformConversation {
    return conversations.find((c) => c.id === id) ?? humanDm();
  }

  const client = {
    origin: "",
    session: async () => options.session ?? null,
    signUp: async (input: unknown) => { calls.signUp.push(input); return { user: ACCOUNT }; },
    signIn: async (input: unknown) => { calls.signIn.push(input); return { user: ACCOUNT }; },
    signOut: async () => {},
    recoverAccount: async (input: unknown) => { calls.recoverAccount.push(input); },
    createRecoveryKey: async () => ({ recoveryKey: "RKEY-LIVE-1", createdAt: new Date(0).toISOString() }),
    addConversationMember: async (id: string, principalId: string) => {
      calls.addGroupMember.push({ id, principalId });
      const target = find(id);
      const human = members.find((m) => m.principalId === principalId);
      const bot = bots.find((b) => b.principalId === principalId);
      const displayName = human?.displayName ?? bot?.name ?? principalId;
      target.participants = [...target.participants, { principalId, kind: bot ? "bot" as const : "human" as const, displayName, accountId: human?.accountId, botId: bot?.id }];
    },
    removeConversationMember: async (id: string, principalId: string) => {
      calls.removeGroupMember.push({ id, principalId });
      const target = find(id);
      target.participants = target.participants.filter((p) => p.principalId !== principalId);
    },
    listWorkspaces: async () => workspaces,
    acceptInvitation: async (token: string) => {
      calls.acceptInvitation.push(token);
      const joined = workspace({ id: "w-joined", name: "Invited Team", myRole: "member" });
      workspaces.push(joined);
      return { workspace: joined, role: "member" as const };
    },
    createWorkspace: async (input: unknown) => { calls.createWorkspace.push(input); const created = workspace(); workspaces.push(created); return created; },
    getWorkspace: async (id: string) => ({ workspace: workspaces.find((w) => w.id === id) ?? workspaces[0] ?? workspace(), members, bots }),
    listConversations: async () => conversations,
    listInvitations: async (): Promise<PlatformInvitation[]> => [],
    listConnections: async () => [],
    getConversation: async (id: string) => {
      if (control.getConversationError) throw control.getConversationError;
      if (control.gateFor === id && control.gate) await control.gate;
      return { conversation: { ...find(id) }, messages: messages[id] ?? [] };
    },
    listMessages: async (id: string, opts: { after?: number; limit?: number } = {}) => {
      calls.listMessages.push({ id, after: opts.after, limit: opts.limit });
      if (control.listMessagesError) throw control.listMessagesError;
      return earlierPages[id] ?? [];
    },
    markRead: async (id: string, sequence: number) => ({ ...find(id), lastReadSequence: sequence, unreadCount: 0 }),
    sendMessage: async (id: string, body: string) => {
      if (options.failSend) throw new Error("The network dropped your message.");
      calls.sendMessage.push({ id, body });
      if (control.gateSendFor === id && control.gateSend) await control.gateSend;
      const sent: PlatformMessage = { id: `m${(messages[id]?.length ?? 0) + 1}`, workspaceId: "w1", conversationId: id, senderPrincipalId: "p-me", senderKind: "human", senderName: "Me Person", sequence: (messages[id]?.length ?? 0) + 1, body, createdAt: new Date(0).toISOString() };
      messages[id] = [...(messages[id] ?? []), sent];
      return sent;
    },
    stopTurns: async () => ({ stopped: 1 }),
    // ── Composio apps ──
    composioStatus: async (): Promise<PlatformComposioStatus> => ({
      configured: true, keyStatus: "active", serviceUserId: "svc-1", canProvision: false,
      ...composioState,
    }),
    setComposioKey: async (_id: string, apiKey: string) => {
      calls.setComposioKey.push(apiKey);
      if (options.rejectKeyWith) throw new PlatformApiError("rejected", 422, options.rejectKeyWith);
      return { configured: true, keyStatus: "active" as const, maskedHint: "ak_…1234", serviceUserId: "svc-1", canProvision: false };
    },
    removeComposioKey: async () => {},
    provisionComposio: async (id: string) => {
      calls.provisionComposio.push(id);
      Object.assign(composioState, { configured: true, keyStatus: "active" as const, maskedHint: "ak_…1234", canProvision: true });
      return { configured: true, keyStatus: "active" as const, serviceUserId: "svc-1", canProvision: true };
    },
    listConnectionLinks: async (): Promise<PlatformConnectionLink[]> => options.links ?? [],
    connectApp: async (_id: string, input: { toolkit: string; audience?: "personal" | "shared" }) => {
      calls.connectApp.push(input);
      return { link: linkFixture({ toolkit: input.toolkit, audience: input.audience ?? "personal" }), redirectUrl: "https://composio.test/oauth", state: "st-1" };
    },
    completeAppConnection: async (id: string, input: { state: string; sessionUri: string }) => {
      calls.completeAppConnection.push({ id, ...input });
      return linkFixture({ status: "active" });
    },
    removeConnectionLink: async () => linkFixture({}),
    openDm: async (_ws: string, input: Record<string, unknown>) => {
      calls.openDm.push(input);
      const existing = input.withAccountId ? conversations.find((c) => c.kind === "dm" && c.id === "c-human") : undefined;
      if (existing) return existing;
      const created: PlatformConversation = input.withBotId
        ? { id: "c-bot", workspaceId: "w1", kind: "dm", createdByPrincipalId: "p-me", createdAt: "", participants: [{ principalId: "p-me", kind: "human", displayName: "Me Person" }, { principalId: "p-atlas", kind: "bot", displayName: "Atlas", botId: "bot-atlas" }], lastReadSequence: 0, lastSequence: 0, unreadCount: 0 }
        : humanDm();
      conversations.push(created);
      return created;
    },
    createBot: async (_ws: string, input: Record<string, unknown>) => { calls.createBot.push(input); return { ...BOT, name: String(input.name) }; },
    createGroup: async () => ({ id: "c-group", workspaceId: "w1", kind: "group" as const, title: "Group", createdByPrincipalId: "p-me", createdAt: "", participants: [], lastReadSequence: 0, lastSequence: 0, unreadCount: 0 }),
    stream: async (_id: string, opts: { signal?: AbortSignal; onEvent: (event: { type: string }, sequence: number) => void }) => {
      subscribers.push(opts.onEvent);
      opts.onEvent({ type: "ready" }, 1);
      return new Promise<void>((resolve) => opts.signal?.addEventListener("abort", () => resolve()));
    },
  };
  /** Push a frame the way a reconnect would, after more events happened. */
  const emit = (event: { type: string }) => { for (const send of subscribers) send(event, 2); };
  return { client: client as unknown as PlatformClient, calls, members, bots, conversations, messages, earlierPages, control, emit };
}

function makeBridge() {
  const opened: string[] = [];
  const created: Array<{ name: string }> = [];
  return {
    opened,
    created,
    bridge: {
      list: async () => [] as LocalWorkspaceSummary[],
      create: async (input: { name: string }) => { created.push(input); return { id: "l-new", name: input.name, mode: "local" as const, active: false }; },
      open: async (id: string) => { opened.push(id); return { id, name: "l-new", origin: "http://127.0.0.1:1234" }; },
      signOut: async () => {},
    },
  };
}

// ── renderer helpers ───────────────────────────────────────────────────────

let host: HTMLDivElement;
let root: Root;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
  await flush();
}

function button(text: string): HTMLElement {
  const found = [...host.querySelectorAll("button, [role=button]")].find((b) => (b.textContent ?? "").trim().includes(text));
  if (!found) throw new Error(`No button containing "${text}". Buttons: ${[...host.querySelectorAll("button")].map((b) => b.textContent).join(" | ")}`);
  return found as HTMLElement;
}

/** The button with exactly this text, inside the list row containing `rowText`. */
function rowButton(rowText: string, label: string): HTMLButtonElement {
  const row = [...host.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes(rowText));
  if (!row) throw new Error(`No row containing "${rowText}".`);
  const found = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
  if (!found) throw new Error(`No "${label}" button in the row for "${rowText}". Buttons: ${[...row.querySelectorAll("button")].map((b) => JSON.stringify(b.textContent)).join(" | ")}`);
  return found as HTMLButtonElement;
}

function byLabel(label: string): HTMLElement {
  const found = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`No element labelled "${label}"`);
  return found;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
}

async function submitForm() {
  const form = host.querySelector("form");
  if (!form) throw new Error("No form on screen");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
}

const text = () => host.textContent ?? "";

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  forgetLinkState();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const baseProps = { location: { pathname: "/", search: "", origin: "https://app.test" }, localBridge: null } as const;

// ── journeys ───────────────────────────────────────────────────────────────

describe("Cloud journey", () => {
  it("signs up, creates a Cloud workspace, creates a bot and chats", async () => {
    const fake = makeFake({ session: null });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    expect(text()).toContain("Welcome to Colonie");

    setValue(host.querySelector<HTMLInputElement>("#colonie-name")!, "Me Person");
    setValue(host.querySelector<HTMLInputElement>("#colonie-email")!, "me@example.com");
    setValue(host.querySelector<HTMLInputElement>("#colonie-password")!, "password1");
    await submitForm();

    expect(fake.calls.signUp).toHaveLength(1);
    // A new account gets its recovery key once, straight after signup.
    expect(text()).toContain("RKEY-LIVE-1");
    expect(text()).toContain("Save your recovery key");
    await click(button("Continue"));

    expect(text()).toContain("Create your first workspace");

    await click(button("Cloud"));
    expect(fake.calls.createWorkspace).toHaveLength(1);
    expect(text()).toContain("Welcome to My Team");

    await click(button("Create a bot"));
    const dialog = host.querySelector('[role="dialog"]')!;
    const nameInput = dialog.querySelector("input")!;
    setValue(nameInput, "Atlas");
    await act(async () => { (dialog.querySelectorAll("button")[dialog.querySelectorAll("button").length - 1] as HTMLButtonElement).click(); });
    await flush();

    expect(fake.calls.createBot).toEqual([{ name: "Atlas", purpose: undefined }]);
    expect(fake.calls.openDm).toEqual([{ withBotId: "bot-atlas" }]);

    const composer = byLabel("Message") as HTMLTextAreaElement;
    setValue(composer, "Hello Atlas");
    await click(byLabel("Send message"));
    expect(fake.calls.sendMessage).toEqual([{ id: "c-bot", body: "Hello Atlas" }]);
    expect(text()).toContain("Hello Atlas");
    setValue(composer, "A separate follow-up");
    await click(byLabel("Send message"));
    const transcript = host.querySelector('[role="log"]')!;
    expect(transcript.textContent).toContain("Hello Atlas");
    expect(transcript.textContent).toContain("A separate follow-up");
    expect(transcript.querySelector('[title="Previous version"]')).toBeNull();
    expect(transcript.querySelector('[title="Next version"]')).toBeNull();
  });
});

describe("private human DM", () => {
  it("opens the chosen person's DM with their account id, not a bot", async () => {
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF, OTHER], bots: [BOT] });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(byLabel("New direct message"));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sam Rivers");

    const samRow = [...dialog.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Sam Rivers"))!;
    await click(samRow);

    expect(fake.calls.openDm).toEqual([{ withAccountId: "acc-sam" }]);
    expect(text()).toContain("Sam Rivers");
    expect(host.querySelector('[role="log"]')?.getAttribute("aria-label")).toContain("Sam Rivers");
  });
});

describe("invitation through auth", () => {
  it("keeps the invite, signs in, then joins the invited workspace", async () => {
    const fake = makeFake({ session: null });
    await render(createElement(PlatformApp, {
      platformOrigin: "https://app.test",
      client: fake.client,
      location: { pathname: "/invite/tok-123", search: "", origin: "https://app.test" },
      localBridge: null,
    }));

    expect(text()).toContain("join the workspace you were invited to");
    setValue(host.querySelector<HTMLInputElement>("#colonie-email")!, "me@example.com");
    setValue(host.querySelector<HTMLInputElement>("#colonie-password")!, "password1");
    await submitForm();

    expect(fake.calls.acceptInvitation).toEqual(["tok-123"]);
    expect(text()).toContain("Invited Team");
  });
});

describe("Local creation", () => {
  it("creates through the bridge and opens the native Local workspace", async () => {
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [] });
    const local = makeBridge();
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client, localBridge: local.bridge }));

    expect(text()).toContain("Create your first workspace");
    await click(button("Local"));

    expect(local.created).toEqual([{ name: "Me's workspace" }]);
    expect(local.opened).toEqual(["l-new"]);
  });
});

describe("failed send", () => {
  it("keeps the typed message and shows the real error", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT },
      workspaces: [workspace()],
      members: [SELF],
      bots: [BOT],
      conversations: [{ id: "c-bot", workspaceId: "w1", kind: "dm", createdByPrincipalId: "p-me", createdAt: "", participants: [{ principalId: "p-me", kind: "human", displayName: "Me Person" }, { principalId: "p-atlas", kind: "bot", displayName: "Atlas", botId: "bot-atlas" }], lastReadSequence: 0, lastSequence: 0, unreadCount: 0 }],
      failSend: true,
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Atlas"));
    const composer = byLabel("Message") as HTMLTextAreaElement;
    setValue(composer, "Please keep this text");
    await click(byLabel("Send message"));

    expect(text()).toContain("The network dropped your message.");
    expect((byLabel("Message") as HTMLTextAreaElement).value).toBe("Please keep this text");
  });
});

describe("account recovery", () => {
  it("resets a password with a key the person saved earlier, then returns to sign in", async () => {
    const fake = makeFake({ session: null });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Sign in"));
    await click(button("Forgot your password?"));

    // The copy must not claim the key was shown or saved at signup.
    expect(text()).toContain("generated earlier");
    expect(text()).not.toContain("when you created your account");

    setValue(host.querySelector<HTMLInputElement>("#colonie-recovery-key")!, "RKEY-LIVE-1");
    setValue(host.querySelector<HTMLInputElement>("#colonie-new-password")!, "password2");
    await submitForm();

    expect(fake.calls.recoverAccount).toEqual([{ recoveryKey: "RKEY-LIVE-1", newPassword: "password2" }]);
    expect(text()).toContain("Password updated");
    // Back at sign in: the email field is present, the recovery key field is gone.
    expect(host.querySelector("#colonie-email")).not.toBeNull();
    expect(host.querySelector("#colonie-recovery-key")).toBeNull();

    // The new password signs in with no email confirmation step.
    setValue(host.querySelector<HTMLInputElement>("#colonie-email")!, "me@example.com");
    setValue(host.querySelector<HTMLInputElement>("#colonie-password")!, "password2");
    await submitForm();
    expect(fake.calls.signIn).toEqual([{ email: "me@example.com", password: "password2" }]);
  });

  it("offers account recovery before any workspace exists", async () => {
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [] });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    expect(text()).toContain("Create your first workspace");
    await click(button("Account recovery"));

    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Account recovery");
    expect(dialog.textContent).toContain("Create recovery key");

    await click(button("Create recovery key"));
    expect(text()).toContain("RKEY-LIVE-1");
  });
});

describe("group members", () => {
  it("adds a person and removes another, refetching the group", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT },
      workspaces: [workspace()],
      members: [SELF, OTHER, KIM],
      bots: [BOT],
      conversations: [groupConversation()],
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Team Sync"));
    await click(byLabel("Group members"));

    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("In this group");
    expect(dialog.textContent).toContain("Sam Rivers");
    expect(dialog.textContent).toContain("Kim Lee");
    expect(dialog.textContent).toContain("Atlas");

    await click(rowButton("Kim Lee", "Add"));
    expect(fake.calls.addGroupMember).toEqual([{ id: "c-group", principalId: "p-kim" }]);
    // Kim is now in the group, so Kim's row offers Remove instead of Add.
    expect(rowButton("Kim Lee", "Remove")).toBeTruthy();

    await click(rowButton("Sam Rivers", "Remove"));
    expect(fake.calls.removeGroupMember).toEqual([{ id: "c-group", principalId: "p-sam" }]);
    expect(rowButton("Sam Rivers", "Add")).toBeTruthy();
  });
});

describe("workspace apps", () => {
  it("shows a member only their own connections, and a pending link is never connected", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace({ myRole: "member" })], members: [SELF],
      composio: { configured: true, keyStatus: "active" },
      links: [linkFixture({ status: "pending" }), linkFixture({ id: "link-2", status: "active", toolkit: "calendar" })],
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Workspace settings"));
    const dialog = host.querySelector('[role="dialog"]')!;

    expect(dialog.textContent).toContain("Waiting for confirmation");
    expect(dialog.textContent).toContain("Gmail");
    expect(dialog.textContent).toContain("calendar");
    // A member is never asked for a key, and the pending row does not claim otherwise.
    expect(dialog.querySelector('input[type="password"]')).toBeNull();
    const gmailRow = [...dialog.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes("Gmail"))!;
    expect(gmailRow.textContent).toContain("Waiting for confirmation");
    expect(gmailRow.textContent).not.toContain("Connected");
  });

  it("tells an owner to add the workspace project key, and rejects a key without session access", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF],
      composio: { configured: false, keyStatus: "unset", setupUnavailableReason: "This server has no Composio organization key, so a project key must be pasted in." },
      rejectKeyWith: "composio_session_write_required",
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Workspace settings"));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Apps are not set up in this workspace yet");
    expect(dialog.textContent).toContain("no Composio organization key");

    setValue(dialog.querySelector<HTMLInputElement>('input[type="password"]')!, "ak_test_only");
    await click(button("Save key"));

    expect(fake.calls.setComposioKey).toEqual(["ak_test_only"]);
    // The server's code becomes an actionable sentence, not a raw code.
    expect(host.textContent).toContain("session management write access");
    // No server-side org key means no automatic setup action to offer.
    expect(dialog.textContent).not.toContain("Set up a project");
  });

  it("lets an owner set up the first project when the server can provision one", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF],
      composio: { configured: false, keyStatus: "unset", canProvision: true },
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));

    await click(button("Workspace settings"));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("This server can create one for it");

    await click(button("Set up a project"));
    await flush();

    expect(fake.calls.provisionComposio).toEqual(["w1"]);
    expect(host.textContent).toContain("This workspace has its own app project");
    // The setup box switches to the configured actions; no key was needed.
    expect(host.textContent).toContain("Replace key");
  });

  it("starts a hosted OAuth connection and keeps the opaque state for this tab", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace({ myRole: "member" })], members: [SELF],
      composio: { configured: true, keyStatus: "active" },
      links: [linkFixture({ status: "pending" })],
    });
    const opened: string[] = [];
    const bridgeHolder = testWindow as unknown as { ogb?: unknown };
    bridgeHolder.ogb = {
      colonieWorkspaces: {
        list: async () => [], create: async () => ({ id: "l1", name: "Local", kind: "local", createdAt: "" }),
        open: async () => ({}), authorizeApp: async (url: string) => { opened.push(url); },
      },
    } as unknown as { ogb?: unknown };
    expect(localWorkspaceBridge()).not.toBeNull();

    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Workspace settings"));

    const dialog = host.querySelector('[role="dialog"]')!;
    setSelect(dialog.querySelector<HTMLSelectElement>('[aria-label="App toolkit"]')!, "googlecalendar");
    await click(button("Connect"));
    await flush();

    expect(fake.calls.connectApp).toEqual([{ toolkit: "googlecalendar", audience: "personal" }]);
    expect(opened).toEqual(["https://composio.test/oauth"]);
    // Only the opaque state is remembered, for this tab.
    expect(takeLinkState()).toEqual({ workspaceId: "w1", state: "st-1" });
    expect(host.textContent).toContain("Waiting for confirmation");

    // Starting over drops this tab's attempt, so a later callback is not acted on.
    rememberLinkState({ workspaceId: "w1", state: "st-1" });
    await click(button("Start over"));
    expect(takeLinkState()).toBeNull();
    delete bridgeHolder.ogb;
  });
  it("reports a rejected navigation instead of claiming the app page opened", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF],
      composio: { configured: true, keyStatus: "active" },
    });
    const attempted: string[] = [];
    const assign = (url: string) => { attempted.push(url); throw new Error("Navigation is blocked in this window."); };
    Object.defineProperty(testWindow.location, "assign", { value: assign, configurable: true });
    try {
      await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
      await click(button("Workspace settings"));
      await click(button("Connect"));
      await flush();

      expect(attempted).toEqual(["https://composio.test/oauth"]);
      expect(host.textContent).toContain("Navigation is blocked in this window.");
      // No claim that a page is waiting, and no invite to go finish there.
      expect(host.textContent).not.toContain("Finish the connection");
    } finally {
      delete (testWindow.location as unknown as { assign?: unknown }).assign;
    }
  });

  it("offers only the read-only apps it supports, and labels anything else connection-only", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF],
      composio: { configured: true, keyStatus: "active" },
      links: [linkFixture({ id: "link-9", toolkit: "slack", status: "active", audience: "shared" })],
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Workspace settings"));

    const dialog = host.querySelector('[role="dialog"]')!;
    const options = [...dialog.querySelectorAll<HTMLOptionElement>('[aria-label="App toolkit"] option')].map((option) => option.value);
    expect(options).toEqual(["gmail", "googlecalendar", "googledrive"]);

    const copy = dialog.textContent ?? "";
    // Read-only, and it says so rather than promising anything more.
    expect(copy).toContain("Read only");
    expect(copy).toContain("cannot send, edit or delete anything");
    // A personal app is for its owner's own chats with bots.
    expect(copy).toContain("only in your own chats with bots");
    // A shared app is read by the workspace's bots in Groups and DMs.
    expect(copy).toContain("Shared: workspace bots can read it in Groups and DMs");
    // Anything outside the catalogue is never shown as usable.
    expect(copy).toContain("slack");
    expect(copy).toContain("Connection only");
  });
});

describe("reconnect resync", () => {
  const openBot = async (fake: ReturnType<typeof makeFake>) => {
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Atlas"));
  };

  it("reloads the open conversation when a truncated replay asks for a resync", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF], bots: [BOT],
      conversations: [botDmConversation()],
      conversationsById: { "c-bot": [messageFixture("m1", "Hello Atlas", 1)] },
    });
    await openBot(fake);
    expect(text()).toContain("Hello Atlas");

    // This frame was missed while the tab was away, so only the server has it.
    fake.messages["c-bot"] = [...fake.messages["c-bot"]!, messageFixture("m2", "Missed while away", 2)];
    await act(async () => { fake.emit({ type: "resync" }); });
    await flush();

    expect(text()).toContain("Missed while away");
  });

  it("drops the messages when a resync finds the access was revoked", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF], bots: [BOT],
      conversations: [botDmConversation()],
      conversationsById: { "c-bot": [messageFixture("m1", "Hello Atlas", 1)] },
    });
    await openBot(fake);
    expect(text()).toContain("Hello Atlas");

    fake.control.getConversationError = new PlatformApiError("forbidden", 403, "forbidden");
    await act(async () => { fake.emit({ type: "resync" }); });
    await flush();

    expect(text()).toContain("You no longer have access to this conversation.");
    expect(text()).not.toContain("Hello Atlas");
  });

  it("discards a resync reload for a conversation the person switched away from", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF, OTHER], bots: [BOT],
      conversations: [botDmConversation(), humanDm()],
      conversationsById: {
        "c-bot": [messageFixture("m1", "Hello Atlas", 1)],
        "c-human": [messageFixture("m9", "Sam's note", 1, { conversationId: "c-human", senderPrincipalId: "p-sam", senderKind: "human", senderName: "Sam Rivers" })],
      },
    });
    await openBot(fake);

    let release = () => {};
    fake.control.gateFor = "c-bot";
    fake.control.gate = new Promise<void>((resolve) => { release = resolve; });
    fake.messages["c-bot"] = [...fake.messages["c-bot"]!, messageFixture("m2", "Missed while away", 2)];
    await act(async () => { fake.emit({ type: "resync" }); });

    // The person leaves before the reload comes back; its answer is not written.
    await click(button("Sam Rivers"));
    await act(async () => { release(); });
    await flush();

    expect(text()).toContain("Sam's note");
    expect(text()).not.toContain("Missed while away");
  });
});

describe("conversation open races", () => {
  const twoConversations = () => ({
    conversations: [botDmConversation(), humanDm()],
    conversationsById: {
      "c-bot": [messageFixture("m1", "Atlas-only line", 1)],
      "c-human": [messageFixture("m9", "Sam's note", 1, { conversationId: "c-human", senderPrincipalId: "p-sam", senderKind: "human", senderName: "Sam Rivers" })],
    },
  });

  it("keeps the conversation opened last when two opens race", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF, OTHER], bots: [BOT],
      ...twoConversations(),
    });
    let release = () => {};
    fake.control.gateFor = "c-bot";
    fake.control.gate = new Promise<void>((resolve) => { release = resolve; });

    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Atlas"));            // still in flight
    await click(button("Sam Rivers"));       // opened second, and answered first
    expect(text()).toContain("Sam's note");

    await act(async () => { release(); });   // the first answer arrives late
    await flush();

    expect(text()).toContain("Sam's note");
    expect(text()).not.toContain("Atlas-only line");
  });

  it("does not merge a send answered after the person left the conversation", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF, OTHER], bots: [BOT],
      ...twoConversations(),
    });
    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Atlas"));

    let release = () => {};
    fake.control.gateSendFor = "c-bot";
    fake.control.gateSend = new Promise<void>((resolve) => { release = resolve; });
    setValue(byLabel("Message") as HTMLTextAreaElement, "Sent from the bot chat");
    await click(byLabel("Send message"));
    expect(fake.calls.sendMessage).toEqual([{ id: "c-bot", body: "Sent from the bot chat" }]);

    await click(button("Sam Rivers"));
    await act(async () => { release(); });
    await flush();

    // The reply belongs to the bot chat, so it never lands in Sam's view.
    expect(text()).toContain("Sam's note");
    expect(text()).not.toContain("Sent from the bot chat");
  });

  it("discards a conversation opened in a workspace the person left", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace(), workspace({ id: "w2", name: "Other Team" })], members: [SELF], bots: [BOT],
      conversations: [botDmConversation()],
      conversationsById: { "c-bot": [messageFixture("m1", "Workspace one line", 1)] },
    });
    const views = [
      { id: "w1", name: "My Team", kind: "cloud" as const, myRole: "owner" as const },
      { id: "w2", name: "Other Team", kind: "cloud" as const, myRole: "owner" as const },
    ];
    const shell = (id: string) => createElement(WorkspaceShell, {
      client: fake.client, account: ACCOUNT, workspaces: views, activeId: id,
      onSwitchWorkspace: () => {}, onNewWorkspace: () => {}, onSignOut: () => {},
    });

    let release = () => {};
    fake.control.gateFor = "c-bot";
    fake.control.gate = new Promise<void>((resolve) => { release = resolve; });

    await render(shell("w1"));
    await click(button("Atlas"));

    // Switching workspace while that open is still in flight.
    await act(async () => { root.render(shell("w2")); });
    await flush();
    await act(async () => { release(); });
    await flush();

    expect(text()).toContain("Other Team");
    expect(text()).not.toContain("Workspace one line");
  });
});

describe("earlier messages", () => {
  it("loads the page above the top, keeps the order, and keeps the view when it fails", async () => {
    const fake = makeFake({
      session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF], bots: [BOT],
      conversations: [botDmConversation()],
      conversationsById: { "c-bot": [messageFixture("m10", "Tenth line", 10)] },
    });
    fake.earlierPages["c-bot"] = [
      messageFixture("m4", "Fourth line", 4),
      messageFixture("m5", "Fifth line", 5),
      messageFixture("m9", "Ninth line", 9),
    ];

    await render(createElement(PlatformApp, { ...baseProps, client: fake.client }));
    await click(button("Atlas"));

    // The conversation starts at sequence 10, so there is a page above it.
    expect(text()).toContain("Tenth line");
    expect(text()).toContain("Load earlier messages");

    await click(button("Load earlier messages"));
    await flush();

    // 100 back at most, and never more rows than the sequences below the top.
    expect(fake.calls.listMessages).toEqual([{ id: "c-bot", after: 0, limit: 9 }]);
    expect(text()).toContain("Fourth line");
    expect(text()).toContain("Tenth line");
    const transcript = host.querySelector('[role="log"]')?.textContent ?? "";
    expect(transcript.indexOf("Fourth line")).toBeLessThan(transcript.indexOf("Tenth line"));

    // A failure says so in plain words and leaves the messages in place.
    fake.control.listMessagesError = new Error("Request failed with status 500");
    await click(button("Load earlier messages"));
    await flush();

    expect(text()).toContain("Earlier messages could not be loaded. Try again.");
    expect(text()).not.toContain("status 500");
    expect(text()).toContain("Fourth line");
    expect(text()).toContain("Tenth line");
  });
});

describe("Composio callback", () => {
  const callbackProps = {
    ...baseProps,
    location: { pathname: "/composio/callback", search: "?session_uri=urn%3Acomposio%3Aabc", origin: "https://app.test" },
  };

  it("confirms the pending attempt from this tab with the session URI, and clears the URL", async () => {
    rememberLinkState({ workspaceId: "w1", state: "st-1" });
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF] });

    await render(createElement(PlatformApp, { ...callbackProps, client: fake.client }));

    expect(fake.calls.completeAppConnection).toEqual([{ id: "w1", state: "st-1", sessionUri: "urn:composio:abc" }]);
    expect(text()).toContain("Gmail is connected.");
    // The state is single-use and the address bar no longer carries the URI.
    expect(takeLinkState()).toBeNull();
    expect(testWindow.location.pathname).toBe("/");
    expect(testWindow.location.search).toBe("");
  });

  it("never completes a callback this tab did not start", async () => {
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF] });

    await render(createElement(PlatformApp, { ...callbackProps, client: fake.client }));

    expect(fake.calls.completeAppConnection).toEqual([]);
    expect(text()).toContain("not started in this tab");
  });

  it("keeps the pending attempt while signed out, then confirms it after sign in", async () => {
    rememberLinkState({ workspaceId: "w1", state: "st-1" });
    const fake = makeFake({ session: null, workspaces: [workspace()], members: [SELF] });

    await render(createElement(PlatformApp, { ...callbackProps, client: fake.client }));

    // Signed out: nothing is confirmed and the attempt is still here, but the
    // session URI is already out of the address bar. (Reading it is destructive,
    // so put the attempt back for the completion below.)
    expect(fake.calls.completeAppConnection).toEqual([]);
    expect(takeLinkState()).toEqual({ workspaceId: "w1", state: "st-1" });
    rememberLinkState({ workspaceId: "w1", state: "st-1" });
    expect(testWindow.location.search).toBe("");

    await click(button("Sign in"));
    setValue(host.querySelector<HTMLInputElement>("#colonie-email")!, "me@example.com");
    setValue(host.querySelector<HTMLInputElement>("#colonie-password")!, "password2");
    await submitForm();

    expect(fake.calls.signIn).toHaveLength(1);
    expect(fake.calls.completeAppConnection).toEqual([{ id: "w1", state: "st-1", sessionUri: "urn:composio:abc" }]);
    expect(takeLinkState()).toBeNull();
  });

  it("reports a redirect that carried no session URI instead of guessing", async () => {
    rememberLinkState({ workspaceId: "w1", state: "st-1" });
    const fake = makeFake({ session: { user: ACCOUNT }, workspaces: [workspace()], members: [SELF] });

    await render(createElement(PlatformApp, {
      ...baseProps,
      client: fake.client,
      location: { pathname: "/composio/callback", search: "?colonieState=st-1", origin: "https://app.test" },
    }));

    expect(fake.calls.completeAppConnection).toEqual([]);
    expect(text()).toContain("did not send a session back");
    // The attempt survives so the person can start over without losing it.
    expect(takeLinkState()).toEqual({ workspaceId: "w1", state: "st-1" });
  });
});
