import { describe, expect, it } from "vitest";

import { routineRunsOn } from "./routine-display";

describe("where a routine runs", () => {
  it("names the bot's own computer", () => {
    expect(routineRunsOn({})).toEqual({
      label: "This computer", hint: "Starts while Colonie is open here.",
    });
    expect(routineRunsOn({ computer: "vm" }).label).toBe("The bot's virtual machine");
  });

  it("reads a routine stored on the removed cloud computer as the bot's own", () => {
    expect(routineRunsOn({ runOn: "cloud" })).toEqual(routineRunsOn({}));
    expect(routineRunsOn({ runOn: "cloud", computer: "vm" }).label).toBe("The bot's virtual machine");
  });

  it("never names Boat or a cloud runner", () => {
    for (const runOn of ["cloud", "maus", undefined]) {
      const { label, hint } = routineRunsOn({ runOn });
      expect(`${label} ${hint}`).not.toMatch(/boat|runner|cloud/i);
    }
  });
});
