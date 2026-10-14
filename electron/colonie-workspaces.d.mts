export type LocalWorkspaceMode = "local";

/** What the renderer may see of a Local workspace: never a root or a path. */
export interface ColonieWorkspaceSummary {
  id: string;
  name: string;
  mode: LocalWorkspaceMode;
  /** The account's selected Local workspace (persisted per account). */
  active: boolean;
}

/** The result of opening one: where the window may load, and nothing else. */
export interface ColonieWorkspaceOrigin {
  id: string;
  name: string;
  /** `http://127.0.0.1:<port>` of this workspace's own server child. */
  origin: string;
}

/** The bridge main exposes as `window.ogb.colonieWorkspaces`. No method takes an
 * account id: the main process supplies the verified account. */
export interface ColonieWorkspacesBridge {
  list(): Promise<ColonieWorkspaceSummary[]>;
  create(input: { name: string }): Promise<ColonieWorkspaceSummary>;
  open(id: string): Promise<ColonieWorkspaceOrigin>;
}

export interface WorkspaceRegistryEntry {
  id: string;
  accountId: string;
  name: string;
  mode: LocalWorkspaceMode;
  root: string;
  adopted?: true;
}
export interface WorkspaceRegistry {
  version: number;
  accounts: Record<string, { activeWorkspaceId: string }>;
  workspaces: WorkspaceRegistryEntry[];
}

export interface LocalWorkspaceSupervisorOptions {
  /** Native injector: Electron utilityProcess, or childProcessLauncher in tests. */
  launch: (input: { workspace: { id: string; root: string }; env: Record<string, string> }) => unknown;
  /** May be async: a caller reads this workspace's own vault before the child
   * starts, so only that workspace's secrets enter it. */
  environment: (input: { id: string; root: string; port: number }) => Record<string, string> | Promise<Record<string, string>>;
  ownerToken?: string | null;
  /** Defaults to true. False omits the desktop owner protocol (tests only). */
  desktopManaged?: boolean;
  stop?: (proc: unknown) => Promise<boolean>;
  probe?: (input: { port: number; pid: () => number | undefined; bootTimeoutMs: number; isExited: () => boolean }) => Promise<{ outcome: string }>;
  choosePort?: () => Promise<number>;
  bootTimeoutMs?: number;
  log?: (message: string) => void;
}
export interface LocalWorkspaceSupervisor {
  start(workspace: { id: string; root: string; port?: number }): Promise<{ origin: string; port: number; pid: number | undefined }>;
  stop(id: string): Promise<boolean>;
  stopAll(): Promise<boolean>;
  running(id: string): boolean;
  origin(id: string): string | null;
  /** Every live workspace origin, for the app's web-session header hook. */
  origins(): string[];
  shutdown(): Promise<boolean>;
}

export interface ColonieWorkspacesOptions {
  /** Registry file (the app's userData directory). */
  file: string;
  /** Base directory for new Local workspace roots. */
  baseDir: string;
  supervisor: Pick<LocalWorkspaceSupervisor, "start" | "stopAll">;
  /** Hook into the account id main verified. Never a renderer value. */
  accountId: () => string | null;
  makeId?: () => string;
  log?: (message: string) => void;
  read?: (file: string) => WorkspaceRegistry;
  write?: (file: string, state: WorkspaceRegistry) => void;
}
export interface ColonieWorkspaces {
  list(): ColonieWorkspaceSummary[];
  activeWorkspaceId(): string | null;
  create(input: { name?: string }): ColonieWorkspaceSummary;
  adopt(input: { root: string; name?: string }): ColonieWorkspaceSummary;
  open(id: string): Promise<ColonieWorkspaceOrigin>;
  shutdown(): Promise<boolean>;
}

export declare const LOCAL_WORKSPACE_MODE: "local";
export declare const WORKSPACE_REGISTRY_VERSION: number;
export declare const MAX_WORKSPACE_NAME: number;
export declare const WORKSPACE_STOP_TIMEOUT_MS: number;
export declare const WORKSPACE_OWNER_MESSAGE: string;
export declare function workspaceRootPath(baseDir: string, id: string): string;
export declare function nativeProvidersDir(root: string): string;
export declare function emptyWorkspaceRegistry(): WorkspaceRegistry;
export declare function parseWorkspaceRegistry(raw: unknown): WorkspaceRegistry;
export declare function serializeWorkspaceRegistry(state: WorkspaceRegistry): string;
export declare function readWorkspaceRegistry(file: string): WorkspaceRegistry;
export declare function writeWorkspaceRegistry(file: string, state: WorkspaceRegistry): void;
export declare function workspaceForAccount(state: WorkspaceRegistry, accountId: string, id: string): WorkspaceRegistryEntry | null;
export declare function activeWorkspaceId(state: WorkspaceRegistry, accountId: string): string | null;
export declare function workspacesForAccount(state: WorkspaceRegistry, accountId: string): ColonieWorkspaceSummary[];
export declare function workspaceSummary(state: WorkspaceRegistry, accountId: string, id: string): ColonieWorkspaceSummary | null;
export declare function registerWorkspace(
  state: WorkspaceRegistry | null,
  input: { accountId: string; name?: string; root: string; adopted?: boolean },
  makeId?: () => string,
): { state: WorkspaceRegistry; workspace: WorkspaceRegistryEntry; changed: boolean };
export declare function adoptWorkspace(
  state: WorkspaceRegistry | null,
  input: { accountId: string; name?: string; root: string },
  makeId?: () => string,
): { state: WorkspaceRegistry; workspace: WorkspaceRegistryEntry; changed: boolean };
export declare function setActiveWorkspace(state: WorkspaceRegistry, accountId: string, id: string): WorkspaceRegistry;
export declare function localWorkspaceEnvironment(options: {
  port: number;
  root: string;
  env?: NodeJS.ProcessEnv;
  desktopManaged?: boolean;
  staticDir?: string | null;
  resourcesPath?: string | null;
  skillsDir?: string | null;
  appVersion?: string | null;
  extra?: Record<string, string>;
  /** This workspace's own vault record. The only channel secrets enter through. */
  credentials?: Record<string, string> | null;
}): Readonly<Record<string, string>>;
export declare function newOwnerToken(): string;
export declare function pickLoopbackPort(): Promise<number>;
export declare function stopWorkspaceProcess(proc: { kill(signal?: string): unknown; once?(event: string, cb: (code?: number) => void): unknown } | null | undefined, options?: { timeoutMs?: number }): Promise<boolean>;
export declare function createLocalWorkspaceSupervisor(options: LocalWorkspaceSupervisorOptions): LocalWorkspaceSupervisor;
export declare function utilityProcessLauncher(
  utilityProcess: { fork(entry: string, args: string[], options: unknown): unknown },
  options: { resourcesPath: string; userData: string; stdio?: string[] },
): (input: { env: Record<string, string> }) => unknown;
export declare function childProcessLauncher(options: { entry: string; args?: string[]; stdio?: string[] }): (input: { env: Record<string, string> }) => unknown;
export declare function createColonieWorkspaces(options: ColonieWorkspacesOptions): ColonieWorkspaces;
