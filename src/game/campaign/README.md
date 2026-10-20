# Campaign runtime and mission authoring

Campaign missions run on the existing realtime match. [`catalog.ts`](catalog.ts) combines the Prologue and
operations into the 18-mission catalogue. [`mission.ts`](mission.ts) owns `MissionDef`, `MissionContext`,
`MissionRunner`, unit templates and mission setup/structure construction. [`progress.ts`](progress.ts) owns
campaign unlocks and best-result rewards; [`loadout.ts`](loadout.ts) owns crew and gadget configuration.

## Mission definitions and beats

A `MissionDef` specifies a stable mission ID, planet kind/seed, starting frame, named sites, ordered beats and a
medal predicate. Sites use bearing in degrees clockwise from the starting heading and surface distance in game
units. Optional routes keep generated buildings clear of authored vehicle corridors; `structures(placer)` adds
authored terrain geometry before the world is built. `timeOfDay` holds the mission's lighting at a chosen day fraction.

Reuse the travel, battle, hold, capture, escort and undermining helpers in [`beats.ts`](beats.ts), or the specialized
Crawler, launch-defence and Whiteout modules. Completion follows gameplay state and committed terrain. A timer alone
does not prove a target died, a support was removed or a protected actor survived.

`MissionRunner` calls `enter` once when a beat begins, `update` and `done` on match ticks while it runs, then `exit`
before advancing. A beat that is already complete after `enter` can finish immediately in the same tick. Exhausting
the beat list wins the mission; explicit `win()` and `lose(reason)` handle terminal conditions. Hints use elapsed
simulation time and are cleared when the beat completes.

`MissionContext` supplies `at`/`near` for sites, `spawn`, named actor groups, `alive`/`cleared`, objectives,
markers, dialogue, reveal controls and terminal results. `elapsed` and `beatTime` are simulation-time properties.
Put persistent beat state in `ctx.flags`; the runner includes those flags in its checkpoint. Keep wall-clock time,
unseeded randomness, DOM, audio playback and rendering out of mission logic.

Mission IDs, beat ordering, group/flag identities and serialized runner state affect saves and recovery. Preserve
them when changing an existing operation, or handle migration explicitly. Use the existing runtime and session
commands for mechanics rather than adding a second mission simulation.

## Presentation, saves and rewards

The runner emits dialogue, objectives, markers, hints and banners; the HUD renders them. For musical state or
feedback, emit `{ type: 'audio', cue }` using the pure types in [`audio-cues.ts`](../audio-cues.ts).
[Audio integration](../../../docs/audio-continuity.md#game-and-campaign-integration) describes explicit cues and
derived fallbacks. New dialogue must be included by the offline [voice corpus pipeline](../../../docs/voice-pipeline.md).

[`GameSession`](../app/session.ts) captures solo checkpoints at settled mission beats, waiting for projectiles and
terrain transactions instead of discarding them. A checkpoint includes realtime state, runner state and resident
terrain. IndexedDB persistence is local to the browser origin; storage failure can leave an in-memory retry available.
Retry after failure uses the latest checkpoint, while restarting from the beginning clears that attempt's save.

Campaign progress uses `campaign:<id>` stars and separate best-reward records in the existing profile. Replaying a
result cannot repeatedly award the same XP/scrap; an improvement pays its delta. Co-op save ownership stays with the
campaign owner when simulation hosting moves. Helpers use separate assistance reward records. The
[multiplayer contract](../../../server/README.md#campaign-ownership-and-saves) covers late join, recovery and the
owner's local fallback save.

## Validation

Add headless coverage for new mission behavior and completion using [`autopilot.ts`](autopilot.ts), which sends
normal session commands. Relevant suites include `tests/rules-campaign-prologue.test.ts`,
`tests/rules-campaign-operations.test.ts`, `tests/rules-campaign-launch.test.ts`,
`tests/rules-campaign-crew.test.ts` and the realtime lifecycle/online co-op suites.

Validate authored sites and routes in the actual resident world as well: `/?mode=campaign&mission=p1&autopilot=1`
runs the pilot in a development build. Inspect terrain placement, objectives, HUD, lighting and actor behavior;
an analytic-world completion test does not establish those properties. `window.__tmtGame.mission` exposes beat,
objectives, marker, outcome and checkpoint diagnostics for browser captures. Store captures in ignored artifacts.
See [development validation](../../../docs/development.md#validation) for the shared checks and browser tooling.

The catalogue contains playable operations built from shared mission verbs. It does not establish completion of
every authored boss or environmental set piece. [Release readiness](../../../docs/release-readiness.md) records
remaining content and platform qualification limits.
