import { createHash } from "node:crypto";
import type { AcpToolMount } from "../connections/contracts.ts";
import { computerToolMount } from "./browser-engine.ts";
import type { ComputerHost } from "./computer-host.ts";

/** What a bot with a screen on the workspace's computer is told. The scope advice
 * is measured: the driver's default window scope sends events Firefox ignores. */
export const BOT_COMPUTER_PROMPT =
  "You have your own computer: a Linux desktop in an isolated container, with a screen that is yours alone. The person can watch it live and take it over from the Screen tab. Use the computer tools to see the screen, click, type, and open apps. Browse with Firefox on this screen, not with web-reading tools, when a page needs looking at or interacting with; start it with launch_app if it is not running. Call bring_to_front on a window before typing into it, and click and type with scope \"desktop\": the default window scope does not reach Firefox. Take a screenshot before acting and after each step that changes the screen; prefer accessibility targets over raw coordinates. Only /home/cua/workspace is durable; everything else on the desktop is disposable, and your own file tools cannot reach it. When a step needs the person (a login you do not have, a CAPTCHA or human check, a passkey, a code, consent only they can give), stop, say exactly what they need to do on your screen, and end your turn; they do it from the Screen tab and tell you to continue. Never try to solve a CAPTCHA yourself, and never ask for a password in chat.";

/** Told instead of the above when the computer is on but has no free screen. */
export const BOT_COMPUTER_FULL_NOTE =
  "The workspace's computer has no free screen right now, so you have no computer for this request. Say so if the request needs one; do not look for another way to browse.";

/** The bot's screen as a tool mount. The computer stays on while the turn holds it. */
export function botComputerMount(host: ComputerHost, botId: string, announce?: () => void): AcpToolMount | undefined {
  const spec = host.mcp(botId);
  if (!spec) return undefined;
  const mount = computerToolMount(spec);
  let release: (() => void) | undefined;
  const drop = () => { release?.(); release = undefined; };
  return {
    ...mount,
    // the screen is part of the revision: another screen is another tool process
    revision: createHash("sha256").update(mount.revision).update(spec.args.join(" ")).digest("hex"),
    activate() { release ??= host.use(); announce?.(); },
    deactivate: drop,
    release: drop,
  };
}
