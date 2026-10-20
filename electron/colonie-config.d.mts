export function colonieDataDir(home: string, env?: NodeJS.ProcessEnv): string;
export function colonieHome(home: string, env?: NodeJS.ProcessEnv): string;
export function developmentData(home: string, argv: string[], env?: NodeJS.ProcessEnv): Record<string, string>;
export function colonieUserData(appData: string, env?: NodeJS.ProcessEnv): string;
export function initializeColonieData(dataDir: string): void;
