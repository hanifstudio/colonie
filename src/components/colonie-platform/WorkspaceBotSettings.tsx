/** The original bot settings panel with workspace-scoped persistence. */
import { useCallback, useEffect, useRef, useState } from "react";
import { BotSettingsDialog } from "@/components/BotSettingsDialog";
import { BotEditorContext } from "@/components/bot-settings/BotEditorContext";
import { BotEditorStore, api, useStore, type Action, type AppState } from "@/state/store";
import { classicBot } from "@/lib/colonie-classic-ui";
import type { PlatformBot, PlatformClient } from "@/lib/colonie-platform";
import { platformBotUpdateSchema, type PlatformBotUpdate } from "../../../shared/colonie-bot-profile";

export function WorkspaceBotSettings({ bot, client, canEdit, onSaved, onClose, overlay = false }: {
  bot: PlatformBot; client: PlatformClient; canEdit: boolean;
  overlay?: boolean;
  onSaved: (bot: PlatformBot) => void; onClose: () => void;
}) {
  const parent = useStore();
  const [draft, setDraft] = useState(bot);
  const [section, setSection] = useState<AppState["botSettingsSection"]>("overview");
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const lane = useRef<{ pending: PlatformBotUpdate; running: Promise<PlatformBot> | null; timer?: ReturnType<typeof setTimeout> }>({ pending: {}, running: null });
  const alive = useRef(true);
  const callbacks = useRef({ onSaved, onClose });
  callbacks.current = { onSaved, onClose };

  const flush = useCallback(async function flushQueue(): Promise<null> {
    const queue = lane.current;
    clearTimeout(queue.timer);
    if (queue.running) { await queue.running; return flushQueue(); }
    if (!Object.keys(queue.pending).length) return null;
    const patch = queue.pending;
    queue.pending = {};
    if (alive.current) { setStatus("saving"); setError(null); }
    queue.running = client.updateBot(bot.workspaceId, bot.id, patch);
    try {
      const saved = await queue.running;
      if (alive.current) {
        setDraft({ ...saved, ...queue.pending });
        callbacks.current.onSaved(saved);
        setStatus(Object.keys(queue.pending).length ? "saving" : "saved");
      }
    } catch (failure) {
      // Keep rejected edits for correction/retry, including edits made while
      // the request was in flight. A late response cannot erase newer typing.
      queue.pending = { ...patch, ...queue.pending };
      if (alive.current) {
        setStatus("error");
        setError(failure instanceof Error ? failure.message : "Your changes could not be saved.");
      }
      throw failure;
    } finally { queue.running = null; }
    return flushQueue();
  }, [bot.id, bot.workspaceId, client]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(lane.current.timer);
      // A workspace switch never sends these edits to the new workspace.
      void flush().catch(() => {});
    };
  }, [flush]);

  const close = useCallback(() => { void flush().then(() => { if (alive.current) callbacks.current.onClose(); }).catch(() => {}); }, [flush]);
  const dispatch = useCallback((action: Action) => {
    if (action.type === "toggleSettings") {
      if (action.open === false) { close(); return; }
      if (action.section) setSection(action.section);
      setExpanded(Boolean(action.section));
    } else if (action.type === "updateBot" && action.botId === bot.id && canEdit) {
      // The editor may temporarily hold an empty name. Server validation
      // refuses it, displays the failure and keeps the draft for correction.
      const patch = Object.fromEntries(Object.entries(action.patch).filter(([key, value]) => value !== undefined && key in platformBotUpdateSchema.shape)) as PlatformBotUpdate;
      lane.current.pending = { ...lane.current.pending, ...patch };
      setDraft((previous) => ({ ...previous, ...patch }));
      setStatus("saving");
      clearTimeout(lane.current.timer);
      lane.current.timer = setTimeout(() => { void flush().catch(() => {}); }, 400);
    } else if (action.type === "error") { setStatus("error"); setError(action.message); }
  }, [bot.id, canEdit, close, flush]);
  const presented = classicBot(draft);
  const state = { ...parent.state, bots: parent.state.bots.map((entry) => entry.id === bot.id ? presented : entry),
    selectedId: bot.id, botSettingsSection: section, botSettingsExpandAccordion: expanded };
  return <BotEditorStore value={{ ...parent, state, dispatch, flushBotPatches: flush }}>
    <BotEditorContext.Provider value={{ workspace: true, readOnly: !canEdit,
      request: (() => Promise.reject(new Error("This profile does not use a local bot API."))) as typeof api,
      uploadAvatar: (file) => client.uploadBotAvatar(bot.workspaceId, bot.id, file) }}>
      <BotSettingsDialog bot={presented} overlay={overlay} saveStatus={<div className="shrink-0 border-t border-hairline/40 px-4 py-3 text-[12px] text-ink-secondary">
        {!canEdit ? <p>Only workspace owners and admins can edit this bot.</p> : status === "error" ? <div role="alert">
          <p className="text-danger">{error} Your changes have not been saved.</p>
          <button type="button" className="mt-2 rounded-lg bg-control px-3 py-1.5 text-ink" onClick={() => void flush().catch(() => {})}>Retry save</button>
          <button type="button" className="ml-2 mt-2 rounded-lg px-3 py-1.5 text-ink" onClick={() => { lane.current.pending = {}; setDraft(bot); setStatus("saved"); setError(null); }}>Discard changes</button>
        </div> : <p role="status">{status === "saving" ? "Saving changes…" : "All changes saved"}</p>}
      </div>} />
    </BotEditorContext.Provider>
  </BotEditorStore>;
}
