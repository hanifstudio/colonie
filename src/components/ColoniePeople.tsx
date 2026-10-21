// Settings → People on a Shared workspace connected to Colonie accounts: who
// has joined, and an invite link the admin copies and sends themselves.
// Nothing is emailed. Each link works once, for seven days, and the person
// signs in (or signs up) with their own Colonie account to use it.
import { useCallback, useEffect, useState } from "react";
import { Copy01Icon, Loading02Icon, MultiplicationSignIcon, PlusSignIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "./HIcon";
import { api } from "@/state/store";
import { useCopyFeedback } from "@/lib/copy-text";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";

type Role = "admin" | "member";
export interface ColonieMember { email: string; name: string; role: Role; joinedAt: string }
export interface Invite { url: string; expiresAt: string }

export async function createInviteLink(request: (path: string, init: RequestInit) => Promise<Invite>, role: Role): Promise<Invite> {
  return request("/api/invites", { method: "POST", body: JSON.stringify({ role }) });
}

function InviteLink({ invite }: { invite: Invite }) {
  const { state, copy } = useCopyFeedback(invite.url);
  return (
    <div className="mt-3 rounded-lg border border-hairline/40 bg-inset p-3 text-[12.5px]">
      <div className="mb-1 text-ink-secondary">Invite link</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 select-all break-all text-ink">{invite.url}</code>
        <button type="button" onClick={copy} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-control hover:text-ink">
          <HIcon icon={state === "copied" ? Tick01Icon : state === "failed" ? MultiplicationSignIcon : Copy01Icon} size={13} className={cn(state === "copied" && "text-success", state === "failed" && "text-danger")} />
          {state === "copied" ? "Copied" : state === "failed" ? "Copy failed; select the link" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
        Send it yourself, by chat or email. It works once, until {invite.expiresAt.slice(0, 10)}. The person signs in
        with their Colonie account, or creates one, and joins this workspace.
      </p>
    </div>
  );
}

export function ColoniePeopleView({ members, invite, busy, error, onCreate, onRemove }: {
  members: ColonieMember[];
  invite: Invite | null;
  busy: boolean;
  error: string | null;
  onCreate: (role: Role) => void;
  onRemove: (member: ColonieMember) => void;
}) {
  const [role, setRole] = useState<Role>("member");
  return (
    <Card title="People" subtitle="Everyone who has joined this workspace, and invite links for new people.">
      <div className="flex flex-wrap items-center gap-2">
        <select value={role} onChange={(event) => setRole(event.target.value as Role)} aria-label="Role" disabled={busy}
          className="rounded-lg border border-hairline/40 bg-inset px-2 py-2 text-[12.5px] text-ink focus:outline-none">
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="button" disabled={busy} onClick={() => onCreate(role)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-60">
          <HIcon icon={busy ? Loading02Icon : PlusSignIcon} size={13} className={cn(busy && "animate-spin")} />Create invite link
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
        Members talk with bots and with each other. Admins also change settings, engines and who is invited.
      </p>
      {invite && <InviteLink invite={invite} />}
      {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
      <div className="mt-4 flex flex-col">
        {members.length === 0
          ? <p className="text-[13px] text-ink-secondary">Nobody has joined yet.</p>
          : members.map((member) => (
            <div key={member.email} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 border-b border-hairline/20 py-2 text-[13px]">
              <span className="min-w-0">
                <span className="block truncate text-ink">{member.name || member.email}</span>
                <span className="block truncate text-[11.5px] text-ink-secondary">{member.email}</span>
              </span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", member.role === "admin" ? "bg-accent/15 text-accent" : "bg-control text-ink-secondary")}>
                {member.role === "admin" ? "Admin" : "Member"}
              </span>
              <span className="text-right tabular-nums text-ink-secondary">{member.joinedAt.slice(0, 10)}</span>
              <button type="button" disabled={busy} onClick={() => onRemove(member)} className="text-[12px] text-danger hover:underline disabled:opacity-50">Remove</button>
            </div>
          ))}
      </div>
    </Card>
  );
}

export function ColoniePeople() {
  const [members, setMembers] = useState<ColonieMember[]>([]);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const state = await api("/api/colonie-cloud");
      setMembers(Array.isArray(state?.members) ? state.members : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const create = async (role: Role) => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await createInviteLink(api, role));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (member: ColonieMember) => {
    const sure = await (window.colonie?.confirm ?? (async (message: string) => window.confirm(message)))(
      `Remove ${member.name || member.email} from this workspace? They are signed out at once and need a new invite to come back.`,
    );
    if (!sure) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/colonie-cloud/members/${encodeURIComponent(member.email)}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <ColoniePeopleView members={members} invite={invite} busy={busy} error={error} onCreate={(role) => void create(role)} onRemove={(member) => void remove(member)} />;
}
