# Development pages

Run `npm run dev`, then open one of these local tools:

| URL | Purpose |
| --- | --- |
| `/dev/engine-sandbox.html?scene=test` | Inspect engine scenes, render passes, quality tiers, and GPU telemetry. |
| `/dev/kit.html?sheet=1` | Inspect component variants, assembly, joint limits, and overlap reports. |
| `/dev/structural-check.html?auto=1&fixture=two-supports` | Run the compatibility terrain renderer's structural acceptance sequence. |

These pages remain available for development and regression investigation. They
are excluded from production builds. The shipped pages are the game at `/` and
the legacy `/play.html` redirect.

The engine and kit capture plans under `scripts/capture-plans/` use these URLs.
The structural tool exercises the TypeScript terrain and Three.js compatibility
path; it does not establish browser qualification of the default Rust resident
terrain renderer.
