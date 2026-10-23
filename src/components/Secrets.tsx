// Secrets: a person's keys and passwords for their bots (server:
// colonie/secrets). A bot asks with a card under its reply (SecretAsk); the
// form (SecretDialog) saves the value straight to the server, so it never
// enters the chat; Settings → AI → Secrets lists them (SecretsSettings).
// The card and form reuse the shapes already in the app: the secure-key card
// of SecretRequestCard and the dialog shell of ConfirmDialog.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Delete02Icon, Key01Icon, Tick01Icon, ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { api, useStore, type Message } from "@/state/store";

export interface SecretView { name: string; description: string; bots: string[]; updatedAt: number; lastUsedAt?: number }

const inputCls = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-tertiary focus:border-accent/60 focus:outline-none";
const labelCls = "mb-1.5 block text-[12px] text-ink-secondary";

/** The person's form for one secret: its name, what it is for, the value
 * (hidden as typed), and which bots may use it. */
export function SecretDialog({ open, initial, existing = false, botId, threadId, messageId, onClose, onSaved }: {
  open: boolean;
  /** Changing a saved secret: an empty value keeps the old one. */
  existing?: boolean;
  initial?: { name?: string; description?: string; bots?: string[] };
  /** Asked by this bot: it may use the secret, and its card is answered. */
  botId?: string;
  threadId?: string;
  messageId?: string;
  onClose: () => void;
  onSaved?: (secret: SecretView) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [bots, setBots] = useState<string[]>(initial?.bots ?? (botId ? [botId] : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valueRef = useRef<HTMLInputElement>(null);
  const editing = existing;

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? ""); setDescription(initial?.description ?? ""); setValue(""); setShown(false);
    setBots(initial?.bots ?? (botId ? [botId] : [])); setError("");
    requestAnimationFrame(() => valueRef.current?.focus());
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // the dialog resets each time it opens
  }, [open]);
  if (!open) return null;

  const save = async () => {
    setBusy(true); setError("");
    try {
      // changing only which bots may use it keeps the value
      if (editing && !value) {
        const changed = await api<{ secret: SecretView }>(`/api/secrets/${encodeURIComponent(name)}`, { method: "PATCH", body: JSON.stringify({ bots }) });
        onSaved?.(changed.secret);
        onClose();
        return;
      }
      const saved = await api<{ secret: SecretView }>(`/api/secrets/${encodeURIComponent(name.trim().toUpperCase())}`, {
        method: "PUT",
        body: JSON.stringify({ value, description, bots, ...(botId ? { botId } : {}), ...(threadId && messageId ? { threadId, messageId } : {}) }),
      });
      onSaved?.(saved.secret);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  const visibleBots = state.bots.filter((bot) => !bot.hidden);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form role="dialog" aria-modal="true" aria-label={editing ? `Change ${name}` : "Add a secret"}
        onSubmit={(event) => { event.preventDefault(); if (name.trim() && (value || editing)) void save(); }}
        className="w-full max-w-[440px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><HIcon icon={Key01Icon} size={17} /></span>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">{editing ? `Change ${name}` : "Add a secret"}</h2>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">Saved privately. Your bots' scripts can use it; it never appears in the chat or goes to the AI.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <label className="block">
            <span className={labelCls}>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} readOnly={editing || Boolean(initial?.name)}
              placeholder="GMAIL_APP_PASSWORD" className={cn(inputCls, "font-mono text-[13px]", (editing || initial?.name) && "text-ink-secondary")} />
          </label>
          <label className="block">
            <span className={labelCls}>What it's for</span>
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="App password for reading my Gmail" className={inputCls} />
          </label>
          <label className="block">
            <span className={labelCls}>Value</span>
            <div className="relative">
              <input ref={valueRef} type={shown ? "text" : "password"} value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" spellCheck={false}
                placeholder={editing ? "Leave empty to keep the current value" : "Paste it here"} className={cn(inputCls, "pr-10 font-mono text-[13px]")} />
              <button type="button" onClick={() => setShown((now) => !now)} aria-label={shown ? "Hide value" : "Show value"}
                className="absolute right-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink">
                <HIcon icon={shown ? ViewOffSlashIcon : ViewIcon} size={15} />
              </button>
            </div>
          </label>
          {!botId && visibleBots.length > 0 && (
            <fieldset>
              <legend className={labelCls}>Bots that may use it</legend>
              <div className="flex flex-wrap gap-1.5">
                {visibleBots.map((bot) => {
                  const on = bots.includes(bot.id);
                  return (
                    <button key={bot.id} type="button" aria-pressed={on} onClick={() => setBots((list) => on ? list.filter((id) => id !== bot.id) : [...list, bot.id])}
                      className={cn("rounded-full border px-3 py-1 text-[12.5px]", on ? "border-accent/60 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:text-ink")}>
                      {bot.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
        {error && <p role="alert" className="mt-3 text-[12.5px] text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">Cancel</button>
          <button type="submit" disabled={busy || !name.trim() || (!value && !editing)} className="rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** A bot's request for a secret, under its reply: one button opens the form.
 * Once saved, it says so; the next message gives the bot its file. */
export function SecretAsk({ message, threadId, onSaved, canAnswer = true }: {
  message: Message; threadId: string; onSaved?: (name: string) => void;
  /** In a group, only the person the bot asked saves it. */
  canAnswer?: boolean;
}) {
  const ask = message.secretAsk!;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(Boolean(ask.saved));
  useEffect(() => setSaved(Boolean(ask.saved)), [ask.saved]);
  return (
    <div className="flex w-full justify-start" data-secret-ask={ask.name}>
      <div className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-hairline/50 bg-card shadow-sm">
        <div className="flex items-center gap-3 p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-control text-ink"><HIcon icon={Key01Icon} size={19} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-[13px] font-semibold text-ink">{ask.name}</span>
              {saved && <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"><HIcon icon={Tick01Icon} size={11} /> Saved</span>}
            </div>
            {ask.description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-secondary">{ask.description}</p>}
          </div>
          {canAnswer && <button type="button" onClick={() => setOpen(true)}
            className={cn("shrink-0 rounded-xl px-3.5 py-2 text-[13px] font-medium", saved ? "bg-control text-ink hover:bg-raised" : "bg-accent text-white hover:brightness-110")}>
            {saved ? "Change" : "Add secret"}
          </button>}
        </div>
      </div>
      <SecretDialog open={open} existing={saved} initial={{ name: ask.name, description: ask.description }} botId={ask.botId} threadId={threadId} messageId={message.id}
        onClose={() => setOpen(false)} onSaved={() => { setSaved(true); onSaved?.(ask.name); }} />
    </div>
  );
}

/** Settings → AI → Secrets: the person's own, by name, with the bots that
 * may use each; values are never shown again. */
export function SecretsSettings() {
  const { state } = useStore();
  const [secrets, setSecrets] = useState<SecretView[] | null>(null);
  const [dialog, setDialog] = useState<{ name?: string; description?: string; bots?: string[] } | null>(null);
  const [error, setError] = useState("");
  const load = () => void api<{ secrets: SecretView[] }>("/api/secrets").then((body) => setSecrets(body.secrets)).catch((cause) => setError(String(cause instanceof Error ? cause.message : cause)));
  useEffect(load, []);
  const botName = (id: string) => state.bots.find((bot) => bot.id === id)?.name;
  const remove = async (name: string) => {
    setError("");
    try { await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" }); load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <Card title="Secrets" subtitle="Keys and passwords your bots can use without seeing them in a chat. A bot asks when it needs one; you can also add one here.">
      <div className="flex flex-col gap-3">
        {secrets && secrets.length > 0 && (
          <div className="divide-y divide-hairline/40 overflow-hidden rounded-lg border border-hairline/40">
            {secrets.map((secret) => (
              <div key={secret.name} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-ink">{secret.name}</div>
                  {secret.description && <div className="mt-0.5 truncate text-[12px] text-ink-secondary">{secret.description}</div>}
                  <div className="mt-0.5 truncate text-[11.5px] text-ink-tertiary">
                    {secret.bots.map(botName).filter(Boolean).join(", ") || "No bot may use it yet"}
                  </div>
                </div>
                <button type="button" onClick={() => setDialog({ name: secret.name, description: secret.description, bots: secret.bots })}
                  className="shrink-0 rounded-md px-2 py-1 text-[12.5px] text-ink-secondary hover:bg-control hover:text-ink">Change</button>
                <button type="button" aria-label={`Remove ${secret.name}`} onClick={() => void remove(secret.name)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-danger/10 hover:text-danger"><HIcon icon={Delete02Icon} size={15} /></button>
              </div>
            ))}
          </div>
        )}
        {secrets && secrets.length === 0 && <div className="rounded-lg bg-inset px-3 py-2 text-[12.5px] text-ink-secondary">No secrets yet.</div>}
        {error && <p role="alert" className="text-[12.5px] text-danger">{error}</p>}
        <button type="button" onClick={() => setDialog({})} className="self-start rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised">Add a secret</button>
      </div>
      <SecretDialog open={dialog !== null} existing={Boolean(dialog?.name)} initial={dialog ?? undefined} onClose={() => setDialog(null)} onSaved={load} />
    </Card>
  );
}
