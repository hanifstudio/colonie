// Joining a Shared workspace from the desktop app: paste the invite link
// someone sent, and the app opens that workspace's sign-in.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { JoinSharedWorkspaceView, joinShared } from "./JoinSharedWorkspace";

test("the dialog asks for the invite link and offers Join", () => {
  const html = renderToStaticMarkup(createElement(JoinSharedWorkspaceView, { link: "", busy: false, error: "", onLink: () => {}, onJoin: () => {}, onClose: () => {} }));
  expect(html).toContain("Join a Shared workspace");
  expect(html).toMatch(/invite link/i);
  expect(html).toContain("Join");
});

test("joining hands the pasted link to the app, trimmed", async () => {
  const addFromLink = vi.fn(async () => true);
  expect(await joinShared({ addFromLink }, "  https://team.example/invite/abc  ")).toEqual({ ok: true });
  expect(addFromLink).toHaveBeenCalledWith("https://team.example/invite/abc");
});

test("a declined join is quiet; a refused link says why", async () => {
  expect(await joinShared({ addFromLink: async () => false }, "https://team.example")).toEqual({ ok: false, error: "" });
  const refused = await joinShared({ addFromLink: async () => { throw new Error("Error invoking remote method 'environments:add-from-link': Error: Paste the invite link exactly as you received it."); } }, "nope");
  expect(refused).toEqual({ ok: false, error: "Paste the invite link exactly as you received it." });
  expect(await joinShared({ addFromLink: async () => true }, "   ")).toEqual({ ok: false, error: "Paste the invite link first." });
});
