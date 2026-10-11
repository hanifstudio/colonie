import { createElement, type EffectCallback, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";
import type { InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as EffectCallback[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? initial() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? next(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useEffect: (effect: EffectCallback) => {
    fixture.effects.push(effect);
  },
}));
const store = vi.hoisted(() => ({ instances: [] as unknown[], dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: store.api, useStore: () => ({ state: { instances: store.instances }, dispatch: store.dispatch }) }));
import { EnginesBeat } from "./EnginesBeat";

const personal = (instanceId: string, ready: boolean): InstanceInfo => ({
  instanceId, driverKind: "claudeAgent", displayName: instanceId, install: { docsUrl: "https://example.test" },
  snapshot: { state: ready ? "available" : "unavailable", authenticated: ready },
  models: { default: "m", options: [] },
});
const props = { onNext: vi.fn(), onSkip: vi.fn(), setMascot: vi.fn(), bump: vi.fn() };

function render() {
  fixture.index = 0;
  fixture.effects = [];
  let tree: ReactNode = null;
  function Capture() {
    tree = EnginesBeat({ ...props });
    return tree;
  }
  return { html: renderToStaticMarkup(createElement(Capture)) };
}

beforeEach(() => {
  fixture.values = [];
  store.dispatch.mockReset();
  store.instances = [personal("claude", false), personal("codex", false)];
  vi.stubGlobal("window", {});
  setLocale("en");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the engines beat", () => {
  it("lists every model provider with its setup state", () => {
    const { html } = render();
    expect(html).toContain("claude");
    expect(html).toContain("codex");
    expect(html).toContain("0 ready");
    expect(html).toContain("2 to set up");
  });

  it("frames Codex and Claude Code as the choice, with help when neither is installed", () => {
    const { html } = render();
    expect(html).toContain("Codex or Claude Code");
    expect(html).toContain("walk you through it");
  });

  it("never offers organisation sign-in, even on the local desktop", () => {
    vi.stubGlobal("window", { ogb: { organization: { onState: vi.fn(), state: vi.fn() } } });
    const { html } = render();
    expect(store.dispatch).not.toHaveBeenCalledWith({ type: "toggleAppSettings", open: true, section: "organization" });
    expect(html).not.toContain("Using");
  });
});