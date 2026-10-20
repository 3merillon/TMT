import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wasmBuildEnvironment } from './wasm-build-env';
const target = process.env.CARGO_TARGET_DIR ?? join(tmpdir(), 'iron-orrery-realtime');
mkdirSync(target, { recursive: true });
const built = spawnSync('cargo', ['+1.90.0', 'build', '--manifest-path', 'rust/realtime-core/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release', '--locked'],
  { stdio: 'inherit', env: wasmBuildEnvironment(target) });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
copyFileSync(join(target, 'wasm32-unknown-unknown/release/iron_orrery_realtime.wasm'), 'src/game/realtime/realtime-core.wasm');
