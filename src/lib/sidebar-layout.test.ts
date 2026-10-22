// The sidebar has no teams: one list of bots, led by one Chief of Staff.
import { describe, expect, it } from "vitest";

import { partitionSidebarBots, withoutTeams, type SidebarBot } from "./sidebar-layout";

describe("one list of bots", () => {
  it("a bot filed in an old team, or Chief of one, is an ordinary row; the first Chief leads", () => {
    const plain: SidebarBot = { id: "a" };
    const bots: SidebarBot[] = [
      plain,
      { id: "b", section: "Research" },
      { id: "c", chiefOfStaff: true },
      { id: "d", section: "Sales", chiefOfStaff: true },
    ];
    const flat = withoutTeams(bots);
    expect(flat[0]).toBe(plain);
    expect(flat.every((bot) => !bot.section)).toBe(true);
    const parts = partitionSidebarBots(flat);
    expect(parts.unsectionedChief?.id).toBe("c");
    expect(parts.unsectionedBots.map((bot) => bot.id)).toEqual(["a", "b", "d"]);
    expect(parts.sectionedBots).toEqual([]);
    expect(parts.sectionChiefs).toEqual([]);
  });
});
