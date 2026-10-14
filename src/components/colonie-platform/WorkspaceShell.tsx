// The signed-in workspace shell: workspace switcher, Groups and private DMs,
// readable conversation, and the member/settings panels. One SSE subscription
// per active workspace folds message, read, turn, membership and revocation
// frames into state; the frame cursor is replayed on reconnect.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown01Icon, Chatting01Icon, CloudIcon, ComputerIcon, HashtagIcon, Key01Icon, Logout01Icon, Menu01Icon,
  MessageMultiple01Icon, PlusSignIcon, Robot01Icon, Settings01Icon, UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { AvatarFor, Badge, Button, EmptyState, IconButton, Notice, SectionLabel, Spinner } from "./ui";
import { ConversationView } from "./ConversationView";
import { BotDialog, DmDialog, GroupDialog, GroupMembersDialog } from "./ComposerDialogs";
import { MembersPanel } from "./MembersPanel";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { RecoveryKeyDialog } from "./AccountRecovery";
import { cn } from "@/lib/cn";
import {
  canManageBots, canManageConnections, canManageMembers, conversationHasUnread, conversationTitle,
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

  return (
    <div className="flex h-dvh min-h-0 bg-app text-ink">
      {sidebarOpen ? <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden="true" /> : null}

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-hairline bg-panel transition-transform md:static md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <WorkspaceSwitcher
          active={active}
          workspaces={workspaces}
          unread={unread}
          onSwitch={(id) => { onSwitchWorkspace(id); setSidebarOpen(false); }}
          onNewWorkspace={() => { onNewWorkspace(); setSidebarOpen(false); }}
        />

        <nav className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 py-3">
          <div>
            <SectionLabel action={<IconButton label="New group" icon={PlusSignIcon} onClick={() => setPanel("group")} />}>Groups</SectionLabel>
            <ConversationList
              conversations={groups}
              selfPrincipalId={selfPrincipalId}
              activeId={activeConversation?.id ?? null}
              icon={<HIcon icon={HashtagIcon} size={16} aria-hidden="true" />}
              empty="No groups yet."
              onOpen={openConversation}
            />
          </div>

          <div>
            <SectionLabel action={<IconButton label="New direct message" icon={PlusSignIcon} onClick={() => setPanel("dm")} />}>Direct messages</SectionLabel>
            <ConversationList
              conversations={humanDms}
              selfPrincipalId={selfPrincipalId}
              activeId={activeConversation?.id ?? null}
              empty="No messages with people yet."
              onOpen={openConversation}
            />
            {botDms.length ? (
              <div className="mt-1">
                <SectionLabel>Bots</SectionLabel>
                <ConversationList
                  conversations={botDms}
                  selfPrincipalId={selfPrincipalId}
                  activeId={activeConversation?.id ?? null}
                  onOpen={openConversation}
                />
              </div>
            ) : null}
          </div>
        </nav>

        <div className="shrink-0 space-y-1 border-t border-hairline px-2 py-2">
          {canManageBots(active.myRole) ? (
            <SidebarAction icon={Robot01Icon} label="Create a bot" onClick={() => setPanel("bot")} />
          ) : null}
          <SidebarAction icon={UserGroupIcon} label="Members" onClick={() => setPanel("members")} />
          <SidebarAction icon={Settings01Icon} label="Workspace settings" onClick={() => setPanel("settings")} />
          <SidebarAction icon={Key01Icon} label="Account recovery" onClick={() => setPanel("recovery")} />
          <div className="flex items-center gap-2 px-2 pt-1">
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-tertiary">{account.email}</span>
            <IconButton label="Sign out" icon={Logout01Icon} onClick={onSignOut} />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-secondary"><Spinner /> Loading workspace…</div>
        ) : loadError ? (
          <div className="p-6"><Notice tone="error">{loadError}</Notice></div>
        ) : activeConversation ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-hairline px-3 py-2 md:hidden">
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
            <div className="flex items-center gap-2 px-3 py-2 md:hidden">
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
                        <Button variant="secondary" icon={Chatting01Icon} onClick={() => setPanel("dm")}>New direct message</Button>
                      </>
                    ) : null}
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
  );
}

function invitationLink(origin: string, token: string): string {
  return invitationLinkFor(origin || (typeof location !== "undefined" ? location.origin : ""), token);
}

function ConversationList({
  conversations,
  selfPrincipalId,
  activeId,
  onOpen,
  icon,
  empty,
}: {
  conversations: PlatformConversation[];
  selfPrincipalId: string;
  activeId: string | null;
  onOpen: (conversation: PlatformConversation) => void;
  icon?: ReactNode;
  empty?: string;
}) {
  if (!conversations.length) {
    return empty ? <p className="px-2 py-1 text-[12px] text-ink-tertiary">{empty}</p> : null;
  }
  return (
    <ul className="space-y-0.5">
      {conversations.map((conversation) => {
        const isActive = conversation.id === activeId;
        const unread = conversationHasUnread(conversation);
        const peer = conversation.participants.find((p) => p.principalId !== selfPrincipalId);
        return (
          <li key={conversation.id}>
            <button
              type="button"
              onClick={() => onOpen(conversation)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                isActive ? "bg-accent/15 text-ink" : "text-ink-secondary hover:bg-raised hover:text-ink",
              )}
            >
              {icon ? (
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-ink-secondary">{icon}</span>
              ) : peer ? (
                <AvatarFor kind={peer.kind} id={peer.botId ?? peer.accountId ?? peer.principalId} name={peer.displayName} size={24} />
              ) : (
                <span className="flex size-6 items-center justify-center rounded-md bg-raised text-ink-secondary"><HIcon icon={Chatting01Icon} size={14} aria-hidden="true" /></span>
              )}
              <span className={cn("min-w-0 flex-1 truncate text-[13px]", unread && "font-semibold text-ink")}>{conversationTitle(conversation, selfPrincipalId)}</span>
              {unread ? <Badge tone="accent">{conversation.unreadCount}</Badge> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
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
    <div className="relative border-b border-hairline p-2">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <HIcon icon={active.kind === "cloud" ? CloudIcon : ComputerIcon} size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold">{active.name}</span>
          <span className="block text-[11px] text-ink-tertiary">{active.kind === "cloud" ? "Cloud workspace" : "Local workspace"}</span>
        </span>
        {unread ? <Badge tone="accent">{unread}</Badge> : null}
        <HIcon icon={ArrowDown01Icon} size={15} className="text-ink-tertiary" aria-hidden="true" />
      </button>

      {open ? (
        <div role="menu" className="absolute left-2 right-2 z-50 mt-1 overflow-hidden rounded-xl border border-hairline bg-menu py-1 shadow-xl">
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
