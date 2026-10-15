// The signed-in workspace shell: workspace switcher, Groups and private DMs,
// readable conversation, and the member/settings panels. One SSE subscription
// per active workspace folds message, read, turn, membership and revocation
// frames into state; the frame cursor is replayed on reconnect.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown01Icon, Chatting01Icon, CloudIcon, ComputerIcon, Key01Icon, Logout01Icon, Menu01Icon,
  MessageMultiple01Icon, PlusSignIcon, Robot01Icon, Settings01Icon, UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { AvatarFor, Badge, Button, EmptyState, IconButton, Notice, Spinner } from "./ui";
import { Sidebar } from "@/components/Sidebar";
import { SidebarSectionHeader } from "@/components/SidebarSectionHeader";
import { BotEditorStore, type Action } from "@/state/store";
import { DesktopCapabilitiesProvider } from "@/components/DesktopCapabilities";
import { ThreadRefsProvider } from "@/components/ThreadRefs";
import { classicWorkspaceState } from "@/lib/colonie-classic-ui";
import { ConversationView } from "./ConversationView";
import { BotDialog, DmDialog, GroupDialog, GroupMembersDialog } from "./ComposerDialogs";
import { MembersPanel } from "./MembersPanel";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { RecoveryKeyDialog } from "./AccountRecovery";
import { cn } from "@/lib/cn";
import {
  canManageBots, canManageConnections, canManageMembers, dmPeer,
  mergeMessages, partitionConversations, totalUnread, invitationLinkFor, PlatformApiError,
  type PlatformAccount, type PlatformBot, type PlatformClient,
  type PlatformConversation, type PlatformInvitation, type PlatformMember, type PlatformMessage,
  type PlatformWorkspace, type WorkspaceView,
} from "@/lib/colonie-platform";

/** True when the server says this account may no longer read the conversation. */
function accessLost(cause: unknown): boolean {
  return cause instanceof PlatformApiError && (cause.forbidden || cause.unauthorized || cause.status === 404);
}

export function WorkspaceShell({
  client,
  account,
  workspaces,
  activeId,
  onSwitchWorkspace,
  onNewWorkspace,
  onSignOut,
  stopConversation,
}: {
  client: PlatformClient;
  account: PlatformAccount;
  workspaces: WorkspaceView[];
  activeId: string;
  onSwitchWorkspace: (id: string) => void;
  onNewWorkspace: () => void;
  onSignOut: () => void;
  /** Overrides the shared stop route; the default calls the backend. */
  stopConversation?: (conversationId: string) => Promise<void>;
}) {
  const active = workspaces.find((w) => w.id === activeId) ?? workspaces[0]!;

  const [workspace, setWorkspace] = useState<PlatformWorkspace | null>(null);
  const [members, setMembers] = useState<PlatformMember[]>([]);
  const [bots, setBots] = useState<PlatformBot[]>([]);
  const [invitations, setInvitations] = useState<PlatformInvitation[]>([]);
  const [conversations, setConversations] = useState<PlatformConversation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [activeConversation, setActiveConversation] = useState<PlatformConversation | null>(null);
  const [messages, setMessages] = useState<PlatformMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  /** The earlier-messages page, tagged with the conversation it belongs to so a
   * late answer cannot show up under another conversation. */
  const [earlierPage, setEarlierPage] = useState<{ conversationId: string; loading: boolean; error: string | null } | null>(null);
  const [working, setWorking] = useState<Record<string, boolean>>({});
  const [turnErrors, setTurnErrors] = useState<Record<string, string>>({});

  const [panel, setPanel] = useState<"members" | "settings" | "group" | "dm" | "bot" | "group-members" | "recovery" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeConversation?.id ?? null;
  /** The workspace a reload belongs to; a switch discards its response. */
  const workspaceIdRef = useRef(active.id);
  /** Bumped by every open, workspace switch and revocation. A response whose
   * generation is gone belongs to a view the person has already left, so it is
   * never written: no stale conversation, message or read mark can appear. */
  const openGenerationRef = useRef(0);
  if (workspaceIdRef.current !== active.id) {
    workspaceIdRef.current = active.id;
    openGenerationRef.current += 1;
  }
  /** Latest workspace event cursor, replayed as `?after=` on reconnect. */
  const cursorRef = useRef(0);

  /** True while this conversation is still the open one in this workspace. */
  const stillOpen = (conversationId: string | null, forWorkspace: string, generation: number) =>
    generation === openGenerationRef.current && workspaceIdRef.current === forWorkspace && activeIdRef.current === conversationId;

  const selfMember = members.find((m) => m.accountId === account.id) ?? null;
  const selfPrincipalId = selfMember?.principalId ?? "";

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const forWorkspace = active.id;
    const detail = await client.getWorkspace(forWorkspace, signal);
    const list = await client.listConversations(forWorkspace, signal);
    // A switched workspace is not written over by the previous one's data.
    if (workspaceIdRef.current !== forWorkspace) return;
    setWorkspace(detail.workspace);
    setMembers(detail.members);
    setBots(detail.bots);
    setConversations(list);
  }, [client, active.id]);

  /** A resync means the replay page was truncated, so the open conversation is
   * refetched through the authorized route — lists alone would leave it stale. */
  const resyncConversation = useCallback(async (conversationId: string) => {
    const forWorkspace = workspaceIdRef.current;
    const generation = openGenerationRef.current;
    try {
      const detail = await client.getConversation(conversationId);
      // Nothing is written if the workspace or the open conversation changed.
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      setActiveConversation(detail.conversation);
      setMessages(detail.messages ?? []);
      setConversations((prev) => prev.map((c) => (c.id === detail.conversation.id ? detail.conversation : c)));
      setMessagesError(null);
    } catch (cause) {
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      if (accessLost(cause)) {
        // Access was revoked: every message is dropped rather than left on
        // screen. The header stays so the notice has somewhere to stand.
        setMessages([]);
        setMessagesError("You no longer have access to this conversation.");
        return;
      }
      setMessagesError(cause instanceof Error ? cause.message : "This conversation could not be reloaded.");
    }
  }, [client]);

  const reloadConversations = useCallback(async () => {
    const forWorkspace = active.id;
    try {
      const list = await client.listConversations(forWorkspace);
      if (workspaceIdRef.current !== forWorkspace) return;
      setConversations(list);
    } catch {
      /* a transient reload failure keeps the previous list */
    }
  }, [client, active.id]);

  // Initial load, plus the member/invitation/connection panels' data.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setActiveConversation(null);
    (async () => {
      try {
        await refresh(controller.signal);
        const invites = canManageMembers(active.myRole) ? await client.listInvitations(active.id).catch(() => []) : [];
        setInvitations(invites);
      } catch (cause) {
        if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "This workspace could not be loaded.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [active.id, active.myRole, client, refresh]);

  // Live workspace stream with a simple retry; a clean close is not an error.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) retry = setTimeout(run, 1500);
    };
    async function run() {
      await client.stream(active.id, {
        signal: controller.signal,
        after: cursorRef.current || undefined,
        onError: schedule,
        onEvent: (event, sequence) => {
          if (sequence > cursorRef.current) cursorRef.current = sequence;
          if (event.type === "message") {
            const { message } = event;
            setConversations((prev) => prev.map((c) => c.id === message.conversationId
              ? { ...c, lastSequence: Math.max(c.lastSequence, message.sequence), unreadCount: c.id === activeIdRef.current || message.senderPrincipalId === selfPrincipalId ? c.unreadCount : c.unreadCount + 1 }
              : c));
            if (message.conversationId === activeIdRef.current) {
              setMessages((prev) => mergeMessages(prev, [message]));
            }
          } else if (event.type === "conversation") {
            void reloadConversations();
          } else if (event.type === "read") {
            setConversations((prev) => prev.map((c) => c.id === event.conversationId && event.accountId === account.id
              ? { ...c, lastReadSequence: event.lastReadSequence, unreadCount: Math.max(0, c.lastSequence - event.lastReadSequence) }
              : c));
          } else if (event.type === "turn") {
            const busy = event.state === "typing";
            setWorking((prev) => ({ ...prev, [event.conversationId]: busy }));
            if (event.state === "error") {
              setTurnErrors((prev) => ({ ...prev, [event.conversationId]: event.error ?? "The bot could not finish that turn." }));
            } else if (event.state === "completed" || event.state === "cancelled") {
              setTurnErrors((prev) => {
                if (!(event.conversationId in prev)) return prev;
                const next = { ...prev };
                delete next[event.conversationId];
                return next;
              });
            }
          } else if (event.type === "membership") {
            void refresh().catch(() => {});
          } else if (event.type === "revoked") {
            if (!event.conversationId || event.conversationId === activeIdRef.current) {
              // Access is gone: drop it and invalidate anything still in flight.
              openGenerationRef.current += 1;
              setActiveConversation(null);
              setMessages([]);
              setMessagesError("You no longer have access to this conversation.");
            }
            void reloadConversations();
          } else if (event.type === "resync") {
            // The replay page was truncated: workspace metadata, the list, and
            // the open conversation all come from the server again.
            void refresh().catch(() => {});
            void reloadConversations();
            const open = activeIdRef.current;
            if (open) void resyncConversation(open);
          }
        },
      });
      schedule();
    }
    void run();
    return () => {
      cancelled = true;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [account.id, active.id, client, refresh, reloadConversations, resyncConversation, selfPrincipalId]);

  const stop = useCallback(async (conversationId: string) => {
    try {
      if (stopConversation) await stopConversation(conversationId);
      else await client.stopTurns(conversationId);
    } catch (cause) {
      setTurnErrors((prev) => ({ ...prev, [conversationId]: cause instanceof Error ? cause.message : "Stop is not available for this conversation." }));
    }
  }, [client, stopConversation]);

  const openConversation = useCallback(async (conversation: PlatformConversation) => {
    // This open owns the view from here: any earlier open's response is dropped.
    const generation = ++openGenerationRef.current;
    const forWorkspace = workspaceIdRef.current;
    const conversationId = conversation.id;
    // Own the view before the first await. A fast response can beat React's
    // next render, especially when opening follows an async DM lookup.
    activeIdRef.current = conversationId;
    setActiveConversation(conversation);
    setSidebarOpen(false);
    setSendError(null);
    setEarlierPage(null);
    setMessagesLoading(true);
    setMessagesError(null);
    setMessages([]);
    try {
      const detail = await client.getConversation(conversationId);
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      setActiveConversation(detail.conversation);
      setMessages(detail.messages ?? []);
      if (detail.conversation.unreadCount > 0) {
        const updated = await client.markRead(conversationId, detail.conversation.lastSequence);
        // A read mark for a conversation the person has left is not written.
        if (!stillOpen(conversationId, forWorkspace, generation)) return;
        setConversations((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
      }
    } catch (cause) {
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      setMessagesError(cause instanceof Error ? cause.message : "This conversation could not be opened.");
    } finally {
      if (stillOpen(conversationId, forWorkspace, generation)) setMessagesLoading(false);
    }
  }, [client]);

  const loadEarlier = useCallback(async () => {
    const conversation = activeConversation;
    const firstSequence = messages[0]?.sequence ?? 1;
    if (!conversation || firstSequence <= 1 || earlierPage?.loading) return;
    const conversationId = conversation.id;
    const forWorkspace = workspaceIdRef.current;
    const generation = openGenerationRef.current;
    setEarlierPage({ conversationId, loading: true, error: null });
    try {
      const earlier = await client.listMessages(conversationId, {
        after: Math.max(firstSequence - 101, 0),
        limit: Math.min(100, firstSequence - 1),
      });
      // Only merged while this is still the open conversation.
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      setMessages((prev) => mergeMessages(prev, earlier));
      setEarlierPage({ conversationId, loading: false, error: null });
    } catch {
      // The messages on screen are left exactly as they were.
      if (!stillOpen(conversationId, forWorkspace, generation)) return;
      setEarlierPage({ conversationId, loading: false, error: "Earlier messages could not be loaded. Try again." });
    }
  }, [activeConversation, client, earlierPage?.loading, messages]);

  const send = useCallback(async (body: string) => {
    const conversation = activeConversation;
    if (!conversation) return;
    const generation = openGenerationRef.current;
    const forWorkspace = workspaceIdRef.current;
    setSendError(null);
    try {
      const message = await client.sendMessage(conversation.id, body);
      // A reply for a conversation that is no longer open is not merged into
      // whatever is on screen now.
      if (!stillOpen(conversation.id, forWorkspace, generation)) return;
      setMessages((prev) => mergeMessages(prev, [message]));
      setConversations((prev) => prev.map((c) => c.id === conversation.id ? { ...c, lastSequence: Math.max(c.lastSequence, message.sequence) } : c));
    } catch (cause) {
      // The failure is only reported while that conversation is still the view.
      if (stillOpen(conversation.id, forWorkspace, generation)) {
        setSendError(cause instanceof Error ? cause.message : "Your message was not sent.");
      }
      throw cause;
    }
  }, [activeConversation, client]);

  const { groups, humanDms, botDms } = useMemo(() => partitionConversations(conversations, selfPrincipalId), [conversations, selfPrincipalId]);
  const unread = totalUnread(conversations);
  const canManage = canManageMembers(active.myRole);

  async function openPeer(input: { withAccountId?: string; withBotId?: string }) {
    const existing = conversations.find((conversation) => {
      if (conversation.kind !== "dm") return false;
      const peer = dmPeer(conversation, selfPrincipalId);
      return input.withBotId ? peer?.botId === input.withBotId : peer?.accountId === input.withAccountId;
    });
    if (existing) { await openConversation(existing); return; }
    const forWorkspace = workspaceIdRef.current;
    const generation = ++openGenerationRef.current;
    try {
      const conversation = await client.openDm(forWorkspace, input);
      if (workspaceIdRef.current !== forWorkspace || generation !== openGenerationRef.current) return;
      setConversations((prev) => prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]);
      await openConversation(conversation);
    } catch (cause) {
      if (workspaceIdRef.current === forWorkspace && generation === openGenerationRef.current) setSendError(cause instanceof Error ? cause.message : "This conversation could not be opened.");
    }
  }

  const classicState = classicWorkspaceState({ bots, conversations, self: selfPrincipalId, active: activeConversation, messages, working });
  const classicDispatch = (action: Action) => {
    if (action.type === "select") {
      const conversation = conversations.find((c) => c.id === action.id);
      if (conversation) void openConversation(conversation);
      else if (bots.some((bot) => bot.id === action.id)) void openPeer({ withBotId: action.id });
    } else if (action.type === "interrupt" && action.threadId) void stop(action.threadId);
    else if (action.type === "toggleNewBot") setPanel("bot");
    else if (action.type === "toggleSettings") setPanel("members");
    else if (action.type === "loadOlderMessages") void loadEarlier();
    else if (action.type === "updateBot" && action.patch.name) {
      void client.updateBot(active.id, action.botId, { name: action.patch.name })
        .then((updated) => setBots((prev) => prev.map((bot) => bot.id === updated.id ? updated : bot)))
        .catch((cause) => setSendError(cause instanceof Error ? cause.message : "The bot could not be renamed."));
    }
  };

  return (
    <BotEditorStore value={{ state: classicState, dispatch: classicDispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} }}>
    <DesktopCapabilitiesProvider>
    <ThreadRefsProvider>
    <div className="relative flex h-dvh min-h-0 bg-app text-ink">
      {sidebarOpen ? <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" /> : null}

      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} workspace={{
        switcher: <WorkspaceSwitcher active={active} workspaces={workspaces} unread={unread}
          onSwitch={(id) => { onSwitchWorkspace(id); setSidebarOpen(false); }} onNewWorkspace={onNewWorkspace} />,
        createMenu: <>
          {canManageBots(active.myRole) ? <SidebarAction icon={Robot01Icon} label="Create a bot" onClick={() => setPanel("bot")} /> : null}
          <SidebarAction icon={UserGroupIcon} label="New group" onClick={() => setPanel("group")} />
          <SidebarAction icon={Chatting01Icon} label="New direct message" onClick={() => setPanel("dm")} />
        </>,
        onBotMenu: () => setPanel("members"),
        onGroupMenu: (id) => { const group = conversations.find((c) => c.id === id); if (group) void openConversation(group).then(() => setPanel("group-members")); },
        people: (query, density) => <div className="pt-3">
          <div className="flex items-center">
            {density !== "icons" ? <div className="min-w-0 flex-1"><SidebarSectionHeader name="People" collapsed={false} reorderable={false} dragging={false} /></div> : null}
            <IconButton label="New direct message" icon={PlusSignIcon} onClick={() => setPanel("dm")} />
          </div>
          {members.filter((person) => person.accountId !== account.id && (!query || person.displayName.toLowerCase().includes(query))).map((person) => {
            const dm = humanDms.find((c) => dmPeer(c, selfPrincipalId)?.accountId === person.accountId);
            return <button key={person.accountId} type="button" aria-current={dm?.id === activeConversation?.id ? "page" : undefined}
              aria-label={person.displayName} onClick={() => void openPeer({ withAccountId: person.accountId })}
              className={cn("flex w-full items-center rounded-md text-left hover:bg-raised/40", density === "icons" ? "justify-center py-2" : "gap-3 px-2 py-2.5", dm?.id === activeConversation?.id && "bg-raised/70")}>
              <AvatarFor kind="human" id={person.principalId} name={person.displayName} size={density === "icons" ? 44 : 40} />
              {density !== "icons" ? <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{person.displayName}</span> : null}
              {dm?.unreadCount ? <span className="size-2 shrink-0 rounded-full bg-accent" /> : null}
            </button>;
          })}
        </div>,
        footer: <div className="flex items-center gap-2">
          <AvatarFor kind="human" id={account.id} name={account.name} size={28} />
          <details className="relative min-w-0 flex-1">
            <summary className="cursor-pointer truncate rounded-xl px-2 py-2 text-[14px] hover:bg-raised/50">{account.name}</summary>
            <div className="absolute bottom-full left-0 z-40 mb-2 w-56 rounded-xl border border-hairline/40 bg-menu p-1.5 shadow-xl">
              <SidebarAction icon={UserGroupIcon} label="Members" onClick={() => setPanel("members")} />
              <SidebarAction icon={Settings01Icon} label="Workspace settings" onClick={() => setPanel("settings")} />
              <SidebarAction icon={Key01Icon} label="Account recovery" onClick={() => setPanel("recovery")} />
              <SidebarAction icon={Logout01Icon} label="Sign out" onClick={onSignOut} />
            </div>
          </details>
          <IconButton label="Workspace settings" icon={Settings01Icon} onClick={() => setPanel("settings")} />
        </div>,
      }} />

      <main className="flex min-w-0 flex-1 flex-col">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-secondary"><Spinner /> Loading workspace…</div>
        ) : loadError ? (
          <div className="p-6"><Notice tone="error">{loadError}</Notice></div>
        ) : activeConversation ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="absolute left-3 top-3 z-30 md:hidden">
              <IconButton label="Open navigation" icon={Menu01Icon} onClick={() => setSidebarOpen(true)} />
            </div>
            <div className="min-h-0 flex-1">
              <ConversationView
                // Keyed by id so nothing about the previous conversation — its
                // draft, its send state, its scroll — can follow it here.
                key={activeConversation.id}
                conversation={activeConversation}
                selfPrincipalId={selfPrincipalId}
                messages={messages}
                working={Boolean(working[activeConversation.id])}
                loading={messagesLoading}
                loadError={messagesError}
                sendError={sendError ?? turnErrors[activeConversation.id] ?? null}
                onSend={send}
                onLoadEarlier={() => void loadEarlier()}
                loadingEarlier={earlierPage?.conversationId === activeConversation.id && earlierPage.loading}
                earlierError={earlierPage?.conversationId === activeConversation.id ? earlierPage.error : null}
                onStop={() => void stop(activeConversation.id)}
                headerAction={
                  activeConversation.kind === "group" ? (
                    <Button variant="ghost" className="px-2 py-1 text-[12px]" icon={UserGroupIcon} aria-label="Group members" onClick={() => setPanel("group-members")}>
                      Members
                    </Button>
                  ) : null
                }
              />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="absolute left-3 top-3 z-30 md:hidden">
              <IconButton label="Open navigation" icon={Menu01Icon} onClick={() => setSidebarOpen(true)} />
            </div>
            <div className="min-h-0 flex-1">
              <EmptyState
                icon={MessageMultiple01Icon}
                title={`Welcome to ${active.name}`}
                description={groups.length || humanDms.length || botDms.length
                  ? "Pick a group or a direct message on the left, or start a new one."
                  : canManageBots(active.myRole)
                    ? "Start by creating a bot, then say hello. You can also create a group or message a teammate."
                    : "Create a group or start a direct message to begin."}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {canManageBots(active.myRole) ? (
                      <>
                        <Button variant="primary" icon={Robot01Icon} onClick={() => setPanel("bot")}>Create a bot</Button>
                      </>
                    ) : null}
                    <Button variant="secondary" icon={Chatting01Icon} onClick={() => setPanel("dm")}>New direct message</Button>
                    <Button variant="secondary" icon={PlusSignIcon} onClick={() => setPanel("group")}>New group</Button>
                  </div>
                }
              />
            </div>
          </div>
        )}
      </main>

      {workspace ? (
        <>
          <MembersPanel
            open={panel === "members"}
            onClose={() => setPanel(null)}
            workspace={workspace}
            members={members}
            bots={bots}
            invitations={invitations}
            selfAccountId={account.id}
            canManage={canManage}
            canChangeMemberRoles={canManage}
            onInvite={async (role) => {
              const created = await client.createInvitation(active.id, { role });
              setInvitations(await client.listInvitations(active.id));
              const link = created.url || invitationLink(client.origin, created.token);
              return link;
            }}
            onRevoke={async (invitationId) => {
              await client.revokeInvitation(active.id, invitationId);
              setInvitations(await client.listInvitations(active.id));
            }}
            onSetRole={async (accountId, role) => {
              await client.setMemberRole(active.id, accountId, role);
              setMembers(await client.listMembers(active.id));
            }}
            onRemove={async (accountId) => {
              await client.removeMember(active.id, accountId);
              setMembers(await client.listMembers(active.id));
            }}
            onRenameBot={async (botId, name) => {
              await client.updateBot(active.id, botId, { name });
              setBots(await client.listBots(active.id));
            }}
            onDeleteBot={async (botId) => {
              await client.deleteBot(active.id, botId);
              setBots(await client.listBots(active.id));
            }}
          />

          <WorkspaceSettings
            open={panel === "settings"}
            onClose={() => setPanel(null)}
            workspace={workspace}
            client={client}
            canRename={canManage}
            canManageApps={canManageConnections(active.myRole)}
            onRename={async (name) => {
              const updated = await client.renameWorkspace(active.id, name);
              setWorkspace(updated);
            }}
          />

          <RecoveryKeyDialog open={panel === "recovery"} onClose={() => setPanel(null)} client={client} />

          {activeConversation?.kind === "group" ? (
            <GroupMembersDialog
              open={panel === "group-members"}
              onClose={() => setPanel(null)}
              participants={activeConversation.participants}
              humans={members}
              bots={bots}
              selfPrincipalId={selfPrincipalId}
              onAdd={async (principalId) => {
                const conversationId = activeConversation.id;
                const forWorkspace = workspaceIdRef.current;
                const generation = openGenerationRef.current;
                await client.addConversationMember(conversationId, principalId);
                const detail = await client.getConversation(conversationId);
                if (!stillOpen(conversationId, forWorkspace, generation)) return;
                setActiveConversation(detail.conversation);
                setConversations((prev) => prev.map((c) => (c.id === detail.conversation.id ? detail.conversation : c)));
              }}
              onRemove={async (principalId) => {
                const conversationId = activeConversation.id;
                const forWorkspace = workspaceIdRef.current;
                const generation = openGenerationRef.current;
                await client.removeConversationMember(conversationId, principalId);
                const detail = await client.getConversation(conversationId);
                if (!stillOpen(conversationId, forWorkspace, generation)) return;
                setActiveConversation(detail.conversation);
                setConversations((prev) => prev.map((c) => (c.id === detail.conversation.id ? detail.conversation : c)));
              }}
            />
          ) : null}
        </>
      ) : null}

      <GroupDialog
        open={panel === "group"}
        onClose={() => setPanel(null)}
        humans={members}
        bots={bots}
        selfPrincipalId={selfPrincipalId}
        onCreate={async (input) => {
          const conversation = await client.createGroup(active.id, input);
          setConversations((prev) => [conversation, ...prev]);
          await openConversation(conversation);
        }}
      />
      <DmDialog
        open={panel === "dm"}
        onClose={() => setPanel(null)}
        humans={members}
        bots={bots}
        selfAccountId={account.id}
        onOpen={async (input) => {
          const conversation = await client.openDm(active.id, input);
          setConversations((prev) => prev.some((c) => c.id === conversation.id) ? prev.map((c) => (c.id === conversation.id ? conversation : c)) : [conversation, ...prev]);
          await openConversation(conversation);
        }}
      />
      <BotDialog
        open={panel === "bot"}
        onClose={() => setPanel(null)}
        onCreate={async (input) => {
          const bot = await client.createBot(active.id, input);
          setBots((prev) => [...prev, bot]);
          const conversation = await client.openDm(active.id, { withBotId: bot.id });
          setConversations((prev) => prev.some((c) => c.id === conversation.id) ? prev.map((c) => (c.id === conversation.id ? conversation : c)) : [conversation, ...prev]);
          await openConversation(conversation);
        }}
      />
    </div>
    </ThreadRefsProvider>
    </DesktopCapabilitiesProvider>
    </BotEditorStore>
  );
}

function invitationLink(origin: string, token: string): string {
  return invitationLinkFor(origin || (typeof location !== "undefined" ? location.origin : ""), token);
}

function WorkspaceSwitcher({
  active,
  workspaces,
  unread,
  onSwitch,
  onNewWorkspace,
}: {
  active: WorkspaceView;
  workspaces: WorkspaceView[];
  unread: number;
  onSwitch: (id: string) => void;
  onNewWorkspace: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative min-w-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px] hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <HIcon icon={active.kind === "cloud" ? CloudIcon : ComputerIcon} size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{active.name}</span>
        </span>
        {unread ? <Badge tone="accent">{unread}</Badge> : null}
        <HIcon icon={ArrowDown01Icon} size={15} className="text-ink-tertiary" aria-hidden="true" />
      </button>

      {open ? (
        <div role="menu" className="absolute right-0 z-50 mt-1 w-64 overflow-hidden rounded-xl border border-hairline/40 bg-menu py-1 shadow-xl">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); onSwitch(workspace.id); }}
              className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-raised", workspace.id === active.id && "text-accent")}
            >
              <HIcon icon={workspace.kind === "cloud" ? CloudIcon : ComputerIcon} size={14} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
            </button>
          ))}
          <div className="my-1 border-t border-hairline" />
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onNewWorkspace(); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-raised">
            <HIcon icon={PlusSignIcon} size={14} aria-hidden="true" /> Create workspace
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SidebarAction({ icon, label, onClick }: { icon: Parameters<typeof HIcon>[0]["icon"]; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-ink-secondary hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <HIcon icon={icon} size={15} aria-hidden="true" /> {label}
    </button>
  );
}
