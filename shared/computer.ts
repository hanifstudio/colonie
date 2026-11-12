/** What a person sees of the bot computer. One computer per workspace, one screen per bot. */
export type ComputerState =
  /** This server cannot run it (a Shared workspace for now). */
  | "unsupported"
  /** No container runtime (Docker, Podman) is installed. */
  | "no-runtime"
  | "off"
  /** Getting the desktop image ready: the first time takes a few minutes. */
  | "preparing"
  | "starting"
  | "on";

export interface ComputerScreen {
  botId: string;
  /** The person is driving this screen, so the bot is paused until they hand it back. */
  taken: boolean;
}

export interface ComputerView {
  state: ComputerState;
  /** Why it is off or could not start, in words a person can act on. */
  message: string | null;
  screens: ComputerScreen[];
  /** It turns itself off after this many idle minutes. */
  idleMinutes: number;
}
