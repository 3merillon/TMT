/** Rebuild the shipped compiler. Cargo intermediates must live outside the checkout. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { wasmBuildEnvironment } from './wasm-build-env';
const target = process.env.CARGO_TARGET_DIR ?? join(tmpdir(), 'tmt-terrain-core');
const result = spawnSync('cargo', ['+1.90.0', 'build', '--manifest-path', 'rust/terrain-core/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release', '--locked'], {
  stdio: 'inherit', env: wasmBuildEnvironment(target, ['-C', 'target-feature=-simd128']),
});
if (result.error) throw result.error; if (result.status !== 0) process.exit(result.status ?? 1);
const destination = resolve('src/gpu/terrain/terrain-core.wasm');
copyFileSync(join(target, 'wasm32-unknown-unknown/release/tmt_terrain_core.wasm'), destination);
const bytes = readFileSync(destination); console.log(JSON.stringify({ file: destination, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
