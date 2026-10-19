// The switch decision guards the one thing the workspace list cannot undo: the
// app records a workspace before it restarts into it, so a target that cannot
// run must be refused before anything is written.
import assert from "node:assert/strict";
import test from "node:test";

import { SWITCH_REFUSED, planWorkspaceSwitch } from "./workspace-switch.mjs";

const FIRST = { id: "local-default", name: "My workspace", dir: "/home/you/.colonie" };
const SECOND = { id: "design-lab", name: "Design lab", dir: "/home/you/.colonie-workspaces/design-lab" };

/** A probe that remembers what it was asked, and can refuse one directory. */
function probe({ busy = [] } = {}) {
  const asked = [];
  return {
    asked,
    directoryAvailable: (dir) => {
      asked.push(dir);
      return !busy.includes(dir);
    },
  };
}

test("a choice nobody named is refused", () => {
  const { asked, directoryAvailable } = probe();
  for (const id of [undefined, null, "", "   ", 42, {}]) {
    assert.deepEqual(
      planWorkspaceSwitch({ id, workspaces: [FIRST, SECOND], activeId: FIRST.id, directoryAvailable, packaged: true }),
      { ok: false, code: SWITCH_REFUSED.NOT_NAMED },
      `id ${JSON.stringify(id)} must not choose anything`,
    );
  }
  assert.deepEqual(asked, [], "nothing may be probed without a target");
});

test("an id that is not in the list is refused, and never probed", () => {
  const { asked, directoryAvailable } = probe();
  const plan = planWorkspaceSwitch({
    id: "gone",
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: true,
  });
  assert.deepEqual(plan, { ok: false, code: SWITCH_REFUSED.NOT_LISTED });
  assert.deepEqual(asked, []);
});

test("the running workspace is reported as already open without probing it", () => {
  // The app holds that directory's own lease: probing it would report it busy
  // and refuse a click that needs to do nothing at all.
  const { asked, directoryAvailable } = probe({ busy: [FIRST.dir] });
  const plan = planWorkspaceSwitch({
    id: FIRST.id,
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: true,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "already-open");
  assert.deepEqual(plan.target, FIRST);
  assert.deepEqual(asked, []);
});

test("a workspace whose directory another Colonie owns is refused, before anything is recorded", () => {
  const { directoryAvailable } = probe({ busy: [SECOND.dir] });
  const plan = planWorkspaceSwitch({
    id: SECOND.id,
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: true,
  });
  assert.deepEqual(plan, { ok: false, code: SWITCH_REFUSED.IN_USE, target: SECOND });
});

test("the app that owns its server restarts into the chosen workspace", () => {
  const { asked, directoryAvailable } = probe();
  const plan = planWorkspaceSwitch({
    id: SECOND.id,
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: true,
  });
  assert.deepEqual(plan, { ok: true, mode: "restart-app", target: SECOND });
  assert.deepEqual(asked, [SECOND.dir]);
});

test("a source checkout asks the person to reopen Colonie", () => {
  const { directoryAvailable } = probe();
  const plan = planWorkspaceSwitch({
    id: SECOND.id,
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: false,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.mode, "reopen-colonie");
  assert.deepEqual(plan.target, SECOND);
});

test("the target the caller records is exactly the one that was validated", () => {
  const { directoryAvailable } = probe();
  const plan = planWorkspaceSwitch({
    id: SECOND.id,
    workspaces: [FIRST, SECOND],
    activeId: FIRST.id,
    directoryAvailable,
    packaged: true,
  });
  assert.equal(plan.target.dir, SECOND.dir);
  assert.equal(plan.target.id, SECOND.id);
  assert.equal(plan.target.name, SECOND.name);
});

test("a malformed list refuses rather than picking a workspace", () => {
  const { directoryAvailable } = probe();
  for (const workspaces of [undefined, null, "design-lab", [null, {}, { id: "design-lab" }]]) {
    const plan = planWorkspaceSwitch({ id: "design-lab", workspaces, activeId: FIRST.id, directoryAvailable, packaged: true });
    assert.equal(plan.ok, false, `${JSON.stringify(workspaces)} must not resolve`);
    assert.equal(plan.code, SWITCH_REFUSED.NOT_LISTED);
  }
});
