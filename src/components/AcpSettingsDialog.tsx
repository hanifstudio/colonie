import { useCallback, useEffect, useRef, useState } from "react";
import { MultiplicationSignIcon, RefreshCwIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api, useStore } from "@/state/store";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import type { NativeSettings, NativeSettingChange } from "../../shared/acp-settings";
import { useDeveloperTools } from "@/lib/developer-tools";

export function AcpSettingsDialog({ botId, threadId, onClose }: { botId: string; threadId: string; onClose: () => void }) {
  const { refreshInstances } = useStore();
  const developerTools = useDeveloperTools();
  const dialog = useRef<HTMLElement>(null);
  useModalDialog(dialog, onClose);
  const [state, setState] = useState<NativeSettings | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    controller.current?.abort();
    const own = new AbortController(); controller.current = own;
    setPending(true); setError("");
    try {
      const snapshot = await api(`/api/bots/${botId}/acp-settings`, { method: "POST", body: JSON.stringify({ threadId }), signal: own.signal }) as NativeSettings;
      if (!own.signal.aborted && alive.current) { setState(snapshot); void refreshInstances(); }
    } catch (cause) { if (!own.signal.aborted && alive.current) setError((cause as Error).message); }
    finally { if (!own.signal.aborted && alive.current) setPending(false); }
  }, [botId, threadId, refreshInstances]);
  useEffect(() => {
    alive.current = true; void load();
    return () => { alive.current = false; controller.current?.abort(); };
  }, [load]);
  const change = async (selection: { kind: "mode"; value: string } | { kind: "option"; configId: string; value: string | boolean }) => {
    if (!state || pending) return;
    setPending(true); setError("");
    const request: NativeSettingChange & { threadId: string } = { ...selection, sessionId: state.sessionId, expectedRevision: state.revision, threadId };
    try {
      const snapshot = await api(`/api/bots/${botId}/acp-settings`, { method: "PATCH", body: JSON.stringify(request) }) as NativeSettings;
      if (alive.current) { setState(snapshot); void refreshInstances(); }
    } catch (cause) { if (alive.current) setError((cause as Error).message); }
    finally { if (alive.current) setPending(false); }
  };
  const inputClass = "mt-2 w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-sm text-ink disabled:opacity-50";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5" onClick={onClose}>
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Native agent settings" className="flex max-h-[85vh] w-full max-w-xl flex-col rounded-2xl border border-hairline bg-panel p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink">Agent options</h2>
          <div className="flex gap-2">
            <button aria-label="Refresh native settings" disabled={pending} onClick={() => { void load(); }} className="rounded p-2 text-ink-secondary hover:bg-raised disabled:opacity-50"><HIcon icon={RefreshCwIcon} size={18} /></button>
            <button aria-label="Close native settings" onClick={onClose} className="rounded p-2 text-ink-secondary hover:bg-raised"><HIcon icon={MultiplicationSignIcon} size={18} /></button>
          </div>
        </header>
        <p className="my-3 text-sm text-ink-secondary">Choose how your agent works in this conversation. Opening these options does not send a message.</p>
        <div className="space-y-4 overflow-auto">
          {pending && <p role="status" className="text-sm text-ink-secondary">Loading agent options…</p>}
          {error && <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm text-danger">{error}</p>}
          {state?.warnings.map((warning) => <p key={warning} className="rounded-lg bg-warning/10 p-3 text-sm text-warning">{warning}</p>)}
          {state && <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all text-xs text-ink-secondary">{developerTools && <><dt>Provider</dt><dd>{state.instanceId}</dd><dt>Session</dt><dd>{state.sessionId}</dd></>}<dt>Working folder</dt><dd>{state.cwd}</dd></dl>
            <label className="block rounded-lg bg-card p-3 text-sm text-ink">Mode
              <select aria-label="Native mode" className={inputClass} disabled={pending} value={state.modes.currentModeId} onChange={(event) => { void change({ kind: "mode", value: event.target.value }); }}>
                {state.modes.availableModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.name}{developerTools ? ` · ${mode.id}` : ""}</option>)}
              </select>
              <span className="mt-2 block text-xs text-ink-secondary">{state.modes.availableModes.find((mode) => mode.id === state.modes.currentModeId)?.description}</span>
            </label>
            <p className="text-xs text-ink-secondary">Available modes depend on your agent. Changing the app's permission setting also resets the mode.</p>
            {state.options.map((option) => <label key={option.id} data-native-category={option.category ?? option.id} className="block rounded-lg bg-card p-3 text-sm text-ink">
              {option.name}{developerTools && <span className="ml-2 text-xs text-ink-secondary">{option.category ?? option.id}</span>}
              {option.type === "select" ? <select aria-label={`Native ${option.id}`} className={inputClass} disabled={pending} value={String(option.currentValue)} onChange={(event) => { void change({ kind: "option", configId: option.id, value: event.target.value }); }}>
                {option.options.map((entry) => <option key={entry.value} value={entry.value}>{entry.name}</option>)}
              </select> : <input type="checkbox" aria-label={`Native ${option.id}`} disabled={pending} checked={Boolean(option.currentValue)} onChange={(event) => { void change({ kind: "option", configId: option.id, value: event.target.checked }); }} className="ml-3 accent-accent" />}
              {option.description && <span className="mt-2 block text-xs text-ink-secondary">{option.description}</span>}
              {(developerTools || state.warnings.length > 0) && <button type="button" aria-label={`Apply native ${option.id}`} disabled={pending} onClick={() => { void change({ kind: "option", configId: option.id, value: option.currentValue }); }} className="mt-2 block text-xs text-accent hover:underline disabled:opacity-40">Apply displayed value</button>}
            </label>)}
            {!state.options.some((option) => option.category === "thought_level") && <p className="text-xs text-ink-secondary">This agent/model does not offer reasoning effort controls in the current snapshot.</p>}
          </>}
        </div>
      </section>
    </div>
  );
}
