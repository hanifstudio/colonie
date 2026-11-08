// The real ContainerBackend: Docker, Podman or Apple's container, through the
// lifecycle functions that already know their hardening and ownership checks.
import {
  containerComputerAction, containerComputerMcp, containerComputerStatus, containerRuntimeStatus, startContainerRuntime,
  SHARED_LOCAL_VM_TARGET, VM_WORKSPACE_GUEST, type CommandRunner, type ContainerComputerStatus, type Runtime,
} from "./container-computer.ts";
import type { ContainerBackend, ContainerFacts } from "./computer-host.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { augmentedPath, resolveCliSpawn } from "../../runtime/env-path.ts";

const exec = promisify(execFile);

/** What the host needs to know, from the full status. A container that is not
 * hardened, not on loopback, or from another image layer is "stale": it is
 * replaced (its home folder is a bind mount, so nothing a person made is lost).
 * A container this app did not make is "foreign": it is never touched. */
export function factsFromStatus(status: ContainerComputerStatus): ContainerFacts {
  const exists = status.container !== "missing";
  return {
    runtime: status.runtime,
    daemonUp: status.daemonUp,
    imageReady: status.image,
    container: status.container,
    foreign: exists && !status.managed,
    stale: exists && status.managed && !(status.imageMatches && status.security === "hardened" && status.network === "loopback" && status.persistence === "durable"),
    viewerPort: status.viewer_port,
    problem: status.problem,
  };
}

const sh: CommandRunner = async (command, args, timeout = 8000) => {
  const resolved = resolveCliSpawn(command, args);
  const { stdout } = await exec(resolved.command, resolved.args, { timeout, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: augmentedPath() } });
  return { stdout };
};

export function containerBackend(options: { runner?: CommandRunner; platform?: NodeJS.Platform } = {}): ContainerBackend {
  const runner = options.runner ?? sh;
  const platform = options.platform ?? process.platform;
  let runtime: Runtime | null = null;
  const target = SHARED_LOCAL_VM_TARGET;
  const need = (): Runtime => { if (!runtime) throw Object.assign(new Error("No container runtime is installed"), { status: 409 }); return runtime; };
  return {
    async facts() {
      const status = await containerComputerStatus(runner, platform, target, { probeDesktop: false });
      runtime = status.runtime;
      return factsFromStatus(status);
    },
    async startRuntime() {
      const found = await containerRuntimeStatus(runner, platform);
      if (!found.runtime) throw new Error("No container runtime is installed");
      await startContainerRuntime(found.runtime, runner, platform);
      runtime = found.runtime;
    },
    async prepareImage() { await containerComputerAction("pull", runner, platform, target); },
    async create() { await containerComputerAction("run", runner, platform, target); },
    async start() { await containerComputerAction("start", runner, platform, target); },
    async stop() { await containerComputerAction("stop", runner, platform, target); },
    async remove() { await containerComputerAction("remove", runner, platform, target); },
    async exec(args, timeoutMs = 30_000) {
      const { stdout } = await runner(need(), ["exec", "-u", "cua", "-w", VM_WORKSPACE_GUEST, "-e", "HOME=/home/cua", target.containerName, ...args], timeoutMs);
      return stdout;
    },
    mcp: (screen) => containerComputerMcp(need(), undefined, target, screen),
  };
}
