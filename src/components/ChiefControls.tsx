// The Chief profile card: whether this bot is the Chief, and a plain action to
// transfer the role to it. No team switches, hashes or transport copy — the
// person just needs to know the Chief can create, change, delete and ask other
// bots and manage their guides. A stale response (another bot, or an unmounted
// profile) is guarded by a request sequence, and a conflicted transfer keeps
// the person's view instead of claiming success.
import { SparklesIcon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ApiError, api, type Bot } from "@/state/store";
import type { ChiefView } from "../../shared/colonie-chief";
import { HIcon } from "./HIcon";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";

export interface ChiefControlsState {
  view: ChiefView | null;
  error: string | null;
}

export const initialChiefControlsState: ChiefControlsState = { view: null, error: null };

export type ChiefControlsAction =
  | { type: "reset" }
  | { type: "loaded"; view: ChiefView; seq: number; current: number }
  | { type: "failed"; error: string; seq: number; current: number };

/** Drop a response for a bot this panel no longer shows, or after unmount. */
export function chiefControlsReducer(state: ChiefControlsState, action: ChiefControlsAction): ChiefControlsState {
  switch (action.type) {
    case "reset":
      return initialChiefControlsState;
    case "loaded":
      return action.seq === action.current ? { view: action.view, error: null } : state;
    case "failed":
      return action.seq === action.current ? { ...state, error: action.error } : state;
  }
}

export function isChief(view: ChiefView | null, botId: string): boolean {
  return view?.chief?.id === botId;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ChiefControls({ bot }: { bot: Bot }) {
  const [state, dispatch] = useReducer(chiefControlsReducer, initialChiefControlsState);
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const current = ++seq.current;
    try {
      const view = await api<ChiefView>("/api/colonie/chief");
      if (current !== seq.current) return;
      dispatch({ type: "loaded", view, seq: current, current: seq.current });
    } catch (cause) {
      if (current !== seq.current) return;
      dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
    }
  }, []);

  useEffect(() => {
    seq.current += 1;
    dispatch({ type: "reset" });
    setSaving(false);
    void load();
    return () => {
      seq.current += 1;
    };
  }, [bot.id, load]);

  const makeChief = async () => {
    const view = state.view;
    if (!view || saving) return;
    const current = seq.current;
    setSaving(true);
    try {
      const next = await api<ChiefView>("/api/colonie/chief", { method: "PUT", body: JSON.stringify({ botId: bot.id, expectedRevision: view.revision }) });
      if (current !== seq.current) return;
      dispatch({ type: "loaded", view: next, seq: current, current: seq.current });
    } catch (cause) {
      if (current !== seq.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        await load();
        dispatch({ type: "failed", error: cause.message, seq: seq.current, current: seq.current });
      } else {
        dispatch({ type: "failed", error: messageOf(cause), seq: current, current: seq.current });
      }
    } finally {
      setSaving(false);
    }
  };

  const chief = isChief(state.view, bot.id);
  return (
    <div className="rounded-xl border border-hairline/40 bg-card p-4">
      <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <HIcon icon={SparklesIcon} className="h-4 w-4 text-ink-secondary" />
        <span>Chief</span>
      </div>
      {state.error ? <p className="mt-2 text-[12.5px] text-danger">{state.error}</p> : null}
      {chief ? (
        <p className="mt-2 text-[13px] text-ink-secondary">
          {bot.name} is the Chief. The Chief can create, change, delete and ask other bots, and manage their guides.
        </p>
      ) : state.view?.chief ? (
        <>
          <p className="mt-2 text-[13px] text-ink-secondary">
            {state.view.chief.name} is the Chief. Making {bot.name} the Chief transfers the role — {state.view.chief.name} becomes an
            ordinary bot.
          </p>
          <button type="button" className={`${buttonCls} mt-3`} onClick={() => void makeChief()} disabled={saving}>
            {saving ? "Transferring…" : "Make Chief"}
          </button>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-ink-secondary">Loading the Chief role…</p>
      )}
    </div>
  );
}