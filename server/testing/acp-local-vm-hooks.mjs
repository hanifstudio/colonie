// Loaded by acp-local-vm.e2e.test.ts through NODE_OPTIONS: a Local VM that is
// up and ready, without a container runtime, whose Cua Driver is the stand-in
// fake-cua-mcp.mjs. The real server, lease, claim and control route run.
import { registerHooks } from "node:module";

const actual = new URL("../colonie/computer/container-computer.ts?actual", import.meta.url).href;
const mock = new URL("./acp-local-vm-mock.mjs", import.meta.url).href;
const fakeCua = new URL("./fake-cua-mcp.mjs", import.meta.url).pathname;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/container-computer.ts") && !context.parentURL?.startsWith(mock)) return { url: mock, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== mock) return nextLoad(url, context);
    return { format: "module", shortCircuit: true, source: `
      export * from ${JSON.stringify(actual)};
      import { SHARED_LOCAL_VM_TARGET } from ${JSON.stringify(actual)};
      import { mkdirSync } from "node:fs";
      const ready = (target) => { mkdirSync(target.workspaceDir, { recursive: true }); return { runtime: "podman", daemonUp: true, image: true, create_supported: true, managed: true,
        container: "running", ready: true, imageMatches: true, network: "loopback", security: "hardened", persistence: "durable", resumable: false,
        stopped_at: null, problem: null, container_name: target.containerName, target_key: target.key, workspace_path: target.workspaceDir }; };
      export async function containerRuntimeStatus() { return { runtime: "podman", daemonUp: true }; }
      export async function containerComputerExists() { return true; }
      export async function containerComputerStatus(_run, _platform, target = SHARED_LOCAL_VM_TARGET) { return ready(target); }
      export async function containerComputerAction(_action, _run, _platform, target = SHARED_LOCAL_VM_TARGET) { return ready(target); }
      export async function containerComputerFrame() { throw new Error("no frames in this fixture"); }
      export function containerComputerMcp(_runtime, control) {
        return { command: process.execPath, args: [${JSON.stringify(fakeCua)}],
          env: control ? { COLONIE_CONTROL_URL: control.url, COLONIE_CONTROL_TOKEN: control.token } : {} };
      }
    ` };
  },
});
