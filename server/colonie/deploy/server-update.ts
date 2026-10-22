// Updating a Shared workspace's server from the app. The server asks the
// registry for the newest published version of its image; an admin's Update
// writes the wanted version into the control folder (COLONIE_CONTROL_DIR,
// /control in the container, /opt/colonie/control on the host). A watcher
// the set-up script installs on the host (digitalocean.ts) sees the request,
// pins that version, pulls it and restarts. Colonie never holds Docker's
// keys: the most anyone inside it can do is ask for a published version.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REQUEST = "update-requested";
const RELEASE = /^\d+\.\d+\.\d+$/;
const CACHE_MS = 10 * 60_000;

/** The highest plain release number (1.2.3) among the tags, or null. */
export function newestVersion(tags: readonly string[]): string | null {
  const releases = tags.filter((tag) => RELEASE.test(tag));
  releases.sort((a, b) => {
    const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  });
  return releases.at(-1) ?? null;
}

export function createServerUpdate(deps: { controlDir: string; version: string; image: string; fetch?: typeof fetch; now?: () => number }) {
  const http = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const supported = Boolean(deps.controlDir) && existsSync(deps.controlDir);
  // ghcr.io/<owner>/<name>:<tag> → its repository path; other images (a local build) have none
  const repository = /^ghcr\.io\/([\w.-]+\/[\w.-]+)(:[\w.-]+)?$/.exec(deps.image)?.[1] ?? null;
  let cached: { at: number; tags: string[] } | null = null;

  async function tags(): Promise<string[]> {
    if (!repository) return [];
    if (cached && now() - cached.at < CACHE_MS) return cached.tags;
    try {
      const { token } = await (await http(`https://ghcr.io/token?scope=repository:${repository}:pull`)).json() as { token?: string };
      const answer = await http(`https://ghcr.io/v2/${repository}/tags/list`, { headers: { authorization: `Bearer ${token ?? ""}` } });
      const list = answer.ok ? ((await answer.json()) as { tags?: string[] }).tags ?? [] : [];
      cached = { at: now(), tags: list };
      return list;
    } catch {
      return cached?.tags ?? [];
    }
  }
  const requested = () => {
    try {
      return supported && existsSync(join(deps.controlDir, REQUEST)) ? readFileSync(join(deps.controlDir, REQUEST), "utf8").trim() || null : null;
    } catch { return null; }
  };

  return {
    async status() {
      if (!supported) return { supported: false, current: deps.version, latest: null, available: false, requested: null };
      const latest = newestVersion(await tags());
      const newer = latest !== null && newestVersion([latest, deps.version]) === latest && latest !== deps.version;
      return { supported: true, current: deps.version, latest, available: newer, requested: requested() };
    },

    /** Ask the host for this published version. */
    request(version: string): { requested: string } {
      if (!supported) throw Object.assign(new Error("This server was set up without updates from the app."), { status: 409 });
      if (!RELEASE.test(version) || !cached?.tags.includes(version)) throw Object.assign(new Error(`${version} is not a published version.`), { status: 400 });
      writeFileSync(join(deps.controlDir, REQUEST), `${version}\n`);
      return { requested: version };
    },
  };
}

export type ServerUpdate = ReturnType<typeof createServerUpdate>;
