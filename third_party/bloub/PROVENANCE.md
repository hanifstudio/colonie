# Bloub source used by Colonie

Source: https://github.com/jeremy-prt/bloub
Revision: b4bb3c1b5f93c7b87a2e8d620f667c4093d97749
Copyright (c) 2026 Jérémy Perret. MIT; see LICENSE.

The framework-free `src/bot` engine is preserved from this revision. Colonie
provides its own React rendering/lifecycle/status wrapper and icon generation.
The upstream Vue application/component is not included in the application.
The repository describes its visual reference as the x.ai bot avatar; the MIT
license covers the contributed code, not ownership of that reference design.

## Colonie additions

The engine is otherwise unchanged. One state was added next to `swirl` in
`src/bot/states.ts`: `rings`, a bot at work with its rings turning, keeping the
body its owner chose (the upstream `orbit` turns the body into a triangle).
`src/components/bloub-motion.ts` decides which state Colonie plays and a test
there keeps that choice honest.
