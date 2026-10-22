import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const env = require("./environments.cjs");

test("origins are bare http(s) origins, nothing else", () => {
  assert.equal(env.normalizeOrigin("https://mini.tail1234.ts.net/pair#code=x"), "https://mini.tail1234.ts.net");
  assert.equal(env.normalizeOrigin("http://192.168.1.20:8799"), "http://192.168.1.20:8799");
  assert.equal(env.normalizeOrigin("HTTPS://Mini.Example:443/"), "https://mini.example");
  for (const bad of ["ftp://x", "mini.example", "https://user:pw@host", "", 42, null]) assert.equal(env.normalizeOrigin(bad), null, String(bad));
});

test("a pairing link keeps its code in the hash; a code anywhere else is refused", () => {
  assert.deepEqual(env.parsePairingLink("https://mini.example/pair#code=ABCD-EFGH-JKLM"), {
    origin: "https://mini.example",
    code: "ABCD-EFGH-JKLM",
    url: "https://mini.example/pair#code=ABCD-EFGH-JKLM",
  });
  assert.deepEqual(env.parsePairingLink("  https://mini.example  "), { origin: "https://mini.example", code: null, url: "https://mini.example" });
  assert.equal(env.parsePairingLink("https://mini.example/?code=ABCD"), null);
  assert.equal(env.parsePairingLink("not a link"), null);
});

test("self-hosted pairing supports custom HTTPS and Cloudflare names without Tailscale", () => {
  for (const origin of ["https://bots.example.com", "https://example.trycloudflare.com", "https://c-example.colonie.com"]) {
    const link = `${origin}/pair#code=ABCD-EFGH-JKLM`;
    assert.deepEqual(env.parsePairingLink(link), {
      origin, code: "ABCD-EFGH-JKLM", url: link,
    });
    const saved = env.withEnvironment({ environments: [], activeId: "local" }, { origin, name: "My server" }, () => "fixture");
    assert.equal(saved.environments[0].origin, origin);
    assert.ok(!env.serializeEnvironments(saved).includes("ABCD"), "pairing codes must not enter saved server records");
  }
});

test("persisted state parses defensively and never resurrects Local as a remote", () => {
  const parsed = env.parseEnvironments(
    JSON.stringify({
      environments: [
        { id: "a1", name: "  Cab   mini ", origin: "https://mini.example/" },
        { id: "local", name: "sneaky", origin: "https://evil.example" },
        { id: "dup", name: "again", origin: "https://mini.example" },
        { id: "b2", origin: "http://10.0.0.5:8799" },
        { id: "bad id!", origin: "https://x.example" },
        { id: "c3", origin: "ftp://nope" },
      ],
      activeId: "b2",
    }),
  );
  assert.deepEqual(parsed, {
    environments: [
      { id: "a1", name: "Cab mini", origin: "https://mini.example" },
      { id: "b2", name: "10.0.0.5:8799", origin: "http://10.0.0.5:8799" },
    ],
    activeId: "b2",
  });
  assert.deepEqual(env.parseEnvironments("{not json"), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments({ environments: [], activeId: "ghost" }), { environments: [], activeId: "local" });
  assert.deepEqual(env.parseEnvironments(env.serializeEnvironments(parsed)), parsed);
});

test("adding the same server twice updates the name instead of duplicating; forgetting the active one falls back to Local", () => {
  let ids = 0;
  const makeId = () => `id${++ids}`;
  let state = { environments: [], activeId: "local" };
  state = env.withEnvironment(state, { origin: "https://mini.example/pair#code=X", name: "" }, makeId);
  state = env.withEnvironment(state, { origin: "https://mini.example", name: "Cab mini" }, makeId);
  state = env.withEnvironment(state, { origin: "nonsense" }, makeId);
  assert.deepEqual(state.environments, [{ id: "id1", name: "Cab mini", origin: "https://mini.example" }]);
  state = env.withActive(state, "id1");
  assert.equal(env.activeEnvironment(state)?.origin, "https://mini.example");
  assert.equal(env.withActive(state, "nope"), state);
  assert.deepEqual([...env.allowedOrigins(state, "http://127.0.0.1:8799")], ["http://127.0.0.1:8799", "https://mini.example"]);
  state = env.withoutEnvironment(state, "id1");
  assert.deepEqual(state, { environments: [], activeId: "local" });
  assert.equal(env.activeEnvironment(state), null);
});

test("hosted workspace input accepts addresses and keeps valid codes only in the fragment", () => {
  for (const address of ["bots.company.com", " https://bots.company.com/ ", "https://bots.company.com:8443"]) {
    const parsed = env.parseHostedWorkspaceLink(address);
    assert.ok(parsed);
    assert.equal(parsed.code, null);
    assert.equal(parsed.url, parsed.origin);
  }
  const parsed = env.parseHostedWorkspaceLink("https://bots.company.com/pair#code=ABCD%2DEFGH%2DJKLM");
  assert.equal(parsed.code, "ABCD-EFGH-JKLM");
  assert.ok(parsed.url.includes("#code="));
  assert.ok(!parsed.origin.includes("ABCD"));
  assert.ok(env.parseHostedWorkspaceLink("http://127.0.0.1:19999"));
  for (const bad of ["", null, "ABCD-EFGH-JKLM", "https:example.com", "http://cloud.example.com", "https://a.example/other", "https://a.example/?code=SECRET", "https://a.example/pair#code=%", "https://a.example/pair#code=", "https://a.example/pair#code=%20", "https://user:password@a.example", "https://a.example\\@b.example", "javascript:alert(1)"]) {
    assert.equal(env.parseHostedWorkspaceLink(bad), null, String(bad));
  }
  assert.equal(env.parsePairingLink("https://a.example/pair#code=%"), null);
});

test("a Shared workspace invite link is accepted as it was copied", () => {
  const code = "q3J0Xn2l7uGm1oS9YbV4cR8eTwKp5Hzd";
  const parsed = env.parseHostedWorkspaceLink(`https://team.example/invite/${code}`);
  assert.deepEqual(parsed, { origin: "https://team.example", code: null, url: `https://team.example/invite/${code}` });
  for (const bad of ["https://team.example/invite/", "https://team.example/invite/short", `https://team.example/invite/${code}/x`, `https://team.example/invite/${code}?x=1`, `http://team.example/invite/${code}`]) {
    assert.equal(env.parseHostedWorkspaceLink(bad), null, bad);
  }
});

test("a Shared workspace may pass through Colonie Cloud to sign in, and nowhere else", () => {
  const local = "http://127.0.0.1:18799";
  const cloud = "https://colonie-cloud.example";
  const state = { environments: [{ id: "team", name: "Team", origin: "https://team.example" }], activeId: "team" };
  assert.equal(env.workspaceNavigationAllowed(`${cloud}/authorize?client_id=x`, state, local, [cloud]), true);
  assert.equal(env.workspaceNavigationAllowed(`${cloud}/authorize`, state, local), false);
  assert.equal(env.workspaceNavigationAllowed("https://evil.example/authorize", state, local, [cloud]), false);
  // The local app never needs the detour.
  assert.equal(env.workspaceNavigationAllowed(`${cloud}/authorize`, env.withActive(state, "local"), local, [cloud]), false);
  // The menu offers joining by name.
  const items = env.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {} });
  assert.equal(items.find((item) => item.id === "workspace-connect").label, "Join a Shared workspace…");
});

test("workspace shell exposes only current identity and rejects subframes and unrelated windows", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  assert.deepEqual(env.workspaceSummary(state), { local: false, name: "Acme", origin: "https://acme.example" });
  assert.deepEqual(env.workspaceSummary({ ...state, activeId: "local" }), { local: true, name: "This computer" });
  const local = "http://127.0.0.1:18799";
  const contents = { mainFrame: { url: "https://acme.example/" } };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), true);
  assert.equal(env.workspaceSenderAllowed({ ...event, sender: {} }, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed({ ...event, senderFrame: { url: "https://acme.example/frame" } }, contents, state, local), false);
  contents.mainFrame.url = "https://untrusted.example";
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  contents.mainFrame.url = local;
  assert.equal(env.workspaceSenderAllowed(event, contents, state, local), false);
  assert.equal(env.workspaceSenderAllowed(event, contents, { ...state, activeId: "local" }, local), true);
});

test("renderer links and redirects cannot switch onto the local or another saved workspace", () => {
  const local = "http://127.0.0.1:18799";
  const state = { environments: [
    { id: "cloud", name: "Acme", origin: "https://acme.example" },
    { id: "other", name: "Other", origin: "https://other.example" },
  ], activeId: "cloud" };
  assert.equal(env.workspaceNavigationAllowed("https://acme.example/pair#code=ABCD-EFGH-JKLM", state, local), true);
  for (const url of [local, "https://other.example", "https://unknown.example", "javascript:void(0)"]) {
    assert.equal(env.workspaceNavigationAllowed(url, state, local), false);
  }
  const switched = env.withActive(state, "local");
  assert.equal(env.workspaceNavigationAllowed(`${local}/?desktop-settings=workspaces`, switched, local), true);
  assert.equal(env.workspaceNavigationAllowed("https://acme.example", switched, local), false);
});

test("native workspace choices use saved IDs and connect opens settings without changing state", () => {
  const state = { environments: [{ id: "cloud", name: "Acme", origin: "https://acme.example" }], activeId: "cloud" };
  const calls = [];
  const items = env.workspaceMenuTemplate(state, { onSwitch: (id) => calls.push(["switch", id]), onConnect: () => calls.push(["settings"]), onForget: (id) => calls.push(["forget", id]) });
  assert.equal(items.find((item) => item.id === "workspace-cloud").checked, true);
  items.find((item) => item.id === "workspace-local").click();
  items.find((item) => item.id === "workspace-connect").click();
  items.find((item) => item.id === "workspace-forget").click();
  assert.deepEqual(calls, [["switch", "local"], ["settings"], ["forget", "cloud"]]);
  assert.equal(state.activeId, "cloud");
});

test("native window identity distinguishes hosted HTML and the local workspace", () => {
  const state = { environments: [{ id: "old", name: "Old team", origin: "https://old.example" }], activeId: "old" };
  assert.equal(env.workspaceWindowTitle(state), "Colonie — Hosted: Old team (old.example)");
  assert.equal(env.workspaceWindowTitle(env.withActive(state, "local")), "Colonie");
});

test("the Colonie account window goes only to Colonie Cloud and back to this computer", () => {
  const cloud = "https://colonie-cloud.example";
  const allowed = (url) => env.accountWindowNavigationAllowed(url, [cloud]);
  assert.equal(allowed(`${cloud}/authorize?client_id=x`), true);
  assert.equal(allowed(`${cloud}/signup?next=%2Fauthorize`), true);
  assert.equal(allowed("http://127.0.0.1:18799/auth/colonie/desktop-callback?code=a&state=b"), true);
  for (const url of ["http://127.0.0.1:18799/", "http://127.0.0.1:18799/api/config", "https://evil.example/authorize", "http://localhost:18799/auth/colonie/desktop-callback", "javascript:alert(1)", `http://${cloud.slice(8)}/authorize`]) {
    assert.equal(allowed(url), false, url);
  }
  // It opens only on Colonie Cloud.
  assert.equal(env.accountWindowStartAllowed(`${cloud}/authorize`, [cloud]), true);
  assert.equal(env.accountWindowStartAllowed("http://127.0.0.1:18799/auth/colonie/desktop-callback", [cloud]), false);
});

test("one list of every workspace: this computer's Local ones, then the Shared ones, then what to do", () => {
  const state = { environments: [{ id: "team", name: "Launch Team", origin: "https://team.example" }], activeId: "local" };
  const calls = [];
  const items = env.workspaceMenuTemplate(state, {
    onSwitch: (id) => calls.push(["switch", id]), onConnect: () => calls.push(["join"]), onForget: (id) => calls.push(["forget", id]),
    onLocal: (id) => calls.push(["local", id]), onNew: () => calls.push(["new"]), onServers: () => calls.push(["servers"]),
  }, { workspaces: [{ id: "default", name: "My workspace" }, { id: "w2", name: "Side project" }], runningId: "default" });
  const labels = items.filter((item) => item.type !== "separator").map((item) => item.label);
  assert.deepEqual(labels, ["My workspace", "Side project", "Launch Team", "New workspace…", "Join a Shared workspace…", "Shared workspace servers…"]);
  assert.equal(items.find((item) => item.label === "My workspace").checked, true);
  assert.equal(items.find((item) => item.label === "My workspace").sublabel, "On this computer");
  assert.equal(items.find((item) => item.label === "Launch Team").sublabel, "Shared · team.example");
  items.find((item) => item.label === "Side project").click();
  items.find((item) => item.label === "Launch Team").click();
  items.find((item) => item.label === "New workspace…").click();
  items.find((item) => item.label === "Shared workspace servers…").click();
  assert.deepEqual(calls, [["local", "w2"], ["switch", "team"], ["new"], ["servers"]]);
  // On the Shared one, its own Local workspace is not marked as open.
  const away = env.workspaceMenuTemplate({ ...state, activeId: "team" }, { onSwitch() {}, onConnect() {}, onForget() {}, onLocal() {}, onNew() {}, onServers() {} },
    { workspaces: [{ id: "default", name: "My workspace" }], runningId: "default" });
  assert.equal(away.find((item) => item.label === "My workspace").checked, false);
  assert.equal(away.find((item) => item.label === "Launch Team").checked, true);
});
