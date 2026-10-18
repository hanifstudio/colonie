// Validation at the model-selection boundary: the cheap rejections are the
// ones worth guarding, because a bad selection would reach a provider launch.
import { expect, test } from "vitest";
import { createModelSelection } from "./model-selection.ts";

const build = (over: Record<string, unknown> = {}) =>
  createModelSelection({
    registry: { get: () => undefined },
    providerInstancesChanging: () => new Set<string>(),
    ...over,
  } as never);

test("a non-object selection is rejected", () => {
  const { checkedModelSelection } = build();
  expect(checkedModelSelection(null)).toEqual({ ok: false, status: 400, error: "modelSelection must be an object" });
});

test("instanceId and model are required", () => {
  const { checkedModelSelection } = build();
  expect(checkedModelSelection({ model: "m" })).toMatchObject({ ok: false, status: 400 });
  expect(checkedModelSelection({ instanceId: "i" })).toMatchObject({ ok: false, status: 400 });
});

test("a variant and an effort level cannot be combined", () => {
  const { checkedModelSelection } = build();
  expect(checkedModelSelection({ instanceId: "i", model: "m", effort: "low", variant: "v" }))
    .toEqual({ ok: false, status: 400, error: "choose either a model variant or an effort level" });
});

test("a busy bot refuses a changed model", () => {
  const { checkedModelSelection } = build();
  const current = { selection: { instanceId: "i", model: "old" }, busy: true };
  expect(checkedModelSelection({ instanceId: "i", model: "new" }, current))
    .toEqual({ ok: false, status: 409, error: "the bot is working — stop it before changing models" });
});

test("an unchanged selection passes while busy", () => {
  const { checkedModelSelection } = build();
  const current = { selection: { instanceId: "i", model: "m" }, busy: true };
  expect(checkedModelSelection({ instanceId: "i", model: "m" }, current))
    .toEqual({ ok: true, selection: { instanceId: "i", model: "m" } });
});