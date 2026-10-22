// The owner's Shared workspace servers, as the menu's list shows them:
// where each is and how it is doing, Open and Delete or Forget. Making one
// is the onboarding (onboarding/beats/SharedBeats.test.ts).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { SharedServersView, openShared, type SharedServersState } from "./CreateSharedWorkspace";

const ocean: SharedServersState["digitalOcean"] = { connected: true, region: "sgp1", size: "s-2vcpu-4gb" };
const view = (state: SharedServersState | null) => renderToStaticMarkup(createElement(SharedServersView, {
  state, busy: "", error: "", onOpen: () => {}, onDelete: () => {}, onNew: () => {}, onClose: () => {},
}));

test("with none yet, the list says how to make one", () => {
  const html = view({ digitalOcean: ocean, servers: [] });
  expect(html).toContain("Shared workspace servers");
  expect(html).toMatch(/New workspace → Shared/);
  expect(html).not.toContain("Connect DigitalOcean");
});

test("each server shows where it is, and a ready one can be opened; a droplet deleted, an own server forgotten", () => {
  const html = view({
    digitalOcean: ocean,
    servers: [
      { id: "a", name: "Launch Team", tag: "colonie-ws-a", region: "sgp1", size: "s-2vcpu-4gb", state: "starting", createdAt: "", address: "https://203-0-113-7.sslip.io" },
      { id: "b", name: "Design", tag: "colonie-ws-b", region: "sgp1", size: "s-2vcpu-4gb", state: "ready", createdAt: "", address: "https://203-0-113-8.sslip.io", inviteUrl: "https://203-0-113-8.sslip.io/invite/x" },
      { id: "c", name: "Broken", tag: "colonie-ws-c", region: "sgp1", size: "s-2vcpu-4gb", state: "failed", createdAt: "", error: "The server did not answer within half an hour." },
      { id: "d", kind: "self", name: "Own", tag: "colonie-ws-d", region: "", size: "", state: "ready", createdAt: "", address: "https://team.example.com" },
    ],
  });
  expect(html).toMatch(/Starting Colonie/);
  expect(html).toContain("did not answer within half an hour");
  expect(html.match(/>Open</g)?.length).toBe(2);
  expect(html.match(/>Delete</g)?.length).toBe(3);
  expect(html.match(/>Forget</g)?.length).toBe(1);
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
