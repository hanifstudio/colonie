// @vitest-environment happy-dom
// The app's global shortcut listener, extracted from App.tsx. This mounts the
// hook alone (no shell, no store) and presses real keys at the window, so it
// proves the bindings, the guards and the live re-subscription on their own.
import { createElement, type Dispatch } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, Bot } from "@/state/store";
import { useAppKeyboardShortcuts } from "./use-app-keyboard-shortcuts";

function bot(id: string, hidden = false): Bot {
  return {
    id, threadId: `thread:${id}`, name: id, title: "", description: "",
    notifications: true, color: "green", unread: false, hidden,
    messages: [],
    modelSelection: { instanceId: "fixture", model: "fixture" },
  };
}

let container: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let props: { bots: Bot[]; selectedId: string; shortcutsOpen: boolean };

function Probe() {
  useAppKeyboardShortcuts({ ...props, dispatch: dispatch as unknown as Dispatch<Action> });
  return null;
}

function render() {
  flushSync(() => root.render(createElement(Probe)));
}

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  dispatch = vi.fn();
  props = { bots: [bot("a"), bot("b"), bot("c")], selectedId: "a", shortcutsOpen: false };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("useAppKeyboardShortcuts", () => {
  it("opens the cheat sheet on ? and consumes the key", () => {
    const event = press({ key: "?" });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleShortcuts", open: true });
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens the cheat sheet on the ⌘/ chord", () => {
    press({ key: "/", metaKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleShortcuts", open: true });
  });

  it("leaves the help key alone while typing in a field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    press({ key: "?" }, input);
    expect(dispatch).not.toHaveBeenCalled();
    input.remove();
  });

  it("asks for a new bot on ⌘N and on Ctrl+N", () => {
    press({ key: "n", metaKey: true });
    press({ key: "n", ctrlKey: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(1, { type: "toggleNewBot", open: true });
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: "toggleNewBot", open: true });
  });

  it("ignores a bare n and the ⇧⌘N chord", () => {
    press({ key: "n" });
    press({ key: "n", metaKey: true, shiftKey: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("jumps to the nth visible bot, skipping hidden ones", () => {
    props.bots = [bot("hidden", true), bot("first"), bot("second")];
    props.selectedId = "second";
    render();
    press({ key: "1", metaKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "first" });
  });

  it("selects the third visible bot on ⌘3", () => {
    press({ key: "3", metaKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "c" });
  });

  it("does nothing when the digit is past the end of the roster", () => {
    press({ key: "9", metaKey: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("steps forward with ⌘⇧] and wraps", () => {
    props.selectedId = "c";
    render();
    press({ key: "]", metaKey: true, shiftKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "a" });
  });

  it("steps back with ⌘⇧[ and wraps", () => {
    props.selectedId = "a";
    render();
    press({ key: "[", metaKey: true, shiftKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "c" });
  });

  it("stays out of the way while the cheat sheet is open", () => {
    props.shortcutsOpen = true;
    render();
    press({ key: "?" });
    press({ key: "n", metaKey: true });
    press({ key: "1", metaKey: true });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("leaves a composing key and an already-handled key alone", () => {
    press({ key: "n", metaKey: true, isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("follows the roster and selection after a re-render", () => {
    props.bots = [bot("a")];
    render();
    press({ key: "2", metaKey: true });
    expect(dispatch).not.toHaveBeenCalled();
    props.bots = [bot("a"), bot("b")];
    render();
    press({ key: "2", metaKey: true });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: "b" });
  });
});