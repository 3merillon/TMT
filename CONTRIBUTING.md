# Contributing

Focused fixes, clear documentation, reproducible reports, and improvements to the game and engine are welcome. Start with [development](docs/development.md) and [architecture](docs/architecture.md).

Bug reports should include mode, seed/steps, browser/OS/GPU, graphics tier, expected behavior, and actual behavior. Small screenshots and redacted logs help. For multiplayer, distinguish local/direct, actual TURN, and separate internet connections. Never include passwords, session tokens, TURN credentials, or unrelated personal data.

Keep pull requests focused. Explain behavior before/after, asset sources, and checks performed. Add regression coverage for changed behavior. Follow surrounding TypeScript/Rust style and avoid unrelated formatting churn. Preserve saves, worker/network compatibility, and performance budgets.

Run `npm run check`, relevant tests, and `npm run verify:guard`. Packaging changes need `verify:bundle` and `verify:repo`; visual/gameplay changes need real browser validation. See [validation commands](docs/development.md#validation).

First-party code contributions use [MIT](LICENSE). Submit only work you can license; preserve third-party notices. Media needs explicit source, redistribution permission, attribution, and size information. See [SECURITY.md](SECURITY.md) for private vulnerability reporting.
