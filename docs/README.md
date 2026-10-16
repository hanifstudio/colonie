# Colonie documentation

For project continuation, use AGENTS and HANDOVER. Everything else is a reference
for a specific question; do not load this entire directory.

| Question | Active document |
|---|---|
| What is implemented now, and what is next? | [HANDOVER](HANDOVER.md) |
| What product are we aiming for? | [Colonie blueprint](COLONIE-BLUEPRINT.md), a provisional target |
| How will architecture, organization, and consistency improve? | [Engineering roadmap](COLONIE-BLUEPRINT.md#engineering-roadmap-architecture-and-consistency) and [acceptance standards](COLONIE-BLUEPRINT.md#code-and-design-consistency-acceptance), read for relevant implementation work |
| What working rules and development loop apply? | [AGENTS.md](../AGENTS.md) |
| How do I run development builds? | [Repository README](../README.md) |
| How do I verify a change safely? | [Verification policy](verification/README.md) |
| Which ACP checks are relevant? | [ACP verification](verification/colonie-acp.md) |
| How does current bot memory work? | [Memory guide](COLONIE-MEMORY.md) and [memory verification](verification/colonie-memory.md) |
| How are connected tools selected? | [Connected tools](tool-selection.md) |
| What was actually checked recently? | [Recent progress](PROGRESS.md) |
| How should routes be structured? | [Route module guide](../server/routes/README.md) |

## Document authority

The owner's latest instruction governs the task. AGENTS describes working rules;
HANDOVER describes the current implementation; the blueprint describes the target.
Progress records evidence rather than setting product scope. A historical success
or a recipe's existence is not a current verification result.

HANDOVER owns one active milestone and its task queue; product rollout plans
remain in the blueprint. Written rules are not proof of autonomous execution.

Keep product decisions, architecture proposals, and rollout plans in the blueprint
instead of maintaining competing specifications. This directory contains only
current guidance. Superseded plans, redirect-only pages, old evidence dumps, and
archive trees have been removed.

Legal and third-party notices remain in their own files. Required test media lives
with test fixtures, rather than inside this documentation directory.
