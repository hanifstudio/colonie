import { expect, afterEach, test } from "vitest";
import { canAccessTeam, canReachPeer, coordinatorSupervises, peerAllowed, peerStatus, reachablePeers } from "./peer-roster.ts";
import type { RosterMember } from "./peer-roster.ts";

const member = (over: Partial<RosterMember> & { id: string }): RosterMember => ({ name: over.id, section: "Design", ...over });

afterEach(() => {
  delete process.env.COLONIE_OPEN_TEAMS;
});

test("one team is the default reach, and an unknown owner list fails closed", () => {
  const ada = member({ id: "a", name: "Ada", section: "Design" });
  expect(canReachPeer(ada, member({ id: "b", name: "Bogdan", section: "Design" }))).toBe(true);
  expect(canReachPeer(ada, member({ id: "c", name: "Cinta", section: "Sales" }))).toBe(false);
  expect(canReachPeer(ada, member({ id: "d", name: "Dodi", section: undefined }))).toBe(false);
});

test("a Chief reaches the teams the owner granted and nothing more", () => {
  const chief = member({ id: "chief", name: "Chief", section: "Design", chiefOfStaff: true, managedSections: ["Sales"] });
  expect(canAccessTeam(chief, "Sales")).toBe(true);
  expect(canAccessTeam(chief, "Design")).toBe(true);
  expect(canAccessTeam(chief, "Support")).toBe(false);
  // a title alone, an imported persona or a room membership is not a grant
  const titled = member({ id: "titled", name: "Titled", section: "Design", chiefOfStaff: true });
  expect(canAccessTeam(titled, "Sales")).toBe(false);
  expect(canAccessTeam(chief, "  Sales  ")).toBe(true);
  // team names are matched exactly, trimming aside — "sales" is another team
  expect(canAccessTeam(chief, "sales")).toBe(false);
  expect(coordinatorSupervises(chief, member({ id: "x", section: "Sales" }))).toBe(true);
  expect(coordinatorSupervises(chief, member({ id: "x", section: "" }))).toBe(false);
  expect(coordinatorSupervises(titled, member({ id: "x", section: "Sales" }))).toBe(false);
});

test("only the sender's list bounds the pair", () => {
  // the target may not refuse work from its own team's Chief by listing nobody
  expect(canReachPeer(member({ id: "a", section: "Design" }), member({ id: "b", section: "Design", peers: [] }))).toBe(true);
  // but the sender's list does bound it, and an empty list cuts it off entirely
  const cutOff = member({ id: "a", section: "Design", peers: [] });
  expect(canReachPeer(cutOff, member({ id: "b", section: "Design" }))).toBe(false);
  const narrowed = member({ id: "a", section: "Design", peers: ["b"] });
  expect(canReachPeer(narrowed, member({ id: "b", section: "Design" }))).toBe(true);
  expect(canReachPeer(narrowed, member({ id: "c", section: "Design" }))).toBe(false);
});

test("a hand-edited peers value degrades to the default instead of failing a turn", () => {
  expect(peerAllowed({ peers: "b" as never, visibility: "everyone" }, member({ id: "b" }))).toBe(true);
  expect(peerAllowed({ peers: null as never, visibility: "everyone" }, member({ id: "b" }))).toBe(true);
});

test("a restricted teammate cannot be reached by one everyone can see", () => {
  expect(peerAllowed({ visibility: "everyone" }, member({ id: "b", visibility: "admins" }))).toBe(false);
  expect(peerAllowed({ visibility: "admins" }, member({ id: "b", visibility: "admins" }))).toBe(true);
  // a bare id carries no audience to compare, so only the pair list applies
  expect(peerAllowed({ visibility: "everyone" }, "b")).toBe(true);
});

test("a hidden bot is unreachable and a bot never reaches itself", () => {
  const ada = member({ id: "a", name: "Ada", section: "Design" });
  expect(canReachPeer(ada, member({ id: "b", section: "Design", hidden: true }))).toBe(false);
  expect(canReachPeer(ada, ada)).toBe(false);
});

test("the roster a bot is told about is exactly what it may reach", () => {
  const ada = member({ id: "a", section: "Design", peers: ["b"] });
  const team = [ada, member({ id: "b", section: "Design" }), member({ id: "c", section: "Sales" }), member({ id: "d", section: "Design", hidden: true })];

  expect(reachablePeers(team, ada).map((bot) => bot.id)).toEqual(["b"]);
});

test("opening every team groups the sidebar without widening a Chief's authority", () => {
  process.env.COLONIE_OPEN_TEAMS = "1";
  const ada = member({ id: "a", section: "Design" });
  const chief = member({ id: "chief", section: "Design", chiefOfStaff: true });

  expect(canAccessTeam(ada, "Sales")).toBe(true);
  // hidden bots and the pair list still apply
  expect(canReachPeer(ada, member({ id: "b", section: "Sales", hidden: true }))).toBe(false);
  expect(canReachPeer(member({ id: "a", section: "Design", peers: [] }), member({ id: "b", section: "Sales" }))).toBe(false);
  // and it grants no Chief authority over another team
  expect(coordinatorSupervises(chief, member({ id: "x", section: "Sales" }))).toBe(false);
});

test("what a teammate is doing prefers the harness signal over the busy flag", () => {
  expect(peerStatus("working", false)).toBe("working");
  expect(peerStatus("waiting-on-you", false)).toBe("waiting-on-user");
  expect(peerStatus("no-signal", false)).toBe("not-responding");
  expect(peerStatus("dead", false)).toBe("unavailable");
  expect(peerStatus("idle", true)).toBe("working");
  expect(peerStatus(undefined, true)).toBe("working");
  expect(peerStatus("idle", false)).toBe("available");
});