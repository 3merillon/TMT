/**
 * CPU mirror of `atmo_integrate` (integrate.wgsl.ts): same clipping to soft-shell entry/exit and scene depth, same
 * uniform jittered segments and segment in-scatter. Optional live air/visibility callbacks represent excavated terrain;
 * absent callbacks use the analytic reference-body umbra used by LUT builders. The LUT lookups are
 * replaced by numerically integrated equivalents (transmittance to the top along the sun, multiscatter optional), so the
 * mirror is exact up to the LUT's resolution. Tests use it to pin the preset metrics of atmo-post §2.3.
 */
import type { Vec3 } from '../../../world/sun';
import { sunsetGrade } from '../../../world/sun';
import { softTopRadius, type AtmospherePreset } from './params';

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);

export function raySphere(ro: readonly number[], rd: readonly number[], radius: number): [number, number] | null {
  const b = dot(ro, rd);
  const qc = [ro[0] - b * rd[0], ro[1] - b * rd[1], ro[2] - b * rd[2]];
  const disc = radius * radius - dot(qc, qc);
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

export function atmoDensity(p: AtmospherePreset, r: number): [number, number] {
  const h = r - p.groundRadius;
  const below = Math.exp(-Math.max(-h, 0) / Math.max(p.rayleighH * 2.5, 0.1));
  const t = Math.max(0, Math.min(1, (r - p.topRadius) / (3 * p.rayleighH)));
  const outer = 1 - t * t * (3 - 2 * t);
  return [Math.exp(-Math.max(h, 0) / p.rayleighH) * below * outer, Math.exp(-Math.max(h, 0) / p.mieH) * below * outer];
}

export function atmoExtinction(p: AtmospherePreset, r: number, aerialDensity = 1): Vec3 {
  const [dR, dM] = atmoDensity(p, r);
  return [0, 1, 2].map(c => (p.rayleighScatter[c] * dR + (p.mieScatter + p.mieAbsorption) * dM) * aerialDensity) as Vec3;
}

/** What the transmittance LUT stores: T from a point at radius r toward cosZenith, to the nominal top (0 if blocked). */
export function lutTransmittance(p: AtmospherePreset, r: number, cosZenith: number, steps = 40): Vec3 {
  const rr = Math.max(r, p.groundRadius + 1e-4);
  const ratio = p.groundRadius / rr;
  const cosH = -Math.sqrt(Math.max(0, 1 - ratio * ratio));
  const blocked = cosZenith < cosH;
  const mc = blocked ? cosH : cosZenith;
  const ro = [0, rr, 0], rd = [Math.sqrt(Math.max(0, 1 - mc * mc)), mc, 0];
  const hit = raySphere(ro, rd, p.topRadius);
  const L = Math.max(hit ? hit[1] : 0, 0);
  const dt = L / steps;
  const tau = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const e = atmoExtinction(p, Math.hypot(rd[0] * t, rr + rd[1] * t));
    for (let c = 0; c < 3; c++) tau[c] += e[c] * dt;
  }
  let occ = 1;
  if (blocked) { const x = Math.min(1, Math.max(0, (cosH - cosZenith) / 0.08)); occ = 1 - x * x * (3 - 2 * x); }
  return tau.map(t => Math.exp(-t) * occ) as Vec3;
}

export function phaseRayleigh(c: number): number { return 3 / (16 * Math.PI) * (1 + c * c); }
export function phaseMie(c: number, g: number): number {
  const g2 = g * g, d = 1 + g2 - 2 * g * c;
  return (1 - g2) / (4 * Math.PI * d * Math.sqrt(Math.max(d, 1e-6)));
}

export interface AtmoSegTs { L: Vec3; T: Vec3 }
export interface IntegrateOptions {
  sun?: Vec3; planetRadius?: number; aerialDensity?: number;
  /** Multiscatter radiance per unit illuminance at (h, cosSun); default 0 (single scattering only). */
  multiscatter?: (h: number, cosSun: number) => Vec3;
  /** Live SDF equivalents for excavated worlds; absent for reference LUTs. */
  terrainVisibility?: (position: Vec3, sun: Vec3) => number;
  air?: (position: Vec3) => number;
}

/** Mirror of atmo_integrate. */
export function atmoIntegrate(p: AtmospherePreset, ro: readonly number[], rd: readonly number[], tMax: number, n: number, xi = 0.5, o: IntegrateOptions = {}): AtmoSegTs {
  const out: AtmoSegTs = { L: [0, 0, 0], T: [1, 1, 1] };
  if (n <= 0) return out;
  const sun = o.sun ?? [0, 1, 0];
  const soft = softTopRadius(p);
  const hit = raySphere(ro, rd, soft);
  if (!hit || hit[1] <= 0) return out;
  const t0 = Math.max(hit[0], 0);
  const t1 = Math.min(hit[1], tMax);
  const dist = t1 - t0;
  if (dist <= 1e-4) return out;
  const cosSv = dot(rd, sun);
  const phR = phaseRayleigh(cosSv), phM = phaseMie(cosSv, p.mieG);
  const tca = Math.max(-dot(ro, rd), 0);
  const ca = len([ro[0] + rd[0] * tca, ro[1] + rd[1] * tca, ro[2] + rd[2] * tca]);
  const x = Math.min(1, Math.max(0, (ca - p.topRadius) / (soft - p.topRadius)));
  const tailFade = 1 - x * x * (3 - 2 * x);
  // Umbra of the solid planet.
  const occ = o.planetRadius ?? 18;
  const uc0 = dot(ro, sun), uc1 = cosSv;
  const qa = Math.max(1 - uc1 * uc1, 0), qb = 2 * (dot(ro, rd) - uc0 * uc1), e2c = dot(ro, ro) - uc0 * uc0;
  let bhLo = -3e38, bhHi = 3e38;
  if (Math.abs(uc1) < 1e-7) { if (uc0 >= 0) { bhLo = 3e38; bhHi = -3e38; } } else if (uc1 > 0) bhHi = -uc0 / uc1; else bhLo = -uc0 / uc1;
  const interval = (radius: number): [number, number] => {
    if (qa < 1e-7) return e2c < radius * radius ? [bhLo, bhHi] : [1, 0];
    const d = qb * qb - 4 * qa * (e2c - radius * radius);
    if (d <= 0) return [1, 0];
    const s = Math.sqrt(d), inv2a = 0.5 / qa;
    return [Math.max((-qb - s) * inv2a, bhLo), Math.min((-qb + s) * inv2a, bhHi)];
  };
  const pen = occ * 0.02;
  const [inLo, inHi] = interval(occ - pen), [outLo, outHi] = interval(occ + pen);
  const seg = dist / n;
  const ad = o.aerialDensity ?? p.aerialDensity;
  for (let i = 0; i < n; i++) {
    const ts = t0 + (i + xi) * seg;
    const pt = [ro[0] + rd[0] * ts, ro[1] + rd[1] * ts, ro[2] + rd[2] * ts];
    const r = len(pt);
    const air = o.air?.(pt as Vec3) ?? 1;
    const [dR, dM] = atmoDensity(p, r).map(d => d * air);
    if (Math.max(dR, dM) * ad < 1e-6) continue;
    const sR = p.rayleighScatter.map(b => b * dR * ad), sM = p.mieScatter * dM * ad;
    const ext = sR.map(v => v + (p.mieScatter + p.mieAbsorption) * dM * ad);
    const segT = ext.map(e => Math.exp(-e * seg));
    const cosS = dot(pt, sun) / Math.max(r, 1e-4);
    const sa = t0 + i * seg, sb = sa + seg;
    const ovIn = Math.max(0, Math.min(sb, inHi) - Math.max(sa, inLo));
    const ovOut = Math.max(0, Math.min(sb, outHi) - Math.max(sa, outLo));
    const lit = o.terrainVisibility?.(pt as Vec3, sun) ?? 1 - Math.min(1, Math.max(0, (ovIn + ovOut) * 0.5 / seg));
    if (lit <= 0) { for (let c = 0; c < 3; c++) out.T[c] *= segT[c]; continue; }
    const grade = sunsetGrade(cosS, p.sunset);
    const solid = raySphere(pt, sun, occ);
    const tSun = o.terrainVisibility && (r < occ || (solid && solid[1] > 0))
      ? referenceTransmittance(p, pt, sun, 1e9, 12) : lutTransmittance(p, r, cosS);
    const ms = o.multiscatter?.(r - p.groundRadius, cosS) ?? [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const scatter = sR[c] * phR + sM * phM * tailFade;
      const integrand = (tSun[c] * grade[c] * lit * scatter + (sR[c] + sM) * ms[c] * grade[c] * lit) * p.sunIlluminance;
      out.L[c] += out.T[c] * integrand * (1 - segT[c]) / Math.max(ext[c], 1e-8);
      out.T[c] *= segT[c];
    }
  }
  return out;
}

/** Reference optical depth with many steps (the atmo-presets.mjs integrator), for comparisons. */
export function referenceTransmittance(p: AtmospherePreset, ro: readonly number[], rd: readonly number[], tMax: number, steps = 4000): Vec3 {
  const hit = raySphere(ro, rd, softTopRadius(p));
  if (!hit) return [1, 1, 1];
  const s0 = Math.max(0, hit[0]), s1 = Math.min(tMax, hit[1]);
  if (s1 <= s0) return [1, 1, 1];
  const dt = (s1 - s0) / steps;
  const tau = [0, 0, 0];
  for (let i = 0; i < steps; i++) {
    const t = s0 + (i + 0.5) * dt;
    const e = atmoExtinction(p, len([ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t]));
    for (let c = 0; c < 3; c++) tau[c] += e[c] * dt;
  }
  return tau.map(t => Math.exp(-t)) as Vec3;
}
