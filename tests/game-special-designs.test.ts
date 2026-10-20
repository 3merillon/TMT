import { describe, expect, it } from 'vitest';
import { defaultProfile, recordMatch, exportProfile, importProfile } from '../src/game/meta/profile';
import { fittingBudget, lockedKitParts, partEntitlement, purchaseSpecialPart, SPECIAL_DESIGNS } from '../src/game/meta/special-designs';
import { assembleKit, validateKitLoadout } from '../src/game/kit';
import { partCards } from '../src/game/ui/workshop-model';

describe('special equipment progression', () => {
  it('offers exactly two complete physically legal sets with distinct upgraded stats', () => {
    expect(SPECIAL_DESIGNS).toHaveLength(2);
    expect(new Set(SPECIAL_DESIGNS.flatMap(d => d.parts.map(p => p.id))).size).toBe(10);
    const [a, b] = SPECIAL_DESIGNS.map(d => assembleKit(validateKitLoadout(d.kit)).stats);
    expect(a.speed).toBeGreaterThan(b.speed); expect(b.hp).toBeGreaterThan(a.hp); expect(b.damage).toBeGreaterThan(a.damage);
    for (const d of SPECIAL_DESIGNS) expect(d.parts.map(p => d.kit[p.slot])).toEqual(d.parts.map(p => p.id));
  });
  it('deducts scrap once, persists ownership, and rejects unaffordable and unknown purchases', () => {
    const original = { ...defaultProfile(), scrap: 600 };
    const bought = purchaseSpecialPart(original, 'arc_cannon');
    expect(bought.scrap).toBe(0); expect(original.scrap).toBe(600);
    expect(partEntitlement(bought, 'arc_cannon').owned).toBe(true);
    expect(purchaseSpecialPart(bought, 'arc_cannon')).toBe(bought);
    expect(purchaseSpecialPart(bought, 'forge_hull')).toBe(bought);
    expect(purchaseSpecialPart(bought, 'fake')).toBe(bought);
    const restored = importProfile(exportProfile(bought)); expect(restored.ok).toBe(true);
    if (restored.ok) expect(partEntitlement(restored.profile, 'arc_cannon').owned).toBe(true);
  });
  it('earns blueprints and enough fitting capacity through completed matches, never forfeits', () => {
    let p = defaultProfile();
    for (let i = 0; i < 12; i++) p = recordMatch(p, true);
    for (const d of SPECIAL_DESIGNS) { expect(lockedKitParts(p, d.kit)).toEqual([]); expect(fittingBudget(p)).toBeGreaterThanOrEqual(assembleKit(d.kit).stats.cost); }
    const loss = recordMatch(defaultProfile(), false); expect(loss.scrap).toBe(60); expect(loss.xp).toBe(45);
    const forfeit = recordMatch(p, false, false); expect(forfeit.scrap).toBe(p.scrap); expect(forfeit.xp).toBe(p.xp); expect(forfeit.stats.wins).toBe(p.stats.wins);
  });
  it('keeps locked parts inspectable while Sandbox exposes them independently of ownership', () => {
    const p = defaultProfile(), kit = SPECIAL_DESIGNS[0].kit;
    expect(lockedKitParts(p, kit)).toHaveLength(5);
    // No profile argument is the explicit Sandbox/unrestricted presentation path.
    expect(partCards({ ...kit, weapon: 'cannon' }, 'weapon', Infinity).find(c => c.id === 'arc_cannon')?.status).toBe('available');
  });
});
