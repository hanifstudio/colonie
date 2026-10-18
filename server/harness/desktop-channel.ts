// The desktop app's private channel to the embedded server.
//
// Electron's utility-process parent port carries messages the renderer and the
// network must not see: the managed-Composio registration that may arrive after
// first paint, the desktop mutation capability, the trusted-approval handshake,
// and browser-cleanup requests. Plain Node/dev launches have no parentPort, so
// every entry point here is a no-op there.
import type { BrowserCleanupIncomingMessage, BrowserCleanupWireRequest } from "../colonie/computer/browser-lifecycle-cleanup.ts";
import type { WireBot } from "../../shared/wire.ts";

type UtilityParentPort = {
  on(event: "message", listener: (event: { data?: object }) => void): void;
  postMessage(message: object): void;
};

// SAFETY: Electron's utility-process runtime is the only environment that
// supplies parentPort; plain Node intentionally leaves it absent.
const utilityParentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;

export type DesktopPrivateMessage = BrowserCleanupWireRequest | {
  type: "colonie:browser-control";
  botId: string;
  held: true;
} | {
  type: "approval-trusted-mode-result" | "approval-trusted-mode-commit-result";
  requestId: string;
  ok: boolean;
  bot?: WireBot;
  error?: string;
} | {
  type: "approval-trusted-mode-confirm-result";
  requestId: string;
  ok: boolean;
  error?: string;
} | {
  type: "approval-trusted-mode-activate-result" | "approval-trusted-mode-finalize-result";
  requestId: string;
  ok: boolean;
  error?: string;
};

export function postDesktopPrivateMessage(message: DesktopPrivateMessage): boolean {
  if (!utilityParentPort) return false;
  try {
    utilityParentPort.postMessage(message);
    return true;
  } catch (error) {
    console.error(`[desktop-sync] could not send private parent message: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export function applyDesktopMutationTokenMessage(raw: unknown, setToken: (token: string) => void): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  if (message.type !== "colonie:desktop-mutation-token") return false;
  if (typeof message.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(message.token)) {
    throw new Error("invalid desktop mutation capability");
  }
  setToken(message.token);
  return true;
}

export interface DesktopChannelDeps {
  /** The private trusted-approval handler; a getter because the handler is
   * created further down the assembly. */
  handleTrustedApprovalMessage: () => (message: unknown) => boolean;
  /** Browser-cleanup requests the renderer asks the server to perform. */
  cleanupBrowser: (message: BrowserCleanupIncomingMessage | undefined) => boolean;
  /** The registered Composio broker's own private message. */
  applyBrokerMessage: (message: unknown) => boolean;
  /** Adopt the mutation capability the desktop just sent. */
  setDesktopMutationToken: (token: string) => void;
}

/** Route a private parent message to its owner. A rejected one is logged and
 * never thrown out of the port's listener. */
export function registerDesktopChannel(deps: DesktopChannelDeps): void {
  utilityParentPort?.on("message", (event) => {
    const message = event?.data;
    try {
      if (applyDesktopMutationTokenMessage(message, deps.setDesktopMutationToken)) return;
      if (deps.handleTrustedApprovalMessage()(message)) return;
      if (deps.cleanupBrowser(message as BrowserCleanupIncomingMessage | undefined)) return;
      deps.applyBrokerMessage(message);
    } catch (error) {
      console.error(`[desktop-sync] rejected private parent message: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
