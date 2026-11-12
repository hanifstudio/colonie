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

  it("puts the visibility choice among the form's fields, after the name and role and before the closing note", () => {
    const draft = new BotCreationDraft({ ...EMPTY_BOT_DEFAULTS, profile: { name: "Nova" } }, () => {});
    const html = renderToStaticMarkup(createElement(SimpleNewBot, { draft, extra: createElement("div", { "data-new-bot-visibility": true }, "Who can see it") }));
    const at = (text: string) => html.indexOf(text);
    expect(at("Name")).toBeLessThan(at("What should Nova do?"));
    expect(at("Or start from")).toBeLessThan(at("Who can see it"));
    expect(at("Who can see it")).toBeLessThan(at("Skills, memory"));
    // the name field is focused by code (without scrolling), not by autofocus
    expect(html).not.toContain("autofocus");
    draft.dispose();
  });
});
