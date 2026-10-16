import { describe, expect, it } from "vitest";

import { routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {
  it("names the bot's own computer", () => {
    expect(routineRunsOn({ roomGoal: false })).toEqual({
      label: "This computer", hint: "Starts while Colonie is open here.",
    });
    expect(routineRunsOn({ roomGoal: false, computer: "vm" }).label).toBe("The bot's virtual machine");
    expect(routineRunsOn({ roomGoal: true }).label).toBe("This computer, with the whole group");
  });

  it("reads a routine stored on the removed cloud computer as the bot's own", () => {
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud" })).toEqual(routineRunsOn({ roomGoal: false }));
    expect(routineRunsOn({ roomGoal: false, runOn: "cloud", computer: "vm" }).label).toBe("The bot's virtual machine");
  });

  it("never names Boat or a cloud runner", () => {
    for (const runOn of ["cloud", "maus", undefined]) {
      for (const roomGoal of [true, false]) {
        const { label, hint } = routineRunsOn({ roomGoal, runOn });
        expect(`${label} ${hint}`).not.toMatch(/boat|runner|cloud/i);
      }
    }
  });
});