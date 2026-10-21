// Settings → People on a Shared workspace: who has joined, and an invite
// link the admin copies and sends themselves.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";

import { ColoniePeopleView, createInviteLink } from "./ColoniePeople";

const members = [
  { email: "ana@example.com", name: "Ana", role: "admin" as const, joinedAt: "2026-10-01T08:00:00.000Z" },
  { email: "budi@example.com", name: "Budi", role: "member" as const, joinedAt: "2026-10-20T08:00:00.000Z" },
];

const view = (props: Partial<Parameters<typeof ColoniePeopleView>[0]>) => renderToStaticMarkup(createElement(ColoniePeopleView, {
  members, invite: null, busy: false, error: null, onCreate: () => {}, onRemove: () => {}, ...props,
}));

test("the admin sees everyone who joined, with name, address and role", () => {
  const html = view({});
  expect(html).toContain("Ana");
  expect(html).toContain("ana@example.com");
  expect(html).toContain("Budi");
  expect(html).toContain("Admin");
  expect(html).toContain("Member");
  expect(html).toContain("Create invite link");
  expect(html.match(/>Remove</g)?.length).toBe(2);
});

test("a new invite link is shown with a copy button and says how it works", () => {
  const html = view({ invite: { url: "https://team.example/invite/abc123", expiresAt: "2026-10-28T08:00:00.000Z" } });
  expect(html).toContain("https://team.example/invite/abc123");
  expect(html).toContain("Copy");
  expect(html).toMatch(/works once/i);
  expect(html).toMatch(/Colonie account/);
});

test("nobody joined yet says so", () => {
  expect(view({ members: [] })).toMatch(/Nobody has joined yet/);
});

test("creating a link asks the server for one with the chosen role", async () => {
  const request = vi.fn(async () => ({ url: "https://team.example/invite/x", expiresAt: "2026-10-28T08:00:00.000Z" }));
  expect(await createInviteLink(request, "admin")).toEqual({ url: "https://team.example/invite/x", expiresAt: "2026-10-28T08:00:00.000Z" });
  expect(request).toHaveBeenCalledWith("/api/invites", { method: "POST", body: JSON.stringify({ role: "admin" }) });
});
