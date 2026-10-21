// Creating a Shared workspace from the desktop app, as the owner sees it:
// connect DigitalOcean, the monthly price first, then the server's progress
// until it can be opened.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { CreateSharedWorkspaceView, openShared, type SharedServersState } from "./CreateSharedWorkspace";

const disconnected: SharedServersState = { digitalOcean: { connected: false, region: "sgp1", size: "s-2vcpu-4gb" }, servers: [] };
const connected: SharedServersState = {
  digitalOcean: { connected: true, region: "sgp1", size: "s-2vcpu-4gb", account: { email: "owner@example.com", dropletLimit: 3, active: true }, price: { monthlyUsd: 24, hourlyUsd: 0.0357 } },
  servers: [],
};
const view = (state: SharedServersState | null, extra: Partial<Parameters<typeof CreateSharedWorkspaceView>[0]> = {}) => renderToStaticMarkup(createElement(CreateSharedWorkspaceView, {
  state, name: "Launch Team", busy: "", error: "", waitingForBrowser: false,
  onName: () => {}, onConnect: () => {}, onCreate: () => {}, onOpen: () => {}, onDelete: () => {}, onClose: () => {}, ...extra,
}));

test("before anything, the owner learns where it runs and who bills them, and connects DigitalOcean", () => {
  const html = view(disconnected);
  expect(html).toContain("Create a Shared workspace");
  expect(html).toMatch(/your own DigitalOcean account/);
  expect(html).toContain("Connect DigitalOcean");
  expect(html).not.toContain("Create workspace");
});

test("while the browser sign-in is open, the dialog says it is waiting", () => {
  expect(view(disconnected, { waitingForBrowser: true })).toMatch(/Finish connecting in your browser/);
});

test("connected, the live monthly price and place are shown before Create", () => {
  const html = view(connected);
  expect(html).toContain("owner@example.com");
  expect(html).toContain("$24 a month");
  expect(html).toContain("Singapore");
  expect(html).toMatch(/Billed by DigitalOcean until you delete it/);
  expect(html).toContain("Create workspace");
});

test("each server shows where it is, and a ready one can be opened or deleted", () => {
  const html = view({
    ...connected,
    servers: [
      { id: "a", name: "Launch Team", tag: "colonie-ws-a", region: "sgp1", size: "s-2vcpu-4gb", state: "starting", createdAt: "2026-10-21T00:00:00Z", address: "https://203-0-113-7.sslip.io" },
      { id: "b", name: "Design", tag: "colonie-ws-b", region: "sgp1", size: "s-2vcpu-4gb", state: "ready", createdAt: "2026-10-21T00:00:00Z", address: "https://203-0-113-8.sslip.io", inviteUrl: "https://203-0-113-8.sslip.io/invite/x" },
      { id: "c", name: "Broken", tag: "colonie-ws-c", region: "sgp1", size: "s-2vcpu-4gb", state: "failed", createdAt: "2026-10-21T00:00:00Z", error: "The server did not answer within half an hour." },
    ],
  });
  expect(html).toMatch(/Starting Colonie/);
  expect(html).toContain("Open");
  expect(html).toContain("did not answer within half an hour");
  expect(html.match(/Delete/g)?.length).toBe(3);
});

test("the first open uses the owner's invite, later opens the address", async () => {
  const addFromLink = vi.fn(async () => true);
  const markOpened = vi.fn(async () => {});
  const server = { id: "b", name: "Design", tag: "t", region: "sgp1", size: "s", state: "ready" as const, createdAt: "", address: "https://h.sslip.io", inviteUrl: "https://h.sslip.io/invite/x" };
  expect(await openShared({ addFromLink }, markOpened, server)).toBe(true);
  expect(addFromLink).toHaveBeenLastCalledWith("https://h.sslip.io/invite/x", "Design");
  expect(markOpened).toHaveBeenCalledWith("b");
  await openShared({ addFromLink }, markOpened, { ...server, opened: true });
  expect(addFromLink).toHaveBeenLastCalledWith("https://h.sslip.io", "Design");
});
