// @vitest-environment happy-dom
// The Cancel / Stop button on a group's working line: shown only to the person who asked, worded by
// whether the request is waiting or running, safe against a double press, and honest when it fails.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Message } from "@/state/store";
import { WorkingLineCancel } from "./WorkingLineCancel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); });

const line = (extra: Partial<Message> = {}) => ({
  id: "m1", role: "bot", kind: "text", text: "Reka is finishing something else; this is next.", working: true, askedBy: "ana",
  from: { botId: "b1", name: "Reka", color: "" }, ...extra,
}) as unknown as Message;
const show = (message: Message, onCancel?: (id: string) => Promise<void>, viewerKey = "ana") =>
  act(() => root.render(createElement(WorkingLineCancel, { message, viewerKey, onCancel })));
const button = () => host.querySelector<HTMLButtonElement>("button");

test("a request that is still waiting offers Cancel, named for the bot", async () => {
  await show(line(), async () => {});
  expect(button()?.getAttribute("aria-label")).toBe("Cancel Reka's queued request");
  expect(button()?.getAttribute("title")).toContain("will not run");
});

test("a request the bot is working on offers Stop", async () => {
  await show(line({ workingSince: Date.now() }), async () => {});
  expect(button()?.getAttribute("aria-label")).toBe("Stop Reka's work on this request");
});

test("nobody but the person who asked sees the button", async () => {
  await show(line(), async () => {}, "bob");
  expect(button()).toBeNull();
  await show(line({ askedBy: undefined }), async () => {});
  expect(button()).toBeNull();
  await show(line(), undefined);
  expect(button()).toBeNull();
});

test("pressing it cancels that line once, and a second press while it is sent does nothing", async () => {
  let finish!: () => void;
  const onCancel = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  await show(line(), onCancel);
  await act(async () => { button()!.click(); });
  expect(onCancel).toHaveBeenCalledWith("m1");
  // sending: the button is busy and cannot be pressed again
  expect(button()!.disabled).toBe(true);
  expect(button()!.getAttribute("aria-busy")).toBe("true");
  await act(async () => { button()!.click(); });
  expect(onCancel).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});

test("if it fails the reason is shown and the button comes back", async () => {
  const onCancel = vi.fn<(id: string) => Promise<void>>(async () => { throw new Error("no such work of yours on that line"); });
  await show(line(), onCancel);
  await act(async () => { button()!.click(); });
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("no such work of yours"));
  expect(button()!.disabled).toBe(false);
  // trying again clears the old reason first
  onCancel.mockImplementationOnce(() => new Promise<void>(() => {}));
  await act(async () => { button()!.click(); });
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
