// Scoped transcript search for the ORIGINAL SearchResults and CommandPalette.
//
// Local mounts no provider, so those components keep their own /api/search
// behavior and markup. The Cloud shell mounts PlatformSearchProvider with a
// workspace-scoped port; the same components then search authorized Cloud
// transcripts and never touch the legacy /api/search, task or branch routes.
import { createContext, createElement, useContext, useMemo, type Dispatch, type ReactNode } from "react";
import { api, type Action, type AppState } from "@/state/store";
import { landOnSearchHit } from "@/lib/focus-message";
import type { SearchHit } from "@/lib/search-hit";
import { searchHitFromPlatform, type PlatformClient } from "@/lib/colonie-platform";

/** What the default Local navigation needs to open a hit. A Cloud port ignores it. */
export type SearchNavigationState = Pick<AppState, "bots" | "groups">;

export interface TranscriptSearchPort {
  /** Bounded transcript search. The port decides where hits come from. */
  search(query: string, limit: number, signal?: AbortSignal, conversationId?: string): Promise<SearchHit[]>;
  /**
   * Open a hit. The default navigates the Local store; a Cloud port ignores the
   * Local state/dispatch and moves the Cloud shell instead.
   */
  land(hit: SearchHit, state: SearchNavigationState, dispatch: Dispatch<Action>): Promise<void>;
}

const SearchPortContext = createContext<Partial<TranscriptSearchPort> | null>(null);

/**
 * Mounted by the Cloud shell around the original UI. Pass a stable `port`
 * (useMemo/useCallback): an identity that changes every render would re-run the
 * components' search effects.
 */
export function PlatformSearchProvider({ port, children }: { port: TranscriptSearchPort; children?: ReactNode }): ReactNode {
  return createElement(SearchPortContext.Provider, { value: port }, children);
}

/** The port in scope: the Local default unless a Cloud provider is mounted. */
export function useTranscriptSearch(): TranscriptSearchPort {
  const provided = useContext(SearchPortContext);
  const search = provided?.search;
  const land = provided?.land;
  return useMemo(
    () => ({
      search: search ?? ((query: string, limit: number, signal?: AbortSignal, conversationId?: string) =>
        api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}${conversationId ? `&threadId=${encodeURIComponent(conversationId)}` : ""}`, { signal }).then((r) => r.hits ?? [])),
      land: land ?? ((hit: SearchHit, state: SearchNavigationState, dispatch: Dispatch<Action>) => landOnSearchHit(hit, state, dispatch)),
    }),
    [search, land],
  );
}

/**
 * A workspace-scoped Cloud port over one PlatformClient. `land` is the shell's
 * own navigation (select the conversation, page around `hit.sequence`); it
 * receives a hit whose `threadId` is the conversation id.
 */
export function createPlatformSearchPort(input: {
  client: PlatformClient;
  workspaceId: string;
  land: (hit: SearchHit) => Promise<void> | void;
}): TranscriptSearchPort {
  return {
    async search(query, limit, signal, conversationId) {
      const hits = await input.client.search(input.workspaceId, query, { limit, signal, ...(conversationId ? { conversationId } : {}) });
      return hits.map(searchHitFromPlatform);
    },
    async land(hit) {
      await input.land(hit);
    },
  };
}
