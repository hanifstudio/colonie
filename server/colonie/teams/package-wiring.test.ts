// A team share must never export a skill whose instructions no longer match
// what the person is looking at: "all" drops it and says so, an explicit
// choice refuses.
import { expect, test } from "vitest";
import { createTeamPackageWiring } from "./package-wiring.ts";

type Listing = { name: string; description: string; enabled: boolean };

const bot = (id: string) => ({ id }) as never;

function build(listingsByBot: Record<string, Listing[]>, readable: string[] = ["alpha", "beta"]) {
  return createTeamPackageWiring({
    listBotSkills: (b: { id: string }) => listingsByBot[b.id] ?? [],
    readBotSkillFile: (_b: unknown, name: string) => (readable.includes(name) ? `# ${name}` : null),
  } as never).collectTeamSkills;
}

const listings = {
  b1: [
    { name: "alpha", description: "Alpha", enabled: true },
    { name: "beta", description: "Beta", enabled: false },
  ],
};

test("a whole-team share exports every skill and reports what changed", () => {
  const collect = build(listings, ["alpha"]); // beta's stored bytes changed
  const result = collect([bot("b1")], "all");
  expect(result).toMatchObject({ ok: true, all: true, available: ["alpha", "beta"] });
  if (!result.ok) throw new Error("unreachable");
  expect(result.skillsByBot.get("b1")?.map((skill) => skill.name)).toEqual(["alpha"]);
  expect(result.skipped).toEqual([{ part: "skills[beta]", reason: "skill_changed" }]);
});

test("naming a changed skill refuses the share instead of dropping it", () => {
  const collect = build(listings, ["alpha"]);
  expect(collect([bot("b1")], ["beta"])).toEqual({
    ok: false,
    error: "Skill \"beta\" changed or is unavailable and cannot be shared safely",
    available: ["alpha", "beta"],
  });
});

test("a name this team does not have is refused with the available list", () => {
  const collect = build(listings);
  expect(collect([bot("b1")], ["gamma"])).toEqual({
    ok: false,
    error: "This team has no skill named \"gamma\"",
    available: ["alpha", "beta"],
  });
});

test("a selection that is not a list of skill names is refused", () => {
  const collect = build(listings);
  expect(collect([bot("b1")], ["Not A Name"])).toMatchObject({ ok: false, error: "skills must be \"all\" or a list of skill names" });
  expect(collect([bot("b1")], { name: "alpha" })).toMatchObject({ ok: false });
});

test("the export carries each skill's listing fields with its instructions", () => {
  const collect = build(listings);
  const result = collect([bot("b1")], "all");
  if (!result.ok) throw new Error("unreachable");
  expect(result.skillsByBot.get("b1")).toEqual([
    { name: "alpha", description: "Alpha", instructions: "# alpha", enabled: true },
    { name: "beta", description: "Beta", instructions: "# beta", enabled: false },
  ]);
});
