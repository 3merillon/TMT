import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Keep workstation paths out of compiler diagnostics embedded in shipped WASM. */
export function wasmBuildEnvironment(target: string, flags?: string[]): NodeJS.ProcessEnv {
  flags ??= process.env.CARGO_ENCODED_RUSTFLAGS?.split('\x1f') ?? process.env.RUSTFLAGS?.trim().split(/\s+/).filter(Boolean) ?? [];
  const home = homedir();
  const paths = [[home, '/home/build'], [process.env.CARGO_HOME ?? join(home, '.cargo'), '/cargo'], [resolve('.'), '/tmt']];
  return { ...process.env, CARGO_TARGET_DIR: target, RUSTFLAGS: undefined,
    CARGO_ENCODED_RUSTFLAGS: [...flags, ...paths.map(([from, to]) => `--remap-path-prefix=${from}=${to}`)].join('\x1f') };
}
