// A group's faces, as Grok Bot draws a channel: up to four of its members
// in a 2×2 tile for the sidebar, and a short overlapping row for the header,
// so a group is recognized by who is in it. Bots come first, then people.
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { HIcon } from "../HIcon";
import { BotAvatar } from "../Avatar";
import { PersonAvatar } from "../PersonAvatar";
import type { Conversation } from "@/lib/conversations";
import type { Bot } from "@/state/store";

type Member = { kind: "bot"; bot: Bot } | { kind: "person"; name: string; email: string; avatar?: string };

function membersOf(conversation: Conversation, bots: readonly Bot[]): Member[] {
  const here = conversation.bots.map((id) => bots.find((bot) => bot.id === id)).filter((bot): bot is Bot => Boolean(bot && !bot.hidden));
  return [
    ...here.map((bot) => ({ kind: "bot" as const, bot })),
    ...conversation.people.filter((person) => !person.you).map((person) => ({ kind: "person" as const, name: person.name, email: person.email, avatar: person.avatar })),
  ];
}

function Face({ member, size }: { member: Member; size: number }) {
  return member.kind === "bot"
    ? <BotAvatar bot={member.bot} state="happy" size={size} motion="none" motionKey={0} animated={false} />
    : <PersonAvatar name={member.name} email={member.email} src={member.avatar} size={size} />;
}

/** The sidebar tile: one face for one member, else a 2×2 of the first four. */
export function GroupTile({ conversation, bots, size }: { conversation: Conversation; bots: readonly Bot[]; size: number }) {
  const members = membersOf(conversation, bots).slice(0, 4);
  if (!members.length) {
    return <span className="flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary" style={{ width: size, height: size }}>
      <HIcon icon={UserGroupIcon} size={Math.round(size * 0.5)} />
    </span>;
  }
  if (members.length === 1) return <span className="shrink-0"><Face member={members[0]!} size={size} /></span>;
  // as Grok Bot's channel tile: the faces fill the square, slightly
  // overlapping; two sit on a diagonal, three in a triangle
  const cell = Math.round(size * (members.length === 2 ? 0.62 : 0.56));
  const far = size - cell;
  const spots = members.length === 2 ? [[0, 0], [far, far]]
    : members.length === 3 ? [[far / 2, 0], [0, far], [far, far]]
    : [[0, 0], [far, 0], [0, far], [far, far]];
  return (
    <span aria-hidden className="relative shrink-0" style={{ width: size, height: size }}>
      {members.map((member, index) => (
        <span key={index} className="absolute" style={{ left: spots[index]![0], top: spots[index]![1] }}><Face member={member} size={cell} /></span>
      ))}
    </span>
  );
}

/** The header row: up to four faces overlapping, then +N for the rest. */
export function GroupStack({ conversation, bots, size = 26 }: { conversation: Conversation; bots: readonly Bot[]; size?: number }) {
  const members = membersOf(conversation, bots);
  const shown = members.slice(0, 4);
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {shown.map((member, index) => (
        <span key={index} className="relative" style={{ marginLeft: index ? -Math.round(size * 0.28) : 0, zIndex: shown.length - index }}>
          <Face member={member} size={size} />
        </span>
      ))}
      {members.length > shown.length && <span className="ml-1 text-[11.5px] text-ink-tertiary">+{members.length - shown.length}</span>}
    </span>
  );
}
