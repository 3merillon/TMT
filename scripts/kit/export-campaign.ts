/** Review the exact runtime meshes in Blender; never a prettier substitute asset. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { campaignModel, type CampaignModel } from '../../src/game/presentation/campaign-models';
import { UNIT_KINDS } from '../../src/game/campaign/mission';
import { assembleKit, buildKitMesh, createKitPose, validateKitLoadout, writeKitPose } from '../../src/game/kit';
import { createRigPose, poseRig, restState } from '../../src/game/kit/rig';
import { kitContext } from '../../src/game/kit/build';
import { mat4, mul, rotX, rotY, translate } from '../../src/game/kit/geometry/math';
import { SEARCHLIGHT_MOUNT } from '../../src/game/realtime/fixtures';
import { componentMeshes } from '../../src/game/presentation/component-meshes';
import { CRAWLER_COMPONENTS } from '../../src/game/realtime/components';
const units = { dragonfly: UNIT_KINDS.mags, skimmer: UNIT_KINDS.seraphine, watchtower: UNIT_KINDS.watchtower,
  relay: UNIT_KINDS.relay, rustling: UNIT_KINDS.rustling, spire: UNIT_KINDS.spire, brann: UNIT_KINDS.brann, crawler: UNIT_KINDS.crawler };
const out = 'artifacts/campaign-art'; mkdirSync(out, { recursive: true });
const metrics: Record<string, number[]> = {};
for (const [name, unit] of Object.entries(units)) {
  const a = assembleKit(validateKitLoadout(unit.loadout)), ctx = kitContext(a.loadout), rig = createRigPose(), pose = createKitPose(a);
  poseRig(ctx, restState(ctx), rig); writeKitPose(a, rig, pose);
  pose.joints.set('searchlight-yoke', new Float32Array(translate(0, SEARCHLIGHT_MOUNT.height, 0)));
  pose.joints.set('searchlight-head', new Float32Array(mul(translate(0, SEARCHLIGHT_MOUNT.height, 0), rotX(SEARCHLIGHT_MOUNT.pitch))));
  pose.joints.set('flight-rotor', new Float32Array(mul(translate(0, .9, -.08), rotY(.3))));
  const lods = [0, 1, 2].map(l => {
    const lod = l as 0 | 1 | 2;
    const parts = 'visualKind' in unit ? campaignModel(unit.visualKind as CampaignModel, lod) : buildKitMesh(a, lod).parts;
    return [...parts, ...(name === 'crawler' ? componentMeshes(CRAWLER_COMPONENTS, lod) : [])];
  });
  metrics[name] = lods.map(parts => parts.reduce((n, p) => n + p.indices.length / 3 * (p.instances ? p.instances.length / 12 : 1), 0));
  writeFileSync(`${out}/${name}.json`, JSON.stringify({ name, lodTriangles: metrics[name], parts: lods[0].map(p => ({
    name: p.part, positions: Array.from(p.positions), normals: Array.from(p.normals), indices: Array.from(p.indices),
    attrs: Array.from(p.attrs), matrix: Array.from(pose.joints.get(p.joint) ?? mat4()), instances: p.instances ? Array.from(p.instances) : null,
  })) }));
}
writeFileSync(`${out}/metrics.json`, JSON.stringify(metrics, null, 2)); console.log(metrics);
