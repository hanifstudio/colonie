// Group participation baseline checks. Pure function, no network, no provider,
// no credentials: every case is a fixed message/bots/history/now fixture.
import { describe, expect, it } from "vitest";
import {
  chooseGroupBot,
  DEFAULT_COOLDOWN_MS,
  isRequestMessage,
  type GroupBot,
  type GroupParticipationInput,
  type ParticipationMessage,
} from "./participation.ts";

const NOW = Date.parse("2026-10-14T09:00:00.000Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const nova: GroupBot = { id: "bot-nova", name: "Nova", purpose: "launch copy and announcements" };
const patch: GroupBot = { id: "bot-patch", name: "Patch", purpose: "code and repository work" };

function human(body: string, overrides: Partial<ParticipationMessage> = {}): ParticipationMessage {
  return {
    id: `m-${body.slice(0, 12)}`, conversationKind: "group", senderKind: "human",
    senderName: "Clive", body, createdAt: at(0), ...overrides,
  };
}

function botMessage(body: string, overrides: Partial<ParticipationMessage> = {}): ParticipationMessage {
  return { ...human(body, overrides), senderKind: "bot", senderName: "Nova" };
}

function input(overrides: Partial<GroupParticipationInput> = {}): GroupParticipationInput {
  return { message: human("halo"), bots: [nova], history: [], now: NOW, ...overrides };
}

describe("chooseGroupBot: useful requests", () => {
  it("lets the only bot answer an explicit English request", () => {
    expect(chooseGroupBot(input({ message: human("Can you summarize the launch notes?") })))
      .toEqual({ action: "speak", reason: "the only bot in this group", botId: "bot-nova" });
  });

  it("lets the only bot answer an explicit Indonesian request", () => {
    expect(chooseGroupBot(input({ message: human("Tolong ringkas catatan peluncuran") })))
      .toEqual({ action: "speak", reason: "the only bot in this group", botId: "bot-nova" });
  });

  it("treats a question mark as a request", () => {
    expect(isRequestMessage("build gagal tadi")).toBe(false);
    expect(isRequestMessage("kenapa build gagal?")).toBe(true);
  });
});

describe("chooseGroupBot: stays silent", () => {
  it("ignores a casual statement", () => {
    expect(chooseGroupBot(input({ message: human("besok kita lanjut ya") })))
      .toEqual({ action: "silent", reason: "not a request" });
  });

  it("ignores another bot's message, even a direct mention of a peer", () => {
    const message = botMessage("@Patch can you fix the build?", { mentions: ["bot-patch"] });
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "silent", reason: "bot message" });
  });

  it("ignores a repeated request", () => {
    const message = human("Tolong ringkas catatan peluncuran", { id: "m-new" });
    const history = [human("Tolong ringkas catatan peluncuran", { id: "m-old", createdAt: at(30_000) })];
    expect(chooseGroupBot(input({ message, history })))
      .toEqual({ action: "silent", reason: "duplicate request" });
  });

  it("ignores a request right after another bot contributed", () => {
    const history = [botMessage("Sudah saya ringkas ya.", { createdAt: at(DEFAULT_COOLDOWN_MS / 2) })];
    expect(chooseGroupBot(input({ message: human("Tolong ringkas lagi?"), history })))
      .toEqual({ action: "silent", reason: "recent bot contribution" });
  });

  it("answers again once the cooldown has passed", () => {
    const history = [botMessage("Sudah saya ringkas ya.", { createdAt: at(DEFAULT_COOLDOWN_MS + 1_000) })];
    expect(chooseGroupBot(input({ message: human("Tolong ringkas lagi?"), history })))
      .toEqual({ action: "speak", reason: "the only bot in this group", botId: "bot-nova" });
  });

  it("stays silent when two bots are equally relevant", () => {
    const bots: GroupBot[] = [
      { id: "bot-a", name: "Mira", purpose: "launch copy" },
      { id: "bot-b", name: "Quill", purpose: "launch copy" },
    ];
    expect(chooseGroupBot(input({ message: human("Can you review the launch copy?"), bots })))
      .toEqual({ action: "silent", reason: "no clearly relevant bot" });
  });

  it("stays silent when no bot is relevant", () => {
    expect(chooseGroupBot(input({ message: human("Tolong periksa faktur pajak"), bots: [nova, patch] })))
      .toEqual({ action: "silent", reason: "no clearly relevant bot" });
  });

  it("stays silent when the Group has no bot", () => {
    expect(chooseGroupBot(input({ message: human("Tolong bantu saya?"), bots: [] })))
      .toEqual({ action: "silent", reason: "no bot in this group" });
  });
});

describe("chooseGroupBot: bypass", () => {
  it("bypasses participation in a DM", () => {
    const message = human("besok kita lanjut ya", { conversationKind: "dm" });
    expect(chooseGroupBot(input({ message })))
      .toEqual({ action: "bypass", reason: "direct message", botIds: ["bot-nova"] });
  });

  it("bypasses for an English @mention even on a casual statement", () => {
    const message = human("besok kita lanjut ya @Nova");
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "bypass", reason: "direct mention", botIds: ["bot-nova"] });
  });

  it("bypasses for an Indonesian @mention", () => {
    const message = human("oke @patch nanti kita cek");
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "bypass", reason: "direct mention", botIds: ["bot-patch"] });
  });

  it("bypasses for a platform-resolved mention that the body does not spell out", () => {
    const message = human("lihat ini dulu", { mentions: ["bot-patch"] });
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "bypass", reason: "direct mention", botIds: ["bot-patch"] });
  });

  it("ignores a mention of a bot that is not in this Group", () => {
    const message = human("hai @Ghost apa kabar");
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "silent", reason: "not a request" });
  });
});

describe("chooseGroupBot: picks one clearly relevant bot", () => {
  it("prefers a name match over a purpose match", () => {
    const message = human("Patch, can you look at this build?");
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "speak", reason: "clearly relevant bot", botId: "bot-patch", matched: "patch" });
  });

  it("picks by purpose when no name is written", () => {
    const message = human("Can you review the launch copy?");
    expect(chooseGroupBot(input({ message, bots: [nova, patch] })))
      .toEqual({ action: "speak", reason: "clearly relevant bot", botId: "bot-nova", matched: "launch" });
  });
});

describe("chooseGroupBot: shape", () => {
  it("reports a decision and a reason, never a probability", () => {
    const decision = chooseGroupBot(input({ message: human("Tolong bantu saya?") }));
    expect(Object.keys(decision).sort()).toEqual(["action", "botId", "reason"]);
    expect(JSON.stringify(decision)).not.toMatch(/confidence|probab|score|likelihood/i);
  });
});
