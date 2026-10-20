import { describe, expect, it } from 'vitest';
import { KIT_SLOTS, legalKitLoadouts } from '../src/game/kit';
import { equippedAppearance, sanitizeCosmetics } from '../src/game/meta/cosmetics';
import { activeKit, defaultProfile, exportProfile, importProfile, withAppearance } from '../src/game/meta/profile';
import { fittingBudget, purchaseSpecialPart, SPECIAL_DESIGNS } from '../src/game/meta/special-designs';
import { buildStats, compareStats, FITTING_BUDGET, partCards, WorkshopInstallGuard } from '../src/game/ui/workshop-model';

const kit = { ...activeKit(defaultProfile()), hull: 'skiff' };
describe('workshop installation transactions', () => {
  it('keeps locked blueprints inspectable, permits buying over-budget parts and enforces ownership at install', () => {
    const profile = { ...defaultProfile(), scrap: 1000 }, budget = fittingBudget(profile);
    const card = partCards(kit, 'turret', budget, profile).find(p => p.id === 'aether_crown')!;
    expect(card).toMatchObject({ status: 'locked', canPurchase: true, price: 450 });
    expect(card.stats).not.toBeNull(); expect(card.stats!.cost).toBeGreaterThan(budget);
    const guard = new WorkshopInstallGuard();
    expect(guard.begin(0, kit, 'turret', card.id, Infinity, profile)).toBeNull();
    const owned = purchaseSpecialPart(profile, card.id);
    expect(owned.scrap).toBe(550); expect(owned.loadouts).toEqual(profile.loadouts);
    expect(partCards(kit, 'turret', budget, owned).find(p => p.id === card.id)?.status).toBe('over-budget');
    const ranked = { ...owned, rank: 5 };
    expect(guard.begin(0, kit, 'turret', card.id, fittingBudget(ranked), ranked)?.candidate.turret).toBe(card.id);
    expect(purchaseSpecialPart(owned, card.id)).toBe(owned);
  });
  it('never lets a build gain an unowned blueprint, lets one shed them, and sandbox exposes both complete special sets', () => {
    const profile = defaultProfile(), design = SPECIAL_DESIGNS[0];
    const special = { ...design.kit };
    // A saved build holding unowned blueprints (as an old save could) can always swap them out…
    expect(partCards(special, 'utility', Infinity, profile).find(p => p.id === 'antenna')?.status).toBe('available');
    expect(new WorkshopInstallGuard().begin(0, special, 'utility', 'antenna', Infinity, profile)).not.toBeNull();
    // …but no swap may introduce one, onto a standard or a special build.
    expect(partCards(kit, 'utility', Infinity, profile).find(p => p.id === design.kit.utility)?.status).toBe('locked');
    const shed = { ...special, utility: 'antenna' };
    expect(partCards(shed, 'utility', Infinity, profile).find(p => p.id === design.kit.utility)?.status).toBe('locked');
    expect(new WorkshopInstallGuard().begin(0, shed, 'utility', design.kit.utility, Infinity, profile)).toBeNull();
    expect(new WorkshopInstallGuard().begin(0, special, 'utility', 'antenna', Infinity)).not.toBeNull();
    for (const preset of SPECIAL_DESIGNS) { expect(buildStats(preset.kit)).not.toBeNull(); expect(partCards(preset.kit, 'hull', Infinity).find(p => p.id === preset.kit.hull)?.status).toBe('fitted'); }
  });
  it('commits each category only after completion and keeps preview data detached', () => {
    const guard = new WorkshopInstallGuard();
    for (const slot of KIT_SLOTS) {
      const card = partCards(kit, slot).find(p => p.status === 'available')!;
      expect(card).toBeDefined();
      const job = guard.begin(0, kit, slot, card.id)!;
      expect(kit[slot]).not.toBe(card.id);
      expect(job.installed).toEqual(kit);
      expect(guard.complete(job.token, 0, kit)?.candidate).toEqual({ ...kit, [slot]: card.id });
      expect(guard.complete(job.token, 0, kit)).toBeNull();
    }
  });
  it('rejects cancelled, superseded, wrong-build and externally changed completions', () => {
    const guard = new WorkshopInstallGuard();
    const cancelled = guard.begin(0, kit, 'weapon', 'cannon')!; guard.cancel();
    expect(guard.complete(cancelled.token, 0, kit)).toBeNull();
    const old = guard.begin(0, kit, 'weapon', 'cannon')!;
    const latest = guard.begin(0, kit, 'utility', 'radar')!;
    expect(guard.complete(old.token, 0, kit)).toBeNull();
    expect(guard.complete(latest.token, 1, kit)).toBeNull();
    expect(guard.complete(latest.token, 0, { ...kit, weapon: 'cannon' })).toBeNull();
    expect(guard.complete(latest.token, 0, kit)?.candidate.utility).toBe('radar');
  });
  it('never starts over-budget, incompatible, already-installed or unknown proposals', () => {
    const guard = new WorkshopInstallGuard();
    expect(guard.begin(0, kit, 'hull', kit.hull)).toBeNull();
    expect(guard.begin(0, kit, 'hull', 'not-a-hull')).toBeNull();
    const legal = legalKitLoadouts().filter(k => buildStats(k)!.cost <= FITTING_BUDGET);
    let budgetChecks = 0, compatibilityChecks = 0;
    for (const ids of legal.slice(0, 50)) for (const slot of KIT_SLOTS) for (const card of partCards(ids, slot)) {
      if (card.status === 'over-budget' || card.status === 'incompatible') {
        expect(guard.begin(0, ids, slot, card.id)).toBeNull();
        if (card.status === 'over-budget') budgetChecks++; else compatibilityChecks++;
      }
    }
    expect(budgetChecks).toBeGreaterThan(0); expect(compatibilityChecks).toBeGreaterThan(0);
  });
  it('lets an over-budget saved build step back down to the budget, never further up', () => {
    // A special set saved as a normal build (cost 22 against the rank 1 budget of 10): every single swap still totals
    // more than 10, which used to mark every part over budget and lock the build in place.
    let ids: import('../src/game/api/match').KitLoadoutIds = { ...SPECIAL_DESIGNS[0].kit }; const budget = fittingBudget(defaultProfile()), guard = new WorkshopInstallGuard();
    expect(buildStats(ids)!.cost).toBeGreaterThan(budget);
    for (let step = 0; step < 12 && buildStats(ids)!.cost > budget; step++) {
      const before = buildStats(ids)!.cost;
      const cards = KIT_SLOTS.flatMap(slot => partCards(ids, slot, budget).map(card => ({ slot, card })));
      for (const { card } of cards) if (card.status === 'available') expect(card.cost!).toBeLessThanOrEqual(before);
      for (const { slot, card } of cards) if (card.status === 'over-budget') expect(guard.begin(0, ids, slot, card.id, budget)).toBeNull();
      const cheapest = cards.filter(c => c.card.status === 'available').sort((a, b) => a.card.cost! - b.card.cost!)[0];
      expect(cheapest).toBeDefined(); expect(cheapest.card.cost!).toBeLessThan(before);
      ids = guard.begin(0, ids, cheapest.slot, cheapest.card.id, budget)!.candidate;
    }
    expect(buildStats(ids)!.cost).toBeLessThanOrEqual(budget);
  });
  it('compares actual assembled stats and interprets lower mass as an improvement', () => {
    const before = buildStats({ ...kit, hull: 'warden' })!, after = buildStats(kit)!;
    const rows = compareStats(before, after);
    expect(rows.find(r => r.key === 'mass')?.change).toBe('better');
    expect(rows.find(r => r.key === 'hp')?.change).toBe('worse');
    expect(rows.find(r => r.key === 'damage')?.change).toBe('same');
  });
});
describe('appearance boundary', () => {
  it('equips built-in paint and round trips without changing kit, budget or statistics', () => {
    const original = defaultProfile();
    const profile = withAppearance(original, { ...equippedAppearance(original.cosmetics), paintId: 'paint:ochre' });
    expect(profile.cosmetics.palette).toBe('ochre');
    expect(profile.loadouts).toEqual(original.loadouts);
    expect(buildStats(activeKit(profile))).toEqual(buildStats(activeKit(original)));
    expect(profile.stats).toEqual(original.stats);
    expect(importProfile(exportProfile(profile))).toEqual({ ok: true, migrated: false, profile });
  });
  it('rejects unowned cosmetics and sanitizes malformed ownership and decals', () => {
    const value = sanitizeCosmetics({ palette: 'sage', owned: ['skin:foundry', 'decal:7', 'decal:7', '../file', 4], appearance: {
      paintId: 'paint:paid', materialId: 'material:chrome', skinId: 'skin:foundry', decalIds: ['decal:7', 'decal:7', 'decal:unowned'],
    } });
    expect(value.owned).toEqual(['skin:foundry', 'decal:7']);
    expect(value.appearance).toEqual({ version: 1, paintId: 'paint:sage', materialId: 'material:field-enamel', skinId: 'skin:foundry', decalIds: ['decal:7'] });
    expect(sanitizeCosmetics({ palette: 'ochre' })).toEqual({ palette: 'ochre' });
  });
});
