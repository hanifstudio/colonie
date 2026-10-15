// The search port the original SearchResults and CommandPalette consume. Local
// has one behavior: the /api/search route. The store and the land helper are
// mocked so this stays a pure unit test of the port.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args) }));
vi.mock("@/lib/focus-message", () => ({ landOnSearchHit: vi.fn(async () => {}) }));

import { useTranscriptSearch } from "./colonie-search";
import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "./search-hit";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  return { name: "N", threadId: "t1", messageId: "m1", role: "user", kind: "text", at: 0, snippet: "s", matchStart: 0, matchLength: 1, onActivePath: true, ...overrides };
}

/** Render the hook and return the port it saw. */
function renderPort() {
  let captured!: ReturnType<typeof useTranscriptSearch>;
  const Probe = () => {
    captured = useTranscriptSearch();
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return captured;
}

const state = { bots: [], groups: [] };
const dispatch = (() => {}) as never;

beforeEach(() => vi.clearAllMocks());

describe("useTranscriptSearch", () => {
  it("queries /api/search and lands the hit in the local store", async () => {
    api.mockResolvedValue({ hits: [hit()] });
    const port = renderPort();

    const hits = await port.search("hello world", 40);
    expect(api).toHaveBeenCalledWith("/api/search?q=hello%20world&limit=40", { signal: undefined });
    expect(hits).toHaveLength(1);

    await port.land(hit(), state, dispatch);
    expect(landOnSearchHit).toHaveBeenCalledTimes(1);
  });

  it("scopes the query to a conversation when asked", async () => {
    api.mockResolvedValue({ hits: [] });
    const port = renderPort();

    await port.search("dinner", 12, undefined, "t9");
    expect(api).toHaveBeenCalledWith("/api/search?q=dinner&limit=12&threadId=t9", { signal: undefined });
  });
});