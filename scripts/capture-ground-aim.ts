/** Real pointer/keyboard qualification for ground and visible-object aiming in normal drive mode.
 * Run with node node_modules/tsx/dist/cli.mjs scripts/capture-ground-aim.ts.
 * Records uninterrupted video plus sparse screenshots and read-only telemetry. Uses the shared GPU lock.
 * TMT_GROUND_AIM_OUT changes the output directory; TMT_CHROME overrides the hardware Chromium executable. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { acquireGpuLock } from './capture';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, process.env.TMT_GROUND_AIM_OUT ?? 'artifacts/ground-aim');
const report: any = { date: new Date().toISOString(), browser: '', hardware: null, checks: [], errors: [], frames: [], video: null };
const save = () => writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
const deltaAngle = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, i) => value - b[i]));
type Pick = { x: number; y: number; point: number[]; range: number; bearing: number };

async function instrument(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const w = window as any;
    const { session } = await import('/src/game/api/session.ts' as string);
    const { registerHooks } = await import('/src/game/app/hooks.ts' as string);
    w.gaSession = session(); w.gaCapture = { phase: 'ready', frames: [], events: [], pointer: null, fireInputs: [] };
    const canvas = document.querySelector('#viewport canvas')!;
    window.addEventListener('pointermove', event => {
      const rect = canvas.getBoundingClientRect();
      w.gaCapture.pointer = [event.clientX - rect.left, event.clientY - rect.top];
    }, true);
    const aimPose = () => {
      const tank = w.gaSession.snapshot.tanks[0];
      return { yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power };
    };
    window.addEventListener('keydown', event => {
      if (event.code === 'Space') w.gaCapture.fireInputs.push({ at: performance.now(), phase: w.gaCapture.phase, before: aimPose() });
    }, true);
    window.addEventListener('keydown', event => {
      if (event.code === 'Space') Object.assign(w.gaCapture.fireInputs.at(-1), { after: aimPose(), goal: w.__tmtGame.aiming?.result?.aim });
    });
    registerHooks('ground-aim-qualification', {
      onEvent(event: any) {
        if (['shot', 'impact', 'terrain-commit'].includes(event.type)) w.gaCapture.events.push({ at: performance.now(), event: structuredClone(event),
          terrainVersion: w.__tmtGame.terrainVersion, aiming: structuredClone(w.__tmtGame.aiming) });
      },
      onFrame(frame: any) {
        if (w.gaCapture.frames.length >= 12000) return;
        const tank = frame.snapshot.tanks[0], performanceState = w.__tmtGame.performance;
        w.gaCapture.frames.push({ at: performance.now(), phase: w.gaCapture.phase, tick: frame.snapshot.tick, dt: frame.realDt, terrainVersion: w.__tmtGame.terrainVersion,
          surfaceVersion: w.gaSession.world?.footprintSurface?.version ?? w.gaSession.world?.version,
          position: [...tank.position], yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power, pointer: w.gaCapture.pointer,
          trajectory: performanceState.trajectory, readout: performanceState.trajectoryReadout, aiming: w.__tmtGame.aiming, target: performanceState.aimTarget,
          aimPick: w.__tmtVisibility.aimPickStats(),
          validationErrors: performanceState.validationErrors, compileErrors: performanceState.compileErrors });
      },
    });
  });
}

async function state(page: Page) {
  return page.evaluate(() => {
    const w = window as any, tank = w.gaSession.snapshot.tanks[0];
    return { at: performance.now(), tick: w.gaSession.snapshot.tick, terrainVersion: w.__tmtGame.terrainVersion,
      surfaceVersion: w.gaSession.world?.footprintSurface?.version ?? w.gaSession.world?.version, yaw: tank.turretYaw, pitch: tank.barrelPitch, power: tank.power,
      position: [...tank.position], rotation: [...tank.rotation], camera: structuredClone(w.__tmtGame.camera),
      trajectory: structuredClone(w.__tmtGame.performance.trajectory), readout: structuredClone(w.__tmtGame.performance.trajectoryReadout),
      prediction: w.gaSession.previewPrediction(0, true, w.__tmtGame.aiming.rangeScale === 1 ? w.__tmtGame.aiming.selection?.object?.collider : undefined), aiming: structuredClone(w.__tmtGame.aiming),
      target: structuredClone(w.__tmtGame.performance.aimTarget), shots: w.gaCapture.events.filter((event: any) => event.event.type === 'shot').length };
  });
}

/** Only read-only geometry chooses cases. Real input below remains responsible for every aim command. */
async function candidates(page: Page, kind: 'front' | 'back' | 'near' | 'far' | 'sky'): Promise<Pick[]> {
  return page.evaluate(async kind => {
    const w = window as any, canvas = document.querySelector('#viewport canvas')!, rect = canvas.getBoundingClientRect();
    const { rotate } = await import('/src/game/math.ts' as string);
    const tank = w.gaSession.snapshot.tanks[0], forward = rotate([0, 0, 1], tank.rotation), left = rotate([1, 0, 0], tank.rotation);
    const picker = w.__tmtVisibility.pickAimSelection;
    if (typeof picker !== 'function') throw new Error('Read-only __tmtVisibility.pickAimSelection probe is unavailable');
    const found = [];
    for (let y = 120; y < rect.height - 24; y += 36) for (let x = 300; x < rect.width - 300; x += 36) {
      if (document.elementFromPoint(rect.left + x, rect.top + y) !== canvas) continue;
      const selection = picker([x, y]), point = selection?.point;
      if (!point) { if (kind === 'sky') found.push({ x: x + rect.left, y: y + rect.top, point: [], range: 0, bearing: 0 }); continue; }
      if (selection.object) continue;
      if (kind === 'sky') continue;
      const delta = point.map((value: number, i: number) => value - tank.position[i]);
      const along = delta.reduce((sum: number, value: number, i: number) => sum + value * forward[i], 0);
      const across = delta.reduce((sum: number, value: number, i: number) => sum + value * left[i], 0);
      const length = Math.hypot(...delta), bearing = Math.atan2(across, along);
      if (length < 2.8 || (kind !== 'far' && length > 6.5)) continue;
      if (kind === 'front' && along / length < .65) continue;
      if (kind === 'back' && along / length > -.65) continue;
      found.push({ x: x + rect.left, y: y + rect.top, point, range: length, bearing });
    }
    return found.sort((a, b) => kind === 'far' ? b.range - a.range : Math.abs(a.range - 4.5) - Math.abs(b.range - 4.5));
  }, kind);
}

async function solved(page: Page) {
  await page.waitForFunction(() => {
    const w = window as any, aiming = w.__tmtGame.aiming, result = aiming?.result;
    // A fresh click can briefly coexist with the previous solution before the next input frame.
    const selection = aiming?.pointer ? w.__tmtVisibility.pickAimSelection(aiming.pointer) : aiming?.selection;
    return result && result.status !== 'invalid' && selection
      && Math.hypot(...result.target.map((value: number, i: number) => value - selection.point[i])) < .015;
  }, undefined, { timeout: 15000 });
  await page.waitForFunction(() => {
    const w = window as any, result = w.__tmtGame.aiming?.result, tank = w.gaSession.snapshot.tanks[0];
    if (!result || result.status !== 'ready' || !result.aim) return !!result;
    const yaw = Math.atan2(Math.sin(result.aim.yaw - tank.turretYaw), Math.cos(result.aim.yaw - tank.turretYaw));
    return Math.abs(yaw) < .006 && Math.abs(result.aim.pitch - tank.barrelPitch) < .006 && Math.abs(result.aim.power - tank.power) < .003;
  }, undefined, { timeout: 7000 });
  await page.waitForTimeout(100);
  return state(page);
}

async function aimAt(page: Page, pick: Pick, label: string, releaseImmediately = false) {
  await phase(page, label);
  await page.mouse.move(pick.x, pick.y); await page.mouse.down({ button: 'left' });
  if (releaseImmediately) await page.mouse.up({ button: 'left' });
  const after = await solved(page);
  assert.equal(after.aiming.result.status, 'ready', `${label} reaches the requested terrain point`);
  assert.ok(distance(after.aiming.result.target, pick.point) < .15, `${label} uses the terrain point under the real pointer`);
  assert.ok(after.prediction.hit && distance(after.prediction.points.at(-1), after.aiming.result.target) < .4, `${label} authoritative prediction lands at the requested target`);
  assert.ok(after.target.visible || after.readout.visible && after.readout.targetVisible, `${label} displays the requested or actual landing marker`);
  if (releaseImmediately) assert.ok(!after.aiming.active && after.aiming.tracking, `${label} finishes turning after a short released click`);
  report.checks.push({ label, pick, after }); await screenshot(page, label);
  return after;
}

async function phase(page: Page, label: string): Promise<void> {
  console.log(`Ground aim: ${label}`);
  await page.evaluate(label => { (window as any).gaCapture.phase = label; }, label);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: resolve(out, `${name}.png`), timeout: 15000 });
}

async function objectPixels(page: Page) {
  return page.evaluate(() => {
    const w = window as any, canvas = document.querySelector('#viewport canvas')!, rect = canvas.getBoundingClientRect();
    const targets = w.__tmtVisibility.aimTargets().filter((target: any) => target.screen);
    for (const target of targets) {
      let best: any[] = [];
      for (let dy = -24; dy <= 24; dy += 2) {
        const row = [];
        for (let dx = -40; dx <= 40; dx += 2) {
          const x = target.screen[0] + dx, y = target.screen[1] + dy;
          if (document.elementFromPoint(x + rect.left, y + rect.top) !== canvas) continue;
          const selection = w.__tmtVisibility.pickAimSelection([x, y]);
          if (selection?.object?.id === target.id) row.push({ x: x + rect.left, y: y + rect.top, selection });
        }
        if (row.length > best.length) best = row;
      }
      if (best.length >= 5) return { target, pixels: best };
    }
    return null;
  });
}

async function qualifyObject(page: Page): Promise<void> {
  const object = await objectPixels(page);
  assert.ok(object, 'a currently visible tank exposes a rendered surface wide enough for precise pointer checks');
  const center = object.pixels[Math.floor(object.pixels.length / 2)];
  await phase(page, 'visible-tank-click-release');
  const before = await state(page);
  await page.mouse.click(center.x, center.y);
  const after = await solved(page);
  assert.ok(!after.aiming.active && after.aiming.tracking, 'a short released click retains its target until the barrel arrives');
  assert.equal(after.aiming.selection.object?.id, object.target.id, 'click chooses the visible tank instead of ground behind it');
  assert.ok(after.aiming.result.status === 'ready' && after.aiming.result.hitTarget, 'the selected visible tank has a real interception solution');
  assert.ok(after.prediction.hitTarget, 'the actual barrel preview ends on the selected tank');
  assert.equal(after.shots, before.shots, 'left target click never fires');
  report.checks.push({ label: 'visible-tank-click-release', object: object.target, pointer: center, before, after });
  await screenshot(page, 'visible-tank-click-release');

  await phase(page, 'tank-precision-sweep');
  // Consecutive two-pixel samples stay on the same rendered object, exposing center-snapping dead zones.
  const middle = Math.floor(object.pixels.length / 2), sweep = object.pixels.slice(Math.max(0, middle - 3), middle + 4);
  const samples: { pixel: any; sample: Awaited<ReturnType<typeof state>> }[] = [];
  await page.mouse.move(sweep[0].x, sweep[0].y); await page.mouse.down({ button: 'left' });
  for (const pixel of sweep) {
    await page.mouse.move(pixel.x, pixel.y); await page.waitForTimeout(180);
    const sample = await state(page);
    assert.equal(sample.aiming.selection.object?.id, object.target.id, 'small pointer movement stays on the selected tank');
    assert.ok(sample.target.x !== null && Math.hypot(sample.target.x - pixel.x, sample.target.y - pixel.y) < 2,
      'requested tank marker stays at the hovered surface pixel');
    samples.push({ pixel, sample });
  }
  const changes = samples.slice(1).map((sample, i) => {
    const a = samples[i].sample.aiming.result.aim, b = sample.sample.aiming.result.aim;
    return Math.abs(deltaAngle(a.yaw, b.yaw)) + Math.abs(a.pitch - b.pitch) + Math.abs(a.power - b.power);
  });
  assert.ok(changes.every(change => change > 1e-5), 'every small same-tank movement changes the ballistic goal without a center dead zone');
  const settled = await solved(page); await page.mouse.up({ button: 'left' });
  assert.ok(settled.prediction.hitTarget, 'fine aiming still predicts a selected-object impact');
  report.checks.push({ label: 'tank-precision-sweep', samples, goalChanges: changes });
  await screenshot(page, 'tank-precision-sweep');

  // Return to the middle of the visible target and use only the normal Space shortcut.
  await page.mouse.click(center.x, center.y); await solved(page);
  await phase(page, 'space-visible-tank');
  const beforeShot = await state(page);
  const eventCount = await page.evaluate(() => (window as any).gaCapture.events.length);
  await page.keyboard.press('Space');
  await page.waitForFunction(start => (window as any).gaCapture.events.slice(start).some((entry: any) => entry.event.type === 'impact'), eventCount, { timeout: 30000 });
  const impact = await page.evaluate(start => (window as any).gaCapture.events.slice(start).find((entry: any) => entry.event.type === 'impact'), eventCount);
  const targetId = Number(object.target.id.split(':')[1]);
  assert.ok(impact.event.hits?.some((hit: any) => hit.tank === targetId && hit.direct), 'the actual Space-fired projectile directly hits the clicked visible tank');
  const impactError = distance(impact.event.position, beforeShot.prediction.points.at(-1));
  assert.ok(impactError < .15, 'the actual object impact agrees with the selected-object preview');
  report.checks.push({ label: 'space-visible-tank', before: beforeShot, impact, error: impactError });
  await page.waitForTimeout(500); await screenshot(page, 'space-visible-tank');
}

async function qualify(page: Page): Promise<void> {
  await page.goto(`${base}play.html?mode=drive&seed=7&dev&engineDev`, { timeout: 120000 });
  await page.waitForFunction(() => (window as any).__tmtGame?.ready && (window as any).__tmtGame.performance?.trajectoryReadout, undefined, { timeout: 120000 });
  await page.waitForTimeout(1800);
  await instrument(page);
  report.hardware = await page.evaluate(async () => {
    const adapter = await (navigator as any).gpu.requestAdapter();
    return { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, fallback: adapter?.info.isFallbackAdapter };
  });
  assert.ok(report.hardware.vendor && report.hardware.fallback === false, 'qualification uses a real hardware WebGPU adapter');
  await page.addStyleTag({ content: '.dev-panel { visibility:hidden !important }' });
  await page.locator('#viewport').focus();
  await screenshot(page, 'initial');
  const before = await state(page);
  assert.ok(before.prediction.hit && before.readout.visible, 'normal drive starts with a complete visible landing prediction');
  report.initial = before;
  await qualifyObject(page);
  const front = (await candidates(page, 'front'))[0], back = (await candidates(page, 'back'))[0];
  assert.ok(front && back, 'normal follow camera exposes terrain both in front of and behind the tank');
  const frontAim = await aimAt(page, front, 'front-target'); await page.mouse.up({ button: 'left' });
  const backAim = await aimAt(page, back, 'back-target', true);
  assert.ok(Math.abs(deltaAngle(backAim.yaw, frontAim.yaw)) > 1.6, 'moving the requested target behind the tank reverses its bearing naturally');
  assert.ok(distance(backAim.camera.position, frontAim.camera.position) < .15, 'left-button aim does not orbit the camera');
  const trimmedBase = await aimAt(page, front, 'range-base');
  await page.mouse.wheel(0, -120); await page.waitForTimeout(400);
  const longer = await state(page);
  assert.ok(longer.aiming.rangeScale > trimmedBase.aiming.rangeScale, 'held wheel lengthens the requested target range');
  assert.equal(longer.camera.requestedDistance, trimmedBase.camera.requestedDistance, 'held range wheel never zooms');
  assert.ok(distance(longer.aiming.result.target, trimmedBase.aiming.result.target) > .05, 'range trim moves the requested world target');
  await page.mouse.wheel(0, 120); await page.waitForTimeout(400);
  const restored = await state(page);
  assert.ok(Math.abs(restored.aiming.rangeScale - trimmedBase.aiming.rangeScale) < 1e-6, 'opposite wheel gesture restores target range');
  report.checks.push({ label: 'held-wheel-range', before: trimmedBase, longer, restored }); await screenshot(page, 'held-wheel-range');

  const sky = (await candidates(page, 'sky'))[0]; assert.ok(sky, 'a visible sky pixel exists');
  await phase(page, 'sky-keeps-aim');
  const beforeSky = await state(page);
  // A single pointer transition isolates the sky miss. Intermediate ground pixels intentionally retarget.
  await page.mouse.move(sky.x, sky.y); await page.waitForTimeout(400);
  const afterSky = await state(page);
  assert.ok(Math.abs(deltaAngle(afterSky.yaw, beforeSky.yaw)) < .02 && Math.abs(afterSky.pitch - beforeSky.pitch) < .02 && Math.abs(afterSky.power - beforeSky.power) < .01,
    'dragging into sky keeps the last valid aim');
  report.checks.push({ label: 'sky-keeps-aim', sky, before: beforeSky, after: afterSky }); await screenshot(page, 'sky-keeps-aim');
  await page.mouse.up({ button: 'left' });
  await page.mouse.wheel(0, 120); await page.waitForTimeout(300);
  const zoom = await state(page);
  assert.ok(zoom.camera.requestedDistance > afterSky.camera.requestedDistance, 'released wheel zooms');
  assert.ok(Math.abs(zoom.power - afterSky.power) < .001, 'released zoom preserves selected power');
  report.checks.push({ label: 'released-wheel-zoom', before: afterSky, after: zoom });

  await phase(page, 'right-drag-camera');
  const beforeOrbit = await state(page);
  await page.mouse.move(700, 390); await page.mouse.down({ button: 'right' });
  await page.mouse.move(800, 415, { steps: 12 }); await page.mouse.up({ button: 'right' }); await page.waitForTimeout(350);
  const orbit = await state(page);
  assert.ok(distance(orbit.camera.position, beforeOrbit.camera.position) > .5, 'right drag orbits the camera');
  assert.equal(orbit.shots, beforeOrbit.shots, 'camera orbit never fires');
  report.checks.push({ label: 'right-drag-camera', before: beforeOrbit, after: orbit });

  const movingPick = (await candidates(page, 'front'))[0]; assert.ok(movingPick, 'a front target remains visible after orbit');
  await aimAt(page, movingPick, 'moving-target-start');
  await phase(page, 'aim-while-driving');
  const driveBefore = await state(page);
  await page.keyboard.down('KeyW'); await page.keyboard.down('KeyD');
  for (let i = 0; i < 12; i++) { await page.mouse.move(movingPick.x + i * 2, movingPick.y, { steps: 2 }); await page.waitForTimeout(100); }
  await page.keyboard.up('KeyD'); await page.keyboard.up('KeyW'); await page.waitForTimeout(450);
  const driven = await state(page);
  assert.ok(distance(driven.position, driveBefore.position) > .5, 'WASD drives while left-button aim remains active');
  assert.ok(driven.aiming.active && driven.aiming.result && driven.trajectory.muzzleError < 1e-5, 'aiming and muzzle-anchored preview continue while moving');
  report.checks.push({ label: 'aim-while-driving', before: driveBefore, after: driven }); await screenshot(page, 'aim-while-driving');
  await page.mouse.up({ button: 'left' });

  await phase(page, 'unreachable-feedback');
  const shotsBeforeUi = (await state(page)).shots;
  await page.locator('#fine-aim-toggle').click();
  await page.locator('[data-munition="nuclear"]').click();
  await page.locator('#fine-aim-toggle').click();
  assert.equal((await state(page)).shots, shotsBeforeUi, 'left-clicking ammunition UI never fires');
  const far = (await candidates(page, 'far')).slice(0, 5); assert.ok(far.length, 'distant visible terrain targets exist');
  let failedTarget: Awaited<ReturnType<typeof state>> | undefined;
  for (const pick of far) {
    await page.mouse.move(pick.x, pick.y); await page.mouse.down({ button: 'left' });
    const result = await solved(page);
    if (result.aiming.result.status === 'unreachable' || result.aiming.result.status === 'blocked') { failedTarget = result; break; }
    await page.mouse.up({ button: 'left' });
  }
  assert.ok(failedTarget && failedTarget.target.labelVisible && ['blocked', 'out-of-range'].includes(failedTarget.target.status), 'unreachable or blocked terrain visibly reports why it cannot be hit');
  report.checks.push({ label: 'unreachable-feedback', after: failedTarget }); await screenshot(page, 'unreachable-feedback');
  await page.mouse.up({ button: 'left' });
  await page.locator('#fine-aim-toggle').click();
  await page.locator('[data-munition="explosive"]').click();
  await page.locator('#fine-aim-toggle').click();

  await phase(page, 'pause-no-fire');
  await page.keyboard.press('Escape'); const paused = await state(page);
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  assert.equal((await state(page)).shots, paused.shots, 'Space while paused never fires');
  // Native Space can activate the focused Resume button; resume only if the modal remains open.
  if (await page.getByRole('button', { name: 'Resume', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.waitForFunction(() => (window as any).__tmtGame.ui.screen === 'match');

  const firePick = (await candidates(page, 'near'))[0]; assert.ok(firePick, 'visible nearby target exists before firing');
  await aimAt(page, firePick, 'space-fire-target'); await page.mouse.up({ button: 'left' });
  await phase(page, 'space-fire');
  const beforeClick = await state(page);
  await page.mouse.click(firePick.x, firePick.y); await page.waitForTimeout(150);
  assert.equal((await state(page)).shots, beforeClick.shots, 'left click on the canvas does not fire');
  // Keep the cursor stationary through recoil and the terrain commit, then test release below.
  await page.mouse.down({ button: 'left' });
  const beforeFire = await solved(page);
  const eventCount = await page.evaluate(() => (window as any).gaCapture.events.length);
  await page.keyboard.press('Space'); await page.waitForTimeout(350);
  const fired = await state(page);
  assert.equal(fired.shots, beforeFire.shots + 1, 'Space fires exactly once');
  report.checks.push({ label: 'space-fire', before: beforeFire, after: fired }); await screenshot(page, 'space-fire');
  await page.waitForFunction(start => (window as any).gaCapture.events.slice(start).some((entry: any) => entry.event.type === 'impact'), eventCount, { timeout: 30000 });
  const impact = await page.evaluate(start => (window as any).gaCapture.events.slice(start).find((entry: any) => entry.event.type === 'impact'), eventCount);
  const expectedImpact = beforeFire.prediction.points.at(-1), impactError = distance(impact.event.position, expectedImpact);
  assert.ok(impactError < .4, 'the real Space-fired projectile hits the predicted terrain point before crater deformation');
  report.checks.push({ label: 'actual-projectile-impact', impact, expectedImpact, error: impactError });
  await page.waitForTimeout(350); await screenshot(page, 'actual-impact');

  await page.waitForFunction(version => {
    const session = (window as any).gaSession;
    return (session.world?.footprintSurface?.version ?? session.world?.version) > version;
  }, beforeFire.surfaceVersion, { timeout: 30000 });
  await phase(page, 'post-crater-held'); await page.waitForTimeout(2500);
  const heldCrater = await state(page);
  assert.ok(heldCrater.aiming.active && heldCrater.aiming.selection?.terrain, 'a stationary held pointer retains its ground anchor after crater commit');
  const acceptedShot = await page.evaluate(start => (window as any).gaCapture.events.slice(start).find((entry: any) => entry.event.type === 'shot'), eventCount);
  // The fire flush may repick during sub-pixel camera settling; its accepted anchor is the precise contract.
  const anchor = acceptedShot.aiming.selection.terrain;
  assert.ok(anchor, 'the fired-at ground target has a committed terrain anchor');
  const fixedSurface = await page.evaluate(direction => {
    const session = (window as any).gaSession, fixed = session.world.footprintSurface ?? session.world;
    return fixed.surface(direction)?.point ?? null;
  }, anchor.direction);
  assert.ok(fixedSurface && distance(heldCrater.aiming.selection.point, fixedSurface) < 1e-5, 'the crater target resurfaces at its original planet bearing');
  assert.equal(heldCrater.aiming.selection.terrain.version, heldCrater.surfaceVersion, 'the retained anchor records the committed surface revision');
  assert.ok(distance(heldCrater.aiming.selection.point, acceptedShot.aiming.selection.point) > .02, 'the test actually changed the selected terrain surface');
  await screenshot(page, 'post-crater-held');
  await page.mouse.up({ button: 'left' });
  await phase(page, 'post-crater-released'); await page.waitForTimeout(1500);
  const releasedCrater = await state(page);
  assert.ok(!releasedCrater.aiming.active && releasedCrater.aiming.tracking, 'released aim keeps the resurfaced crater target');
  assert.ok(distance(releasedCrater.aiming.selection.point, heldCrater.aiming.selection.point) < 1e-6, 'release does not move the crater anchor');
  const craterFrames = await page.evaluate(() => (window as any).gaCapture.frames.filter((frame: any) => frame.phase.startsWith('post-crater-')));
  const finalFrames = craterFrames.filter((frame: any) => frame.at > releasedCrater.at - 1000);
  const targetMotion = Math.max(...finalFrames.map((frame: any) => distance(frame.aiming.selection.point, releasedCrater.aiming.selection.point)));
  const goals = finalFrames.map((frame: any) => frame.aiming.result?.aim).filter(Boolean);
  const goalMotion = Math.max(...goals.map((aim: any) => Math.abs(deltaAngle(aim.yaw, goals.at(-1).yaw))
    + Math.abs(aim.pitch - goals.at(-1).pitch) + Math.abs(aim.power - goals.at(-1).power)));
  assert.ok(finalFrames.length > 20 && targetMotion < 1e-6 && goalMotion < .01, 'the retained post-crater target and solved goal stay stable at rest');
  const byRevision = new Map<number, number[][]>();
  const anchorFrames = await page.evaluate(start => {
    const capture = (window as any).gaCapture, shot = capture.events.slice(start).find((entry: any) => entry.event.type === 'shot');
    return capture.frames.filter((frame: any) => frame.at >= shot.at);
  }, eventCount);
  assert.ok(anchorFrames.every((frame: any) => frame.trajectory?.points > 1 && frame.readout?.visible),
    'the complete next-shot preview stays visible throughout free-drive flight, crater commit and settling');
  for (const frame of anchorFrames) {
    const selection = frame.aiming?.selection;
    if (!selection?.terrain) continue;
    const points = byRevision.get(selection.terrain.version) ?? [];
    if (!points.some(point => distance(point, selection.point) < 1e-6)) points.push(selection.point);
    byRevision.set(selection.terrain.version, points);
  }
  assert.ok([...byRevision.values()].every(points => points.length === 1), 'each committed terrain revision keeps one retained world anchor');
  report.checks.push({ label: 'post-crater-stability', before: beforeFire, acceptedShot, held: heldCrater, released: releasedCrater,
    fixedSurface, targetMotion, goalMotion, frameCount: finalFrames.length, distinctAnchorsByRevision: [...byRevision].map(([version, points]) => ({ version, count: points.length })) });
  await screenshot(page, 'post-crater-released');

  await phase(page, 'space-during-turn');
  const reverse = (await candidates(page, 'back'))[0] ?? (await candidates(page, 'front'))[0];
  assert.ok(reverse, 'a reverse target exists for the firing-while-turning check');
  await page.mouse.click(reverse.x, reverse.y);
  await page.keyboard.press('Space'); await page.waitForTimeout(200);
  const spaceInput = await page.evaluate(() => (window as any).gaCapture.fireInputs.at(-1));
  assert.ok(spaceInput.after && spaceInput.goal, 'the real Space event exposes before/after barrel state and the solved goal');
  assert.deepEqual(spaceInput.after, spaceInput.before, 'Space preserves the exact current barrel pose while flushing its next target solution');
  const remaining = Math.abs(deltaAngle(spaceInput.goal.yaw, spaceInput.after.yaw)) + Math.abs(spaceInput.goal.pitch - spaceInput.after.pitch);
  assert.ok(remaining > .15, 'the no-snap check actually fires before the barrel reaches its new goal');
  report.checks.push({ label: 'space-during-turn', input: spaceInput, remainingRadians: remaining });
  await screenshot(page, 'space-during-turn');

  const frames = await page.evaluate(() => (window as any).gaCapture.frames);
  const turn = frames.filter((frame: any) => frame.phase === 'back-target');
  const steps = turn.slice(1).map((frame: any, i: number) => ({
    // Input and render hooks are separate rAF callbacks; the adjacent rAF interval covers either ordering.
    dt: Math.max(frame.dt, turn[i].dt), wallDt: (frame.at - turn[i].at) / 1000, yaw: Math.abs(deltaAngle(frame.yaw, turn[i].yaw)),
    pitch: Math.abs(frame.pitch - turn[i].pitch), power: Math.abs(frame.power - turn[i].power),
  }));
  assert.ok(steps.filter((step: any) => step.yaw > .001).length >= 5, 'the released back-target click turns across multiple rendered frames');
  assert.ok(steps.every((step: any) => step.yaw <= 6 * Math.min(.05, step.dt) + .025
    && step.pitch <= 4 * Math.min(.05, step.dt) + .025 && step.power <= 3 * Math.min(.05, step.dt) + .02),
    'actual per-frame turret, barrel and power changes stay within the smoothing speed caps');
  const pointerErrors = frames.filter((frame: any) => frame.phase === 'tank-precision-sweep' && frame.aiming?.active && frame.pointer && frame.target?.x !== null)
    .map((frame: any) => Math.hypot(frame.target.x - frame.pointer[0], frame.target.y - frame.pointer[1]));
  const rms = Math.sqrt(pointerErrors.reduce((sum: number, value: number) => sum + value ** 2, 0) / pointerErrors.length);
  assert.ok(pointerErrors.length > 20 && rms < 3, 'the visible tank requested marker follows the cursor every frame with under three pixel RMS error');
  report.checks.push({ label: 'smooth-frame-response', frames: turn.length, movingFrames: steps.filter((step: any) => step.yaw > .001).length,
    maxYawStep: Math.max(...steps.map((step: any) => step.yaw)), pointerSamples: pointerErrors.length, pointerRmsPixels: rms });
}

mkdirSync(out, { recursive: true });
let browser: Browser | undefined, server: ViteDevServer | undefined, context: BrowserContext | undefined;
let release: (() => void) | undefined, base = '';
const totalTimeoutMs = 300000;
let timer: ReturnType<typeof setTimeout> | undefined;
let timedOut = false;
try {
  release = await acquireGpuLock(undefined, 30000);
  server = await createServer({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn',
    cacheDir: resolve(root, '.vite-capture'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, open: false } });
  await server.listen(); base = server.resolvedUrls!.local[0];
  browser = await chromium.launch({ executablePath: process.env.TMT_CHROME ?? 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    headless: true, timeout: 30000, args: ['--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu',
      '--enable-webgpu-developer-features', '--force-color-profile=srgb', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ignoreDefaultArgs: ['--headless'] });
  report.browser = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: resolve(out, 'video'), size: { width: 1440, height: 900 } } });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.addInitScript('globalThis.__name = (fn, name) => fn;');
  page.on('pageerror', error => report.errors.push({ type: 'pageerror', text: error.message }));
  page.on('console', event => { if (event.type() === 'error') report.errors.push({ type: 'console', text: event.text() }); });
  await Promise.race([qualify(page), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error(`Ground-aim qualification exceeded ${totalTimeoutMs / 1000}s`)); }, totalTimeoutMs);
  })]);
  if (timer) clearTimeout(timer);
  const capture = await page.evaluate(() => (window as any).gaCapture);
  report.frames = capture.frames; report.events = capture.events; report.video = await page.video()?.path();
  assert.ok(report.frames.every((frame: any) => !frame.validationErrors && !frame.compileErrors), 'all sampled frames have clean GPU pipelines');
  assert.equal(report.errors.length, 0, 'no browser console or page errors');
  report.passed = true;
} catch (error) {
  report.passed = false; report.errors.push({ type: 'harness', text: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  if (context) {
    const page = context.pages()[0];
    if (page && !page.isClosed() && !timedOut) {
      report.video ??= await page.video()?.path();
      try { const capture = await page.evaluate(() => (window as any).gaCapture); report.frames = capture?.frames ?? report.frames; report.events = capture?.events ?? report.events; } catch { /* A timeout can close the page. */ }
      if (!report.passed) { try { await page.screenshot({ path: resolve(out, 'failure.png'), timeout: 3000 }); } catch { /* Preserve the report even if the renderer stopped. */ } }
    }
    await context.close();
  }
  await browser?.close(); await server?.close(); release?.();
  const solves = new Map<number, any>();
  for (const frame of report.frames) if (frame.aiming?.calls > 0) solves.set(frame.aiming.calls, frame.aiming);
  const costs = [...solves.values()].map(aiming => aiming.solveMs).filter(Number.isFinite).sort((a, b) => a - b);
  report.solverCost = { observedCalls: costs.length, totalCalls: Math.max(0, ...solves.keys()),
    p50Ms: costs[Math.floor(costs.length * .5)] ?? 0, p95Ms: costs[Math.floor(costs.length * .95)] ?? 0, maxMs: costs.at(-1) ?? 0,
    maxTraces: Math.max(0, ...[...solves.values()].map(aiming => aiming.result?.traces ?? 0)),
    maxSteps: Math.max(0, ...[...solves.values()].map(aiming => aiming.result?.steps ?? 0)),
    note: 'One observation per distinct solver call; cached frame repeats excluded. Video capture is active.' };
  const picks = report.frames.filter((frame: any) => frame.phase === 'tank-precision-sweep' && frame.aiming?.active && frame.aimPick);
  const pickCosts = picks.map((frame: any) => frame.aimPick.milliseconds).filter(Number.isFinite).sort((a: number, b: number) => a - b);
  report.pickerCost = { samples: pickCosts.length, p50Ms: pickCosts[Math.floor(pickCosts.length * .5)] ?? 0,
    p95Ms: pickCosts[Math.floor(pickCosts.length * .95)] ?? 0, maxMs: pickCosts.at(-1) ?? 0,
    maxParts: Math.max(0, ...picks.map((frame: any) => frame.aimPick.parts)), maxTriangles: Math.max(0, ...picks.map((frame: any) => frame.aimPick.triangles)),
    note: 'Per-rendered-frame exact mesh picks during the held-pointer tank sweep; video capture is active.' };
  save();
  console.log(JSON.stringify({ out, passed: report.passed, checks: report.checks.length, errors: report.errors, video: report.video }, null, 2));
}
