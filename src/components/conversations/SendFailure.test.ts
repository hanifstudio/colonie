// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SendFailure } from "./SendFailure";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(() => root.unmount()); document.body.replaceChildren(); });

test("says why, promises the words are kept, and Try again sends once per press", async () => {
  const onRetry = vi.fn();
  await act(() => root.render(createElement(SendFailure, { reason: "No connection.", onRetry })));
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("Not sent. No connection.");
  expect(alert.textContent).toContain("still in the box");
  await act(async () => { host.querySelector("button")!.click(); });
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("while it is being sent again the button cannot be pressed", async () => {
  const onRetry = vi.fn();
  await act(() => root.render(createElement(SendFailure, { reason: "x", busy: true, onRetry })));
  await act(async () => { host.querySelector("button")!.click(); });
  expect(onRetry).not.toHaveBeenCalled();
});

test("a reason without an ending mark still reads as a sentence", async () => {
  await act(() => root.render(createElement(SendFailure, { reason: "Failed to fetch", onRetry: () => {} })));
  expect(host.textContent).toContain("Not sent. Failed to fetch. Your message");
});
