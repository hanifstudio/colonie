// Members and invitations. Everyone sees the roster; only admin/owner get the
// management controls, and the backend re-checks every one of them. Invitations
// are shareable links (never a pairing code); the raw token is shown once.
import { useState } from "react";
import { Copy01Icon, Delete02Icon, Edit02Icon, Link01Icon, Tick01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { AvatarFor, Badge, Button, Field, Modal, Notice, Select, TextInput } from "./ui";
import { canChangeRoles, outranks, roleLabel, type PlatformBot, type PlatformInvitation, type PlatformMember, type PlatformRole, type PlatformWorkspace } from "@/lib/colonie-platform";

export function MembersPanel({
  open,
  onClose,
  workspace,
  members,
  bots,
  invitations,
  selfAccountId,
  canManage,
  canChangeMemberRoles,
  onInvite,
  onRevoke,
  onSetRole,
  onRemove,
  onRenameBot,
  onDeleteBot,
}: {
  open: boolean;
  onClose: () => void;
  workspace: PlatformWorkspace;
  members: PlatformMember[];
  bots: PlatformBot[];
  invitations: PlatformInvitation[];
  selfAccountId: string;
  canManage: boolean;
  canChangeMemberRoles: boolean;
  onInvite: (role: PlatformRole) => Promise<string>;
  onRevoke: (invitationId: string) => Promise<void>;
  onSetRole: (accountId: string, role: PlatformRole) => Promise<void>;
  onRemove: (accountId: string) => Promise<void>;
  onRenameBot: (botId: string, name: string) => Promise<void>;
  onDeleteBot: (botId: string) => Promise<void>;
}) {
  const [inviteRole, setInviteRole] = useState<PlatformRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function invite() {
    await run("invite", async () => {
      const created = await onInvite(inviteRole);
      setLink(created);
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Members" description={workspace.kind === "local" ? "This Local workspace is private to this Mac." : "People and bots in this workspace."} wide>
      <div className="space-y-6">
        {error && <Notice tone="error">{error}</Notice>}

        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">People</h3>
          <ul className="space-y-1">
            {members.map((member) => {
              const isSelf = member.accountId === selfAccountId;
              const manageable = canChangeMemberRoles && !isSelf && member.role !== "owner" && canChangeRoles(myRoleOf(members, selfAccountId)) && outranks(myRoleOf(members, selfAccountId), member.role);
              return (
                <li key={member.principalId} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
                  <AvatarFor kind="human" id={member.accountId} name={member.displayName} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{member.displayName}{isSelf ? " (you)" : ""}</div>
                    {member.email ? <div className="truncate text-[12px] text-ink-tertiary">{member.email}</div> : null}
                  </div>
                  {manageable ? (
                    <Select
                      aria-label={`Role for ${member.displayName}`}
                      value={member.role}
                      disabled={busy !== null}
                      onChange={(e) => void run(member.accountId, () => onSetRole(member.accountId, e.target.value as PlatformRole))}
                      className="w-28 py-1 text-[12.5px]"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Owner</option>
                    </Select>
                  ) : (
                    <Badge tone={member.role === "member" ? "neutral" : "accent"}>{roleLabel(member.role)}</Badge>
                  )}
                  {canManage && !isSelf && member.role !== "owner" ? (
                    <Button variant="ghost" className="px-2 py-1 text-[12px]" busy={busy === member.accountId} onClick={() => void run(member.accountId, () => onRemove(member.accountId))}>
                      Remove
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Bots</h3>
          {bots.length ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <BotRow
                  key={bot.id}
                  bot={bot}
                  canManage={canManage}
                  busy={busy === bot.id}
                  onRename={(name) => run(bot.id, () => onRenameBot(bot.id, name))}
                  onDelete={() => run(bot.id, () => onDeleteBot(bot.id))}
                />
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-tertiary">No bots yet.</p>
          )}
        </section>

        {canManage ? (
          <section className="rounded-xl border border-hairline bg-inset/50 p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">
              <HIcon icon={UserAdd01Icon} size={13} aria-hidden="true" /> Invite people
            </h3>
            <div className="flex items-end gap-2">
              <Field label="Role" id="colonie-invite-role">
                <Select id="colonie-invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as PlatformRole)} className="py-1.5">
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </Select>
              </Field>
              <Button variant="primary" icon={Link01Icon} busy={busy === "invite"} onClick={() => void invite()}>
                Create invitation link
              </Button>
            </div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-tertiary">
              Share the link with the person you want to invite. They sign in or create an account, and the workspace opens for them.
            </p>
            {link ? <InviteLink link={link} /> : null}
            {invitations.length ? (
              <ul className="mt-3 space-y-1">
                {invitations.map((invitation) => (
                  <li key={invitation.id} className="flex items-center gap-2 rounded-lg bg-panel px-2 py-1.5 text-[12.5px]">
                    <Badge tone="warning">{roleLabel(invitation.role)}</Badge>
                    <span className="text-ink-tertiary">
                      {invitation.revokedAt ? "Revoked" : invitation.acceptedAt ? "Accepted" : expiresLabel(invitation.expiresAt)}
                    </span>
                    {!invitation.revokedAt && !invitation.acceptedAt ? (
                      <Button variant="ghost" className="ml-auto px-2 py-1 text-[12px]" busy={busy === invitation.id} onClick={() => void run(invitation.id, () => onRevoke(invitation.id))}>
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : (
          <p className="text-[12.5px] text-ink-tertiary">Only owners and admins can invite people or change roles.</p>
        )}
      </div>
    </Modal>
  );
}

function myRoleOf(members: PlatformMember[], selfAccountId: string): PlatformRole {
  return members.find((m) => m.accountId === selfAccountId)?.role ?? "member";
}

function expiresLabel(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "Active";
  return `Expires ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** One bot in the roster: a name (renamable by admins) and a remove action. */
function BotRow({
  bot,
  canManage,
  busy,
  onRename,
  onDelete,
}: {
  bot: PlatformBot;
  canManage: boolean;
  busy: boolean;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(bot.name);
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-raised/60">
      <AvatarFor kind="bot" id={bot.id} name={bot.name} size={30} />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-2">
            <TextInput aria-label="Bot name" value={name} onChange={(e) => setName(e.target.value)} />
            <Button
              variant="secondary"
              busy={busy}
              onClick={() => void onRename(name.trim()).then(() => setEditing(false))}
            >
              Save
            </Button>
            <Button variant="ghost" onClick={() => { setName(bot.name); setEditing(false); }}>
              Cancel
            </Button>
          </div>
        ) : (
          <>
            <div className="truncate text-[13.5px] font-medium">{bot.name}</div>
            {bot.purpose ? <div className="truncate text-[12px] text-ink-tertiary">{bot.purpose}</div> : null}
          </>
        )}
      </div>
      {!editing && (
        <div className="flex items-center gap-1">
          <Badge>Bot</Badge>
          {canManage ? (
            <>
              <Button variant="ghost" aria-label={`Rename ${bot.name}`} icon={Edit02Icon} onClick={() => setEditing(true)} />
              <Button variant="ghost" aria-label={`Remove ${bot.name}`} icon={Delete02Icon} busy={busy} onClick={() => void onDelete()} />
            </>
          ) : null}
        </div>
      )}
    </li>
  );
}

function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg bg-panel px-2 py-1.5">
      <input readOnly value={link} aria-label="Invitation link" className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink-secondary outline-none" onFocus={(e) => e.target.select()} />
      <Button variant="secondary" icon={copied ? Tick01Icon : Copy01Icon} onClick={() => void copy()}>
        {copied ? "Copied" : "Copy link"}
      </Button>
    </div>
  );
}
