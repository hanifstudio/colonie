// Making a Shared workspace is a guided onboarding like the first run: a
// name, where its server runs, the wait while it starts, then Open. Inside
// the new workspace the same onboarding goes on: connect AI on the server,
// invite people, meet the bot.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { beatsFor } from "@/lib/onboarding";
import type { SharedServer, SharedServersState } from "@/lib/shared-servers";
import { InviteBeatView, SharedNameBeat, SharedReadyBeatView, SharedWhereBeatView } from "./SharedBeats";

const beat = { onNext: () => {}, onSkip: () => {}, setMascot: () => {}, bump: () => {} };
const ocean = (connected: boolean): SharedServersState["digitalOcean"] => ({
  connected, region: "sgp1", size: "s-2vcpu-4gb",
  ...(connected ? { account: { email: "owner@example.com", dropletLimit: 3, active: true }, price: { monthlyUsd: 24, hourlyUsd: 0.036 } } : {}),
});
const server = (extra: Partial<SharedServer>): SharedServer => ({
  id: "s1", name: "Launch Team", tag: "t", region: "", size: "", state: "starting", createdAt: "", address: "https://team.example.com", ...extra,
});

describe("the Shared workspace onboarding", () => {
  it("has its own steps, whether chosen on the first run or as a new workspace later", () => {
    expect(beatsFor({ dictation: false, reel: false, shared: true })).toEqual(["sharedName", "sharedWhere", "sharedReady"]);
  });

  it("inside the new workspace its admin connects AI and invites people before meeting the bot", () => {
    expect(beatsFor({ dictation: false, reel: false, hosted: true })).toEqual(["hello", "engines", "invite", "bot"]);
  });

  it("asks for the workspace's name first", () => {
    const html = renderToStaticMarkup(createElement(SharedNameBeat, { ...beat, name: "", onName: () => {} }));
    expect(html).toMatch(/Name your Shared workspace/);
    expect(html).toContain("Continue");
  });

  it("then where it runs: one click on DigitalOcean, with the price before anything is made", () => {
    const view = (props: Partial<Parameters<typeof SharedWhereBeatView>[0]>) => renderToStaticMarkup(createElement(SharedWhereBeatView, {
      mode: "digitalocean", ocean: ocean(false), address: "", busy: "", error: "", waitingForBrowser: false,
      onMode: () => {}, onAddress: () => {}, onConnect: () => {}, onCreate: () => {}, ...props,
    }));
    expect(view({})).toContain("One click on DigitalOcean");
    expect(view({})).toContain("My own server");
    expect(view({})).toContain("Connect DigitalOcean");
    const connected = view({ ocean: ocean(true) });
    expect(connected).toContain("$24 a month");
    expect(connected).toContain("Create the server");
  });

  it("or on their own server: its address, then the command to paste", () => {
    const html = renderToStaticMarkup(createElement(SharedWhereBeatView, {
      mode: "self", ocean: ocean(false), address: "203.0.113.9", busy: "", error: "", waitingForBrowser: false,
      onMode: () => {}, onAddress: () => {}, onConnect: () => {}, onCreate: () => {},
    }));
    expect(html).toMatch(/IP address or domain/);
    expect(html).toMatch(/Ubuntu/);
    expect(html).toContain("Get the command");
  });

  it("waits with the person while the server starts, and offers Open when it answers", () => {
    const starting = renderToStaticMarkup(createElement(SharedReadyBeatView, { server: server({ kind: "self", command: "echo H4sI | base64 -d | gunzip | sudo bash" }), busy: false, error: "", onOpen: () => {} }));
    expect(starting).toContain("echo H4sI | base64 -d | gunzip | sudo bash");
    expect(starting).toMatch(/Paste this into your server/);
    expect(starting).not.toContain("Open Launch Team");
    const ready = renderToStaticMarkup(createElement(SharedReadyBeatView, { server: server({ state: "ready", inviteUrl: "https://team.example.com/invite/x" }), busy: false, error: "", onOpen: () => {} }));
    expect(ready).toContain("Open Launch Team");
    const failed = renderToStaticMarkup(createElement(SharedReadyBeatView, { server: server({ state: "failed", error: "The server did not answer." }), busy: false, error: "", onOpen: () => {} }));
    expect(failed).toContain("The server did not answer.");
  });

  it("inside the workspace, inviting people can be done now or skipped", () => {
    const html = renderToStaticMarkup(createElement(InviteBeatView, { ...beat, invite: null, busy: false, error: "", onCreate: () => {} }));
    expect(html).toMatch(/Invite people/);
    expect(html).toContain("Create invite link");
    expect(html).toContain("Skip for now");
    const made = renderToStaticMarkup(createElement(InviteBeatView, { ...beat, invite: { url: "https://team.example.com/invite/abc", expiresAt: "2026-10-29T00:00:00Z" }, busy: false, error: "", onCreate: () => {} }));
    expect(made).toContain("https://team.example.com/invite/abc");
    expect(made).toContain("Copy");
  });
});
