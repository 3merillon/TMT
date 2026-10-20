# Release validation — 18 October 2026

This report separates the repository cleanup from earlier release preparation and deployment. The validation below was collected before publishing the cleanup; later deployment receipts and live checks are separate evidence. Local verification does not validate a deployed build.

## Review — 20 October 2026

A pre-publication source review on the `release/open-source-review` branch. It changed no gameplay, network, save or shader behavior.

- **Consistent source formatting.** 164 TypeScript files mixed whitespace-stripped statements with normally spaced code, most heavily in the resident terrain core (`src/gpu/terrain/arrangement.ts`, `service.ts`, page packets and workers), the structural physics adapter and their tests. An AST-driven pass re-spaced adjacent same-line tokens and verified that each file's token stream was unchanged; `git diff -w` for that commit is empty. Line structure, comments and indentation were not touched.
- The peer-link message handler lost a duplicated null check and a repeated serialization. CI now caches the `naga` binary and Cargo state instead of compiling them on every shard and run.

Fresh validation on the same Windows machine (Node 22.15.0, Edge with hardware WebGPU), all against the formatted tree:

| Check | Result |
| --- | --- |
| TypeScript, guards, import closure, repository gate, bundle budget | Passed; zero unresolved imports. The one closure "orphan" is a benchmark probe shader read by path |
| `npm run verify:fast` | 271 files; 2,322 passing tests and the two expected failures; exit 0 |
| `npm run verify:cloudflare` | 13 checks passed on local workerd, SQLite and WebSockets |
| Native Rust tests, both crates | Passed (eight realtime tests; the terrain crate has no unit tests) |
| Realtime PvP, two and three browsers | Simultaneous movement and fire, identical health, terrain edits and winner on every browser, playable rematch; direct `host` UDP candidates; no browser errors |
| Realtime artillery, two browsers | The same checks passed with ballistic ammunition selection |
| Realtime lifecycle, two browsers | Queue kept across Workshop and Settings, passworded join, mobile touch drive/aim/fire, chat and unread badge, guest disconnect and reload, 1v1 reconnect pause and resume without host election |
| Co-op campaign, three browsers | First Light win, owner-only progression, guest assistance rewards, modified-world late join, next mission, manual transfer, unexpected host loss, reconnect, helper leave and rejoin |
| Solo smoke capture | Functional gates passed in both runs (no errors, crater committed, simulation resumed). Ready time 16,540 ms cold and 12,146 ms with a warm Vite cache against the unchanged 12,000 ms sanity bound; DOMContentLoaded fell from 9,888 to 5,536 ms between the runs, so the development server's module transform dominates this measurement |

Not repeated in this review: the online menu lifecycle script (its title check opens the live donate link), forced TURN, production smoke and independent-network devices. The [18 October evidence](multiplayer-validation-2026-10-18.md) remains the latest record for those. No budget was raised.

## Current repository cleanup

- Removed 182 obsolete plans, task briefs, handoffs, scratch programs, and superseded evidence files from `docs/` after preserving originals outside the checkout. Current contracts, useful dated measurements, provenance, and licensing remain. Three regression inputs moved into `tests/fixtures/terrain/` with their test readers updated.
- Removed 16 superseded tank-kit v1 asset/recipe files, two unreferenced source helpers, and the obsolete pre-overhaul capture calibration pair. Import searches, dynamic loading, worker/WASM URLs, manifests, generators, tests, and shader discovery informed the decisions; import closure alone was not treated as proof of dead code.
- Moved the three active diagnostic pages into `dev/`. Only `index.html` and the compatible `play.html` redirect remain at the root. Production builds include the game and redirect; diagnostics remain available through Vite.
- Moved reflection-probe build metadata out of `public/` into its source package and updated its generators. Runtime workshop assets retain their manifest closure. No artwork, audio, Rust source, or required WASM was regenerated.
- Corrected retained guides against current code, including texture painting, campaign state, liquid ownership, clouds, audio caching, and multiplayer limitations. Preserved the complete looptile MIT notice alongside existing media/dependency attribution.
- The repository gate checks links and npm commands in every released Markdown file. A local link must point into the release inventory, so an ignored capture cannot silently make a broken public link pass. New regression coverage exercises that distinction. Determinism coverage now checks every current simulation file without relying on a retired task-ownership map.
- Simplified duplicate profile-unlock sanitization without changing its output. Made the Windows worktree helper portable and kept optional ownership checks available through an explicitly supplied map.

Every retained release file has a recorded purpose in the local audit inventory. Working inventories, source-search evidence, test logs, and captures are ignored under `artifacts/release-polish/`; removed originals have checksum-verified copies outside the repository. Those working files are not distributed. Git history was not rewritten, so older blobs remain in history.

## Current measurements

File totals use decimal MB; bundle KiB uses 1,024 bytes. The release inventory includes existing tracked and nonignored files plus the physical `public/` tree, because Vite copies ignored files there too.

| Measure | Current local tree/build |
| --- | ---: |
| Release files | 1,637 |
| Physical public payload | 351 files / 52,680,238 bytes (52.68 MB) |
| Source assets | 649.62 MB |
| Source GLBs | 249.60 MB |
| README screenshots | 170,678 bytes / three WebP images |
| Initial game JavaScript, raw / gzip | 961.2 KiB / 327.9 KiB |
| Complete production output | 60,112,105 bytes (60.11 MB), 377 files |

Source assets include the editable workshop, source models, texture masters, and provenance needed for regeneration. They are not browser downloads. The runtime workshop package is 45 files / 7,678,628 bytes. See [media provenance and loading](media.md). Existing public, asset, image, and game bundle budgets were not raised. Removing the structural diagnostic from production also removes its dedicated bundle-budget entry; the game's checks remain.

These are file and bundle measurements, not evidence of improved frame rate, startup time, memory use, or network transfer. No comparable performance experiment was performed for this cleanup.

## Fresh local validation

Node 22.15.0, Windows; browser captures used Chromium 149.0.7827.55 with hardware NVIDIA Ampere WebGPU, not a fallback adapter. Heavy CPU tests and browser measurements ran separately.

| Check | Result |
| --- | --- |
| Full Vitest suite after cleanup | 276 files; 2,326 passing tests and two expected failures (2,328 total); exit 0 |
| TypeScript, architecture/determinism guards, import closure | Passed; zero unresolved relative imports |
| Bundle budget, repository gate, production build | Passed; bundle checker has zero errors/warnings. Vite retains its advisory 500 kB chunk warning |
| Local Cloudflare integration | 13 checks passed using real local workerd, SQLite and WebSockets; server runtime source was unchanged |
| Shader validation | Naga 30.0.0 available; WGSL suite included in the passing full run |
| Mobile emulation | Passed joystick movement and second-finger firing; captures inspected, no console/page errors |
| Developer pages | Renderer sandbox ready, all 16 kit assemblies without overlap, and 10 structural checks passed; captures inspected, no browser/HTTP errors |
| Desktop smoke gameplay | Crater committed and simulation resumed; seven of eight gates passed, no page/console/HTTP errors; captures inspected |
| Desktop startup timing | **Failed:** 13,395 ms and 16,045 ms; isolated rerun after closing another game tab was 14,512 ms against the unchanged 12,000 ms gate |
| Windows helper | Isolated path/branch/junction checks passed in PowerShell 5.1 and 7.6.5; no real worktree creation or removal |
| Independent source review | No cleanup regression found; all local Markdown links and 17 explicit Markdown anchors resolve |

The startup timing is the developer smoke test's navigation-to-ready measurement on a local Vite server. It is not a multiplayer admission timeout. Closing another game tab did not make that gate pass; the cause of the remaining excess has not been established. The test harness can continue waiting and run gameplay checks after missing the timing target. Failed results remain recorded; no threshold was raised.

The two expected-failing reference cases are Story AI accuracy and a light-tank hemispherical-pit recovery case. They remain visible and unchanged. Native Rust tests and WASM rebuilds were not repeated because this cleanup did not change Rust sources or binaries; the full JavaScript suite still exercises the checked-in WASM.

## Earlier qualification evidence

Earlier preparation on the same date included renderer loading, canonical-cap terrain repair, texture painting and cosmetic transfer, protected workshop navigation, realtime AI, Help, and multiplayer/campaign work. Those changes and their measurements predate this cleanup. The original full report and captures are retained locally; [multiplayer validation](multiplayer-validation-2026-10-18.md) records the detailed online evidence.

| Earlier evidence | Scope and limitation |
| --- | --- |
| Installation and native builds | Clean locked npm install; terrain native compilation (zero native unit tests), eight realtime native tests, and both locked WASM builds passed |
| Earlier full suite | 273 files / 2,306 passes / two expected failures. A kit CPU-budget failure under overlapping browser load passed its isolated rerun with the same 30-second threshold; the failed run was retained |
| Gameplay and recovery | Local solo/same-screen and realtime AI, three-player combat/rematch, co-op rewards/late join/host transfer/recovery, and the real three-minute 1v1 reconnect lifecycle passed |
| Workshop and presentation | Painting through 311 pointer gestures, save/reload, protected exits, two-browser appearance exchange, Help, creator links and gamepad navigation passed; captures were inspected |
| Actual TURN | Two local browsers used relay-to-relay UDP during realtime play, with 120 ms synthetic input delay and every tenth drive submission dropped; agreed result and playable rematch passed. Faults affected game-input submissions, not arbitrary network packets |
| Production smoke | Earlier build deployed as Cloudflare version `2139cd9c-da6c-47a0-9452-0890acabff52`; live title/link checks, desktop realtime AI and mobile Help/footer checks passed |

The earlier renderer split reduced initial static JS from 1,846.5 to 1,076.2 KiB raw and from 596 to 357.6 KiB gzip. Warm-up still fetches renderer code; this did not establish a frame-rate gain or a smaller complete gameplay download. Earlier removal of generated Cargo output reduced the release tree, but did not shrink historical Git objects. Current local cleanup has not repeated production smoke or actual TURN testing.

## Remaining qualification limits

- The desktop startup smoke gate still misses its 12,000 ms sanity bound (by 146 ms with a warm Vite cache on 20 October). The measurement runs against the development server, whose on-demand module transform accounts for most of the time; a production-build startup measurement is still needed before calling that check green.
- Multiplayer has no world-build readiness deadline. A connected, heartbeating player can hold versus startup open; the 30-second WebRTC negotiation timeout and three-minute disconnected-seat grace serve different purposes. See [multiplayer lifecycle](../server/README.md#architecture-and-recovery).
- Physical phones/tablets, independent home/mobile networks, prolonged play, and browser background/suspend behavior are not comprehensively qualified. Local browser emulation and real TURN on one computer do not establish those results.
- The 18-mission catalogue uses playable shared mission verbs. Authored boss/environmental set pieces, mission-specific art/layout, and broader human playtesting remain incomplete; automated mission completion is not a complete content-quality assessment. See [campaign authoring](../src/game/campaign/README.md).
- Long-session terrain edit/memory behavior and worst-case workloads need broader qualification. Bounded effects, approximate terrain sampling, and compatibility paths have the limits described in [architecture](architecture.md) and [the algorithm contract](algorithm.md).
- Multiplayer trusts the simulation host and may roll back to acknowledged checkpoints. Saves are browser-local. Source MIT licensing does not automatically relicense artwork or third-party components.

The profile refactor and production-package changes reach players through a new build/deployment. Follow [development](development.md) and [deployment](../server/README.md) for the commands and repeat live smoke checks on any newly deployed revision. Publishing this revision does not establish the unresolved qualification results above.
