// The Colonie platform client and its pure helpers. Everything the shell
// depends on for the wire is exercised here with an injected fetch, so a change
// to a path, an error mapping or the stream frame shape fails loudly.
import { describe, expect, it, vi } from "vitest";
import {
  botColor, canChangeRoles, canDeleteWorkspace, canManageBots, canManageConnections, canManageMembers,
  COMPOSIO_TOOLKITS, composioCallbackParams, composioErrorMessage, composioToolkit, connectionAudienceLabel,
  connectionLinkLabel, connectionLinkTone,
  conversationTitle, initialsOf, invitationLinkFor, invitationTokenFromLocation, isComposioCallback,
  mergeMessages, mergeWorkspaceViews, outranks, partitionConversations, platformUrl, PlatformApiError,
  PlatformClient, rememberLinkState, roleLabel, route, searchHitFromPlatform, sseData, takeLinkState, totalUnread,
  type PlatformConnectionLink, type PlatformConversation, type PlatformMessage, type PlatformSearchHit,
} from "./colonie-platform";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function conversation(overrides: Partial<PlatformConversation>): PlatformConversation {
  return {
    id: "c1", workspaceId: "w1", kind: "group", createdByPrincipalId: "p-me", createdAt: "2026-01-01T00:00:00Z",
    participants: [], lastReadSequence: 0, lastSequence: 0, unreadCount: 0, ...overrides,
  };
}

function message(overrides: Partial<PlatformMessage>): PlatformMessage {
  return {
    id: "m1", workspaceId: "w1", conversationId: "c1", senderPrincipalId: "p-me", senderKind: "human",
    senderName: "Me", sequence: 1, body: "hi", createdAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

describe("platformUrl and route", () => {
  it("joins an absolute origin and leaves same-origin paths relative", () => {
    expect(platformUrl("", "/api/x")).toBe("/api/x");
    expect(platformUrl("https://cloud.example:8443", "/api/x")).toBe("https://cloud.example:8443/api/x");
    expect(platformUrl("https://cloud.example/", "/api/x")).toBe("https://cloud.example/api/x");
  });

  it("fills placeholder routes positionally", () => {
    expect(route("/api/workspaces/:id/members/:accountId", "w1", "acc 2")).toBe("/api/workspaces/w1/members/acc%202");
    expect(route("/api/workspaces/:id/invitations/:invitationId", "w1", "inv1")).toBe("/api/workspaces/w1/invitations/inv1");
  });
});

describe("invitations in the URL", () => {
  it("reads both the product link and the query form", () => {
    expect(invitationTokenFromLocation({ pathname: "/invite/abc123", search: "" })).toBe("abc123");
    expect(invitationTokenFromLocation({ pathname: "/", search: "?colonieInvite=xyz" })).toBe("xyz");
    expect(invitationTokenFromLocation({ pathname: "/", search: "" })).toBeNull();
    expect(invitationTokenFromLocation(undefined)).toBeNull();
  });

  it("builds a shareable link", () => {
    expect(invitationLinkFor("https://cloud.example/", "a b")).toBe("https://cloud.example/invite/a%20b");
  });
});

describe("role-scoped controls", () => {
  it("gates management on admin and above", () => {
    expect(canManageBots("member")).toBe(false);
    expect(canManageBots("admin")).toBe(true);
    expect(canManageBots("owner")).toBe(true);
    expect(canManageMembers("member")).toBe(false);
    expect(canManageConnections("admin")).toBe(true);
    expect(canChangeRoles("admin")).toBe(false);
    expect(canChangeRoles("owner")).toBe(true);
    expect(canDeleteWorkspace("admin")).toBe(false);
    expect(canDeleteWorkspace("owner")).toBe(true);
    expect(outranks("owner", "admin")).toBe(true);
    expect(outranks("admin", "admin")).toBe(false);
    expect(roleLabel("owner")).toBe("Owner");
  });
});

describe("conversation helpers", () => {
  const self = "p-me";
  it("labels a group by title and a DM by the other participant", () => {
    expect(conversationTitle(conversation({ title: "Launch" }), self)).toBe("Launch");
    expect(conversationTitle(conversation({ title: "" }), self)).toBe("Group");
    const dm = conversation({
      kind: "dm",
      participants: [
        { principalId: self, kind: "human", displayName: "Me", accountId: "a-me" },
        { principalId: "p-bot", kind: "bot", displayName: "Atlas", botId: "b1" },
      ],
    });
    expect(conversationTitle(dm, self)).toBe("Atlas");
  });

  it("separates human DMs from bot DMs and sorts by recency", () => {
    const parts = (other: { principalId: string; kind: "human" | "bot"; displayName: string }) => [
      { principalId: self, kind: "human" as const, displayName: "Me" },
      other,
    ];
    const result = partitionConversations([
      conversation({ id: "g1", kind: "group", lastSequence: 1 }),
      conversation({ id: "g2", kind: "group", lastSequence: 9 }),
      conversation({ id: "h1", kind: "dm", lastSequence: 2, participants: parts({ principalId: "p-h", kind: "human", displayName: "Sam" }) }),
      conversation({ id: "b1", kind: "dm", lastSequence: 5, participants: parts({ principalId: "p-b", kind: "bot", displayName: "Atlas" }) }),
    ], self);
    expect(result.groups.map((c) => c.id)).toEqual(["g2", "g1"]);
    expect(result.humanDms.map((c) => c.id)).toEqual(["h1"]);
    expect(result.botDms.map((c) => c.id)).toEqual(["b1"]);
  });

  it("totals unread without letting a negative count subtract", () => {
    expect(totalUnread([conversation({ unreadCount: 2 }), conversation({ unreadCount: -5 }), conversation({ unreadCount: 3 })])).toBe(5);
  });

  it("merges messages by id in server order", () => {
    const first = message({ id: "a", sequence: 2 });
    const second = message({ id: "b", sequence: 1 });
    const dupe = message({ id: "a", sequence: 2, body: "updated" });
    expect(mergeMessages([first], [second, dupe]).map((m) => m.id)).toEqual(["b", "a"]);
    expect(mergeMessages([first], [dupe])[0]!.body).toBe("updated");
    const existing = [first];
    expect(mergeMessages(existing, [])).toBe(existing);
  });
});

describe("avatars and workspace views", () => {
  it("makes stable initials and bot colours", () => {
    expect(initialsOf("Ada Lovelace")).toBe("AL");
    expect(initialsOf("cher")).toBe("CH");
    expect(initialsOf("  ")).toBe("?");
    expect(botColor("bot-1")).toBe(botColor("bot-1"));
  });

  it("puts Cloud workspaces before Local ones", () => {
    const views = mergeWorkspaceViews(
      [{ id: "w1", name: "Team", kind: "cloud", ownerAccountId: "a", myRole: "admin", createdAt: "" }],
      [{ id: "l1", name: "My Mac", mode: "local" as const, active: true }],
    );
    expect(views.map((v) => [v.id, v.kind, v.myRole])).toEqual([["w1", "cloud", "admin"], ["l1", "local", "owner"]]);
  });
});

describe("PlatformClient", () => {
  it("posts signup and returns the account without a token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ user: { id: "u1", email: "a@b.c", name: "Ada" } }));
    const client = new PlatformClient({ platformOrigin: "https://cloud.example", fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await client.signUp({ email: "a@b.c", password: "password1", name: "Ada" });
    expect(result.user.id).toBe("u1");
    expect("token" in result).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://cloud.example/api/colonie/auth/sign-up/email");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.c", password: "password1", name: "Ada" });
  });

  it("maps a 401 to an unauthorized error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Unauthorized", code: "no_session" }, 401));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listWorkspaces()).rejects.toMatchObject({ status: 401, unauthorized: true, code: "no_session" });
    await expect(client.listWorkspaces()).rejects.toBeInstanceOf(PlatformApiError);
  });

  it("treats a 401 session check as signed out rather than an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "no session" }, 401));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.session()).resolves.toBeNull();
  });

  it("builds messages and read/stop requests on the shared routes", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({ message: message({}), conversation: conversation({}), stopped: 1 });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.sendMessage("c1", "hello");
    await client.markRead("c1", 4);
    await client.stopTurns("c1");
    expect(seen).toEqual([
      "POST /api/colonie/platform/conversations/c1/messages",
      "POST /api/colonie/platform/conversations/c1/read",
      "POST /api/colonie/platform/conversations/c1/turns/stop",
    ]);
  });

  it("targets the added bot, connection, member and recovery routes", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({ bot: {}, connection: {}, recoveryKey: "RKEY-1", createdAt: "2026-01-01T00:00:00.000Z" });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.updateBot("w1", "b1", { name: "Renamed" });
    await client.deleteBot("w1", "b1");
    await client.rotateConnection("w1", "conn1", "s3cret");
    await client.addConversationMember("c1", "p2");
    await client.removeConversationMember("c1", "p2");
    await client.createRecoveryKey();
    await client.recoverAccount({ recoveryKey: "RKEY-1", newPassword: "password2" });
    expect(seen).toEqual([
      "PATCH /api/colonie/platform/workspaces/w1/bots/b1",
      "DELETE /api/colonie/platform/workspaces/w1/bots/b1",
      "PATCH /api/colonie/platform/workspaces/w1/connections/conn1",
      "POST /api/colonie/platform/conversations/c1/members",
      "DELETE /api/colonie/platform/conversations/c1/members/p2",
      "POST /api/colonie/platform/account/recovery-key",
      "POST /api/colonie/platform/account/recover",
    ]);
  });

  it("opens a private human DM with the other account id", async () => {    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ conversation: conversation({ kind: "dm" }) }));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.openDm("w1", { withAccountId: "a-2" });
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/colonie/platform/workspaces/w1/conversations/open");
    expect(JSON.parse(init.body as string)).toEqual({ kind: "dm", withAccountId: "a-2" });
  });

  it("accepts an invitation by secret token", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse({ workspace: { id: "w9" }, role: "member" }));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const accepted = await client.acceptInvitation("secret");
    expect(accepted.workspace.id).toBe("w9");
    const [url, init] = fetchImpl.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/colonie/platform/invitations/accept");
    expect(JSON.parse(init.body as string)).toEqual({ token: "secret" });
  });
});

describe("Composio apps", () => {
  it("targets the workspace-scoped app routes", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({
        configured: true, keyStatus: "active", serviceUserId: "svc-1", canProvision: false,
        links: [], link: { id: "l1", status: "pending" }, redirectUrl: "https://composio.test/x", state: "st-1",
      });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.composioStatus("w1");
    await client.setComposioKey("w1", "ak_test_only");
    await client.removeComposioKey("w1");
    await client.provisionComposio("w1", "Team");
    await client.listConnectionLinks("w1");
    await client.connectApp("w1", { toolkit: "gmail" });
    await client.completeAppConnection("w1", { state: "st-1", sessionUri: "urn:composio:abc" });
    await client.removeConnectionLink("w1", "l1");

    expect(seen).toEqual([
      "GET /api/colonie/platform/workspaces/w1/composio",
      "PUT /api/colonie/platform/workspaces/w1/composio/key",
      "DELETE /api/colonie/platform/workspaces/w1/composio/key",
      "POST /api/colonie/platform/workspaces/w1/composio/provision",
      "GET /api/colonie/platform/workspaces/w1/composio/connections",
      "POST /api/colonie/platform/workspaces/w1/composio/connections",
      "POST /api/colonie/platform/workspaces/w1/composio/connections/complete",
      "DELETE /api/colonie/platform/workspaces/w1/composio/connections/l1",
    ]);
    const connectBody = (fetchImpl.mock.calls[5]![1] as RequestInit).body as string;
    expect(JSON.parse(connectBody)).toEqual({ toolkit: "gmail" });
    const completeBody = (fetchImpl.mock.calls[6]![1] as RequestInit).body as string;
    expect(JSON.parse(completeBody)).toEqual({ state: "st-1", sessionUri: "urn:composio:abc" });
  });

  it("returns the link list from the envelope", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ links: [{ id: "l1", status: "pending" }] }));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await client.listConnectionLinks("w1")).map((l) => l.id)).toEqual(["l1"]);
  });

  it("reports a pending link as waiting and only an active one as connected", () => {
    const link = (status: "pending" | "active" | "failed" | "expired", statusReason?: string): PlatformConnectionLink => ({
      id: "l1", workspaceId: "w1", audience: "personal" as const, toolkit: "gmail", status, userId: "svc-1",
      ownedByMe: true, createdAt: "", updatedAt: "", statusReason,
    });
    expect(connectionLinkLabel(link("pending"))).toBe("Waiting for confirmation");
    expect(connectionLinkLabel(link("active"))).toBe("Connected");
    expect(connectionLinkLabel(link("failed", "denied"))).toBe("Failed: denied");
    expect(connectionLinkLabel(link("expired"))).toBe("Disconnected");
    expect(connectionLinkTone(link("active"))).toBe("success");
    expect(connectionLinkTone(link("pending"))).toBe("warning");
  });

  it("lists only the read-only apps Colonie supports", () => {
    expect(COMPOSIO_TOOLKITS.map((toolkit) => toolkit.id)).toEqual(["gmail", "googlecalendar", "googledrive"]);
    expect(COMPOSIO_TOOLKITS.map((toolkit) => toolkit.summary)).toEqual(["Fetch mail", "List and read events", "Find and read documents"]);
    expect(composioToolkit("gmail")?.label).toBe("Gmail");
    expect(composioToolkit("slack")).toBeUndefined();
    expect(connectionAudienceLabel("personal")).toContain("only in your own chats with bots");
    expect(connectionAudienceLabel("shared")).toContain("Groups and DMs");
  });

  it("turns server codes into actionable sentences", () => {
    expect(composioErrorMessage(new PlatformApiError("rejected", 422, "composio_session_write_required")))
      .toContain("session management write access");
    expect(composioErrorMessage(new PlatformApiError("unconfigured", 409, "composio_unconfigured")))
      .toContain("An owner or admin sets it up first");
    expect(composioErrorMessage(new Error("boom"))).toBe("boom");
  });
});

describe("Composio callback", () => {
  it("reads only the session URI, which is all the verifier redirect carries", () => {
    expect(composioCallbackParams("?session_uri=urn%3Acomposio%3Aabc"))
      .toEqual({ sessionUri: "urn:composio:abc" });
    expect(composioCallbackParams("?sessionUri=urn:composio:abc"))
      .toEqual({ sessionUri: "urn:composio:abc" });
    // No state is expected in the redirect; its absence never fills anything in.
    expect(composioCallbackParams("?colonieState=st-1")).toBeNull();
    expect(composioCallbackParams("?session_uri=")).toBeNull();
    expect(composioCallbackParams("")).toBeNull();
  });

  it("recognises the callback path and not its neighbours", () => {
    expect(isComposioCallback("/composio/callback")).toBe(true);
    expect(isComposioCallback("/composio/callback/")).toBe(true);
    expect(isComposioCallback("/composio/callbacks")).toBe(false);
    expect(isComposioCallback(undefined)).toBe(false);
  });

  it("keeps the attempt for this tab only, and only until it is taken", () => {
    const store = new Map<string, string>();
    const fakeStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    } as unknown as Storage;
    Object.defineProperty(globalThis, "sessionStorage", { value: fakeStorage, configurable: true });
    try {
      rememberLinkState({ workspaceId: "w1", state: "st-1" });
      // The session URI is never stored, only the opaque state and its workspace.
      expect([...store.values()].join("")).not.toContain("sessionUri");
      expect(takeLinkState()).toEqual({ workspaceId: "w1", state: "st-1" });
      expect(takeLinkState()).toBeNull();
    } finally {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
  });
});

describe("SSE", () => {
  it("splits data lines from a stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n"));
        controller.close();
      },
    });
    const payloads: string[] = [];
    for await (const data of sseData(stream)) payloads.push(data);
    expect(payloads).toEqual(["{\"a\":1}", "{\"b\":2}"]);
  });

  it("unwraps framed events and reports the cursor", async () => {
    const body = [
      `data: ${JSON.stringify({ sequence: 1, event: { type: "ready", workspaceId: "w1", subscriberAccountId: "me", at: "" } })}`,
      "",
      `data: ${JSON.stringify({ sequence: 2, event: { type: "turn", conversationId: "c1", botPrincipalId: "p", state: "typing", at: "" } })}`,
      "",
      "",
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const seen: Array<{ type: string; sequence: number }> = [];
    await client.stream("w1", { onEvent: (event, sequence) => seen.push({ type: event.type, sequence }) });
    expect(seen).toEqual([{ type: "ready", sequence: 1 }, { type: "turn", sequence: 2 }]);
  });

  it("accepts a bare (unframed) event too", async () => {
    const body = `data: ${JSON.stringify({ type: "resync", workspaceId: "w1", at: "" })}\n\n`;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const seen: Array<{ type: string; sequence: number }> = [];
    await client.stream("w1", { onEvent: (event, sequence) => seen.push({ type: event.type, sequence }) });
    expect(seen).toEqual([{ type: "resync", sequence: 0 }]);
  });
});

// ── transcript search wire ─────────────────────────────────────────────────

function searchHit(overrides: Partial<PlatformSearchHit> = {}): PlatformSearchHit {
  return {
    conversationId: "c1", conversationKind: "dm", title: "Bob", messageId: "m1", sequence: 7,
    senderPrincipalId: "p-alice", senderKind: "human", senderName: "Alice",
    snippet: "dinner plan", matchStart: 0, matchLength: 6, createdAt: "2026-02-01T10:00:00.000Z", ...overrides,
  };
}

describe("PlatformClient transcript search", () => {
  it("GETs the workspace-scoped search route with a bounded query and reads the hits", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({ hits: [searchHit()] });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const hits = await client.search("w 1", "hello world", { limit: 12 });
    expect(seen).toEqual(["GET /api/colonie/platform/workspaces/w%201/search?q=hello+world&limit=12"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.messageId).toBe("m1");
  });

  it("omits the limit when none is given", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({ hits: [] });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.search("w1", "q");
    expect(seen).toEqual(["GET /api/colonie/platform/workspaces/w1/search?q=q"]);
  });

  it("pages a conversation with after/limit and stays compatible without options", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${url}`);
      return jsonResponse({ conversation: conversation({}), messages: [message({})] });
    });
    const client = new PlatformClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.getConversation("c1");
    await client.getConversation("c1", { after: 4, limit: 50 });
    expect(seen).toEqual([
      "GET /api/colonie/platform/conversations/c1",
      "GET /api/colonie/platform/conversations/c1?after=4&limit=50",
    ]);
  });
});

describe("searchHitFromPlatform", () => {
  it("maps a human DM hit without inventing a bot identity", () => {
    const hit = searchHitFromPlatform(searchHit());
    expect(hit.name).toBe("Bob");
    expect(hit.threadId).toBe("c1");
    expect(hit.messageId).toBe("m1");
    expect(hit.sequence).toBe(7);
    expect(hit.role).toBe("user");
    expect(hit.from).toBe("Alice");
    expect(hit.botId).toBeUndefined();
    expect(hit.groupId).toBeUndefined();
    expect(hit.onActivePath).toBe(true);
    expect(hit.snippet.length).toBeGreaterThan(0);
  });

  it("attributes a Group hit to the conversation and a bot DM hit to the bot", () => {
    const group = searchHitFromPlatform(searchHit({ conversationKind: "group", title: "Launch Room" }));
    expect(group.groupId).toBe("c1");
    expect(group.botId).toBeUndefined();
    expect(group.name).toBe("Launch Room");

    const botDm = searchHitFromPlatform(searchHit({ botId: "bot-9", senderKind: "bot", senderName: "Atlas", title: "Atlas" }));
    expect(botDm.botId).toBe("bot-9");
    expect(botDm.groupId).toBeUndefined();
    expect(botDm.role).toBe("bot");
  });
});
