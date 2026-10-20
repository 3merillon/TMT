/**
 * One download per packaged workshop file. The title screen prefetches the whole package (manifest, geometry, maps) at
 * low priority while it is idle, and the scene's loaders read the same in-flight or finished downloads, so entering the
 * workshop needs no network round trip. File names other than the manifest carry a content hash.
 * Kept free of engine imports: the title loads this module, not the scene.
 */
import type { RoomManifest } from './room';

const BASE = '/workshop/';
const downloads = new Map<string, Promise<Blob>>();
let prefetching: Promise<void> | undefined, scheduled = false;

function download(file: string, priority: RequestPriority): Promise<Blob> {
  let pending = downloads.get(file);
  if (!pending) {
    if (!/^[a-z0-9._-]+\.(json|wmesh|bin|webp|png|jpe?g)$/i.test(file)) return Promise.reject(new Error('Invalid workshop asset path.'));
    pending = fetch(BASE + file, { priority }).then(response => {
      if (!response.ok) throw new Error(`Workshop asset ${file} failed (${response.status}).`);
      return response.blob();
    });
    downloads.set(file, pending);
    // A failed download is retried by the next request instead of being remembered.
    pending.catch(() => { if (downloads.get(file) === pending) downloads.delete(file); });
  }
  return pending;
}

/** The packaged file, shared with any prefetch already under way; abandoning it leaves the shared download running. */
export function workshopAsset(file: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  const pending = download(file, 'high');
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function workshopManifest(signal?: AbortSignal): Promise<RoomManifest> {
  return JSON.parse(await (await workshopAsset('manifest.json', signal)).text()) as RoomManifest;
}

/** Every file the scene loads, in the order it needs them. */
export function workshopFiles(manifest: RoomManifest): string[] {
  return [
    ...manifest.meshes.map(spec => spec.file), ...(manifest.fanRotor ?? []).map(spec => spec.file),
    ...(manifest.surfaces ?? []), ...(manifest.reflection?.faces ?? []), ...(manifest.gaugeFace ? [manifest.gaugeFace] : []),
    ...(manifest.textures ?? []).flatMap(spec => [spec.baseColor, spec.normal, spec.orm]),
  ];
}

/** Warms the scene code and the whole package once (low priority from the title, high once the workshop opens). Safe to call repeatedly. */
export function prefetchWorkshop(priority: RequestPriority = 'low'): Promise<void> {
  prefetching ??= (async () => {
    void import('./scene').catch(() => {});
    const manifest = JSON.parse(await (await download('manifest.json', priority)).text()) as RoomManifest;
    await Promise.all(workshopFiles(manifest).map(file => download(file, priority)));
  })();
  prefetching.catch(() => { prefetching = undefined; });
  return prefetching;
}

// The workshop renderer can be compiled ahead of entry (scene.ts keeps it for the next scene to adopt). `wanted` is
// the title's standing request; opening the workshop or starting a match withdraws it, so a request still waiting on
// idle time or on the scene code never builds a renderer nobody will adopt.
let wanted = false, prepared = false, idleScheduled = false;
/** Compiles the workshop renderer now. Safe to call repeatedly. */
export function prewarmWorkshop(): void {
  wanted = true;
  void import('./scene').then(scene => { if (wanted) { prepared = true; scene.prewarmWorkshopEngine(); } }).catch(() => {});
}
/** Compiles it once the page is idle; the title asks only after the battle renderer has finished its own compilation. */
export function prewarmWorkshopWhenIdle(): void {
  if (idleScheduled) return;
  idleScheduled = wanted = true;
  const start = () => { idleScheduled = false; if (wanted) prewarmWorkshop(); };
  typeof requestIdleCallback === 'function' ? requestIdleCallback(start, { timeout: 3000 }) : setTimeout(start, 500);
}
/** The workshop is opening: it adopts whatever is already prepared, and nothing more is started for it. */
export function workshopOpening(): void { wanted = false; prepared = false; }
/** A match is starting and needs the GPU: frees a renderer nobody adopted. Loads no code when none was prepared. */
export function releaseWorkshopPrewarm(): void {
  wanted = false;
  if (!prepared) return;
  prepared = false;
  void import('./scene').then(scene => scene.releaseWorkshopEngine()).catch(() => {});
}

/** Prefetch once the page is idle; a Save-Data connection waits for an explicit intent such as hovering Workshop. */
export function prefetchWorkshopWhenIdle(delayMs = 1500): void {
  if (scheduled || prefetching || (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  scheduled = true;
  const start = () => { void prefetchWorkshop().catch(() => {}); };
  setTimeout(() => typeof requestIdleCallback === 'function' ? requestIdleCallback(start, { timeout: 4000 }) : start(), delayMs);
}
