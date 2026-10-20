/** Renderer-independent mesh data: a wreck collides only with the parts still attached to it.
 * Campaign builders are pure geometry, shared with presentation; no GPU or scene objects are created here. */
import type { TankState } from '../contracts';
import { assembleKit, buildKitMesh, createKitPose, instanceMatrix, kitInstanceSource, poseKit, tankKit } from '../kit';
import { applyPoint, mul, rotX, rotY } from '../kit/geometry/math';
import { campaignModel } from '../presentation/campaign-models';
import { DRAGONFLY_ROTOR, DRAGONFLY_TAIL_ROTOR } from '../presentation/dragonfly-model';
import { SEARCHLIGHT_MOUNT } from '../realtime/fixtures';
import { vehiclePartMissing } from '../rules/vehicle-parts';

export function vehicleCollisionParts(tank: TankState): { positions: Float32Array; transform: Float64Array }[] {
  const kit = assembleKit(tankKit(tank)), pose = createKitPose(kit);
  poseKit(kit, { ...tank, recoil: 0 }, pose);
  // Campaign fixtures add joints beyond the kit rig. Match their mounted offsets, including the
  // watchtower yoke that remains attached after the lamp breaks off.
  if (tank.visualKind === 'watchtower') {
    const yoke = new Float32Array(rotY(tank.turretYaw)); yoke[13] = SEARCHLIGHT_MOUNT.height;
    const head = new Float32Array(mul(rotY(tank.turretYaw), rotX(SEARCHLIGHT_MOUNT.pitch))); head[13] = SEARCHLIGHT_MOUNT.height;
    pose.joints.set('searchlight-yoke', yoke); pose.joints.set('searchlight-head', head);
  }
  if (tank.visualKind === 'dragonfly') {
    const rotor = new Float32Array(rotY(.3)); rotor.set(DRAGONFLY_ROTOR, 12);
    const tail = new Float32Array(rotX(.5)); tail.set(DRAGONFLY_TAIL_ROTOR, 12);
    pose.joints.set('flight-rotor', rotor); pose.joints.set('flight-tail-rotor', tail);
  }
  const parts = tank.visualKind ? campaignModel(tank.visualKind, 2) : buildKitMesh(kit, 2).parts;
  const out: { positions: Float32Array; transform: Float64Array }[] = [];
  for (const part of parts) {
    // The wheels support the surviving running gear; tiny fasteners and suspension trim need no extra bodies.
    if (part.instances && !['wheels', 'idlers', 'sprockets'].includes(part.part)) continue;
    const source = kitInstanceSource(kit, part), joint = new Float64Array(pose.joints.get(part.joint) ?? pose.joints.get('hull')!);
    const buffer = source ? pose[source.buffer] : undefined;
    const count = part.instances ? part.instances.length / 12 : 1;
    for (let i = 0; i < count; i++) {
      const at = (source?.first ?? 0) + i;
      if (vehiclePartMissing(tank, part.part, part.joint, buffer ? buffer[at * 12 + 3] > 0 : undefined)) continue;
      const transform = buffer ? mul(joint, instanceMatrix(buffer, at)) : joint;
      out.push({ positions: part.positions, transform });
    }
  }
  return out;
}

export function vehicleCollisionGeometry(tank: TankState): Float32Array[] {
  return vehicleCollisionParts(tank).map(({ positions, transform }) => {
    const vertices = new Float32Array(positions.length);
    for (let j = 0; j < vertices.length; j += 3) vertices.set(applyPoint(transform, positions[j], positions[j + 1], positions[j + 2]), j);
    return vertices;
  });
}
