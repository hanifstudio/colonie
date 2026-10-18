// What a proposal card may claim: an engine switch is warned about only from a
// live registry instance, only a Chief may target a peer, and a model proposal
// is refused when the destination cannot carry the bot's permissions.
import { expect, test } from "vitest";
import { createProposalValidation } from "./proposal-validation.ts";

const bots: Record<string, never> = {
  chief: { id: "chief", name: "Chief", section: "core", chiefOfStaff: true, peers: ["peer"] } as never,
  peer: { id: "peer", name: "Peer", section: "core" } as never,
  stranger: { id: "stranger", name: "Stranger", section: "other" } as never,
};

function build(overrides: Record<string, unknown> = {}) {
  return createProposalValidation({
    checkedModelSelection: () => ({ ok: true }),
    registry: {
      get: (instanceId: string) => (instanceId === "live" ? { driverKind: "claude-acp", adapter: { capabilities: { agentsMcp: true } } } : undefined),
      cliTarget: (instanceId: string) => ({ driverKind: instanceId === "claude" ? "claude-acp" : "codex" }),
    },
    store: { bot: (id: string) => bots[id] },
    supportsApprovalMode: () => true,
    ...overrides,
  } as never);
}

test("driver capabilities come only from a live registry instance", () => {
  const { driverCapabilitiesFor } = build();
  expect(driverCapabilitiesFor("live")).toEqual({ driverKind: "claude-acp", agentsMcp: true });
  expect(driverCapabilitiesFor("shadow")).toBeUndefined();
});

test("a Chief may target one section peer, and nobody else may target anyone", () => {
  const { chiefPeerTargetRule } = build();
  const rule = chiefPeerTargetRule("permissions");
  expect(rule("chief", "peer")).toBeNull();
  expect(rule("chief", "ghost")).toBe("that bot no longer exists");
  expect(rule("chief", "stranger")).toBe("that bot is not in a team this Chief is allowed to manage");
  expect(rule("peer", "chief")).toBe("only a section's Chief of Staff can change another bot's permissions");
});

test("a model proposal is refused before its approval level is confirmed", () => {
  const { validateModelProposal } = build();
  expect(validateModelProposal({ instanceId: "claude", model: "m" } as never, { approvalGrant: { threadOnly: true } } as never))
    .toBe("Wait for the approval-level confirmation before changing this bot's model");
});

test("an unresolvable selection is refused with the checker's own words", () => {
  const { validateModelProposal } = build({ checkedModelSelection: () => ({ ok: false, error: "no such model" }) });
  expect(validateModelProposal({ instanceId: "claude", model: "nope" } as never)).toBe("no such model");
});

test("a destination driver that cannot carry the bot's permissions is refused", () => {
  const { validateModelProposal } = build({ supportsApprovalMode: () => false });
  const message = validateModelProposal({ instanceId: "claude", model: "m" } as never, { name: "Ada", approvalMode: "full", modelSelection: { instanceId: "codex", model: "x" } } as never);
  expect(message).toContain("@Ada's existing permissions are incompatible with that provider");
  // And an acceptable selection passes.
  expect(build().validateModelProposal({ instanceId: "claude", model: "m" } as never, { name: "Ada", approvalMode: "ask", modelSelection: { instanceId: "codex", model: "x" } } as never)).toBeNull();
});
