import artwork from './title-art.svg?raw';
import { GLOBE_RADIUS, TAU, cameraPose, depthOpacity, globeScreenRadius, inverseView, orbitPoint, project, projectedPath, rotateView, spherePoint, surfaceRing, tagReveal, type Point3 } from './title-art-math';

const NS = 'http://www.w3.org/2000/svg';
// Renderer warmup and profile changes can replace the title DOM. Resume the same
// camera time on reconnect instead of jumping back to the opening composition.
let lastTitleTime = 5;
const orbits = [
  { name: 'nuclear', ammoLabel: 'NUCLEAR', radius: 270, tilt: 1.18, bank: -.42, phase: .56, seconds: 24, size: 1.25 },
  { name: 'heavy', ammoLabel: 'HEAVY SHELL', radius: 298, tilt: .91, bank: .32, phase: 3.77, seconds: 38, size: .82 },
  { name: 'explosive', ammoLabel: 'HE ROUND', radius: 218, tilt: .72, bank: -1.03, phase: 5.13, seconds: 31, size: .7 },
] as const;
const fmt = (value: number) => value.toFixed(2);
const clamp = (value: number) => Math.max(0, Math.min(1, value));
function element<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

/** The native element owns its frame, media-query listener and observer. Removing a title
 * synchronously cancels them; no renderer or animation loop remains on another screen. */
export function titleArt(): HTMLElement {
  if (!customElements.get('tmt-tactical-art')) {
    class TacticalArt extends HTMLElement {
      private readonly svg = new DOMParser().parseFromString(artwork, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
      private readonly scene = this.svg.querySelector<SVGGElement>('#tmt-scene')!;
      private readonly rear = this.svg.querySelector<SVGGElement>('#tmt-rear')!;
      private readonly front = this.svg.querySelector<SVGGElement>('#tmt-front')!;
      private readonly grid = this.svg.querySelector<SVGGElement>('#tmt-grid')!;
      private readonly backGrid = this.svg.querySelector<SVGGElement>('#tmt-grid-back')!;
      private readonly tags = this.svg.querySelector<SVGGElement>('#tmt-tags')!;
      private readonly target = this.svg.querySelector<SVGGElement>('#tmt-target')!;
      private readonly shells = Array.from(this.svg.querySelectorAll<SVGCircleElement>('circle[r="146"]'));
      private readonly media = matchMedia('(prefers-reduced-motion: reduce)');
      private readonly observer = new MutationObserver(() => this.syncMotion());
      private frame = 0;
      private elapsed = 5;
      private stamp = 0;
      private lastDraw = 0;
      private readonly gridLines: { points: Point3[]; node: SVGPathElement; back: SVGPathElement }[] = [];
      private readonly tracks = orbits.map((orbit, index) => {
        const back = element('path', { class: 'tactical-orbit rear', 'data-orbit': orbit.name });
        const front = element('path', { class: 'tactical-orbit front', 'data-orbit': orbit.name });
        const missile = element('g', { class: 'title-orbiter', 'data-track': orbit.name });
        missile.append(element('use', { href: `/brand/tmt-ordnance.svg#${orbit.name}` }));
        const tag = element('g', { class: 'tactical-track-tag' });
        const leader = element('path', { fill: 'none', pathLength: '1', 'stroke-dasharray': '1 1' });
        const bracket = element('path', { d: 'M-15-10h6m-6 0v6m30-6h-6m6 0v6M-15 10h6m-6 0v-6m30 6h-6m6 0v-6', fill: 'none' });
        const label = element('text', { 'font-size': '7.5', 'letter-spacing': '1.2' });
        tag.append(leader, bracket, label);
        this.rear.append(back);
        this.front.append(front, missile);
        this.tags.append(tag);
        return { ...orbit, index, back, front, missile, tag, leader, bracket, label };
      });
      private readonly targetRing = element('path', { class: 'tactical-target-ring' });
      private readonly targetSweep = element('path', { class: 'tactical-target-sweep' });
      private readonly targetWave = element('path', { class: 'tactical-target-wave' });
      private readonly targetDot = element('circle', { r: '2.2', fill: '#f1c78d' });
      private readonly targetLeader = element('path', { class: 'tactical-target-leader', fill: 'none', pathLength: '1', 'stroke-dasharray': '1 1' });
      private readonly targetLabel = element('text', { class: 'tactical-target-label', 'font-size': '9', 'letter-spacing': '1.4' });
      private readonly targetState = element('text', { class: 'tactical-target-state', 'font-size': '6.5', 'letter-spacing': '1.2' });

      constructor() {
        super();
        this.target.append(this.targetRing, this.targetSweep, this.targetWave, this.targetDot);
        this.tags.append(this.targetLeader, this.targetLabel, this.targetState);
        // Separate near/far wireframes give the transparent sphere depth without hiding rear missiles.
        for (let latitude = -60; latitude <= 60; latitude += 20) {
          const points = Array.from({ length: 97 }, (_, i) => spherePoint(latitude * Math.PI / 180, i / 96 * TAU));
          const node = element('path'), back = element('path'); this.grid.append(node); this.backGrid.append(back); this.gridLines.push({ points, node, back });
        }
        for (let longitude = 0; longitude < 360; longitude += 20) {
          const points = Array.from({ length: 49 }, (_, i) => spherePoint(-Math.PI / 2 + i / 48 * Math.PI, longitude * Math.PI / 180));
          const node = element('path'), back = element('path'); this.grid.append(node); this.backGrid.append(back); this.gridLines.push({ points, node, back });
        }
      }
      connectedCallback(): void {
        this.elapsed = lastTitleTime;
        this.classList.add('title-art');
        this.append(this.svg);
        const root = this.closest('#game');
        if (root) this.observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        this.media.addEventListener('change', this.syncMotion);
        document.addEventListener('visibilitychange', this.syncMotion);
        this.draw(this.elapsed);
        this.syncMotion();
      }
      disconnectedCallback(): void {
        lastTitleTime = this.elapsed;
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.observer.disconnect();
        this.media.removeEventListener('change', this.syncMotion);
        document.removeEventListener('visibilitychange', this.syncMotion);
        this.dataset.motion = 'stopped';
      }
      private readonly syncMotion = (): void => {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.stamp = this.lastDraw = 0;
        const reduced = this.media.matches || !!this.closest('.reduced-motion');
        this.dataset.motion = reduced || document.hidden ? 'static' : 'running';
        if (reduced) this.draw(5);
        else if (this.isConnected && !document.hidden) this.frame = requestAnimationFrame(this.tick);
      };
      private readonly tick = (now: number): void => {
        if (!this.isConnected) return;
        if (this.stamp) this.elapsed += Math.min((now - this.stamp) / 1000, .1);
        this.stamp = now;
        // Thirty SVG updates per second leave the renderer warmup plenty of CPU time.
        if (now - this.lastDraw >= 1000 / 30) { this.draw(this.elapsed); this.lastDraw = now; }
        this.frame = requestAnimationFrame(this.tick);
      };
      private draw(t: number): void {
        this.dataset.time = t.toFixed(3);
        // Move the entire view, including orbit planes, labels and the surface grid.
        const { yaw, pitch, roll, distance, panX, panY } = cameraPose(t);
        const view = (p: Point3) => rotateView(p, yaw, pitch, roll);
        const world = (p: Point3) => view(rotateView(p, t * .027, 0));
        this.scene.setAttribute('transform', `translate(${fmt(360 + panX)} ${fmt(345 + panY)})`);
        const radius = globeScreenRadius(distance).toFixed(5);
        for (const shell of this.shells) shell.setAttribute('r', radius);
        const horizon = GLOBE_RADIUS ** 2 / distance;
        for (const line of this.gridLines) {
          const points = line.points.map(world);
          line.node.setAttribute('d', projectedPath(points, p => p.z > horizon, distance));
          line.back.setAttribute('d', projectedPath(points, p => p.z <= horizon, distance));
        }
        for (const track of this.tracks) {
          const points = Array.from({ length: 145 }, (_, i) => view(orbitPoint(track.radius, track.tilt, track.bank, i / 144 * TAU)));
          track.back.setAttribute('d', projectedPath(points, p => p.z < 0, distance));
          track.front.setAttribute('d', projectedPath(points, p => p.z >= 0, distance));
          const angle = track.phase + t / track.seconds * TAU;
          const point = view(orbitPoint(track.radius, track.tilt, track.bank, angle));
          const position = project(point, distance);
          const ahead = project(view(orbitPoint(track.radius, track.tilt, track.bank, angle + .005)), distance);
          const heading = Math.atan2(ahead.y - position.y, ahead.x - position.x) * 180 / Math.PI;
          const layer = point.z < 0 ? this.rear : this.front;
          if (track.missile.parentNode !== layer) layer.append(track.missile);
          const scale = track.size * position.scale;
          track.missile.setAttribute('transform', `translate(${fmt(position.x)} ${fmt(position.y)}) rotate(${fmt(heading)}) scale(${fmt(scale)})`);
          track.missile.setAttribute('opacity', depthOpacity(point.z, track.radius).toFixed(4));
          const cycle = (t + track.index * 3.4) % 11;
          const reveal = tagReveal(cycle, 1, 7);
          track.tag.setAttribute('opacity', depthOpacity(point.z, track.radius, .45).toFixed(4));
          track.leader.setAttribute('stroke-dashoffset', ((cycle >= 7 ? -1 : 1) * (1 - reveal.line)).toFixed(4));
          track.label.setAttribute('opacity', fmt(reveal.text));
          track.bracket.setAttribute('opacity', fmt(Math.max(reveal.line, reveal.text)));
          const side = position.x < 0 ? 1 : -1, endX = position.x + side * 45, endY = position.y + (position.y < -120 ? 26 : -26);
          track.bracket.setAttribute('transform', `translate(${fmt(position.x)} ${fmt(position.y)}) scale(${fmt(position.scale)})`);
          track.leader.setAttribute('d', `M${fmt(position.x + side * 13)},${fmt(position.y - 9)}L${fmt(endX)},${fmt(endY)}h${side * 38}`);
          track.label.setAttribute('x', fmt(endX)); track.label.setAttribute('y', fmt(endY - 5));
          track.label.setAttribute('text-anchor', side < 0 ? 'end' : 'start');
          track.label.textContent = `${cycle < 2.4 ? 'ACQUIRE' : cycle > 7 ? 'RELEASE' : track.ammoLabel} / 0${track.index + 1}`;
        }
        const cycle = t % 18, index = Math.floor(t / 18) % 3;
        const acquisition = cameraPose(t - cycle);
        const initialTarget = inverseView(spherePoint([.15, -.24, .06][index], [-.5, -.7, -.3][index]), acquisition.yaw, acquisition.pitch, acquisition.roll);
        const target = rotateView(initialTarget, cycle * .027, 0);
        const normal = view(target), p = project(normal, distance);
        const targetDepthOpacity = depthOpacity(normal.z - horizon, GLOBE_RADIUS);
        const targetOpacity = targetDepthOpacity * clamp(cycle / 1.4) * clamp(18 - cycle);
        this.target.setAttribute('opacity', targetOpacity.toFixed(4));
        // This is a transparent tactical globe: a rear target remains visible through it.
        // Its entire ring lives on the sphere, including the part beyond the horizon.
        const surfaceVisible = () => true;
        this.targetRing.setAttribute('d', projectedPath(surfaceRing(target, .18).map(view), surfaceVisible, distance));
        this.targetSweep.setAttribute('d', projectedPath(surfaceRing(target, .23, t * 1.2, 1.5).map(view), surfaceVisible, distance));
        const wavePhase = ((cycle - 10) % 2 + 2) % 2 / 2;
        this.targetWave.setAttribute('d', projectedPath(surfaceRing(target, .04 + wavePhase * .4).map(view), surfaceVisible, distance));
        this.targetWave.setAttribute('opacity', cycle >= 10 && cycle < 14 ? fmt(1 - wavePhase) : '0');
        this.targetDot.setAttribute('cx', fmt(p.x)); this.targetDot.setAttribute('cy', fmt(p.y));
        const side = p.x > 60 ? -1 : 1, down = p.y > 50 ? -1 : 1;
        const endX = p.x + side * 78, endY = p.y + down * 60;
        this.targetLeader.setAttribute('d', `M${fmt(p.x + side * 20)},${fmt(p.y + down * 15)}L${fmt(endX)},${fmt(endY)}h${side * 95}`);
        const reveal = tagReveal(cycle, .2, 16.2, .8);
        this.targetLeader.setAttribute('stroke-dashoffset', ((cycle >= 16.2 ? -1 : 1) * (1 - reveal.line)).toFixed(4));
        this.targetLeader.setAttribute('opacity', targetDepthOpacity.toFixed(4));
        for (const node of [this.targetLabel, this.targetState]) node.setAttribute('opacity', (targetDepthOpacity * reveal.text).toFixed(4));
        this.targetLabel.setAttribute('text-anchor', side < 0 ? 'end' : 'start');
        this.targetState.setAttribute('text-anchor', side < 0 ? 'end' : 'start');
        this.targetLabel.setAttribute('x', fmt(endX + side * 5)); this.targetLabel.setAttribute('y', fmt(endY - 6));
        this.targetLabel.textContent = cycle < 3 ? 'ACQUIRING ZONE' : cycle < 10 ? 'IMPACT ZONE' : cycle < 14 ? 'IMPACT CONFIRMED' : 'RE-TASKING';
        this.targetState.setAttribute('x', fmt(endX + side * 5)); this.targetState.setAttribute('y', fmt(endY + 11));
        this.targetState.textContent = cycle >= 3 && cycle < 10 ? `SOLUTION LOCKED / T − 0${Math.ceil(10 - cycle)}` : 'SURFACE SCAN / 0' + (index + 1);
      }
    }
    customElements.define('tmt-tactical-art', TacticalArt);
  }
  const art = document.createElement('tmt-tactical-art');
  art.setAttribute('aria-hidden', 'true');
  return art;
}
