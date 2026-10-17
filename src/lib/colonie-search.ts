// Scoped transcript search for the original SearchResults and CommandPalette,
// over the local server's /api/search route.
import { useMemo, type Dispatch } from "react";
import { api, type Action, type AppState } from "@/state/store";
import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";

/** What opening a hit needs: the store's bots. */
export type SearchNavigationState = Pick<AppState, "bots">;

export function useTranscriptSearch() {
  return useMemo(() => ({
    search: (query: string, limit: number, signal?: AbortSignal, conversationId?: string) =>
      api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}${conversationId ? `&threadId=${encodeURIComponent(conversationId)}` : ""}`, { signal }).then((r) => r.hits ?? []),
    land: (hit: SearchHit, state: SearchNavigationState, dispatch: Dispatch<Action>) => landOnSearchHit(hit, state, dispatch),
  }), []);
}