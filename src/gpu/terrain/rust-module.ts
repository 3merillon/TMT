/** Vite emits the checked-in release WASM as a content-addressed asset. */
let compiled: Promise<WebAssembly.Module> | undefined;
export function loadTerrainModule(): Promise<WebAssembly.Module> {
  return compiled ??= fetch(new URL('./terrain-core.wasm', import.meta.url)).then(async response => {
    if (!response.ok) throw new Error(`Terrain WASM fetch failed (${response.status})`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { compiled = undefined; throw error; });
}
