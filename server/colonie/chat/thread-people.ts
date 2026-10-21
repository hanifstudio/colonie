// The people in a conversation, in a Shared workspace. Whoever takes part in
// a conversation may see who else does, add another person of the workspace,
// or leave. A conversation someone does not take part in answers as if it did
// not exist, admins included (privacy by person). People are kept by person
// key; their addresses come from the
// workspace's sign-in list and their names from Colonie accounts.
import type { Store } from "../../persistence/store.ts";

export interface ThreadPerson { email: string; name: string; you: boolean }
type Answer = { status: number; body: unknown };

export function createThreadPeople(deps: {
  store: () => Store;
  /** Everyone of the workspace who can be named, by address, with a name when known. */
  directory: () => Array<{ email: string; name?: string }>;
  /** Whether this address may sign in to the workspace. */
  isMember: (email: string) => boolean;
  /** The person key a signed-in address gets (harness/identity.ts personKey). */
  keyOf: (email: string) => string;
}) {
  const { keyOf } = deps;
  const notFound: Answer = { status: 404, body: { error: "no such conversation" } };

  function listFor(threadId: string, me: string): ThreadPerson[] {
    const keys = deps.store().threadParticipants(threadId) ?? [];
    const known = new Map(deps.directory().map((entry) => [keyOf(entry.email), entry]));
    return keys.map((key) => {
      const entry = known.get(key);
      return { email: entry?.email ?? "", name: entry?.name || entry?.email || "Someone who left the workspace", you: key === me };
    });
  }
  const takesPart = (threadId: string, me: string) => (deps.store().threadParticipants(threadId) ?? []).includes(me);

  return {
    list(me: string | null, threadId: string): Answer {
      if (!me || !takesPart(threadId, me)) return notFound;
      return { status: 200, body: { people: listFor(threadId, me) } };
    },

    add(me: string | null, threadId: string, rawEmail: unknown): Answer {
      if (!me || !takesPart(threadId, me)) return notFound;
      const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
      if (!email.includes("@") || !deps.isMember(email)) return { status: 400, body: { error: `${email || "That address"} is not in this workspace. Invite them to the workspace first.` } };
      const keys = deps.store().threadParticipants(threadId) ?? [];
      const key = keyOf(email);
      if (!keys.includes(key)) deps.store().setThreadParticipants(threadId, [...keys, key]);
      return { status: 200, body: { people: listFor(threadId, me) } };
    },

    leave(me: string | null, threadId: string): Answer {
      if (!me || !takesPart(threadId, me)) return notFound;
      deps.store().setThreadParticipants(threadId, (deps.store().threadParticipants(threadId) ?? []).filter((key) => key !== me));
      return { status: 200, body: { ok: true } };
    },
  };
}

export type ThreadPeople = ReturnType<typeof createThreadPeople>;
