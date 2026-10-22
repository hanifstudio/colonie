// Making a bot is one short form: a face and a name, what it should do, or a
// role to start from. Everything else waits in the bot's settings.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BotCreationDraft, EMPTY_BOT_DEFAULTS } from "@/lib/bot-creation-draft";
import { BOT_ROLES } from "@/lib/bot-roles";
import { SimpleNewBot } from "./NewBotDialog";

describe("a new bot", () => {
  it("asks only for a name, what it should do, or a role to start from", () => {
    const draft = new BotCreationDraft({ ...EMPTY_BOT_DEFAULTS, profile: { name: "Nova" } }, () => {});
    const html = renderToStaticMarkup(createElement(SimpleNewBot, { draft }));
    expect(html).toContain('value="Nova"');
    expect(html).toContain("What should Nova do?");
    for (const role of BOT_ROLES) expect(html).toContain(`>${role.name}</button>`);
    for (const tab of ["Soul", "Permissions", "Voice &amp; alerts", "Routines"]) expect(html).not.toContain(`>${tab}<`);
    draft.dispose();
  });
});
