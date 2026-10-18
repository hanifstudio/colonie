// The boot sweep's flag gate and failure guard: flag-off boots leave the
// pending assignments untouched, flag-on boots apply them and clear the file,
// and a failing patch is reported without stopping the server.
import { expect, test, vi } from "vitest";
import { readPendingAssignments, runSkillsLibraryBoot, writePendingAssignments } from "./skills-library-migration.ts";

function build() {
  const patchBot = vi.fn();
  const store = { bots: [{ id: "b1" }], patchBot } as never;
  return { patchBot, store };
}

test("a flag-off boot leaves the pending assignments alone", () => {
  writePendingAssignments({ b1: ["deploy"] });
  const { patchBot, store } = build();
  runSkillsLibraryBoot({ cfg: {}, store });
  expect(patchBot).not.toHaveBeenCalled();
  expect(readPendingAssignments().b1).toEqual(["deploy"]);
});

test("a flag-on boot applies the pending assignments and clears the file", () => {
  writePendingAssignments({ b1: ["deploy"] });
  const { patchBot, store } = build();
  runSkillsLibraryBoot({ cfg: { features: { skillsLibrary: true } }, store });
  expect(patchBot).toHaveBeenCalledWith("b1", { assignedSkills: ["deploy"] });
  expect(readPendingAssignments()).toEqual({});
});

test("a failing patch is reported, never thrown at boot", () => {
  writePendingAssignments({ b1: ["deploy"] });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const store = { bots: [{ id: "b1" }], patchBot: () => { throw new Error("disk full"); } } as never;
    expect(() => runSkillsLibraryBoot({ cfg: { features: { skillsLibrary: true } }, store })).not.toThrow();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("boot sweep failed"));
  } finally {
    error.mockRestore();
  }
});
