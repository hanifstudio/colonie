export interface WorkspaceCredentialReadResult {
  status: "ok" | "empty" | "unavailable";
  credentials: Record<string, string>;
  error?: string;
}

/** Electron's safeStorage surface this vault uses (async API, as main.mjs does). */
export interface WorkspaceVaultSafeStorage {
  isAsyncEncryptionAvailable(): boolean | Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(buffer: Buffer): Promise<string>;
}

export interface WorkspaceCredentialVault {
  /** Always `<root>/credentials.bin`: never the app's global vault. */
  file: string;
  root: string;
  status(): "ok" | "unavailable";
  read(): Promise<WorkspaceCredentialReadResult>;
  /** Empty credentials remove the file; a failed write keeps the previous bytes. */
  save(credentials: Record<string, string>, options?: { rollback?: boolean }): Promise<void>;
}

export declare function workspaceCredentialsFile(root: string): string;
export declare function createWorkspaceCredentialVault(options: {
  root: string;
  safeStorage: WorkspaceVaultSafeStorage;
  log?: (message: string) => void;
  readDelays?: number[];
  sleep?: (ms: number) => Promise<void>;
}): WorkspaceCredentialVault;
export declare function workspaceCredentialEnvironment(credentials: Record<string, string> | null | undefined): Record<string, string>;
