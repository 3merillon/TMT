import type { V3, WorldQuery } from '../contracts';
import { setData, setHidden, setStyle } from './dom-writes';
import './trajectory-readout.css';

export interface TrajectoryTarget { position: V3; range: number; kind: 'landing' | 'impact' | 'flight-limit' }
export interface ScreenRect { x: number; y: number; width: number; height: number }
const LABEL_WIDTH = 156, LABEL_HEIGHT = 42, MARGIN = 12;
/** A full prediction can expire in midair. Use its authoritative hit flag for terrain, water and extension impacts;
 * an array from an older preview provider safely defaults to an unconfirmed flight limit. Range is surface distance. */
export function trajectoryTarget(points: readonly V3[], origin: V3, radius: number | undefined, full: boolean, hit = false, hitTarget = false): TrajectoryTarget | null {
  if (!full || points.length < 2 || !(radius && Number.isFinite(radius))) return null;
  const end = points.at(-1)!;
  if (!end.every(Number.isFinite) || !origin.every(Number.isFinite)) return null;
  const a = Math.hypot(...origin), b = Math.hypot(...end);
  const cosine = a > 1e-8 && b > 1e-8 ? Math.max(-1, Math.min(1, (origin[0] * end[0] + origin[1] * end[1] + origin[2] * end[2]) / (a * b))) : 1;
  return { position: [...end], range: Math.acos(cosine) * radius, kind: hit ? hitTarget ? 'impact' : 'landing' : 'flight-limit' };
}

/** Stop just before the endpoint so the landing surface itself is not treated as an obstruction. */
export function trajectoryTargetOccluded(target: TrajectoryTarget | null, eye: V3, world: Pick<WorldQuery, 'raycast'> | undefined): boolean {
  if (!target || !world) return false;
  const delta = target.position.map((value, i) => value - eye[i]) as V3, distance = Math.hypot(...delta);
  if (!(distance > .08)) return false;
  return world.raycast(eye, delta.map(value => value / distance) as V3, distance - .06) !== null;
}

const overlaps = (a: ScreenRect, b: ScreenRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Try positions near the target first, then along each HUD boundary. No overlap is preferable to a fixed corner
 * that would cover the drive pad or fire controls at another window size. Null means the viewport has no free area. */
export function placeTrajectoryLabel(anchor: readonly number[] | null, width: number, height: number, obstacles: readonly ScreenRect[]): ScreenRect | null {
  if (width < LABEL_WIDTH + MARGIN * 2 || height < LABEL_HEIGHT + MARGIN * 2) return null;
  const x = anchor?.[0] ?? width * .5, y = anchor?.[1] ?? height * .4;
  // Leave the descending arc above the landing point clear in the usual straight-ahead aiming view.
  const candidates: [number, number][] = [];
  // A selected tank can be wider than the usual point reticle. Keep its impact label just outside the body frame.
  for (const box of obstacles) if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height)
    candidates.push([box.x + box.width + 10, y - LABEL_HEIGHT * .5], [box.x - LABEL_WIDTH - 10, y - LABEL_HEIGHT * .5],
      [x - LABEL_WIDTH * .5, box.y - LABEL_HEIGHT - 10], [x - LABEL_WIDTH * .5, box.y + box.height + 10]);
  candidates.push([x + 23, y - LABEL_HEIGHT * .5], [x - LABEL_WIDTH - 23, y - LABEL_HEIGHT * .5],
    [x - LABEL_WIDTH * .5, y - LABEL_HEIGHT - 22], [x - LABEL_WIDTH * .5, y + 23]);
  for (const box of obstacles) candidates.push([x - LABEL_WIDTH * .5, box.y - LABEL_HEIGHT - 10],
    [box.x - LABEL_WIDTH - 10, y - LABEL_HEIGHT * .5], [box.x + box.width + 10, y - LABEL_HEIGHT * .5],
    [x - LABEL_WIDTH * .5, box.y + box.height + 10]);
  candidates.push([width * .5 - LABEL_WIDTH * .5, height * .4]);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const box = { x: Math.max(MARGIN, Math.min(width - LABEL_WIDTH - MARGIN, candidate[0])),
      y: Math.max(MARGIN, Math.min(height - LABEL_HEIGHT - MARGIN, candidate[1])), width: LABEL_WIDTH, height: LABEL_HEIGHT };
    const key = `${box.x}/${box.y}`;
    if (seen.has(key)) continue; seen.add(key);
    if (!obstacles.some(obstacle => overlaps(box, obstacle))) return box;
  }
  return null;
}

/**
 * The landing readout. The view passes the host's client size, read before the frame's first DOM write, and calls
 * `measureObstacles` before it too: a layout read after a style write forces a synchronous layout.
 */
export class TrajectoryReadout {
  private readonly label: HTMLElement;
  private readonly heading: HTMLElement;
  private readonly value: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly leader: HTMLElement;
  private obstacles: ScreenRect[] = [];
  private measuredAt = -Infinity;
  private size = '';
  private record = { visible: false, text: '', kind: '' as TrajectoryTarget['kind'] | '', range: 0, targetVisible: false, occluded: false, x: 0, y: 0 };

  constructor(private readonly host: HTMLElement) {
    this.label = document.createElement('div'); this.label.className = 'trajectory-readout';
    this.heading = document.createElement('span'); this.value = document.createElement('strong');
    this.label.append(this.heading, this.value);
    this.marker = document.createElement('div'); this.marker.className = 'trajectory-target';
    this.leader = document.createElement('div'); this.leader.className = 'trajectory-leader';
    for (const node of [this.leader, this.marker, this.label]) { node.setAttribute('aria-hidden', 'true'); this.host.append(node); }
    this.hide();
  }

  /** The HUD boxes to avoid, re-read every 200 ms or when the host's size (width × height) changes. */
  measureObstacles(width: number, height: number): void {
    const size = `${width}/${height}`, now = performance.now();
    if (size !== this.size || now - this.measuredAt > 200) {
      const host = this.host.getBoundingClientRect();
      this.obstacles = Array.from(document.querySelectorAll<HTMLElement>('.hud-top > *, .hud-bottom > *, #toast')).flatMap(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'
          ? [{ x: box.left - host.left - 8, y: box.top - host.top - 8, width: box.width + 16, height: box.height + 16 }] : [];
      });
      this.size = size; this.measuredAt = now;
    }
  }

  /** Requested-target feedback also avoids the actual landing readout. */
  targetObstacles(width: number, height: number): readonly ScreenRect[] {
    this.measureObstacles(width, height);
    return this.record.visible ? [...this.obstacles, { x: this.record.x - 8, y: this.record.y - 8, width: LABEL_WIDTH + 16, height: LABEL_HEIGHT + 16 }] : this.obstacles;
  }

  hudObstacles(width: number, height: number): readonly ScreenRect[] { this.measureObstacles(width, height); return this.obstacles; }

  update(target: TrajectoryTarget | null, project: (p: V3) => [number, number] | null, width: number, height: number, occluded = false, avoid: readonly ScreenRect[] = []): void {
    if (!target) { this.hide(); return; }
    this.measureObstacles(width, height);
    const anchor = project(target.position), box = placeTrajectoryLabel(anchor, width, height, avoid.length ? [...this.obstacles, ...avoid] : this.obstacles);
    if (!box) { this.hide(); return; }
    const heading = target.kind === 'flight-limit' ? 'FLIGHT LIMIT' : `${target.kind === 'impact' ? 'IMPACT' : 'LANDING'}${occluded ? ' · OBSCURED' : ''}`;
    const value = `${target.range.toFixed(1)} m${anchor ? '' : ' · offscreen'}`;
    if (this.heading.textContent !== heading) this.heading.textContent = heading;
    if (this.value.textContent !== value) this.value.textContent = value;
    setHidden(this.label, false);
    setStyle(this.label, 'transform', `translate(${box.x}px,${box.y}px)`);
    const targetVisible = !!anchor && !this.obstacles.some(obstacle => overlaps({ x: anchor[0] - 12, y: anchor[1] - 12, width: 24, height: 24 }, obstacle));
    setHidden(this.marker, !targetVisible);
    setHidden(this.leader, !targetVisible);
    setData(this.marker, 'kind', target.kind);
    setData(this.marker, 'occluded', String(occluded)); setData(this.leader, 'occluded', String(occluded));
    if (anchor && targetVisible) {
      setStyle(this.marker, 'transform', `translate(${anchor[0]}px,${anchor[1]}px)`);
      const endX = Math.max(box.x + 8, Math.min(box.x + box.width - 8, anchor[0]));
      const endY = Math.max(box.y, Math.min(box.y + box.height, anchor[1]));
      const dx = endX - anchor[0], dy = endY - anchor[1];
      setStyle(this.leader, 'width', `${Math.hypot(dx, dy)}px`);
      setStyle(this.leader, 'transform', `translate(${anchor[0]}px,${anchor[1]}px) rotate(${Math.atan2(dy, dx)}rad)`);
    }
    this.record = { visible: true, text: `${heading} ${value}`, kind: target.kind, range: target.range, targetVisible, occluded, x: box.x, y: box.y };
  }

  snapshot() { return { ...this.record }; }
  hide(): void {
    setHidden(this.label, true); setHidden(this.marker, true); setHidden(this.leader, true);
    this.record.visible = this.record.targetVisible = false;
  }
}
