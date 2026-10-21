// Bot visibility: who is looking (viewerFor), the cached thread-owner and per-viewer VisibleSet lookups, and the one subjectVisible check every member request naming a bot, thread, room, routine, run or attachment passes through.
import { SEES_EVERYTHING, VisibleSet, routineVisible, type PathSubject, type ThreadOwner, type Viewer } from "../colonie/bots/bot-visibility.ts";
import { threadsReferencing } from "../persistence/message-db.ts";
import { type RequestAuth } from "../request-auth.ts";
import { personKey } from "./identity.ts";

/** Everything this cluster reaches in the server; see the header. */
export interface VisibilityDeps {
  // ponytail: one permissive shape instead of hand-typed lines for each name;
  // tighten it when this cluster gets tests of its own.
  [name: string]: any;
}

export function createVisibility(deps: VisibilityDeps) {
  const {
    routines, store
  } = deps;
  /** Whether this is a Shared workspace (server/runtime/workspace-kind.ts),
   * and who takes part in a thread. Both absent means Local. */
  const sharedWorkspace: () => boolean = deps.sharedWorkspace ?? (() => false);
  const participantsOf: (threadId: string) => readonly string[] | undefined = deps.participantsOf
    ?? ((threadId: string) => store().threadParticipants(threadId));


// ── bot visibility (server/bot-visibility.ts) ──────────────────────────
/** Who is looking. The owner, a session-less local service (the Slack
 * worker) and admin sessions see every bot; any other session is a member,
 * known by the email it signed in with. In a Shared workspace everyone is a
 * person who sees only their own conversations, admins included; a loopback
 * caller there is no person and sees none. */
function viewerFor(auth: RequestAuth): Viewer {
  if (sharedWorkspace()) {
    if (auth.kind === "loopback") return { kind: "person", key: "", admin: true };
    return {
      kind: "person", key: personKey(auth.session), admin: auth.scopes.includes("admin"),
      ...(auth.session.email ? { email: auth.session.email } : {}),
    };
  }
  if (auth.kind === "loopback" || auth.scopes.includes("admin")) return SEES_EVERYTHING;
  return { kind: "member", ...(auth.session.email ? { email: auth.session.email } : {}) };
}

/** Thread → the bot or room that owns it, and one VisibleSet per viewer,
 * both kept until the next bot, room or thread change (store.onChange
 * below), so a stream of live frames costs a map lookup each. */
const threadOwners = new Map<string, ThreadOwner | null>();
const visibleSets = new Map<string, VisibleSet>();
function threadOwner(threadId: string): ThreadOwner | undefined {
  let owner = threadOwners.get(threadId);
  if (owner === undefined) {
    const bot = store().botByThread(threadId);
    const group = bot ? undefined : store().groupByThread(threadId);
    owner = bot ? { bot: bot.id } : group ? { group: group.id } : null;
    if (threadOwners.size >= 20_000) threadOwners.clear();
    threadOwners.set(threadId, owner);
  }
  return owner ?? undefined;
}
function visibleTo(viewer: Viewer): VisibleSet {
  const email = viewer.kind === "all" ? "" : viewer.email?.trim().toLowerCase() ?? "";
  const key = viewer.kind === "all" ? "*"
    : viewer.kind === "person" ? `person:${viewer.key}:${viewer.admin ? "admin" : ""}:${email}`
    : `member:${email}`;
  let set = visibleSets.get(key);
  if (!set) {
    set = new VisibleSet(store().bots, store().groups, viewer, threadOwner, participantsOf);
    if (visibleSets.size >= 1_000) visibleSets.clear();
    visibleSets.set(key, set);
  }
  return set;
}
function forgetVisibility(): void {
  threadOwners.clear();
  visibleSets.clear();
}

/** Which threads mention an attachment, for a member's file request while a
 * bot is restricted: a scan of the message store, so kept a minute. */
const attachmentThreads = new Map<string, { at: number; threads: readonly string[] }>();
function threadsUsingAttachment(name: string): readonly string[] {
  const cached = attachmentThreads.get(name);
  if (cached && Date.now() - cached.at < 60_000) return cached.threads;
  const threads = threadsReferencing(name);
  if (attachmentThreads.size >= 2_000) attachmentThreads.clear();
  attachmentThreads.set(name, { at: Date.now(), threads });
  return threads;
}

/** The conversations a signed-in person takes part in, for routes that scan
 * or list across threads. null means no per-person narrowing: Local, the
 * owner, or a local service. An empty list means a person who takes part in
 * none yet, so a scan must find nothing. */
function ownThreadIds(auth: RequestAuth): string[] | null {
  if (!sharedWorkspace()) return null;
  const viewer = viewerFor(auth);
  if (viewer.kind !== "person") return null;
  if (!viewer.key) return [];
  const visible = visibleTo(viewer);
  const ids = new Set<string>();
  for (const bot of store().bots) {
    if (!visible.bot(bot.id)) continue;
    for (const task of bot.tasks ?? []) {
      if ((task.participants ?? []).includes(viewer.key)) ids.add(task.threadId);
    }
  }
  return [...ids];
}

/** The one check every request naming a bot, thread, room, routine, run or
 * attachment passes through for a member. An id nobody knows goes on to its
 * handler, which answers "not found" itself. */
function subjectVisible(subject: PathSubject, visible: VisibleSet): boolean {
  switch (subject.kind) {
    case "bot":
      return !store().bot(subject.id) || visible.bot(subject.id);
    case "thread":
      return !threadOwner(subject.id) || visible.thread(subject.id);
    case "group":
      return !store().group(subject.id) || visible.group(subject.id);
    case "routine": {
      const routine = routines()?.listRoutines().find((candidate: any) => candidate.id === subject.id);
      return !routine || routineVisible(routine, visible);
    }
    case "routine-run": {
      const run = routines()?.listRuns().find((candidate: any) => candidate.id === subject.id);
      return !run || routineVisible(run, visible);
    }
    case "attachment":
      return visible.attachment(subject.name, threadsUsingAttachment);
  }
}

  return {
    viewerFor,
    visibleTo,
    ownThreadIds,
    forgetVisibility,
    subjectVisible,
  };
}
