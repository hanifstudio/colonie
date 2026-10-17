import { homedir, userInfo } from "node:os";
import { sep } from "node:path";
import { expect, test } from "vitest";
import { DATA_DIR } from "../config.ts";

// Persistence reads and writes whatever DATA_DIR points at. The vitest setup
// (server/testing/setup.ts) gives every test file a throwaway home for exactly
// that reason; this is the guard that says so out loud, next to the code that
// would do the damage if it ever stopped being true. os.homedir() follows the
// setup's HOME, so the real one is asked of the system instead.
test("a test process reads a throwaway data directory, never the owner's", () => {
  expect(DATA_DIR.startsWith(homedir())).toBe(true);
  expect(DATA_DIR).not.toBe(`${userInfo().homedir}${sep}.colonie`);
});