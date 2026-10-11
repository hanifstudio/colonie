import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { workspaceDir } from "../../workspace.ts";
import { installLibrarySkill } from "../../skill-library.ts";
import { ColonieSkills, type SkillsBot } from "./service.ts";

const SKILL_MD = (name: string, description = "Use when the user asks for the weekly report.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`;

function setup() {
  const bots = new Map<string, SkillsBot>();
  const flag = { busy: false };
  const add = (id: string) => {
    bots.set(id, { id, assignedSkills: [] });
    return id;
  };
  const service = new ColonieSkills({
    bot: (id) => bots.get(id),
    setAssigned: (id, names) => {
      const bot = bots.get(id);
      if (bot) bot.assignedSkills = [...names];
    },
    busy: () => flag.busy,
  });
  return { service, bots, add, flag };
}

const id = () => `bot-${Math.random().toString(36).slice(2, 10)}`;

describe("ColonieSkills private guides", () => {
  it("creates an editable private guide and reads its authored SKILL.md back", () => {
    const { service, add } = setup();
    const botId = add(id());
    const view = service.save(botId, {
      name: "weekly-report",
      description: "Use when the user asks for the weekly report.",
      instructions: "1. Gather the numbers.\n2. Summarize.",
      enabled: true,
    });
    const skill = view.skills.find((entry) => entry.name === "weekly-report")!;
    expect(skill).toMatchObject({ origin: "private", editable: true, enabled: true });
    expect(skill.sha256).toMatch(/^[a-f0-9]{64}$/);

    const content = service.read(botId, "weekly-report")!;
    expect(content.text).toContain("name: \"weekly-report\"");
    expect(content.text).toContain("1. Gather the numbers.");
    expect(service.readEnabled(botId, "weekly-report")).toEqual({ text: content.text, sha256: skill.sha256 });
  });

  it("preserves the enabled choice across an edit", () => {
    const { service, add } = setup();
    const botId = add(id());
    service.save(botId, { name: "quiet", description: "Use for quiet tasks.", instructions: "Do it.", enabled: false });
    expect(service.view(botId).skills[0]!.enabled).toBe(false);

    service.save(botId, { name: "quiet", description: "Use for quiet tasks.", instructions: "Do it carefully.", enabled: false });
    expect(service.view(botId).skills[0]!.enabled).toBe(false);

    service.setEnabled(botId, "quiet", true, service.view(botId).revision);
    expect(service.view(botId).skills[0]!.enabled).toBe(true);

    service.save(botId, { name: "quiet", description: "Use for quiet tasks.", instructions: "Do it carefully and quietly.", enabled: true });
    expect(service.view(botId).skills[0]!.enabled).toBe(true);
  });

  it("rejects a stale revision", () => {
    const { service, add } = setup();
    const botId = add(id());
    service.save(botId, { name: "a", description: "Use for a.", instructions: "A.", enabled: true });
    expect(() =>
      service.save(botId, { name: "b", description: "Use for b.", instructions: "B.", enabled: true }, "deadbeef"),
    ).toThrowError(/changed elsewhere/);
  });

  it("refuses a mutation while busy, but lets a trusted actor create a new self guide", () => {
    const { service, add, flag } = setup();
    const botId = add(id());
    flag.busy = true;
    expect(() =>
      service.save(botId, { name: "busy", description: "Use for busy.", instructions: "X.", enabled: true }),
    ).toThrowError(/busy/);
    const view = service.save(
      botId,
      { name: "self", description: "Use for self.", instructions: "X.", enabled: true },
      undefined,
      { botId },
    );
    expect(view.skills.map((skill) => skill.name)).toContain("self");
    expect(() =>
      service.save(botId, { name: "self", description: "Use for self.", instructions: "Y.", enabled: true }, undefined, { botId }),
    ).toThrowError(/busy/);
  });

  it("blanks out a guide whose stored bytes changed after review", () => {
    const { service, add } = setup();
    const botId = add(id());
    service.save(botId, { name: "tamper", description: "Use for tamper.", instructions: "X.", enabled: true });
    writeFileSync(join(workspaceDir(botId), "skills", "tamper", "SKILL.md"), SKILL_MD("tamper"));
    expect(service.readEnabled(botId, "tamper")).toBeNull();
    expect(() => service.setEnabled(botId, "tamper", true, service.view(botId).revision)).toThrowError(/changed|review/);
  });
});

describe("ColonieSkills imports and the library", () => {
  it("lands a pasted import disabled and non-editable", async () => {
    const { service, add } = setup();
    const botId = add(id());
    const view = await service.importSource(botId, "", service.view(botId).revision, SKILL_MD("pasted-guide"));
    const skill = view.skills.find((entry) => entry.name === "pasted-guide")!;
    expect(skill).toMatchObject({ origin: "private", editable: false, enabled: false });
    expect(service.readEnabled(botId, "pasted-guide")).toBeNull();
    const enabledView = service.setEnabled(botId, "pasted-guide", true, view.revision);
    expect(enabledView.skills.find((entry) => entry.name === "pasted-guide")!.enabled).toBe(true);
  });

  it("shadows a same-named library guide with a private one without losing the assignment", () => {
    const { service, add } = setup();
    const botId = add(id());
    const installed = installLibrarySkill({
      name: "shared-guide",
      instructions: SKILL_MD("shared-guide"),
      source: "test",
      reviewState: "approved",
    });
    expect("error" in installed).toBe(false);
    service.assign(botId, ["shared-guide"], service.view(botId).revision);
    expect(service.view(botId).skills.find((entry) => entry.name === "shared-guide")!.origin).toBe("library");

    const view = service.save(botId, {
      name: "shared-guide",
      description: "Use a private override.",
      instructions: "Private.",
      enabled: true,
    });
    const shadow = view.skills.find((entry) => entry.name === "shared-guide")!;
    expect(shadow.origin).toBe("private");
    expect(view.assignedSkills).toContain("shared-guide");
  });

  it("refuses to assign an unknown name", () => {
    const { service, add } = setup();
    const botId = add(id());
    expect(() => service.assign(botId, ["nope"], service.view(botId).revision)).toThrowError(/not a library guide/);
  });
});

describe("ColonieSkills context", () => {
  it("says so plainly when nothing is enabled", () => {
    const { service, add } = setup();
    const botId = add(id());
    const context = service.context(botId);
    expect(context.entries).toEqual([]);
    expect(context.text).toBe("No app-managed guides are enabled for this request.");
  });

  it("builds a bounded named index that never carries a body", () => {
    const { service, add } = setup();
    const botId = add(id());
    for (let i = 0; i < 40; i += 1) {
      service.save(botId, {
        name: `guide-${i}`,
        description: `Description ${i} `.padEnd(200, "x"),
        instructions: `SECRET BODY ${i}`,
        enabled: true,
      });
    }
    const context = service.context(botId);
    expect(context.entries.length).toBeGreaterThan(0);
    expect(context.entries.length).toBeLessThanOrEqual(30);
    expect(Buffer.byteLength(context.text, "utf8")).toBeLessThanOrEqual(4000);
    expect(context.text).toContain("read_skill");
    expect(context.text).not.toContain("SECRET BODY");
  });

  it("excludes disabled guides from the index", () => {
    const { service, add } = setup();
    const botId = add(id());
    service.save(botId, { name: "off-guide", description: "Use for off.", instructions: "X.", enabled: false });
    const context = service.context(botId);
    expect(context.entries).toEqual([]);
    expect(context.text).not.toContain("off-guide");
  });
});