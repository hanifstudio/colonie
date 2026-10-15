// Two small pickers: create a Group (title + members, people and bots) and
// start a private DM (one person or one bot). DM choices are membership of this
// workspace only; the backend decides who may actually be messaged.
import { useState } from "react";
import { HashtagIcon, UserAdd01Icon, UserRemove01Icon } from "@hugeicons/core-free-icons";
import { HIcon } from "@/components/HIcon";
import { AvatarFor, Button, Field, Modal, Notice, TextArea, TextInput } from "./ui";
import { cn } from "@/lib/cn";
import type { PlatformBot, PlatformMember, PlatformParticipant } from "@/lib/colonie-platform";

export function BotDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; purpose?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) return setError("Give your bot a name.");
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), purpose: purpose.trim() || undefined });
      setName("");
      setPurpose("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The bot could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create a bot"
      description="A bot is a workspace member with its own name, purpose and direct messages."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={() => void create()}>Create bot</Button>
      </>}
    >
      <div className="space-y-3">
        <Field label="Bot name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Atlas" />
        </Field>
        <Field label="What is it for?" hint="Optional. Shown to your workspace.">
          <TextArea rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Helps draft release notes" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Modal>
  );
}

export function GroupDialog({
  open,
  onClose,
  humans,
  bots,
  selfPrincipalId,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  humans: PlatformMember[];
  bots: PlatformBot[];
  selfPrincipalId: string;
  onCreate: (input: { title: string; memberPrincipalIds: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(principalId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(principalId)) next.delete(principalId);
      else next.add(principalId);
      return next;
    });
  }

  async function create() {
    if (!title.trim()) return setError("Give the group a name.");
    setBusy(true);
    setError(null);
    try {
      await onCreate({ title: title.trim(), memberPrincipalIds: [selfPrincipalId, ...selected] });
      setTitle("");
      setSelected(new Set());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The group could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New group"
      description="Groups are shared with the people and bots you add."
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={() => void create()}>Create group</Button>
      </>}
    >
      <div className="space-y-4">
        <Field label="Group name">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Project launch" />
        </Field>
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-ink-secondary">
            <HIcon icon={HashtagIcon} size={13} aria-hidden="true" /> Members
          </p>
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {humans.map((human) => (
              <PrincipalRow
                key={human.principalId}
                kind="human"
                id={human.accountId}
                name={human.displayName}
                checked={selected.has(human.principalId)}
                onToggle={() => toggle(human.principalId)}
              />
            ))}
            {bots.map((bot) => (
              <PrincipalRow
                key={bot.principalId}
                kind="bot"
                profile={bot}
                id={bot.id}
                name={bot.name}
                checked={selected.has(bot.principalId)}
                onToggle={() => toggle(bot.principalId)}
              />
            ))}
          </ul>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </Modal>
  );
}

export function DmDialog({
  open,
  onClose,
  humans,
  bots,
  selfAccountId,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  humans: PlatformMember[];
  bots: PlatformBot[];
  selfAccountId: string;
  onOpen: (input: { withAccountId?: string; withBotId?: string }) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = humans.filter((human) => human.accountId !== selfAccountId);

  async function startDm(key: string, input: { withAccountId?: string; withBotId?: string }) {
    setBusy(key);
    setError(null);
    try {
      await onOpen(input);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That conversation could not be opened.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New direct message" description="A direct message is private to you and the other member.">
      <div className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        <section>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">People</h3>
          {others.length ? (
            <ul className="space-y-1">
              {others.map((human) => (
                <li key={human.principalId}>
                  <PickRow
                    kind="human"
                    id={human.accountId}
                    name={human.displayName}
                    sub={human.email}
                    busy={busy === human.principalId}
                    onClick={() => void startDm(human.principalId, { withAccountId: human.accountId })}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-tertiary">No other people in this workspace yet.</p>
          )}
        </section>
        <section>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Bots</h3>
          {bots.length ? (
            <ul className="space-y-1">
              {bots.map((bot) => (
                <li key={bot.principalId}>
                  <PickRow
                    kind="bot"
                    profile={bot}
                    id={bot.id}
                    name={bot.name}
                    sub={bot.description ?? bot.purpose}
                    busy={busy === bot.principalId}
                    onClick={() => void startDm(bot.principalId, { withBotId: bot.id })}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-tertiary">No bots yet.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

function PrincipalRow({ kind, id, name, checked, onToggle, profile }: { kind: "human" | "bot"; id: string; name: string; checked: boolean; onToggle: () => void; profile?: PlatformBot }) {
  return (
    <li>
      <label className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5", checked ? "bg-accent/10" : "hover:bg-raised/60")}>
        <input type="checkbox" checked={checked} onChange={onToggle} className="size-4 accent-[var(--color-accent)]" />
        <AvatarFor kind={kind} id={id} name={name} size={26} profile={profile} />
        <span className="truncate text-[13.5px]">{name}</span>
      </label>
    </li>
  );
}

/** Who is in a Group, and who could be added. Only Groups are edited here; a
 * direct message is fixed by who it is between. The backend decides who may
 * change a group, so a refusal surfaces as the real error. */
export function GroupMembersDialog({
  open,
  onClose,
  participants,
  humans,
  bots,
  selfPrincipalId,
  onAdd,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  participants: PlatformParticipant[];
  humans: PlatformMember[];
  bots: PlatformBot[];
  selfPrincipalId: string;
  onAdd: (principalId: string) => Promise<void>;
  onRemove: (principalId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const present = new Set(participants.map((participant) => participant.principalId));
  const addableHumans = humans.filter((human) => !present.has(human.principalId));
  const addableBots = bots.filter((bot) => !present.has(bot.principalId));

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Group members" description="People and bots in this group conversation.">
      <div className="space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        <section>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">In this group</h3>
          <ul className="space-y-1">
            {participants.map((participant) => {
              const self = participant.principalId === selfPrincipalId;
              return (
                <li key={participant.principalId} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                  <AvatarFor kind={participant.kind} id={participant.botId ?? participant.accountId ?? participant.principalId} name={participant.displayName} size={28} profile={bots.find((bot) => bot.id === participant.botId)} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">
                    {participant.displayName}
                    {participant.kind === "bot" ? <span className="ml-1.5 text-[11.5px] text-ink-tertiary">Bot</span> : null}
                  </span>
                  {self ? (
                    <span className="text-[11.5px] text-ink-tertiary">You</span>
                  ) : (
                    <Button
                      variant="ghost"
                      icon={UserRemove01Icon}
                      busy={busy === participant.principalId}
                      onClick={() => void run(participant.principalId, () => onRemove(participant.principalId))}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section>
          <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-ink-tertiary">Add</h3>
          {addableHumans.length || addableBots.length ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {addableHumans.map((human) => (
                <li key={human.principalId} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                  <AvatarFor kind="human" id={human.accountId} name={human.displayName} size={28} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{human.displayName}</span>
                  <Button variant="secondary" icon={UserAdd01Icon} busy={busy === human.principalId} onClick={() => void run(human.principalId, () => onAdd(human.principalId))}>
                    Add
                  </Button>
                </li>
              ))}
              {addableBots.map((bot) => (
                <li key={bot.principalId} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
                  <AvatarFor kind="bot" id={bot.id} name={bot.name} size={28} profile={bot} />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{bot.name}</span>
                  <Button variant="secondary" icon={UserAdd01Icon} busy={busy === bot.principalId} onClick={() => void run(bot.principalId, () => onAdd(bot.principalId))}>
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2 text-[12.5px] text-ink-tertiary">Everyone in this workspace is already here.</p>
          )}
        </section>
      </div>
    </Modal>
  );
}

function PickRow({ kind, id, name, sub, busy, onClick, profile }: { kind: "human" | "bot"; id: string; name: string; sub?: string; busy: boolean; onClick: () => void; profile?: PlatformBot }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised/60 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <AvatarFor kind={kind} id={id} name={name} size={28} profile={profile} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px]">{name}</span>
        {sub ? <span className="block truncate text-[12px] text-ink-tertiary">{sub}</span> : null}
      </span>
    </button>
  );
}
