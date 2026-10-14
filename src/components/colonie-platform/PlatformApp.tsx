// Root of the Colonie platform shell. It boots a session, keeps a pending
// invitation through auth, routes to Cloud or Local, and never renders a Local
// engine/store surface on a Cloud origin: a Local workspace is opened through
// the native bridge, which loads its own server and welcome flow.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthScreen, BootScreen } from "./AuthScreen";
import { RecoveryKeyDialog, RecoveryKeyStep } from "./AccountRecovery";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceShell } from "./WorkspaceShell";
import { Notice } from "./ui";
import {
  clearComposioCallbackUrl, composioCallbackParams, composioErrorMessage, composioToolkit, invitationTokenFromLocation,
  isComposioCallback, localWorkspaceBridge, mergeWorkspaceViews, takeLinkState,
  PlatformApiError, PlatformClient,
  type LocalWorkspaceBridge, type PlatformAccount, type PlatformWorkspace, type WorkspaceView,
} from "@/lib/colonie-platform";

export interface PlatformAppProps {
  /** Absolute origin of the Cloud platform; empty means same-origin. */
  platformOrigin?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** A pre-built client (tests); otherwise one is created from the above. */
  client?: PlatformClient;
  /** The current URL, injectable for tests; defaults to window.location. */
  location?: { pathname?: string; search?: string; origin?: string };
  /** An explicit pending invitation token; defaults to the URL. */
  inviteToken?: string | null;
  /** Native Local bridge; defaults to window.ogb.colonieWorkspaces. */
  localBridge?: LocalWorkspaceBridge | null;
  /** Opens the native Local workspace (its own server + welcome flow). The
   * default calls the bridge's `open`. */
  openLocalApp?: (workspaceId: string) => void | Promise<void>;
  /** Overrides the shared stop route for conversations. */
  stopConversation?: (conversationId: string) => Promise<void>;
  onSignedOut?: () => void;
}

export function PlatformApp({
  platformOrigin,
  fetchImpl,
  client: providedClient,
  location: providedLocation,
  inviteToken,
  localBridge,
  openLocalApp,
  stopConversation,
  onSignedOut,
}: PlatformAppProps) {
  const client = useMemo(
    () => providedClient ?? new PlatformClient({ platformOrigin, fetchImpl }),
    [providedClient, platformOrigin, fetchImpl],
  );

  const here = providedLocation ?? (typeof window !== "undefined" ? window.location : undefined);
  const fromUrl = inviteToken === undefined;
  const bridge = localBridge !== undefined ? localBridge : localWorkspaceBridge();

  const inviteRef = useRef<string | null>(fromUrl ? invitationTokenFromLocation(here) : inviteToken ?? null);
  const [pendingInvite, setPendingInvite] = useState<string | null>(inviteRef.current);

  const [phase, setPhase] = useState<"booting" | "auth" | "recovery" | "choosing" | "shell">("booting");
  const [account, setAccount] = useState<PlatformAccount | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cloud" | "local" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A freshly created account gets its recovery key shown exactly once, before
  // anything else. It is held in memory for that screen only.
  const [newRecoveryKey, setNewRecoveryKey] = useState<string | null>(null);
  const [recoveryAccount, setRecoveryAccount] = useState<PlatformAccount | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const openLocal = useCallback(async (workspaceId: string) => {
    if (openLocalApp) return openLocalApp(workspaceId);
    const active = bridgeRef.current;
    if (!active) throw new Error("Local workspaces need the Colonie desktop app.");
    await active.open(workspaceId);
  }, [openLocalApp]);
  const openLocalRef = useRef(openLocal);
  openLocalRef.current = openLocal;

  // The one boot: an existing session goes straight through, otherwise sign in.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await client.session();
        if (cancelled) return;
        if (!session) {
          setPhase("auth");
          return;
        }
        await afterAuthenticated(session.user);
      } catch {
        if (!cancelled) setPhase("auth");
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Composio returns the browser here with a single-use session URI and no
  // state. The URI is read, immediately dropped from the address bar, and kept
  // in memory only; the state it is matched against stays in this tab until a
  // signed-in member can confirm it. Nothing is fabricated when either part is
  // missing.
  const capturedCallback = useRef(false);
  const [callbackUri, setCallbackUri] = useState<string | null>(null);
  useEffect(() => {
    if (capturedCallback.current || !isComposioCallback(here?.pathname)) return;
    capturedCallback.current = true;
    const uri = composioCallbackParams(here?.search);
    clearComposioCallbackUrl();
    if (!uri) {
      setNotice("The app page did not send a session back, so this connection cannot be confirmed. Start it again from workspace settings.");
      return;
    }
    setCallbackUri(uri.sessionUri);
  }, [client, here]);

  // Confirmation waits for a session: a signed-out member keeps the pending
  // attempt and it resumes after sign-in.
  useEffect(() => {
    if (!callbackUri || !account) return;
    const uri = callbackUri;
    setCallbackUri(null);
    const attempt = takeLinkState();
    if (!attempt) {
      setNotice("That app connection was not started in this tab, so it was not confirmed. Start the connection again from workspace settings.");
      return;
    }
    void (async () => {
      try {
        const link = await client.completeAppConnection(attempt.workspaceId, { state: attempt.state, sessionUri: uri });
        const named = composioToolkit(link.toolkit)?.label ?? link.toolkit;
        setNotice(link.status === "active" ? `${named} is connected.` : `${named} is still waiting for confirmation. Check Apps in workspace settings.`);
      } catch (cause) {
        setNotice(composioErrorMessage(cause));
      }
    })();
  }, [account, callbackUri, client]);

  // A link-derived token is consumed once; drop it from the address bar.
  useEffect(() => {
    if (!fromUrl || !inviteRef.current || typeof window === "undefined" || !window.history?.replaceState) return;
    try {
      const url = new URL(window.location.href);
      if (url.pathname.startsWith("/invite/")) url.pathname = "/";
      url.searchParams.delete("colonieInvite");
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* leaving the URL untouched is harmless */
    }
  }, [fromUrl]);

  const afterAuthenticated = useCallback(async (user: PlatformAccount) => {
    setAccount(user);
    setError(null);
    let cloud: PlatformWorkspace[] = [];
    try {
      cloud = await client.listWorkspaces();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your workspaces could not be loaded.");
    }
    const activeBridge = bridgeRef.current;
    const local = activeBridge ? await activeBridge.list().catch(() => []) : [];
    let views = mergeWorkspaceViews(cloud, local);

    const token = inviteRef.current;
    if (token) {
      inviteRef.current = null;
      setPendingInvite(null);
      try {
        const accepted = await client.acceptInvitation(token);
        setNotice(`You joined ${accepted.workspace.name}.`);
        cloud = await client.listWorkspaces().catch(() => cloud);
        views = mergeWorkspaceViews(cloud, local);
        setActiveId(accepted.workspace.id);
      } catch (cause) {
        setError(invitationError(cause));
      }
    }

    setWorkspaces(views);
    if (!views.length) {
      setPhase("choosing");
      return;
    }
    setActiveId((current) => current ?? views[0]!.id);
    setPhase("shell");
  }, [client]);

  // A brand new account gets one chance to save its recovery key, right after
  // signup. If the server does not hand one out, do not pretend: move on.
  const showRecoveryKey = useCallback(async (user: PlatformAccount) => {
    try {
      const secret = await client.createRecoveryKey();
      setRecoveryAccount(user);
      setNewRecoveryKey(secret.recoveryKey);
      setPhase("recovery");
    } catch {
      await afterAuthenticated(user);
    }
  }, [client, afterAuthenticated]);

  async function createCloud(name: string) {
    setBusy("cloud");
    setError(null);
    try {
      const workspace = await client.createWorkspace({ name, kind: "cloud" });
      setWorkspaces((prev) => [{ id: workspace.id, name: workspace.name, kind: "cloud", myRole: workspace.myRole }, ...prev]);
      setActiveId(workspace.id);
      setPhase("shell");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be created.");
    } finally {
      setBusy(null);
    }
  }

  // Local: create through the bridge, then let the bridge open the workspace's
  // own native server (which runs the existing welcome flow: engine, first bot,
  // chat). Nothing is rendered into this Cloud-origin page.
  async function createLocal(name: string) {
    const active = bridgeRef.current;
    if (!active) {
      setError("Local workspaces need the Colonie desktop app.");
      return;
    }
    setBusy("local");
    setError(null);
    try {
      const workspace = await active.create({ name });
      setWorkspaces((prev) => [...prev, { id: workspace.id, name: workspace.name, kind: "local", myRole: "owner", local: true }]);
      await openLocalRef.current(workspace.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The Local workspace could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function selectWorkspace(id: string) {
    const target = workspaces.find((workspace) => workspace.id === id);
    if (!target) return;
    if (target.local) {
      setError(null);
      try {
        await openLocalRef.current(id);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "That Local workspace could not be opened.");
      }
      return;
    }
    setActiveId(id);
    setPhase("shell");
  }

  async function signOut() {
    try {
      await client.signOut();
    } catch {
      /* the local session is cleared regardless */
    }
    // The desktop's verified account is cleared by main, never by the renderer.
    try {
      await bridgeRef.current?.signOut?.();
    } catch {
      /* signing out locally still proceeds */
    }
    inviteRef.current = null;
    setPendingInvite(null);
    setAccount(null);
    setWorkspaces([]);
    setActiveId(null);
    setPhase("auth");
    onSignedOut?.();
  }

  if (phase === "booting") return <BootScreen />;

  if (phase === "auth") {
    return <AuthScreen client={client} invitePending={Boolean(pendingInvite)} onAuthenticated={(user, created) => void (created ? showRecoveryKey(user) : afterAuthenticated(user))} />;
  }

  if (phase === "recovery" && recoveryAccount && newRecoveryKey) {
    return <RecoveryKeyStep recoveryKey={newRecoveryKey} onContinue={() => void afterAuthenticated(recoveryAccount)} />;
  }

  if (!account) return <BootScreen />;

  if (phase === "choosing") {
    return (
      <>
        <WorkspaceChooser
          account={account}
          canCreateLocal={Boolean(bridge)}
          localUnavailableReason="Local workspaces need the Colonie desktop app."
          busy={busy}
          error={error}
          onCreateCloud={(name) => void createCloud(name)}
          onCreateLocal={(name) => void createLocal(name)}
          onSignOut={() => void signOut()}
          onOpenAccount={() => setAccountOpen(true)}
        />
        <RecoveryKeyDialog open={accountOpen} onClose={() => setAccountOpen(false)} client={client} />
      </>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      {notice ? (
        <div className="shrink-0 border-b border-hairline bg-panel px-3 py-2">
          <Notice>{notice}</Notice>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <WorkspaceShell
          client={client}
          account={account}
          workspaces={workspaces}
          activeId={activeId ?? workspaces[0]?.id ?? ""}
          onSwitchWorkspace={(id) => void selectWorkspace(id)}
          onNewWorkspace={() => { setError(null); setPhase("choosing"); }}
          onSignOut={() => void signOut()}
          stopConversation={stopConversation}
        />
      </div>
    </div>
  );
}

function invitationError(cause: unknown): string {
  if (cause instanceof PlatformApiError) {
    if (cause.status === 404) return "That invitation is no longer valid.";
    if (cause.status === 410) return "That invitation has expired.";
    if (cause.forbidden) return "That invitation could not be accepted for this account.";
    return cause.message;
  }
  return cause instanceof Error ? cause.message : "That invitation could not be accepted.";
}

export { PlatformApiError };
export default PlatformApp;
