// This workspace's apps. A person connects their own apps through Composio's
// hosted OAuth page (never by pasting a provider key); an owner or admin sets
// the workspace's project key once so the workspace has its own app project.
// A link counts as connected only after Composio verifies the callback, so a
// pending link says "waiting", never "connected".
import { useCallback, useEffect, useState } from "react";
import { Plug01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { Badge, Button, Field, Notice, Select, Spinner, TextInput } from "./ui";
import {
  COMPOSIO_TOOLKITS,
  composioErrorMessage,
  composioToolkit,
  connectionAudienceLabel,
  connectionLinkLabel,
  connectionLinkTone,
  forgetLinkState,
  localWorkspaceBridge,
  rememberLinkState,
  type ConnectionLinkAudience,
  type PlatformClient,
  type PlatformComposioStatus,
  type PlatformConnectionLink,
} from "@/lib/colonie-platform";

/** Send the person to the provider's OAuth page in this same window. A new tab
 * or an external browser would lose this tab's pending attempt, so the desktop
 * bridge navigates its own window when it can, and the browser navigates here.
 * A rejected navigation tells the caller, which must not claim it opened. */
async function openProviderPage(url: string): Promise<void> {
  const bridge = localWorkspaceBridge();
  if (bridge?.authorizeApp) {
    await bridge.authorizeApp(url);
    return;
  }
  const location = globalThis.window?.location;
  if (!location || typeof location.assign !== "function") {
    throw new Error("This window cannot open the app connection page.");
  }
  location.assign(url);
}

export function ConnectedApps({
  workspaceId,
  canManage,
  client,
}: {
  workspaceId: string;
  canManage: boolean;
  client: PlatformClient;
}) {
  const [status, setStatus] = useState<PlatformComposioStatus | null>(null);
  const [links, setLinks] = useState<PlatformConnectionLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState(false);
  const [apiKey, setApiKey] = useState("");

  const [toolkit, setToolkit] = useState<string>(COMPOSIO_TOOLKITS[0].id);
  const [audience, setAudience] = useState<ConnectionLinkAudience>("personal");
  const [started, setStarted] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, list] = await Promise.all([client.composioStatus(workspaceId), client.listConnectionLinks(workspaceId)]);
      setStatus(next);
      setLinks(list);
    } catch (cause) {
      setError(composioErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(composioErrorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const configured = Boolean(status?.configured);

  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">
        <HIcon icon={Plug01Icon} size={13} aria-hidden="true" /> Apps
      </h3>

      {error && <Notice tone="error">{error}</Notice>}
      {status?.setupUnavailableReason ? <Notice>{status.setupUnavailableReason}</Notice> : null}

      {canManage ? (
        <div className="space-y-2 rounded-xl border border-hairline bg-inset/40 p-3">
          <p className="text-[12.5px] font-medium">Workspace setup</p>
          {status?.configured ? (
            <>
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                This workspace has its own app project{status.maskedHint ? `, key ${status.maskedHint}` : ""}. Only owners and admins see this line.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" className="px-2 py-1 text-[12px]" onClick={() => setEditingKey((open) => !open)}>
                  {editingKey ? "Keep key" : "Replace key"}
                </Button>
                <Button variant="ghost" className="px-2 py-1 text-[12px]" busy={busy === "remove-key"} onClick={() => void run("remove-key", async () => { await client.removeComposioKey(workspaceId); setEditingKey(false); await load(); })}>
                  Remove key
                </Button>
                {status.canProvision ? (
                  <Button variant="secondary" className="px-2 py-1 text-[12px]" busy={busy === "provision"} onClick={() => void run("provision", async () => { await client.provisionComposio(workspaceId); await load(); })}>
                    Set up a new project
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                {status?.canProvision
                  ? "This workspace has no app project yet. This server can create one for it — no key needed — or an owner or admin can paste a project key instead."
                  : "Apps are not set up in this workspace yet. An owner or admin adds the workspace's Composio project key here; the server stores it and never shows it again."}
              </p>
              {status?.canProvision ? (
                <Button variant="secondary" className="px-2 py-1 text-[12px]" busy={busy === "provision"} onClick={() => void run("provision", async () => { await client.provisionComposio(workspaceId); await load(); })}>
                  Set up a project
                </Button>
              ) : null}
            </div>
          )}

          {(editingKey || !status?.configured) && !loading ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Field label="Workspace project key" hint="A Composio key that can manage sessions.">
                  <TextInput type="password" aria-label="Workspace project key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" placeholder="ak_…" />
                </Field>
              </div>
              <Button
                variant="secondary"
                busy={busy === "key"}
                disabled={!apiKey.trim()}
                onClick={() => void run("key", async () => {
                  await client.setComposioKey(workspaceId, apiKey.trim());
                  setApiKey("");
                  setEditingKey(false);
                  await load();
                })}
              >
                Save key
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading && !status ? (
        <Spinner />
      ) : (
        <>
          <div>
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Connections</p>
            {links.length ? (
              <ul className="space-y-1.5">
                {links.map((link) => (
                  <li key={link.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-inset/40 px-3 py-2">
                    <span className="flex size-7 items-center justify-center rounded-lg bg-raised text-ink-secondary">
                      <HIcon icon={Plug01Icon} size={14} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{composioToolkit(link.toolkit)?.label ?? link.toolkit}</div>
                      <div className="truncate text-[11.5px] text-ink-tertiary">
                        {connectionAudienceLabel(link.audience)}
                        {composioToolkit(link.toolkit) ? "" : " · Connection only"}
                      </div>
                    </div>
                    <Badge tone={connectionLinkTone(link)}>{connectionLinkLabel(link)}</Badge>
                    {canManage || link.ownedByMe ? (
                      <Button variant="ghost" className="px-2 py-1 text-[12px]" busy={busy === link.id} onClick={() => void run(link.id, async () => { await client.removeConnectionLink(workspaceId, link.id); await load(); })}>
                        Remove
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-ink-tertiary">No apps are connected in this workspace yet.</p>
            )}
          </div>

          {!configured ? (
            <p className="text-[12.5px] text-ink-secondary">
              {canManage
                ? "Add the workspace's project key above before anyone connects an app."
                : "Apps for this workspace are set up by owners and admins. Until then there is nothing to connect."}
            </p>
          ) : started ? (
            <div className="space-y-2 rounded-xl border border-hairline bg-inset/40 p-3">
              <p className="text-[12.5px] leading-relaxed text-ink-secondary">
                Finish the connection in the app page. It stays waiting until Composio confirms it.
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" busy={busy === "reload"} onClick={() => void run("reload", async () => { await load(); setStarted(null); })}>
                  I have finished
                </Button>
                <Button variant="ghost" onClick={() => { forgetLinkState(); setStarted(null); }}>
                  Start over
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2 rounded-xl border border-hairline bg-inset/40 p-3">
              <p className="text-[12px] leading-relaxed text-ink-secondary">
                Read only: Colonie can read this data. It cannot send, edit or delete anything.
              </p>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="Connect an app" hint={composioToolkit(toolkit)?.summary}>
                    <Select aria-label="App toolkit" value={toolkit} onChange={(e) => setToolkit(e.target.value)}>
                      {COMPOSIO_TOOLKITS.map((entry) => (
                        <option key={entry.id} value={entry.id}>{entry.label}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                {canManage ? (
                  <div className="w-52">
                    <Field label="Who can use it">
                      <Select aria-label="Who can use it" value={audience} onChange={(e) => setAudience(e.target.value as ConnectionLinkAudience)}>
                        <option value="personal">Only me</option>
                        <option value="shared">Everyone in this workspace</option>
                      </Select>
                    </Field>
                  </div>
                ) : null}
                <Button
                  variant="secondary"
                  busy={busy === "connect"}
                  disabled={!toolkit.trim()}
                  onClick={() => void run("connect", async () => {
                    const attempt = await client.connectApp(workspaceId, { toolkit: toolkit.trim(), audience });
                    // The opaque state is kept for this tab only so the callback
                    // can be matched; the session URI never touches the renderer.
                    rememberLinkState({ workspaceId, state: attempt.state });
                    // Same-window navigation, so the attempt above is still here
                    // when the provider returns. A failure is reported, not hidden.
                    await openProviderPage(attempt.redirectUrl);
                    setStarted(attempt.link.id);
                    await load();
                  })}
                >
                  Connect
                </Button>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-secondary">{connectionAudienceLabel(canManage ? audience : "personal")}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
