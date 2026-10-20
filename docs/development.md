# Development

## Install and run

Use Node.js 22.12+ and npm with the checked-in `package-lock.json`. `npm ci` installs the locked dependencies. Required terrain/realtime WASM is versioned under `src/`, so a Rust toolchain is unnecessary for ordinary browser development.

```sh
npm ci
npm run dev
```

Vite serves the game at the printed localhost address. WebGPU needs a supported browser/device and a secure context (HTTPS or localhost); there is no WebGL fallback. Current development and browser automation target Chromium/Edge. Unsupported devices should show a renderer error rather than be treated as validated platforms.

`index.html` is the game; `play.html` preserves older links by redirecting. `/?mode=drive&seed=7` opens the drive test. `/?mode=bot&seed=7` starts solo artillery. Renderer, kit, and structural diagnostics live under [`dev/`](../dev/README.md) and are available through Vite only; the production build includes the game and redirect.

## Local multiplayer

`npm run dev:online` builds and serves the game through Wrangler at `http://localhost:8787`. No account or secrets are needed for local direct peer connections. For hot reload, build once, then run `npm run dev:hub` and `npm run dev` in separate terminals. Vite proxies `/api/online` HTTP/WebSocket requests to the local hub.

Automated gameplay uses `npm run dev:online-test` at port 5174 with HMR disabled. Restart it after source changes. See [server/README.md](../server/README.md) for the browser scripts, TURN setup, room ownership, and recovery contract.

## Validation

| Command | Coverage |
| --- | --- |
| `npm run check` | TypeScript type checking |
| `npm run verify:fast` | Typecheck and all unit/integration projects except heavy physics/slow tiers |
| `npm test` | All Vitest projects, including physics and slow suites |
| `npm run verify:performance` | Enforce the kit collision CPU and terrain edit timing targets on comparable hardware |
| `npm run verify:guard` | Import layering, deterministic simulation restrictions, WGSL line endings |
| `npm run verify:closure` | App/test/tool import graph, dynamic literal globs, and potential unused files |
| `npm run verify:bundle` | Production chunks, initial/lazy import boundaries, raw/gzip budgets |
| `npm run verify:repo` | Public source/media policy, size budgets, and links/commands in every released Markdown file |
| `npm run verify:cloudflare` | Local workerd, SQLite Durable Objects, WebSockets, admission, recovery |
| `npm run build` | Typecheck and production Vite build into ignored `dist/` |
| `npm run deploy:check` | Production build and Wrangler dry run; does not publish |

Run targeted projects while iterating (`verify:engine`, `verify:terrain`, `verify:rules`, `verify:ui`, and the other package scripts). To run a file: `npx vitest run tests/engine-view-initialize.test.ts --maxWorkers=1`. Avoid overlapping heavy browser/performance runs. Full test results may include deliberately expected-failing reference cases; the report must distinguish these from real failures.

CI runs the complete discovered Vitest suite in four shards, with one worker per runner so timing measurements do not compete with another test file. Type checking, repository guards, packaging, and the local Cloudflare checks run in a separate job. Reproduce a shard with `npm test -- --shard=1/4 --maxWorkers=1`; all four shards together cover the same suite as `npm test`.

Normal tests enforce correctness and report the full kit collision sweep's 30,000 ms CPU target and terrain preparation's <1.15 timing ratio separately in the console and GitHub job summaries. Exceeding either target does not fail normal CI: processor, operating system, runtime and scheduling affect these measurements. `npm run verify:performance` runs the same complete checks and explicitly enforces both unchanged targets; compare those results on the same hardware and runtime. Invalid measurements, geometry errors, incorrect results and test execution timeouts still fail normal tests.

WGSL validation uses the `naga` executable, discovered on PATH, in the Cargo bin directory, or through `TMT_NAGA`. Without it, the shader suite explicitly skips: a test run on such a machine is not evidence of shader validation. CI installs it before running the suite.

```sh
npm run verify:browser -- smoke --strict
npm run verify:browser -- mobile-fire --strict
npm run verify:browser -- release-gallery --strict
npm run verify:browser -- projectile-water --strict
```

The capture harness starts an isolated Vite server and a local Chromium browser. Set `TMT_CHROME` if browser discovery fails. Captures/logs go under ignored `artifacts/`; inspect images and console/page errors. `--perf` serializes GPU measurements; record device, tier, resolution, seed, warm/cold cache, and workload before comparing runs. An initial bundle-size reduction does not by itself prove a higher frame rate or lower complete gameplay download.

The projectile-water plan fires from a natural basin using resident live shots and checks speed loss and preview agreement.

## Rust cores

Terrain uses Rust 1.90.0 and `wasm32-unknown-unknown`. Realtime has no external crate dependencies. Build scripts use locked dependencies and external temporary Cargo target directories by default; `CARGO_TARGET_DIR` overrides the location. A first build may download dependencies. No generated `target/` belongs in Git.

```sh
rustup toolchain install 1.90.0
rustup target add wasm32-unknown-unknown --toolchain 1.90.0
npm run build:terrain-wasm
npm run build:realtime-wasm
cargo +1.90.0 test --manifest-path rust/terrain-core/Cargo.toml --locked
cargo +1.90.0 test --manifest-path rust/realtime-core/Cargo.toml --locked
```

The builds update `src/gpu/terrain/terrain-core.wasm` and `src/game/realtime/realtime-core.wasm`. Review source/binary changes together, preserve ABI compatibility, and rerun terrain, structural, and realtime regressions. Native Rust unit tests complement browser/WASM tests; neither substitutes for the other.

## Repository and assets

`src/engine` owns rendering, `src/gpu/terrain` bridges resident terrain and GPU pages, `rust/terrain-core` owns the native resident core, `src/game` composes gameplay, and `server` coordinates online rooms. [Architecture](architecture.md) explains each boundary. Browser localStorage/IndexedDB saves and Cloudflare room storage are distinct; there is no separately provisioned application database to migrate.

Keep runtime media in `public/` and editable/build inputs in `assets/`. Keep working captures, profiles, and experiment output in ignored `artifacts/` or outside the checkout. [Media provenance](media.md) records rights and budgets. `public/wasm/` is ignored legacy output, not the current WASM source location.

Keep task briefs, working plans, handoffs, and experiment logs in ignored `artifacts/` or outside the checkout. Public documentation should explain current behavior, maintenance, provenance, or explicitly dated qualification evidence. Curated regression inputs belong in `tests/fixtures/`. Read the [agent guide](../AGENTS.md) before automated edits.

The optional ownership check accepts a caller-supplied map: `npx tsx scripts/guards.ts --stream <ID> --ownership <file.json> --base <ref>`. The old built-in overhaul map is retired; the ordinary `npm run verify:guard` still checks every current simulation file and all import boundaries without a map. The Windows worktree helper (`scripts/worktree-setup.ps1`) defaults to the current `HEAD`, a `codex/<id>` branch, and a sibling worktree directory; explicit `-Base`, `-Branch`, and `-Root` remain available.

## Build and release

```sh
npm run build
npm run deploy:check
```

Review [release readiness](release-readiness.md), asset notices, tests, and browser evidence before committing. Publish only with the maintainer's explicit authorization. `npm run deploy` deploys the Worker and static assets to the configured account; it is never part of CI. See [deployment instructions](../server/README.md).

### Maintainer public releases

Development lives in the private `3merillon/TMT-private` repository. The public `3merillon/TMT` repository has independent history, beginning with a reviewed source snapshot. Keep separate local checkouts; the public checkout uses `main`. Deployment continues from the private checkout with the existing Cloudflare Worker and secrets.

After committing and testing a release in the private checkout, make sure both checkouts are clean and the public checkout is up to date. Then run from the private checkout:

```sh
npm run public:sync -- ../TMT-public
```

The command checks the release inventory and stages the committed source tree in the public checkout, including removals. It preserves ignored local files and refuses dirty checkouts or conflicting ignored paths. It copies no private Git history and performs no commit or push. Review the staged changes in GitHub Desktop, then commit and push from the public checkout using a GitHub privacy email. Never merge or push private branches into the public repository. Public contributions can be applied to development and included in a later reviewed snapshot; commit those contributions in the public checkout before syncing a release.
