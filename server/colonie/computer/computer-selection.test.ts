import { expect, test } from "vitest";
import { pickComputer, type ComputerOption } from "./computer-selection.ts";

const option = (surface: ComputerOption["surface"], flags: Partial<ComputerOption> = {}): ComputerOption => ({
  surface, available: false, ready: false, canStart: false, canCreate: false, ...flags,
});

test("asking for a place gets that place, or nothing when it is not offered", () => {
  const options = [option("local", { ready: true }), option("vm", { canCreate: true })];

  expect(pickComputer(options, "local", undefined, false)).toEqual({ option: options[0], current: false });
  expect(pickComputer(options, "browser", undefined, false).option).toBeUndefined();
  // a place only being creatable is still the place when it is asked for by name
  expect(pickComputer(options, "vm", undefined, false).option).toEqual(options[1]);
});

test("the turn's own place is kept, not restarted somewhere else", () => {
  const options = [option("vm", { ready: true }), option("local", { ready: true })];

  expect(pickComputer(options, "auto", "vm", false)).toEqual({ option: options[0], current: true });
  expect(pickComputer(options, "vm", "vm", false).current).toBe(true);
  expect(pickComputer(options, "local", "vm", false)).toEqual({ option: options[1], current: false });
});

test("a place this turn is about to wake counts as this turn's before it is up", () => {
  const waking = option("vm", { available: true, canCreate: true });

  expect(pickComputer([waking], "auto", "vm", true)).toEqual({ option: waking, current: true });
  // and without that, an unready place is not this turn's
  expect(pickComputer([waking], "auto", "vm", false)).toEqual({ option: waking, current: false });
});

test("Auto prefers a ready virtual machine over an already-ready local one", () => {
  const local = option("local", { ready: true });
  const vm = option("vm", { ready: true });

  expect(pickComputer([local, vm], "auto", undefined, false).option).toBe(vm);
  expect(pickComputer([vm, local], "auto", undefined, false).option).toBe(vm);
  expect(pickComputer([local], "auto", undefined, false).option).toBe(local);
});

test("Auto walks its order: ready, then startable, then creatable, virtual first", () => {
  const creatable = option("browser", { canCreate: true });
  const creatableVm = option("vm", { canCreate: true });
  const startable = option("local", { canStart: true });

  expect(pickComputer([creatable, startable, creatableVm], "auto", undefined, false).option).toBe(startable);
  expect(pickComputer([creatable, creatableVm], "auto", undefined, false).option).toBe(creatableVm);
  expect(pickComputer([creatable], "auto", undefined, false).option).toBe(creatable);
  expect(pickComputer([option("vm")], "auto", undefined, false).option).toBeUndefined();
});

test("an offered place that cannot be used at all is never picked by Auto", () => {
  const dead = option("vm");

  expect(pickComputer([dead], "auto", undefined, false).option).toBeUndefined();
  expect(pickComputer([dead], "auto", "vm", false).option).toBeUndefined();
  // asked for by name it is still the answer, just not this turn's place
  expect(pickComputer([dead], "vm", undefined, false)).toEqual({ option: dead, current: false });
});