// The desktop app's private channel: messages the renderer and the network
// must not see. With no parent port (plain Node/dev) everything here is inert;
// with one, each message reaches exactly one owner and a bad one is logged,
// never thrown into the port's listener.
import { afterEach, expect, test, vi } from "vitest";

interface FakePort {
  sent: object[];
  fire(data: unknown): void;
}

function installPort(options: { throwOnSend?: boolean } = {}): FakePort {
  const sent: object[] = [];
  let listener: ((event: { data?: object }) => void) | undefined;
  Object.defineProperty(process, "parentPort", {
    configurable: true,
    value: {
      on(event: string, next: (event: { data?: object }) => void) {
        if (event === "message") listener = next;
      },
      postMessage(message: object) {
        if (options.throwOnSend) throw new Error("no ipc");
        sent.push(message);
      },
    },
  });
  return { sent, fire: (data) => listener!({ data: data as object }) };
}

function removePort() {
  delete (process as { parentPort?: unknown }).parentPort;
}

async function load() {
  vi.resetModules();
  return import("./desktop-channel.ts");
}

afterEach(() => {
  vi.restoreAllMocks();
  removePort();
});

test("with no parent port, sending a private message is inert", async () => {
  removePort();
  const mod = await load();
  expect(mod.postDesktopPrivateMessage({ type: "colonie:browser-control", botId: "b1", held: true })).toBe(false);
});

test("each private message reaches exactly one owner", async () => {
  const port = installPort();
  const mod = await load();
  const tokens: string[] = [];
  const brokered: unknown[] = [];
  mod.registerDesktopChannel({
    handleTrustedApprovalMessage: () => (message) => (message as { type?: string }).type === "approval-trusted-mode-result",
    cleanupBrowser: (message) => message?.type === "colonie:browser-lifecycle-result",
    applyBrokerMessage: (message) => { brokered.push(message); return true; },
    setDesktopMutationToken: (token) => { tokens.push(token); },
  });

  const token = "a".repeat(43);
  port.fire({ type: "colonie:desktop-mutation-token", token });
  expect(tokens).toEqual([token]);
  // The capability is consumed, not offered to the other owners.
  expect(brokered).toEqual([]);

  port.fire({ type: "approval-trusted-mode-result" });
  port.fire({ type: "colonie:browser-lifecycle-result" });
  port.fire({ type: "colonie:composio-managed-result" });
  // Only the message no owner claimed fell through to the broker.
  expect(brokered).toEqual([{ type: "colonie:composio-managed-result" }]);
});

test("a malformed mutation capability is rejected, never thrown into the port", async () => {
  const port = installPort();
  const mod = await load();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const tokens: string[] = [];
  mod.registerDesktopChannel({
    handleTrustedApprovalMessage: () => () => false,
    cleanupBrowser: () => false,
    applyBrokerMessage: () => false,
    setDesktopMutationToken: (token) => { tokens.push(token); },
  });

  expect(() => port.fire({ type: "colonie:desktop-mutation-token", token: "too-short" })).not.toThrow();
  expect(tokens).toEqual([]);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("rejected private parent message"));
});

test("a message is handed to the port; a failing hand-off reports false", async () => {
  const port = installPort();
  const ok = await load();
  const message = { type: "colonie:browser-control", botId: "b1", held: true } as const;
  expect(ok.postDesktopPrivateMessage(message)).toBe(true);
  expect(port.sent).toEqual([message]);

  installPort({ throwOnSend: true });
  const broken = await load();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(broken.postDesktopPrivateMessage(message)).toBe(false);
  expect(error).toHaveBeenCalledWith(expect.stringContaining("could not send private parent message"));
});
