---
name: verify-colonie
description: "Verify Colonie server and conversation changes against an isolated fake-engine instance before claiming they work."
---

# Verify Colonie

Follow `docs/verification/README.md`: start a throwaway server with its own
`HOME`, data folder, and port, probe local routes only, and never drive the
user's live Colonie instance or real data.
