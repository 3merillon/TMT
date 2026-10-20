import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeRoomMesh, type RoomManifest } from '../src/game/workshop/room';
import { decodeQuantizedRoomMesh } from '../src/game/workshop/mesh-codec';
import type { InstanceInit, MeshDesc, SceneRegistry, Vec3 } from '../src/engine';
import { KIT_PART_IDS, KIT_SLOTS, legalKitLoadouts, type KitLoadoutIdsLike, type SlotId } from '../src/game/kit';
import { WorkshopMechanics, serviceMotion, NEW_RACK, TROLLEY_PAD_COMPRESSION } from '../src/game/workshop/mechanics';
import { ACTUATOR_BARREL_END, ACTUATOR_ROD_LENGTH, actuatorMounts, ROBOT_FORE, ROBOT_UPPER, solveRobot, WorkshopRobot } from '../src/game/workshop/robot';
import { meshesIntersect } from './workshop-geometry-audit';
import { WorkshopTank, workshopKitMeshes } from '../src/game/workshop/tank';
import { liftDeckMesh } from '../src/game/workshop/fixtures';
import { transform } from '../src/game/workshop/geometry';
import { WORKSHOP_TANK_ROOT, WORKSHOP_SERVICE_HEIGHT, WORKSHOP_LIFT_MAX } from '../src/game/workshop/dimensions';
import { applyPoint, mul, type Mat4 } from '../src/game/kit/geometry/math';
import { instanceMatrix } from '../src/game/kit/pose';

const base: KitLoadoutIdsLike = { hull: 'skiff', runningGear: 'scout', turret: 'dome', weapon: 'mortar', utility: 'antenna' };
function mockScene() {
  let serial = 0;
  const meshes = new Map<number, MeshDesc>(), instances = new Map<number, { mesh: number; model: Float32Array; visible: boolean; tint?: Vec3 }>();
  const scene = { meshes: {
    create(desc: MeshDesc) { const h = { id: ++serial }; meshes.set(h.id, desc); return h; },
    destroy(h: { id: number }) { expect(meshes.delete(h.id)).toBe(true); },
  }, instances: {
    add(h: { id: number }, init: InstanceInit) { const instance = { id: ++serial }; instances.set(instance.id, { mesh: h.id, model: init.model, visible: true, tint: init.tint }); return instance; },
    set(h: { id: number }, model: Float32Array) { const instance = instances.get(h.id)!; expect(instance).toBeDefined(); instance.model = model; },
    setVisibility(h: { id: number }, visibility: number) { instances.get(h.id)!.visible = visibility > 0; },
    remove(h: { id: number }) { expect(instances.delete(h.id)).toBe(true); },
  }, get() { return undefined; } } as unknown as SceneRegistry;
  return { scene, meshes, instances };
}
function advance(mechanics: WorkshopMechanics, seconds = 5) { for (let t = 0; t <= seconds; t += 1 / 60) mechanics.update(1 / 60, t); }
const distance = (a: Vec3, b: Vec3) => Math.hypot(...a.map((v, i) => v - b[i]));

describe('physical workshop servicing', () => {
  it('uses all five production categories, batched by rigid group with intact triangle indices', () => {
    const data = workshopKitMeshes(base);
    expect(new Set(data.meshes.map(m => m.slot))).toEqual(new Set(KIT_SLOTS));
    expect(data.meshes.length).toBeLessThan(40);
    for (const { mesh } of data.meshes) {
      expect(mesh.positions.length / 3).toBe(mesh.attrs?.length);
      expect(Array.from(mesh.indices).every(i => i >= 0 && i < mesh.positions.length / 3)).toBe(true);
      expect(Array.from(mesh.positions).every(Number.isFinite)).toBe(true);
    }
  });
  it('keeps fixed-length robot links and the tool at reachable targets', () => {
    for (const target of [[0, 1.8, .2], [-2.7, 1.2, -2.8], [-2.7, 1.5, 1.8], [0, 2.45, .1]] as Vec3[]) {
      const pose = solveRobot(target);
      expect(pose.reachable).toBe(true);
      expect(pose.yaw + pose.wristYaw).toBeCloseTo(0, 10);
      expect(distance(pose.shoulder, pose.elbow)).toBeCloseTo(ROBOT_UPPER, 8);
      expect(distance(pose.elbow, pose.wrist)).toBeCloseTo(ROBOT_FORE, 8);
      expect(distance(pose.tip, target)).toBeLessThan(1e-8);
    }
  });
  it('keeps every rendered parked robot triangle clear of the actual deck and tank through the full manual stroke', () => {
    const mock = mockScene(), robot = new WorkshopRobot(mock.scene), deck = liftDeckMesh();
    const positions: number[] = [], indices: number[] = [];
    // Include the production instanced wheels, tracks and fasteners, not only the rigid shell.
    for (const { mesh, joint } of workshopKitMeshes({ ...base, hull: 'warden' }).meshes) {
      const count = mesh.instances ? mesh.instances.length / 12 : 1;
      for (let i = 0; i < count; i++) {
        const matrix = mesh.instances ? mul(joint as unknown as Mat4, instanceMatrix(mesh.instances, i)) : joint as unknown as Mat4, offset = positions.length / 3;
        for (let v = 0; v < mesh.positions.length; v += 3) positions.push(...applyPoint(matrix, mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]));
        for (const index of mesh.indices) indices.push(index + offset);
      }
    }
    const tank: MeshDesc = { positions: Float32Array.from(positions), normals: new Float32Array(positions.length), indices: Uint32Array.from(indices) };
    for (let step = 0; step <= WORKSHOP_LIFT_MAX * 100; step++) {
      const height = step / 100, deckModel = transform([0, height - .65, 0]), tankModel = transform([0, WORKSHOP_TANK_ROOT[1] + height, 0]);
      for (const part of mock.instances.values()) if (part.visible) {
        const mesh = mock.meshes.get(part.mesh)!;
        expect(meshesIntersect(mesh, part.model, deck, deckModel), `${mesh.label} touches deck at height ${height}`).toBe(false);
        expect(meshesIntersect(mesh, part.model, tank, tankModel), `${mesh.label} touches tank at height ${height}`).toBe(false);
      }
    }
    robot.dispose(); expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
  }, 30000);
  it('maintains gripper contact throughout removal and delivery with continuous payload paths', () => {
    const args: [Vec3, Vec3, Vec3, Vec3, Vec3] = [[0, 1.8, 0], [0, 1.9, 0], [-2.7, 1.2, -2.8], [-2.7, 1.3, 1.8], [0, .43, 0]];
    let previous = serviceMotion(0, ...args);
    for (let i = 1; i <= 1000; i++) {
      const t = i / 1000, motion = serviceMotion(t, ...args);
      if (t >= .23 && t <= .46) expect(distance(motion.target, motion.old)).toBeLessThan(1e-8);
      if (t >= .66 && t <= .88) expect(distance(motion.target, motion.replacement)).toBeLessThan(1e-8);
      expect(distance(motion.old, previous.old)).toBeLessThan(.1);
      expect(distance(motion.replacement, previous.replacement)).toBeLessThan(.1);
      previous = motion;
    }
  });
  it('seats the actual magnetic shoes or short finger pads on every serviced production part', () => {
    const mock = mockScene(), robot = new WorkshopRobot(mock.scene);
    const toolParts = [...mock.instances.values()];
    for (const [slot, id] of KIT_SLOTS.flatMap(slot => KIT_PART_IDS[slot].map(id => [slot, id] as [SlotId, string]))) {
      const candidate = legalKitLoadouts().find(kit => kit[slot] === id)!;
      const tank = new WorkshopTank(mock.scene, candidate, WORKSHOP_TANK_ROOT, [slot]);
      const grip = tank.serviceGrip(slot), soup = (tank as unknown as { triangles: Map<SlotId, Float32Array> }).triangles.get(slot)!;
      const mesh: MeshDesc = { positions: soup, normals: new Float32Array(soup.length), indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) };
      robot.update([grip.anchor[0], grip.anchor[1] + WORKSHOP_TANK_ROOT[1], grip.anchor[2]], 1, grip.span, 0, false, { ...grip, deployment: 1 });
      const pads = toolParts.filter(i => mock.meshes.get(i.mesh)?.label === (grip.mode === 'magnet' ? 'workshop:contact-pole' : grip.mode === 'tracks' ? 'workshop:track-contact-pole' : 'workshop:box:2'));
      expect(pads.length).toBe(grip.mode === 'magnet' ? 3 : 2);
      for (const pad of pads) {
        expect(meshesIntersect(mock.meshes.get(pad.mesh)!, pad.model, mesh, transform(WORKSHOP_TANK_ROOT)), `${slot}/${id} pickup must touch the production surface`).toBe(true);
        if (grip.mode !== 'fingers') {
          const m = pad.model, length = Math.hypot(m[8], m[9], m[10]), normal: Vec3 = [m[8] / length, m[9] / length, m[10] / length];
          // Independently sample the rendered shoe footprint, including its actual renderer radius.
          for (let edge = 0; edge < 16; edge++) {
            const angle = edge * Math.PI / 8;
            const origin = [0, 1, 2].map(i => m[12 + i] + normal[i] * .052 + (m[i] * Math.cos(angle) + m[4 + i] * Math.sin(angle)) * .94) as Vec3;
            const hit = tank.raycast(origin, normal.map(v => -v) as Vec3);
            expect(hit?.slot, `${slot}/${id} shoe footprint must remain over actual metal`).toBe(slot);
            expect(Math.abs(hit!.distance - .05), `${slot}/${id} whole shoe fits within spring compliance`).toBeLessThan(.0025);
          }
        }
      }
      tank.dispose();
    }
    robot.dispose(); expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
  }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle'], ['weapon', 'cannon'], ['utility', 'radar']] as [SlotId, string][])(
    'installs %s only on completion and frees every owned mesh/instance', async (slot, id) => {
      const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
      const promise = mechanics.install({ ...base, [slot]: id }, slot);
      expect(mechanics.tank.loadout).toEqual(base);
      expect(mechanics.state.busy).toBe(true);
      for (let t = 0; t < 5; t += 1 / 60) {
        mechanics.update(1 / 60, t);
        expect(mechanics.robot.pose.reachable, `${slot} progress ${mechanics.state.progress}`).toBe(true);
        for (const [i, [a, b]] of actuatorMounts(mechanics.robot.pose).entries()) {
          const extension = distance(a, b) - .055 - ACTUATOR_BARREL_END[i];
          expect(extension, `${slot} actuator ${i} gland clearance`).toBeGreaterThan(.02);
          expect(ACTUATOR_ROD_LENGTH[i] - extension, `${slot} actuator ${i} retained rod overlap`).toBeGreaterThan(.06);
        }
      }
      expect(await promise).toBe(true);
      expect(mechanics.tank.loadout[slot]).toBe(id);
      expect(mechanics.state.busy).toBe(false);
      mechanics.dispose(); mechanics.dispose();
      expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
    });
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle'], ['weapon', 'cannon'], ['utility', 'radar']] as [SlotId, string][])(
    'keeps the actual %s actuator barrel triangles clear of every rendered arm bearing and link during the full sweep', async (slot, id) => {
      const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
      const done = mechanics.install({ ...base, [slot]: id }, slot);
      const barrels = [...mock.instances.values()].filter(i => mock.meshes.get(i.mesh)?.label?.startsWith('workshop:hydraulic-barrel'));
      const links = [...mock.instances.values()].filter(i => /workshop:(robot-(pedestal|yaw-clevis|upper-clevis|fore-clevis)|wrist-pitch-clevis)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
      expect(barrels.length).toBe(2); expect(links.length).toBe(5);
      for (let frame = 0; frame < 132; frame++) {
        mechanics.update(.03, frame * .03);
        for (const barrel of barrels) for (const link of links) {
          const a = mock.meshes.get(barrel.mesh)!, b = mock.meshes.get(link.mesh)!;
          expect(meshesIntersect(a, barrel.model, b, link.model), `${slot} p=${mechanics.state.progress.toFixed(3)} ${a.label} vs ${b.label}`).toBe(false);
        }
      }
      expect(await done).toBe(true); mechanics.dispose();
    }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle'], ['weapon', 'cannon'], ['utility', 'radar']] as [SlotId, string][])('keeps the actual arm clear of every visible tank body during a %s swap', async (slot, id) => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const done = mechanics.install({ ...base, [slot]: id }, slot);
    const arms = [...mock.instances.values()].filter(i => /workshop:robot-(upper-clevis|fore-clevis)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
    const hulls = [...mock.instances.values()].filter(i => /workshop:tank:(hull|turret|weapon|utility):/.test(mock.meshes.get(i.mesh)?.label ?? '') && !mock.meshes.get(i.mesh)?.instances);
    expect(arms.length).toBe(2); expect(hulls.length).toBeGreaterThan(0);
    for (let frame = 0; frame < 132; frame++) {
      mechanics.update(.03, frame * .03);
      for (const arm of arms) for (const hull of hulls) if (hull.visible) {
        const a = mock.meshes.get(arm.mesh)!, b = mock.meshes.get(hull.mesh)!;
        expect(meshesIntersect(a, arm.model, b, hull.model), `p=${mechanics.state.progress.toFixed(3)} ${a.label} vs ${b.label}`).toBe(false);
      }
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle'], ['weapon', 'cannon'], ['utility', 'radar']] as [SlotId, string][])('keeps the compact tool clear of the arm and trolley shutters throughout a %s swap', async (slot, id) => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const done = mechanics.install({ ...base, [slot]: id }, slot);
    const robotGeometry = (mechanics.robot as unknown as { geometry: { instances: Set<{ id: number }> } }).geometry;
    const robotParts = [...robotGeometry.instances].map(h => mock.instances.get(h.id)!);
    const tools = robotParts.filter(i => /workshop:(compact-magnetic-tool-head|contact-pole|short-service-finger|track-fixture|track-contact-pole|visible-fastener-socket)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
    const arms = robotParts.filter(i => /workshop:(robot-(pedestal|yaw-clevis|upper-clevis|fore-clevis)|hydraulic-barrel|wrist-pitch-clevis)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
    const covers = (mechanics as unknown as { trolleyCovers: { id: number }[][]; trolleyFrames: { id: number }[][] });
    const shutters = [...covers.trolleyCovers.flat(), ...covers.trolleyFrames.flat()].map(h => mock.instances.get(h.id)!);
    for (let frame = 0; frame < 140; frame++) {
      mechanics.update(.03, frame * .03);
      for (const tool of tools) if (tool.visible) {
        const a = mock.meshes.get(tool.mesh)!;
        for (const obstacle of [...arms, ...shutters]) if (obstacle.visible) {
          const b = mock.meshes.get(obstacle.mesh)!;
          expect(meshesIntersect(a, tool.model, b, obstacle.model), `${slot} p=${mechanics.state.progress.toFixed(3)} ${a.label} vs ${b.label}`).toBe(false);
        }
      }
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle']] as [SlotId, string][])('seats all overhead magnetic shoes on exposed actual surfaces without opposing-shoe collisions during %s servicing', async (slot, id) => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const done = mechanics.install({ ...base, [slot]: id }, slot);
    const hooks = [...mock.instances.values()].filter(i => mock.meshes.get(i.mesh)?.label === 'workshop:lifting-contact-shoe');
    for (let frame = 0; frame < 132; frame++) {
      mechanics.update(.03, frame * .03);
      for (let i = 0; i < hooks.length; i++) for (let j = i + 1; j < hooks.length; j++) if (hooks[i].visible && hooks[j].visible)
        expect(meshesIntersect(mock.meshes.get(hooks[i].mesh)!, hooks[i].model, mock.meshes.get(hooks[j].mesh)!, hooks[j].model), `${slot} support pair ${i}/${j}`).toBe(false);
      if (frame === 40) for (let i = 0; i < hooks.length; i++) {
        const category = slot === 'runningGear' ? 'hull' : slot === 'hull' ? 'turret' : i < 2 ? 'weapon' : 'utility';
        const supported = [...mock.instances.values()].filter(v => v.visible && mock.meshes.get(v.mesh)?.label?.startsWith(`workshop:tank:${category}:`) && !mock.meshes.get(v.mesh)?.instances);
        expect(supported.some(v => meshesIntersect(mock.meshes.get(hooks[i].mesh)!, hooks[i].model, mock.meshes.get(v.mesh)!, v.model)), `${slot} hook ${i} supports actual ${category} surface`).toBe(true);
      }
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
  it('finds separated, fully exposed crane contact patches for every supported catalogue component', () => {
    const mock = mockScene();
    for (const slot of ['hull', 'turret', 'weapon', 'utility'] as SlotId[]) for (const id of KIT_PART_IDS[slot]) {
      const compatible = legalKitLoadouts().find(kit => kit[slot] === id)!;
      expect(compatible, `${slot}/${id} has a supported assembly`).toBeDefined();
      const tank = new WorkshopTank(mock.scene, compatible);
      const poles = tank.overheadContacts(slot, slot === 'weapon' || slot === 'utility' ? 2 : 4);
      for (const pole of poles) {
        const n = pole.normal, length = Math.hypot(n[1], n[0]), u: Vec3 = [n[1] / length, -n[0] / length, 0], v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const point = tank.attachmentPoint(slot, pole.offset);
        for (let j = -1; j < 16; j++) {
          const angle = j * Math.PI / 8, r = j < 0 ? 0 : pole.radius * .94;
          const start = point.map((p, i) => p + n[i] * .05 + (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)) * r) as Vec3;
          const hit = tank.raycast(start, n.map(p => -p) as Vec3);
          expect(hit?.slot, `${slot}/${id} crane foot rests on the intended part`).toBe(slot);
          expect(Math.abs(hit!.distance - .05), `${slot}/${id} crane shoe footprint`).toBeLessThan(.0025);
          expect(tank.raycast(start, [0, 1, 0]), `${slot}/${id} crane approach corridor`).toBeNull();
        }
      }
      tank.dispose();
    }
    expect(mock.instances.size).toBe(0);
  }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle']] as [SlotId, string][])('keeps every %s lifting cable and housing clear of every actual tank triangle through deployment, service and retraction', async (slot, id) => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const done = mechanics.install({ ...base, [slot]: id }, slot);
    const fixtures = [...mock.instances.values()].filter(i => /workshop:lifting-(cable|magnet-housing|pole-stem|overhead-outrigger)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
    const next = (mechanics as unknown as { job: { next: WorkshopTank } }).job.next;
    const tanks = [mechanics.tank, next].map(tank => ({ tank, soups: new Map([...((tank as unknown as { triangles: Map<SlotId, Float32Array> }).triangles)].map(([category, soup]) => [category, { positions: soup, normals: new Float32Array(soup.length), indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) } as MeshDesc])) }));
    expect(fixtures).toHaveLength(16);
    for (let frame = 0; frame < 132; frame++) {
      mechanics.update(.03, frame * .03);
      for (const { tank, soups } of tanks) for (const [category, soup] of soups) {
        if (!(tank as unknown as { visible: Set<SlotId> }).visible.has(category)) continue;
        const model = transform(tank.attachmentPoint(category, [0, 0, 0]));
        for (const fixture of fixtures) if (fixture.visible)
          expect(meshesIntersect(mock.meshes.get(fixture.mesh)!, fixture.model, soup, model), `${slot} p=${mechanics.state.progress.toFixed(3)} ${mock.meshes.get(fixture.mesh)?.label} crosses ${category}`).toBe(false);
      }
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
  it.each([['hull', 'warden'], ['runningGear', 'grip'], ['turret', 'cradle']] as [SlotId, string][])('clears actual overhead crane beams with the supported %s assembly', async (slot, id) => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const handles = (mechanics as unknown as { geometry: { instances: Set<{ id: number }> } }).geometry.instances;
    const beams = [...handles].map(h => mock.instances.get(h.id)!).filter(i => i.model[13] > 3 && mock.meshes.get(i.mesh)?.label?.startsWith('workshop:box:'));
    const done = mechanics.install({ ...base, [slot]: id }, slot);
    const tankParts = [...mock.instances.values()].filter(v => mock.meshes.get(v.mesh)?.label?.startsWith('workshop:tank:') && !mock.meshes.get(v.mesh)?.instances);
    for (let frame = 0; frame < 132; frame++) {
      mechanics.update(.03, frame * .03);
      for (const part of tankParts) if (part.visible) for (const beam of beams)
        expect(meshesIntersect(mock.meshes.get(part.mesh)!, part.model, mock.meshes.get(beam.mesh)!, beam.model), `${slot} p=${mechanics.state.progress.toFixed(3)} ${mock.meshes.get(part.mesh)?.label} touches overhead beam at ${Array.from(beam.model.slice(12, 15))}`).toBe(false);
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
  it('keeps the raised service crane clear of the actual authored ceiling steel and machinery', () => {
    const manifest = JSON.parse(readFileSync('public/workshop/manifest.json', 'utf8')) as RoomManifest;
    const room = manifest.meshes.map(spec => {
      const bytes = readFileSync(`public/workshop/${spec.file}`), decoded = spec.encoding ? gunzipSync(bytes) : bytes;
      const buffer = decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength);
      return spec.encoding ? decodeQuantizedRoomMesh(spec, buffer) : decodeRoomMesh(spec, buffer);
    });
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const handles = (mechanics as unknown as { geometry: { instances: Set<{ id: number }> } }).geometry.instances;
    const beams = [...handles].map(h => mock.instances.get(h.id)!).filter(i => i.model[13] > 3 && mock.meshes.get(i.mesh)?.label?.startsWith('workshop:box:'));
    for (const beam of beams) for (const wall of room)
      expect(meshesIntersect(mock.meshes.get(beam.mesh)!, beam.model, wall, transform([0, 0, 0])), `Crane beam at ${Array.from(beam.model.slice(12, 15))} intersects ${wall.label}`).toBe(false);
    mechanics.dispose();
  }, 30000);
  it('services every catalogue part with reachable joints and retained actuator engagement', async () => {
    for (const slot of KIT_SLOTS) for (const id of KIT_PART_IDS[slot]) {
      const candidate = legalKitLoadouts().find(kit => kit[slot] === id)!;
      const installed = legalKitLoadouts().find(kit => kit[slot] !== id && KIT_SLOTS.every(other => other === slot || candidate[other] === kit[other]))!;
      expect(installed, `${slot}/${id} can replace an existing compatible part`).toBeDefined();
      const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, installed);
      const done = mechanics.install(candidate, slot);
      for (let frame = 0; frame < 132; frame++) {
        mechanics.update(.03, frame * .03);
        expect(mechanics.robot.pose.reachable, `${slot}/${id} reachable at ${mechanics.state.progress}`).toBe(true);
        for (const [i, [a, b]] of actuatorMounts(mechanics.robot.pose).entries()) {
          const extension = distance(a, b) - .055 - ACTUATOR_BARREL_END[i];
          expect(extension, `${slot}/${id} actuator ${i} extension`).toBeGreaterThan(.02);
          expect(ACTUATOR_ROD_LENGTH[i] - extension, `${slot}/${id} actuator ${i} overlap`).toBeGreaterThan(.06);
        }
      }
      expect(await done, `${slot}/${id} installation completes`).toBe(true); mechanics.dispose(); expect(mock.instances.size).toBe(0);
    }
  }, 30000);
  it('rests every preview on the actual trolley support mat without changing the installed assembly', () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const support = [...mock.instances.values()].find(i => mock.meshes.get(i.mesh)?.label === 'workshop:box:2' && Math.abs(i.model[12] - NEW_RACK[0]) < .001 && Math.abs(i.model[13] - (NEW_RACK[1] - .015)) < .001)!;
    expect(support).toBeDefined();
    for (const slot of KIT_SLOTS) for (const id of KIT_PART_IDS[slot]) {
      mechanics.preview(legalKitLoadouts().find(kit => kit[slot] === id)!, slot);
      const preview = (mechanics as unknown as { previewTank: WorkshopTank }).previewTank;
      const soup = (preview as unknown as { triangles: Map<SlotId, Float32Array> }).triangles.get(slot)!, b = preview.categoryBounds(slot);
      const payload: MeshDesc = { positions: soup, normals: new Float32Array(soup.length), indices: Uint32Array.from({ length: soup.length / 3 }, (_, i) => i) };
      expect(meshesIntersect(payload, transform([NEW_RACK[0] - b.center[0], NEW_RACK[1] - TROLLEY_PAD_COMPRESSION - b.min[1], NEW_RACK[2] - b.center[2]]), mock.meshes.get(support.mesh)!, support.model), `${slot}/${id} rests on the trolley`).toBe(true);
      expect(mechanics.tank.loadout).toEqual(base);
    }
    mechanics.dispose(); expect(mock.instances.size).toBe(0);
  }, 30000);
  it('rolls a cancellation back along its path and resolves false without changing the installed kit', async () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const result = mechanics.install({ ...base, utility: 'radar' }, 'utility');
    advance(mechanics, 1.2);
    const before = mechanics.robot.pose.tip;
    mechanics.cancel();
    expect(mechanics.robot.pose.tip).toEqual(before);
    advance(mechanics);
    expect(await result).toBe(false); expect(mechanics.tank.loadout).toEqual(base);
    mechanics.dispose(); expect(mock.instances.size).toBe(0);
  });
  it('replaces queued rapid choices, commits only the last job, and handles build-switch/exit during service', async () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const first = mechanics.install({ ...base, utility: 'radar' }, 'utility'); advance(mechanics, 1.5);
    const second = mechanics.install({ ...base, utility: 'periscope' }, 'utility');
    const third = mechanics.install({ ...base, utility: 'smoke' }, 'utility');
    advance(mechanics, 8);
    expect(await first).toBe(false); expect(await second).toBe(false); expect(await third).toBe(true);
    const interrupted = mechanics.install({ ...base, utility: 'antenna' }, 'utility'); advance(mechanics, .7);
    mechanics.setLoadout({ ...base, hull: 'warden' }); expect(await interrupted).toBe(false);
    expect(mechanics.tank.loadout.hull).toBe('warden');
    const exit = mechanics.install({ ...base, hull: 'warden', weapon: 'cannon' }, 'weapon'); advance(mechanics, .7);
    mechanics.dispose(); expect(await exit).toBe(false);
    expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
  });
  it('clears previews when switching identical builds and defers replacement previews until cancellation has returned the delivery payload', async () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const state = mechanics as unknown as { previewTank: WorkshopTank | null; deferredPreview: unknown };
    mechanics.preview({ ...base, hull: 'warden' }, 'hull'); expect(state.previewTank).not.toBeNull();
    mechanics.setLoadout({ ...base }); expect(state.previewTank).toBeNull();
    const install = mechanics.install({ ...base, utility: 'radar' }, 'utility'); advance(mechanics, 1.8);
    mechanics.cancel(); mechanics.preview({ ...base, utility: 'smoke' }, 'utility');
    expect(state.previewTank).toBeNull(); expect(state.deferredPreview).not.toBeNull();
    advance(mechanics); expect(await install).toBe(false);
    expect(state.previewTank?.loadout.utility).toBe('smoke'); expect(state.deferredPreview).toBeNull();
    mechanics.clearPreview(); expect(state.previewTank).toBeNull();
    mechanics.dispose(); expect(mock.instances.size).toBe(0); expect(mock.meshes.size).toBe(0);
  });
  it('carries the whole tank with a bounded manual lift, stops on release, and restores height after service or cancellation', async () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    const before = mechanics.tank.categoryCenter('hull');
    mechanics.setLiftInput(1); advance(mechanics, 1); mechanics.setLiftInput(0);
    const height = mechanics.liftHeight;
    expect(height).toBeGreaterThan(.34); expect(height).toBeLessThan(.37);
    expect(mechanics.tank.categoryCenter('hull')[1] - before[1]).toBeCloseTo(height, 6);
    advance(mechanics, 1); expect(mechanics.liftHeight).toBe(height);
    const install = mechanics.install({ ...base, weapon: 'cannon' }, 'weapon');
    mechanics.setLiftInput(1); advance(mechanics, .5); expect(mechanics.liftHeight).toBeCloseTo(WORKSHOP_SERVICE_HEIGHT, 5);
    advance(mechanics); expect(await install).toBe(true); expect(mechanics.liftHeight).toBeCloseTo(height, 8);
    const cancel = mechanics.install({ ...base, weapon: 'mortar' }, 'weapon'); advance(mechanics, 1); mechanics.cancel(); advance(mechanics);
    expect(await cancel).toBe(false); expect(mechanics.liftHeight).toBeCloseTo(height, 8);
    mechanics.setLiftInput(1); advance(mechanics, 5); mechanics.setLiftInput(0); expect(mechanics.liftHeight).toBe(WORKSHOP_LIFT_MAX);
    mechanics.setReducedMotion(true); expect(await mechanics.install({ ...base, weapon: 'mortar' }, 'weapon')).toBe(true); expect(mechanics.liftHeight).toBe(WORKSHOP_LIFT_MAX);
    mechanics.setLiftInput(-1); advance(mechanics, 5); mechanics.setLiftInput(0); expect(mechanics.liftHeight).toBe(0);
    mechanics.dispose(); expect(mock.instances.size).toBe(0);
  });
  it('occludes tank picking with the rendered far-side gantry, leaving the open service side clear', () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base);
    expect(mechanics.occludes([2.22, 2, 3], [0, 0, -1], 3)).toBe(true);
    expect(mechanics.occludes([-.9, 2, 3], [0, 0, -1], 2)).toBe(false);
    mechanics.dispose(); expect(mock.meshes.size).toBe(0);
  });
  it('treats reduced motion and quick fitting as atomic, with appearance separate from the loadout', async () => {
    const mock = mockScene(), mechanics = new WorkshopMechanics(mock.scene, base, { reducedMotion: true });
    mechanics.setPalette('ochre'); expect(mechanics.tank.loadout).toEqual(base);
    expect(await mechanics.install({ ...base, weapon: 'cannon' }, 'weapon')).toBe(true);
    expect(mechanics.state.busy).toBe(false);
    mechanics.setReducedMotion(false);
    expect(await mechanics.install({ ...base, weapon: 'mortar' }, 'weapon', { quick: true })).toBe(true);
    mechanics.preview({ ...base, hull: 'warden' }, 'hull'); mechanics.clearPreview(); mechanics.dispose();
    expect(mock.meshes.size).toBe(0); expect(mock.instances.size).toBe(0);
  });
  it('previews and seats a required turret and weapon bundle together without an invalid intermediate build', async () => {
    const mock = mockScene(), from = { ...base, hull: 'warden' }, mechanics = new WorkshopMechanics(mock.scene, from);
    const matched = { ...from, turret: 'wedge', weapon: 'cannon' };
    mechanics.preview(matched, 'turret');
    const preview = (mechanics as unknown as { previewTank: WorkshopTank }).previewTank;
    expect(preview.loadout).toEqual(matched);
    expect(preview.categoryBounds('weapon').max[2]).toBeGreaterThan(preview.categoryBounds('turret').max[2]);
    expect(mechanics.tank.loadout).toEqual(from);
    const moving = mechanics.install(matched, 'turret');
    expect(mechanics.state.busy).toBe(true); expect(mechanics.tank.loadout).toEqual(from);
    advance(mechanics, 1.6); expect(mechanics.state.progress).toBeGreaterThan(.3); expect(mechanics.state.progress).toBeLessThan(.5);
    expect(mechanics.tank.loadout).toEqual(from);
    const job = (mechanics as unknown as { job: { next: WorkshopTank; payload: SlotId[] } }).job;
    expect(job.payload).toEqual(['turret', 'weapon']); expect(job.next.loadout).toEqual(matched);
    expect(mechanics.tank.attachmentPoint('turret', [0, 0, 0])).toEqual(mechanics.tank.attachmentPoint('weapon', [0, 0, 0]));
    expect(job.next.attachmentPoint('turret', [0, 0, 0])).toEqual(job.next.attachmentPoint('weapon', [0, 0, 0]));
    advance(mechanics, 3); expect(await moving).toBe(true);
    expect(mechanics.tank.loadout).toEqual(matched); expect(mechanics.state.busy).toBe(false);
    expect(await mechanics.install({ ...matched, utility: 'radar', weapon: 'rail' }, 'weapon')).toBe(false);
    expect(mechanics.tank.loadout).toEqual(matched);
    const heavy = { ...matched, hull: 'bastion', armor: 'reactive' as const };
    expect(await mechanics.install(heavy, 'hull', { quick: true })).toBe(true);
    expect(mechanics.tank.loadout).toEqual(heavy);
    expect(await mechanics.install({ ...heavy, armor: 'standard' }, 'hull')).toBe(true);
    expect(mechanics.tank.loadout.armor).toBe('standard');
    expect(await mechanics.install({ ...heavy, utility: 'radar', armor: 'standard' }, 'utility', { quick: true })).toBe(true);
    expect(mechanics.tank.loadout.utility).toBe('radar');
    mechanics.dispose(); expect(mock.meshes.size).toBe(0); expect(mock.instances.size).toBe(0);
  });
  it('reverses an animated matched assembly without committing either dependent part', async () => {
    const mock = mockScene(), from = { ...base, hull: 'warden' }, mechanics = new WorkshopMechanics(mock.scene, from);
    const moving = mechanics.install({ ...from, turret: 'wedge', weapon: 'cannon' }, 'turret');
    advance(mechanics, 2.9); expect(mechanics.state.busy).toBe(true); expect(mechanics.tank.loadout).toEqual(from);
    mechanics.cancel(); advance(mechanics, 3); expect(await moving).toBe(false);
    expect(mechanics.tank.loadout).toEqual(from); expect(mechanics.state.busy).toBe(false);
    mechanics.dispose(); expect(mock.meshes.size).toBe(0); expect(mock.instances.size).toBe(0);
  });
  it('keeps the actual arm clear while carrying the complete Wedge and Cannon bundle', async () => {
    const mock = mockScene(), from = { ...base, hull: 'warden' }, mechanics = new WorkshopMechanics(mock.scene, from);
    const done = mechanics.install({ ...from, turret: 'wedge', weapon: 'cannon' }, 'turret');
    const arms = [...mock.instances.values()].filter(i => /workshop:robot-(upper-clevis|fore-clevis)/.test(mock.meshes.get(i.mesh)?.label ?? ''));
    const parts = [...mock.instances.values()].filter(i => /workshop:tank:(hull|turret|weapon|utility):/.test(mock.meshes.get(i.mesh)?.label ?? '') && !mock.meshes.get(i.mesh)?.instances);
    for (let frame = 0; frame < 132; frame++) {
      mechanics.update(.03, frame * .03);
      for (const arm of arms) for (const part of parts) if (part.visible) expect(meshesIntersect(mock.meshes.get(arm.mesh)!, arm.model, mock.meshes.get(part.mesh)!, part.model), `bundle arm collision p=${mechanics.state.progress.toFixed(3)} ${mock.meshes.get(part.mesh)!.label}`).toBe(false);
    }
    expect(await done).toBe(true); mechanics.dispose();
  }, 30000);
});
