// Choosing Local VM starts the installed container runtime for the person:
// Colima when it is installed, the Podman machine, Apple's container service.
import { expect, test } from "vitest";

import { startContainerRuntime, type CommandRunner } from "./container-computer.ts";

function host(installed: string[]) {
  const ran: string[] = [];
  let up = false;
  const runner: CommandRunner = async (command, args) => {
    const line = [command, ...args].join(" ");
    if (command === "/usr/bin/which") {
      if (installed.includes(args[0]!)) return { stdout: `/usr/local/bin/${args[0]}` };
      throw new Error("not found");
    }
    if (/^(docker|podman) info/.test(line) || line === "container system status") {
      if (up) return { stdout: "ok" };
      throw new Error("daemon down");
    }
    ran.push(line);
    if (/^(colima start|podman machine start|container system start|open -a Docker)$/.test(line)) up = true;
    return { stdout: "" };
  };
  return { runner, ran };
}

test("docker with Colima installed starts Colima and waits for the daemon", async () => {
  const { runner, ran } = host(["docker", "colima"]);
  await startContainerRuntime("docker", runner, "darwin", 5_000);
  expect(ran).toEqual(["colima start"]);
});

test("docker without Colima on a Mac opens Docker Desktop", async () => {
  const { runner, ran } = host(["docker"]);
  await startContainerRuntime("docker", runner, "darwin", 5_000);
  expect(ran).toEqual(["open -a Docker"]);
});

test("Podman starts its machine", async () => {
  const { runner, ran } = host(["podman"]);
  await startContainerRuntime("podman", runner, "darwin", 5_000);
  expect(ran).toEqual(["podman machine start"]);
});

test("a daemon that never comes up says what was tried", async () => {
  const runner: CommandRunner = async (command, args) => {
    if (command === "/usr/bin/which" && args[0] === "docker") return { stdout: "/usr/local/bin/docker" };
    if (command === "/usr/bin/which") throw new Error("not found");
    if (command === "docker") throw new Error("daemon down");
    return { stdout: "" };
  };
  await expect(startContainerRuntime("docker", runner, "linux", 50)).rejects.toThrow("Start docker first");
  await expect(startContainerRuntime("docker", runner, "darwin", 50)).rejects.toThrow("docker did not start (tried: open -a Docker)");
});
