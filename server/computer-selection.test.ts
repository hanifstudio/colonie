import { describe, expect, it } from "vitest";

import { pickComputer, type ComputerOption } from "./computer-selection.ts";

const option = (surface: ComputerOption["surface"], state: "ready" | "asleep" | "missing" | "off"): ComputerOption => ({
  surface,
  available: state !== "off",
  ready: state === "ready",
  canStart: state === "asleep",
  canCreate: state === "missing",
});

describe("which computer select_computer picks", () => {
  // A turn before its first computer call: the place it starts on is missing
  // or asleep, and the built-in browser is ready.
  const offered = (vm: "asleep" | "missing") => [option("vm", vm), option("local", "off"), option("browser", "ready")];

  it("keeps the place this turn starts on its first call: asking for it or for Auto never moves the request", () => {
    for (const vm of ["asleep", "missing"] as const) {
      for (const requested of ["vm", "auto"] as const) {
        const picked = pickComputer(offered(vm), requested, "vm", true);
        expect(picked.option?.surface).toBe("vm");
        expect(picked.current).toBe(true);
      }
    }
  });

  it("switches away from a current computer that is not up and not this turn's to start", () => {
    // A failed start, or a desktop only leased once it is up.
    const auto = pickComputer(offered("asleep"), "auto", "vm", false);
    expect(auto.option?.surface).toBe("browser");
    expect(auto.current).toBe(false);
    const vm = pickComputer(offered("asleep"), "vm", "vm", false);
    expect(vm.option?.surface).toBe("vm");
    expect(vm.current).toBe(false);
  });

  it("keeps a ready current computer, and moves to another when asked", () => {
    const options = [option("vm", "ready"), option("browser", "ready")];
    expect(pickComputer(options, "auto", "vm", false)).toMatchObject({ option: { surface: "vm" }, current: true });
    expect(pickComputer(options, "browser", "vm", true)).toMatchObject({ option: { surface: "browser" }, current: false });
  });

  it("on Auto with nothing current prefers a ready Local VM, then anything ready, then one it can start or create", () => {
    expect(pickComputer([option("browser", "ready"), option("vm", "ready")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("local", "asleep"), option("browser", "ready")], "auto", "off", false).option?.surface).toBe("browser");
    expect(pickComputer([option("local", "missing"), option("vm", "asleep")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("local", "missing"), option("vm", "missing")], "auto", "off", false).option?.surface).toBe("vm");
    expect(pickComputer([option("local", "off")], "auto", "off", false).option).toBeUndefined();
  });
});