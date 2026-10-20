# Startup UI integration qualification — 13 October 2026

`scripts/verify-startup-ui.ts` passed **15 checks with zero JavaScript, HTTP, console-error, GPU-validation or shader-compilation errors** in isolated desktop Chromium/WebGPU at 1280×720. This is functional evidence, not a startup benchmark or a physical-phone measurement. The compact machine-readable result is [startup-ui.json](startup-ui.json); raw telemetry, the checkpoint and ten screenshots remain in ignored `artifacts/startup-ui-final/`.

The script uses the actual title, workshop, skirmish, loading, match, pause, settings and results UI. It starts with a fresh local profile and the existing skiff/scout/dome/mortar/antenna build. All four explicit world choices use **seed 7**. Setup, resident terrain, rendered terrain metadata, world soundscape and score arrangement agree for temperate, glacial, dune and volcanic. All ten screenshots were inspected; the four world captures show their corresponding soil/grass, ice, sand and volcanic materials and atmospheric colors.

The failure test deliberately throws once **after real terrain initialization**. It tests cleanup and retry, and does not claim to reproduce a natural topology failure. The failed request leaves one terrain created and one disposed, keeps seed 7 and the selected kind on the setup screen, and its next Start succeeds. Cancellation tests gate initialization on real allocated worlds: the first canceled request finishes late on the title screen; the second finishes after a replacement starts. Neither makes a stale world ready. The replacement is volcanic seed 209, with ten total created worlds and nine disposed while it is active; returning to the menu verifies all ten are disposed.

An actual HUD shot (55° elevation, 25% power, Fire button) advances terrain version **1 → 2** and resident history **1 → 2**, with impact and terrain-commit audio events and no resident failure. The checkpoint is saved after that shot, then restored through the session checkpoint API. Restore verifies replay hash **`e737d96e93bea956`** at tick **122**, preserving explicit temperate kind and the `resident-f32-game-v3` profile. The destruction screenshot includes the resulting blast; it is gameplay, not a fabricated visual hull probe.

Workshop lift controls respond while the global score runs; the room reports `musicOwner: application` and zero room-owned music notes. The score clock continues through setup, failure/retry, gameplay, pause/settings, restart, results, menu and subsequent world choices. Actual Audio settings controls verify music mute, effects mute with continuing music, master mute and resumed levels. The visibility test dispatches `visibilitychange` with a temporary `document.hidden` override; it verifies the handler and resumed context, not operating-system background behavior. Music voices stay within 16. These checks do not constitute a subjective listening review; see [audio-continuity.md](../audio-continuity.md) for current audio integration and preview commands.

Expected warnings were Chromium's ignored Windows `powerPreference`, explicit workshop device destruction during disposal, and the deliberately injected startup error. No unexpected errors occurred. This suite checks liquid pipeline readiness, but makes no claim about water depth, vehicle buoyancy/drag, swimming, or terrain-to-fluid contact; those need their own evidence.

A follow-up review found that the engine's shared idle wait could absorb a selected terrain shader rejection. The final code adds a captured selected-shader readiness promise and an explicit same-key retry. `engine-terrain-ready`, `engine-pipeline-retention`, `engine-gpu-core` and `rules-session` passed **33 focused tests** together, including failed shader → non-playable → same-world retry and an obsolete rejection after a replacement is ready; TypeScript also passes. The fifteen-check browser run above predates this final rejection-path correction and is not presented as browser fault injection of a real GPU compile error.

Local-only captures under `artifacts/startup-ui-final/` (not included in the repository):

| Capture filename | Evidence |
| --- | --- |
| `01-workshop-shared-music.png` | Original workshop, application-owned music |
| `02-recoverable-initialization-failure.png` | Injected failure shown in setup; seed and kind preserved |
| `03-temperate-same-seed.png` | Seed 7, selected temperate |
| `04-real-shot-terrain-destruction.png` | Fired shell, impact and committed terrain edit |
| `05-audio-settings-during-pause.png` | Pause Audio panel and restored volume levels |
| `glacial-same-seed.png` | Seed 7, selected glacial |
| `dune-same-seed.png` | Seed 7, selected dune |
| `volcanic-same-seed.png` | Seed 7, selected volcanic |
| `09-loading-cancellable.png` | Allocated-world loading remains cancellable |
| `10-latest-world-after-cancellations.png` | Volcanic seed 209 survives the stale completion |

Reproduce with `node --import tsx scripts/verify-startup-ui.ts --out artifacts/startup-ui-final --summary docs/evidence/startup-ui.json`. `--summarize-only artifacts/startup-ui-final/verification.json --summary docs/evidence/startup-ui.json` regenerates the compact evidence without a browser.
