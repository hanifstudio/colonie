// The search port the original SearchResults and CommandPalette consume. Local
// mounts no provider and must keep its /api/search behavior; the Cloud shell
// mounts a workspace-scoped port and the components must use it instead of the
// legacy route. The store and the Local land helper are mocked so this stays a
// pure unit test of the port selection.
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: vi.fn(async () => {}) }));

import { createPlatformSearchPort, PlatformSearchProvider, useTranscriptSearch, type TranscriptSearchPort } from "./colonie-search";
import { landOnSearchHit } from "@/lib/focus-message";
import type { PlatformClient, PlatformSearchHit } from "./colonie-platform";
import type { SearchHit } from "./search-hit";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return { name: "N", threadId: "t1", messageId: "m1", role: "user", kind: "text", at: 0, snippet: "s", matchStart: 0, matchLength: 1, onActivePath: true, ...overrides };
}

function wire(overrides: Partial<PlatformSearchHit> = {}): PlatformSearchHit {
  return {
    conversationId: "c1", conversationKind: "dm", title: "Bob", messageId: "m1", sequence: 7,
    senderPrincipalId: "p-alice", senderKind: "human", senderName: "Alice",
    snippet: "dinner plan", matchStart: 0, matchLength: 6, createdAt: "2026-02-01T10:00:00.000Z", ...overrides,
  };
}

/** Render the hook (optionally under a provider) and return the port it saw. */
function renderPort(wrap?: (probe: ReactNode) => ReactNode): TranscriptSearchPort {
  let captured!: TranscriptSearchPort;
  const Probe = () => {
    captured = useTranscriptSearch();
    return null;
  };
  const probe = createElement(Probe);
  renderToStaticMarkup(wrap ? wrap(probe) : probe);
  return captured;
}

const state = { bots: [], groups: [] };
const dispatch = (() => {}) as never;

beforeEach(() => vi.clearAllMocks());

describe("useTranscriptSearch", () => {
  it("defaults to the Local /api/search behavior when no Cloud provider is mounted", async () => {
    api.mockResolvedValue({ hits: [hit()] });
    const port = renderPort();

    const hits = await port.search("hello world", 40);
    expect(api).toHaveBeenCalledWith("/api/search?q=hello%20world&limit=40", { signal: undefined });
    expect(hits).toHaveLength(1);

    await port.land(hit(), state, dispatch);
    expect(landOnSearchHit).toHaveBeenCalledTimes(1);
  });

  it("uses the mounted Cloud port instead of the Local default", () => {
    const cloud: TranscriptSearchPort = { search: vi.fn(async () => []), land: vi.fn(async () => {}) };
    const port = renderPort((probe) => createElement(PlatformSearchProvider, { port: cloud }, probe));
    expect(port.search).toBe(cloud.search);
    expect(port.land).toBe(cloud.land);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("createPlatformSearchPort", () => {
  it("queries the scoped client and maps wire hits to the original shape", async () => {
    const client = { search: vi.fn(async () => [wire()]) } as unknown as PlatformClient;
    const landed: string[] = [];
    const port = createPlatformSearchPort({ client, workspaceId: "w1", land: (mapped) => { landed.push(mapped.threadId); } });

    const hits = await port.search("dinner", 12);
    expect(client.search).toHaveBeenCalledWith("w1", "dinner", { limit: 12, signal: undefined });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.threadId).toBe("c1");
    expect(hits[0]!.sequence).toBe(7);
    expect(hits[0]!.botId).toBeUndefined();

    await port.land(hits[0]!, state, dispatch);
    expect(landed).toEqual(["c1"]);
  });
});