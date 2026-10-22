// "/" at the start of a draft offers commands, including the bot's guides.
import { describe, expect, it } from "vitest";

import { composerSlashTrigger, replaceComposerSlashTrigger, slashReplacement } from "./composer-commands";

describe("slash commands", () => {
  it("a guide's name, digits and hyphens included, keeps the menu open", () => {
    expect(composerSlashTrigger("/weekly-report-2", 16)).toEqual({ query: "weekly-report-2", start: 0, end: 16 });
    expect(composerSlashTrigger("hi /x", 5)).toBeNull();
  });

  it("picking a guide leaves a plain request to use it, which the person can still edit", () => {
    const trigger = composerSlashTrigger("/week", 5)!;
    const next = replaceComposerSlashTrigger("/week", trigger, slashReplacement("guide:weekly-launch-report"));
    expect(next.text).toBe('Use your guide "weekly-launch-report": ');
    expect(next.caret).toBe(next.text.length);
    expect(slashReplacement("learn")).toBe("/learn ");
  });
});
