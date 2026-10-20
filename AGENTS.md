# Working in Tiny Metal Tank

Read `README.md`, `docs/architecture.md`, and the nearest subsystem README. `docs/development.md` lists commands; `server/README.md` defines multiplayer/deployment behavior. Keep working plans, handoffs, logs, and captures in ignored `artifacts/` or outside the checkout.

- Inspect `git status` and relevant diffs first. Preserve pre-existing changes; do not reset, reformat, or regenerate unrelated files.
- Keep one owner for each responsibility. Extend existing systems rather than introducing parallel engines, networking stacks, or save systems.
- `src/engine` must not import `src/game`. `src/world` must not import engine/game or DOM APIs.
- Simulation uses explicit ticks/seeds. Keep wall-clock time, `Math.random`, rendering, and audio out of deterministic paths; `verify:guard` enforces this.
- Rust/WASM owns native resident geometry, connectivity, render-publication data, and structural physics. TypeScript/compatibility paths still serve old saves and verification. Inspect callers before removing either.
- Simulation hosting and campaign-save ownership are separate. Preserve reconnect grace, authority leases, checkpoints, late joining, and owner/guest rewards. Read lifecycle tests before changing online code.
- Preserve public APIs, worker formats, WASM ABIs, shader bindings, and saves unless the change handles migration.
- Check dynamic imports, globs, workers, WASM URLs, manifests, shaders, tests, and asset generators before deleting an apparently unused file. `verify:closure` is supporting evidence, not permission to delete.
- Run targeted tests, `npm run check`, and `verify:guard`. Packaging changes need `verify:bundle` and `verify:repo`; rendering/gameplay changes need real browser validation.
- Do not raise budgets, suppress failures, or add broad exclusions to obtain green checks. Distinguish unit tests, browser gameplay, simulated faults, actual TURN, production smoke, and independent-device testing.
- Normal CI reports the kit collision CPU and terrain preparation timing targets separately from correctness. Enforce those unchanged targets with `npm run verify:performance` on comparable hardware; do not turn hardware-dependent benchmark targets back into normal CI failure gates.
- Required WASM under `src/` is versioned: rebuild it with source changes. Cargo targets, screenshots, profiles, and logs belong outside the release tree or in ignored `artifacts/`. Keep credentials out of Git and respect media/dependency notices.
- Do not push, deploy, publish, change visibility, or rewrite history without explicit user authorization.
