// Built-in driver registration — a static array, nothing more.
// Colonie is ACP-only: the two maintained adapters are the whole fleet, and
// server/devone/profile.ts refuses any other driver in a config. The inherited
// native/legacy-ACP drivers were retired on 2026-10-14 (PLAN.md M11 step 3).
import type { AnyProviderDriver } from "../contracts.ts";
import { CodexAcpDriver } from "../devone/codex-acp.ts";
import { ClaudeAcpDriver } from "../devone/claude-acp.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [CodexAcpDriver, ClaudeAcpDriver];
