// Soul: the bot's standing instructions (SOUL.md), plus a short intro so a
// bot's Read all link into this section always lands somewhere legible.
import type { Bot } from "@/state/store";
import { SoulField } from "../SoulField";
import { ProposalStatus } from "./ProposalStatus";
import type { BotPatch } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";

export function SoulSection({ bot, patch, acp = false }: { bot: Bot; patch: (patch: BotPatch) => void; acp?: boolean }) {
  const { workspace } = useBotEditor();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-secondary">
        {workspace ? "Tell your bot how to help you. Saved instructions are used automatically starting with your next message." : acp ? "Tell your bot how to help you. Saved instructions are used automatically in new conversations." : "Who this bot is and the rules it never breaks. Always in its context."}
      </p>
      <ProposalStatus bot={bot} kind="chief" />
      <SoulField bot={bot} onPatch={patch} contextNote={workspace ? "Used automatically starting with your next message." : acp ? "Used automatically in new conversations." : undefined} />
    </div>
  );
}
