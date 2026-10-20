# Documentation

Start with the [project README](../README.md). The guides below explain the current implementation, maintenance commands, asset provenance, and explicitly dated validation evidence.

| Guide | What it covers |
| --- | --- |
| [Architecture](architecture.md) | Renderer, terrain, Rust/WASM, physics, networking, persistence |
| [Development](development.md) | Installation, verification, Rust builds, browser captures |
| [Multiplayer and deployment](../server/README.md) | Cloudflare, TURN, authority, recovery, campaign ownership |
| [Renderer](../src/engine/README.md) | Engine modules, GPU contracts, interior rendering |
| [Workshop](../src/game/workshop/README.md) | Assets, mechanical assembly, selection, saved loadouts |
| [Campaign](../src/game/campaign/README.md) | Mission definitions, state ownership, authoring, and current content limits |
| [Media](media.md) | Source/runtime sizes, loading, provenance, asset rights |
| [Release readiness](release-readiness.md) | Measurements, changes, validation, remaining limits |
| [Contributing](../CONTRIBUTING.md) / [Agent guide](../AGENTS.md) | How to make and verify a change |

## Deeper references

- [Geometry algorithm](algorithm.md): exact reference-kernel semantics and approximation limits.
- [Performance measurements](performance-pass.md), [topology evidence](evidence/startup-topology.md), and [UI evidence](evidence/startup-ui.md): dated measurements and qualification, not performance guarantees for every device.
- [Audio continuity](audio-continuity.md), [fluid architecture](fluid-architecture.md), and [projectile effects](projectile-effects.md): subsystem design and experiments.
- [Visibility](visibility-architecture.md), [planetary lighting](planetary-lighting.md), and [mobile UI](mobile-ui.md): current rendering and interaction contracts.
- [Tank designs](tank-designs.md) and [armor tradeoffs](tank-armor-tradeoffs.md): component design and measured mechanical tradeoffs.
- [Voice pipeline](voice-pipeline.md): offline speech generation and runtime playback.
- [Multiplayer validation, 18 October 2026](multiplayer-validation-2026-10-18.md): prior checks and deployment context. The release report distinguishes fresh validation from these records.

Development diagnostics live under [`dev/`](../dev/README.md). Regression fixtures belong under `tests/fixtures/`; working reports and captures go in ignored `artifacts/`. Completed task briefs and superseded designs are available through Git history rather than maintained as current documentation.
