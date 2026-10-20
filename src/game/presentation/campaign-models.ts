/** Campaign vehicles share the tanks' machined geometry and materials. */
import type { PartMesh } from '../kit/types';
import { relayModel } from './relay-model';
import { watchtowerModel } from './watchtower-model';
import { skimmerModel } from './skimmer-model';
import { rustlingModel } from './rustling-model';
import { spireModel } from './spire-model';
import { dragonflyModel } from './dragonfly-model';
export type CampaignModel = 'dragonfly' | 'rustling' | 'spire' | 'skimmer' | 'relay' | 'watchtower';
export function campaignModel(kind: CampaignModel, lod: 0 | 1 | 2): PartMesh[] {
  return ({ dragonfly: dragonflyModel, relay: relayModel, watchtower: watchtowerModel,
    skimmer: skimmerModel, rustling: rustlingModel, spire: spireModel })[kind](lod);
}
