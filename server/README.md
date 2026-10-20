# Cloudflare multiplayer and game hosting

One Cloudflare Worker deployment hosts the built game, public/private room discovery, matchmaking, chat and connection signaling. Each match has its own SQLite-backed Durable Object. Gameplay travels over WebRTC between players; Cloudflare Realtime TURN relays connections that cannot connect directly. No Vercel, Redis, separately rented server, D1 database, or scheduled cron is required.

## Deploy your own copy

You need a Cloudflare account, Node.js 22.12+ and npm, and this source checkout. Everyone in a match must open the same deployed URL and game build. A fork gets its own rooms and secrets; it does not use the original project's service or billing account.

1. Install the locked dependencies and log in:

   ```sh
   npm ci
   npx wrangler login
   ```

2. Optional: change `name` in the root `wrangler.jsonc` from `tmt` to your chosen Worker name before the first deployment. No account ID or database IDs need to be copied into source. The official game is at [tmt.3merillon.workers.dev](https://tmt.3merillon.workers.dev).

3. Deploy the game and create its managed room bindings:

   ```sh
   npm run deploy
   ```

   Wrangler uploads the assets and Worker, and creates both SQLite Durable Object namespaces from the checked-in migration. Start on **Workers Free** if its daily limits suit your test. No custom domain is needed: Wrangler prints an HTTPS `workers.dev` URL. Solo play works immediately. Online Play reports a setup message until the relay secrets are present.

4. In Cloudflare's dashboard, open **Realtime → TURN** and create a TURN key. Record its **TURN Key ID** and **TURN Key API Token**. Follow [Cloudflare's credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/) if the labels change. Use the key-specific credentials, not a temporary player username/password or your global Cloudflare API key.

5. Add both values as Worker secrets. Each command prompts for its value; do not paste credentials into source, chat, or a command argument:

   ```sh
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

   Secret updates apply to the configured Worker. The backend exchanges them for three-hour client credentials; the long-term API token never reaches the browser. Each Worker isolate shares one issued set for up to five minutes and coalesces concurrent issuance requests. Cache hits keep the original expiry; failures can be retried. Clients renew five minutes before expiry and update existing peer connections. Production requires a relay configuration rather than silently presenting STUN-only networking as ready for cross-network play.

6. Open `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/online/health`. Expect `{"ok":true,"deployment":"cloudflare","relay":true}`. Health checks configuration, not remote TURN validity/reachability. Then open **Online Play → Create game**, choose a mode and room password, and select **Create lobby**. Connection is automatic. Use **Join friend** on another network to test real credential issuance and connectivity. Once everyone joins, the host's **Start match** button becomes available.

7. Share the game's HTTPS URL and room invitation/code with friends. Share a private room's password separately. They need a browser with WebGPU support, but no Cloudflare account or source checkout.

For subsequent releases, run `npm run deploy`. Keep the existing migration and Durable Object class names; do not recreate namespaces for ordinary updates. Membership persists, but different game builds cannot join one another. Reload all players to the same release before starting a new match.

To shorten an existing `workers.dev` address, rename the existing Worker in Cloudflare first, then match its new name in `wrangler.jsonc`. Changing only the config deploys a separate Worker without the original secrets or room storage. Browser saves belong to their original address and do not move with the Worker.

### Automatic Git deployment

After the first deployment, open **Workers & Pages → your Worker → Settings → Builds → Connect** and connect your GitHub/GitLab repository. Select this project's root and production branch. Use **build command** `npm run build` and **deploy command** `npx wrangler deploy`. The dashboard's Worker name must match `wrangler.jsonc`. Secrets belong in Worker runtime settings, not frontend build variables. [Cloudflare Git setup](https://developers.cloudflare.com/workers/ci-cd/builds/).

Use a separate Worker name/account and TURN secrets for staging. Version URLs can use their Worker's live resources and are disabled in this config. Do not point experimental builds at the production multiplayer URL. Custom domains are optional under the Worker's domains settings.

## Local play without an account

```sh
npm ci
npm run dev:online
```

Open `http://localhost:8787`. This builds the game and runs the actual Cloudflare runtime, SQLite storage and WebSockets locally. No account or keys are needed for direct local connections. The `ALLOW_DIRECT_ONLY:true` override is applied only by local development scripts and is absent from deployment configuration.

For Vite hot reload, run `npm run build` once, then `npm run dev:hub` and `npm run dev` in separate terminals. Vite proxies HTTP and WebSockets to port 8787. Local state lives in ignored `.wrangler/` files. Localhost is a browser secure context; ordinary LAN HTTP does not enable WebGPU. Use the deployed HTTPS site for physical multi-device testing.

To test TURN locally, copy `.dev.vars.example` to `.dev.vars` and fill in your key values. This file is ignored by Git. Never use a `VITE_` prefix for secrets. Normal deployments use the same origin and need no `VITE_ONLINE_URL`, `HUB_ORIGINS`, or external database configuration. Optional `HUB_ICE_SERVERS` supports another provider's authenticated TURN endpoints, but static credentials do not auto-renew.

## Architecture and recovery

- `server/cloudflare/worker.ts` serves the API and upgrades authenticated sockets. Static assets normally bypass it. Requests are same-origin by default; JSON bodies and admission rates are bounded.
- Directory API requests are limited to 300 per minute per IP, shared by all players behind that address; new sessions retain a separate 12-per-minute limit. Rejected requests still invoke the Worker and access the directory, so these application limits reduce downstream work rather than protect the Worker request allowance.
- `RoomDirectory` stores indexed summaries and session routing in SQLite. It serializes admission/queue decisions, reserves a room before entering it, and recovers interrupted admissions from committed room membership. Private rooms stay out of discovery. Quick Match chooses open rooms in the selected versus mode (turn-based artillery, realtime artillery or realtime PvP), orders by estimated latency and rechecks compatibility before admission. It never silently substitutes a different ruleset.
- `GameRoom` serializes passwords, membership, chat, signaling, checkpoints and authority epochs. Changes persist before replies/pushes leave the object. Hibernatable sockets keep authenticated attachments across eviction; state restores from SQLite. Reloads rotate the seat token, with a request-bound receipt to recover a lost reconnect response without rotating twice.
- Four-second socket heartbeats renew only the caller's authority lease and acknowledge recovery checkpoints. Pushes never renew another player's lease. Failed WebSocket connections can fall back to bounded HTTP polling, which costs more. Directory browsing refreshes every fifteen seconds; a queue continues in Workshop/Settings.
- The elected player simulates the world at 60 fixed steps per second, with bounded catch-up. Snapshots run at up to 10 Hz. Guests predict/reconcile movement and interpolate remote units and projectiles. Aim is presented locally, while ammunition, cooldowns, impacts and damage resolve at the host; there is no historical hit rewind. Guest commands have sequence, shape, range, seat and rate validation. The host is trusted: a modified host can falsify the world/results, and replicated hidden world data is not an anti-cheat boundary.
- The host's ten-second local lease expires before the server's fifteen-second election deadline. A successor must hold an acknowledged checkpoint with the complete simulation, NPCs, projectiles, mission state, random state and terrain log. Recovery may pause and roll back several seconds. Without a surviving world holder, play cannot recover. Membership storage is not a server world/campaign autosave.
- Recovery messages have a 16 MiB serialized limit and terrain history has a 20,000-edit limit. Oversized captures retain the previous verified checkpoint and show an error. Wire reassembly and checkpoint retention are bounded; gameplay inputs/control take priority over snapshots, which take priority over recovery fragments. Snapshots carry only unacknowledged terrain edits. Finished matches stop high-frequency publishing once the final events are acknowledged. Canonical standing liquid levels are fixed for a world and sent on initial synchronization/recovery; cosmetic GPU waves are local.
- Seats remain reserved for three minutes. Expiry alarms clean up disconnected rooms and stale records, then stop when nothing remains. There is no permanent cron or idle client polling. Free quotas still apply to heartbeats and alarms.
- Versus waits for every player's world before its first simulation tick. There is currently no world-loading deadline or automatic slow-loader rejection: an admitted player who keeps heartbeating can hold startup open. The 30-second WebRTC negotiation timeout and three-minute disconnected-seat grace do not bound planet construction. Co-op can run while helpers load and join.
- In a versus match with two remaining members, a missing opponent pauses play with a reconnect countdown. The lone survivor does not rebuild a world or migrate authority. A returning player can resume; expiry ends the match with an opponent-disconnected result. An explicit Leave ends it immediately. Three-player versus can continue with two; departed tanks are retired. Co-op permits one remaining human and uses checkpoint recovery when its host is lost.

## Custom paint transfer

Saved colors, finishes, and custom paint travel over the existing WebRTC links separately from match snapshots and recovery. Each seat announces a SHA-256 content identifier; peers request missing designs, validate their decompressed content and checksum, and reuse cached assets. The host forwards guest designs to other guests. Authenticated peer/seat membership constrains who may announce an appearance; cosmetic fields never authorize equipment, rewards, or simulation changes.

Paint tiles use lossless RGBA run/literal coding in the profile, then deflate compression for transport. A design is limited to 2 MiB of serialized JSON, a 2 MiB wire envelope, and 32 MiB of decoded pixels. The appearance cache is bounded to eight entries and 24 MiB of accounted strings. Transfers use the lowest-priority bulk queue, below gameplay, snapshots, and recovery, with their own 2 MiB backlog bound. These are byte limits, not brush-stroke limits. Oversized local designs show an error. Invalid remote designs are rejected while default paint remains available.

## Campaign ownership and saves

The creator is the campaign owner (seat zero), even after a helper becomes simulation host. A co-op lobby can start with the owner alone and admit up to two helpers during play, subject to the room password and available seats. Late join receives the current terrain, bodies, tanks, NPCs, projectiles and objectives. All living humans can complete objectives and issue companion orders. The ending choice belongs to the first living human, so a surviving helper can finish the campaign after the owner's tank is destroyed.

Only the owner advances campaign stars, unlocks and endings. Helpers receive assistance XP/scrap using separate per-mission best-result records; duplicate results and retries do not repeat rewards. Improving a result awards only the improvement. Guest participation never imports the owner's campaign progress or replaces a guest's solo checkpoint. Mission results and rewards are still reported by the trusted player host, not independently verified by Cloudflare.

The owner's browser writes received valid recovery checkpoints to a separate IndexedDB `owned-coop` slot. Solo **Continue** can use that fallback for the same mission, seed, kit, crew and difficulty, retiring absent helper tanks. A normal solo checkpoint takes precedence. A live party advances to the next mission using the original owner's configuration even when a helper hosts. The fallback can be several seconds behind and requires a surviving owner tank. It is a local save, not cloud synchronization: clearing browser data or changing origin loses it. If the owner is temporarily offline when a mission ends, that browser must reconnect while the completed mission is still current to receive its result. Helpers may continue, but advancing first leaves the absent owner without that completion reward; there is no account service or offline reward inbox. Explicit **Leave server** ends the owner's participation in that party: seat zero cannot be reclaimed by entering the invite code, and the previous local checkpoint remains available for solo Continue. Refresh and temporary connection loss use the reserved reconnect seat instead.

## Free allowances and costs

Pricing checked 2026-10-18; account allowances are shared with other projects:

| Service | Allowance / pricing |
| --- | --- |
| Static game assets | Static asset requests are free and unlimited; API requests are separately metered. |
| Workers Free | 100,000 requests/day; CPU limits apply. |
| Durable Objects Free | 100,000 compute requests/day, 13,000 GB-s/day, 5 million row reads/day, 100,000 row writes/day and 5 GB stored. Twenty incoming socket messages count as one compute request; outgoing messages have no request charge. Index maintenance also counts toward row usage. |
| Workers Paid | $5/month minimum, even when idle. Includes Worker and Durable Object allocations; further usage is metered. |
| Realtime TURN | 1,000 GB/month free, shared with Realtime SFU; excess relay egress is $0.05/GB. Direct peer traffic does not use this allowance. |

[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [TURN pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/).

A stable heartbeat produces 900 small incoming socket messages per player-hour, about 45 Durable Object compute requests before allowances. This is only one component: joins, directory publication, row writes/indexes, expiry alarms, active duration and TURN traffic also matter. Measure those counters during playtests before estimating a bill for thousands of users. The former Redis/Vercel dollar estimate no longer applies. Free daily quotas are hard limits: exceeding them can interrupt play until reset. Paid plans do not automatically revert to free when nobody plays. Git builds and optional domains/add-ons have separate limits/costs.

TURN credentials can relay traffic outside the game until they expire. Shorter lifetimes and caching reduce exposure and issuance load, but do not cap relay bandwidth or spending. Workers Free limits do not cap Realtime TURN charges. Keep Workers Free while its quotas suit the game and configure available usage/budget alerts in Cloudflare's dashboard; alert availability depends on the account and product, and alerts do not stop usage. See [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/) and [available notifications](https://developers.cloudflare.com/notifications/notification-available/).

## Verification and live testing

```sh
npm run check
npm run verify:cloudflare
npm run deploy:check
```

`verify:cloudflare` exercises real local workerd, SQLite and WebSockets with synthetic players and no cloud credentials. It covers origin/auth checks, private rooms, concurrent final-seat admission, queue races, durable retries, hibernation, chat/signaling, host handoff and lease expiry. Results go to `artifacts/cloudflare-tests/result.json`. `deploy:check` validates the production bundle without publishing.

For browser automation, use the dedicated no-HMR Vite server so source edits do not reload an active match. Restart that test server after editing source; file watching is intentionally disabled and cached modules otherwise remain old. Run `npm run dev:hub` and `npm run dev:online-test` in separate terminals, then in PowerShell:

```powershell
$env:TMT_ONLINE_TEST_URL = 'http://127.0.0.1:5174'
$env:TEST_BACKEND = 'cloudflare'
$env:TEST_MODE = 'artillery'
$env:TEST_PLAYERS = '3'
npm run verify:online
node scripts/verify-online-combat.mjs
node scripts/verify-online-coop-game.mjs
node scripts/verify-online-coop-recovery.mjs
node scripts/verify-online-menu.mjs
node scripts/verify-classic-browser.mjs
node scripts/verify-online-appearance.mjs
```

`TMT_CHROME` selects Chromium/Edge with WebGPU if it is not in a standard install location. Run browser scripts **one at a time**: several resident-world clients already share significant GPU resources. The scripts use development diagnostics against Vite, real local Worker sockets and real browser WebRTC. They do not establish production or independent-network coverage.

- `verify-online.mjs`: `TEST_MODE=duel|artillery|realtime|coop`, `TEST_PLAYERS=2|3`; menu/footer, movement, shooting/terrain, chat, mobile controls and manual host transfer. Optional `TEST_DISCONNECT=1` and `TEST_RELOAD=1` exercise interruption/rejoin. Browser offline emulation can interrupt signaling without necessarily cutting an established WebRTC path; it is not physical internet loss.
- `verify-online-combat.mjs`: `TEST_MODE=artillery|realtime`, `TEST_PLAYERS=2|3`; normal gameplay commands for simultaneous driving/shooting, projectile hits, deaths, consistent results and rematch. `TEST_NETWORK=1` delays guest input by 120 ms and drops every tenth drive submission; this is application-level fault injection, not WAN packet loss.
- `verify-online-coop-game.mjs`: normal autopilot gameplay commands through an actual campaign mission, modified-world late join, objectives, owner/guest persistence, next mission, manual host transfer, host interruption/reconnect and helper leave/rejoin.
- `verify-online-coop-recovery.mjs`: starts the second mission, waits for an acknowledged checkpoint after actual combat and terrain destruction, then verifies terrain history, completed objectives, destroyed NPCs and campaign ownership across manual transfer, unexpected host interruption and reconnect. Records the elected checkpoint IDs, ticks and AI/random state.
- `verify-online-menu.mjs`: desktop/mobile create/join, keyboard password submission, start availability, temporary 1v1 signaling loss/resume with the same host/epoch/world, a closed host through the actual three-minute deadline without rebuilding the world, a fresh match afterward and immediate ending on explicit Leave. It takes several minutes.
- `verify-classic-browser.mjs`: public-menu preservation smoke for classic solo AI and same-screen artillery. Verifies a human shot, the AI's shot/turn return, then a second local human's turn and shot. It does not play either mode to a match result.
- `verify-online-appearance.mjs`: two saved painted profiles join a real local room, exchange compressed designs, show both seat appearances in gameplay, and retain them across guest refresh. Records content hashes and transfer/cache diagnostics without putting paint into gameplay snapshots.

Screenshots and machine-readable results are saved under `artifacts/online/`, `artifacts/online-combat/`, `artifacts/online-menu/`, and `artifacts/online-appearance/`. A script must finish successfully before treating its run as passed; screenshots from failed runs are diagnostic evidence.

For a forced TURN run, configure valid relay credentials first, load **every player's game with `?relay=1`**, then create/join normally. This sets WebRTC's relay-only ICE policy. `TEST_RELAY=1 node scripts/verify-online-combat.mjs` is the equivalent on POSIX shells; in PowerShell set `$env:TEST_RELAY = '1'` before running that script. It checks selected candidates via redacted `PeerLink.transportInfo()` diagnostics. A successful room join or `/health` alone is not proof of TURN: confirm selected candidate type `relay`, then play, transfer and reconnect. Remove the environment variable afterward with `Remove-Item Env:TEST_RELAY`.

If your deployed Worker already issues TURN credentials, the combat test can borrow a temporary public admission's ICE servers while keeping all test rooms on the local Worker. Set `$env:TMT_TEST_TURN_ISSUER = 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'` with `$env:TEST_RELAY = '1'`. Credentials stay in memory and are never written to artifacts; only selected candidate types/protocol are recorded. This proves real relay use from the local test machine, not separate household/mobile-network coverage. Remove both test variables afterward.

Before public release:

1. Load the same HTTPS deployment on two or three physical systems using separate home/mobile connections.
2. Create an unlisted passworded room. Check wrong-password rejection and private discovery, then join using its code/invitation.
3. Play all four modes: classic turn-based artillery, simultaneous realtime artillery, simultaneous realtime PvP and co-op. With two and three people, drive and fire at once, kill tanks and compare the final winner. In co-op, complete a mission, compare objectives/rewards, advance together and join an empty helper seat after terrain has changed. Verify the owner's campaign advances and a guest's unrelated progress stays intact.
4. Check chat filtering/unread badges, objective docking and mobile drag-through/tap controls.
5. With three versus players or at least two co-op players, wait for **Transfer host**, transfer manually, then disconnect the new host for twenty seconds. Verify surviving players resume and the absent player rejoins the reserved seat. Repeat with refresh, browser closure, background tabs and a suspended device. A loading pause/rollback is expected. Separately, in a 1v1, disconnect either player: verify the countdown, reconnect before three minutes and resume; repeat through expiry and verify **Match over** without world rebuilding. Explicit Leave must end the 1v1 immediately. In co-op, have a helper leave and keep playing alone.
6. Rematch or advance the campaign without rebuilding the party. Queue for Quick Match and navigate Workshop/Settings.
7. Include an actual TURN connection. LAN success does not establish relay coverage. Watch Worker/Durable Object/Realtime usage during longer sessions and mobile background/resume tests.

Cross-network reliability, actual relay use and production costs still require live qualification after setup.
