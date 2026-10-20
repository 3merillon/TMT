# Tank designs and workshop controls

This guide describes the current tank catalogue, workshop fitting and appearance behavior.
The [workshop subsystem guide](../src/game/workshop/README.md) owns detailed paint, asset and scene contracts.

## Three chassis

- **Skiff:** compact reconnaissance tub, a low tapered prow, open channels beside the body and separate thin running boards. Its running gear stays exposed and its low mass gives the strongest acceleration and turning.
- **Warden:** welded central crew compartment, stepped driver front and lower forward shelf, separate shoulder sections and an aft engine deck with upright exhausts.
- **Bastion:** broad siege hull, a steep blunt front, deep segmented skirts and seated reactive cassettes. Selecting Bastion fits the reactive package by default; the armor control can strip it to standard armor. Existing saved standard builds remain standard.

Fenders follow the selected Scout, Grip or Crawler track envelope. Final-drive housings connect the hull to the inner sprocket hubs; suspension pivots have supporting saddles. Hull profiles feed the actual pitch-clearance solver, so the larger heavy front reduces available gun depression where necessary.

The exhaust repair is in the swept-tube primitive: the bore's inner ring now uses the same transported frame as the outer ring. It does not use a depth bias to conceal crossed faces. Weapon muzzles have open bores and wall thickness, and the cannon brake has through ports.

Each build has one crew hatch. Enclosed turrets carry the recessed, hinged roof hatch; the open Cradle instead gets a hull hatch fitted to its actual deck surface. Warden places that hatch on its lower front shelf to clear every accessory during traverse. Dome and Crown shells are centered on the rotating bearing while retaining their gun pivots. The Crown uses a stepped octagonal field-generator housing with flat armor facets and supported capacitor banks. Trunnion cheeks cover the complete bearing footprint, and the Cradle's journals have seated service housings instead of exposed shaft ends.

## Fitting and accessories

Click the antenna/accessory or use **Components → Accessories**. The original field antenna, short whip, Yagi array, dish radar, periscope, smoke launcher and point-defense preview share identical cost, mass and handling contributions. Accessories are cosmetic; the radar does not add a sensor bonus and point defense does not intercept targets.

The upright radar aperture faces the horizon and rotates independently around its pedestal. The defensive head scans a bounded elevation arc with eased acceleration, deceleration and short dwells. Whips and the directional array flex on their spring mounts, the periscope follows elevation, the Aether vane rotates and the steam sentinel scans. Workshop and match share the motion functions. Painting pauses presentation motion so brush placement remains precise.

Host selection preserves compatible equipment and previews any required replacements. Choosing **Wedge** with the S-class mortar fits **Field cannon** as a paired assembly. Choosing Bastion with an unsupported small turret fits a compatible turret. The preview includes the complete resulting cost and mass; normal build budgets still apply. Paired changes use the trolley and robot installation sequence, moving the supported host and dependent components together. The profile changes only once the complete assembly is seated; cancellation restores the original build. Explicit Quick install and reduced-motion settings skip the sequence.

The Yagi's central feed gearbox includes a real service cover that supports the magnetic gripper. Utility installation errors remain visible in the action bar instead of silently abandoning a fit.

Accessory inspection uses a front-quarter service angle that clears the crane hook. Candidate changes keep the same heading. Dismissing the drawer recenters the installed tank while keeping a pending installation available; discarding or completing the fit clears the preview. Closing unrelated controls preserves the user's orbit.

The workshop's bay and bench lamps have machined reflector bowls, recessed optics, external bearing forks and nested pairs of arm plates. Each elbow has one shared spindle. Bay lights adjust their fixed-length links and optical axes with the service lift; bench lights remain aimed at their work surfaces. The six wall lanterns have rounded caps, ribbed optics and protective rails. The old static lamp geometry was removed from the Blender room export, and dynamic lamps release their meshes, instances and lights on exit.

## Special designs and progression

Two complete fantasy sets supply **two additional choices in every equipment slot**:

- **Aether Regent:** a split-shoulder hull with integrated capacitor nacelles, Aether drive, crown turret, induction arc cannon and rotating field vane. The complete set has 180 HP, 75 damage and about 4.20 m/s top speed at cost 22.
- **Furnace Leviathan:** a broad siege hull with an integrated engine cowl, open recessed radiator grilles and seated exhaust manifolds, Forge tracks, pressure-jacket casemate, Forge mortar and steam sentinel. It has 275 HP, 90 damage and about 2.24 m/s top speed at cost 27.

Open **Builds** in Sandbox for one-click complete-set presets and matching palettes. Every component can also be mixed through the existing component cards, subject to its real sockets. Special accessories remain cosmetic previews; they do not secretly add interception or other combat abilities.

In normal play, each blueprint unlocks at its listed victory milestone or can be purchased explicitly with earned scrap. Completed wins grant 100 XP/150 scrap; completed losses grant 45 XP/60 scrap. Forfeits grant neither. Each 100 XP raises rank, up to 30; the fitting budget starts at 10 and increases by 2 per rank. Sandbox/workshop tests never award progression. Purchases deduct scrap once and persist through profile export/import; locked and unaffordable parts remain inspectable. Normal match starts check ownership and fitting budget.

## Paint, surface detail and lights

Open **Paint** for solid, woodland, geometric or stripe finishes and palette controls. Brush controls include color, radius, opacity and softness. Use the eraser, Undo/Redo, Reset, Save or Cancel. Right-drag manipulates the camera without painting. Save persists the design and applies it to the next match without reloading the application.

The brush raycasts the nearest rendered surface. Tracks, lenses and non-paint materials block the ray but do not receive paint. Gestures rasterize into compressed RGBA tiles attached to component geometry at three LODs; there is no stroke-count limit. The editor retains 32 undo gestures. Retained components keep their drawing, replacing a component hides its paint, and refitting restores it. Storage and multiplayer byte limits still apply. See the [paint contract](../src/game/workshop/README.md#paint-and-lighting) for resolution, migration, saving and online transfer.

Tank-only surface treatment uses a shared pair of 1024² linear height/mask and tangent normal maps with a full mip chain. Varied scratches, broad notches, chipped edges and intact-painted depressions use bounded parallax occlusion (up to eight steps and two refinements); fine grit changes normal and roughness. Detail fades with the pixel footprint. The maps occupy 10.67 MiB per renderer, shared by every tank. Rubber pads sit over steel track carriers and use a near-black dielectric material with filtered grain and burnished edges. Close wheel silhouettes use 24 segments. Workshop scenery retains its existing material path.

**Lights on/off** previews two mounted, shadowed spotlights that illuminate nearby geometry. The saved setting carries into play. Each headlamp's visible lens carries a warm glow when enabled and returns to reflective glass when off; sensor and periscope glass remain unlit. Glass uses an opaque reflective deferred material with geometric lens and reflector depth; the lamp glow represents its hidden bulb without simulating optical transmission.

Direct gameplay impacts can leave up to 24 temporary marks on rigid painted/steel surfaces. Each has local parallax dent depth, a perturbed shading normal, an irregular exposed-metal rim and soot. Marks follow component motion, survive LOD changes, and never enter the saved paint design or collision/damage calculations. They do not yet tear silhouette geometry or detach pieces; instanced track parts do not receive marks.

The conventional barrels have layered sleeves, deep bores and recessed chambers/projectile noses; muzzle openings remain genuinely hollow. The rail accelerator and arc cannon carry bounded traveling particles, changing contact arcs, recharge pulses and a colored local light. Accepted shots add a brief pressure ring and outward discharge; the Forge mortar emits warm heat particles. Effects use the current recoiling barrel transform, release their instances/lights when hidden, and never alter aiming or simulation. The existing projectile and volumetric muzzle effects remain in place.

## Sandbox and driving

Enter **Workshop sandbox** to experiment with all catalog parts, armor, finishes and paint without normal progression or build-budget restrictions. Unsupported sockets still require a compatible fit. Use **Drive test** or **Combat test** to try the sandbox assembly. **Exit sandbox** restores normal profile behavior; sandbox edits and match rewards do not change saved ownership or progression.

Accepted controls remain WASD to drive, left-click/drag for precise world aiming, right-drag for the camera, wheel for range trim while aiming (otherwise zoom), and Space to fire.

See [armor and handling measurements](tank-armor-tradeoffs.md) for equivalent-equipment comparisons, directional damage, reactive consumption and timing results. Reactive armor consumes four independent sections in combat; its brackets and spent trays remain visible. It uses the existing coarse contact model, rather than individual cassette penetration hitboxes.

## Recorded verification — 14 October 2026

At the tank-design checkpoint, checks passed TypeScript, the production Vite build, repository architecture guards, original and compacted WGSL validation, 81 fast kit tests, 157 UI tests (including all 47 installation mechanics checks), and the full vehicle project (193 passed plus one existing expected failure). Engine, rules, FX, world, audio and content projects passed in the broader regression run; focused presentation checks also cover same-frame damage marks and extinguishing destroyed-vehicle headlights. Actual browser verification retained all 19 accepted aiming/control checks, 36 utility installation checks, seven fantasy fitting/progression/test groups, and three camera/picking groups without errors.

The full geometric sweep covers 26,576,806 states across 4,680 legal assemblies, with no overlap above the unchanged 1 mm tolerance, in 28.156 seconds CPU against the unchanged 30-second cap. Exact maximum triangle counts, including reactive armor where applicable, are 19,588 / 5,862 / 1,144 at LOD0/1/2, within 20,000 / 6,000 / 1,200. The complete-vehicle draw cap remains 24.

The checkpoint had inherited initial-JavaScript budget failures; those historical results are not the current release result. See [release readiness](release-readiness.md) for present bundle checks. Local-only source reports were named `bundle-baseline.json` and `bundle-final.json`.

Reproduction scripts:

```powershell
node node_modules/tsx/dist/cli.mjs scripts/verify-tank-customization.ts
node node_modules/tsx/dist/cli.mjs scripts/verify-tank-customization.ts --headlights-only --out artifacts/tank-designs/headlights
node node_modules/tsx/dist/cli.mjs scripts/bench-tank-designs.ts
node node_modules/tsx/dist/cli.mjs scripts/bench-tank-render.ts
node node_modules/tsx/dist/cli.mjs scripts/capture-ground-aim.ts
node node_modules/tsx/dist/cli.mjs scripts/verify-workshop-camera.ts
node node_modules/tsx/dist/cli.mjs scripts/capture.ts --plan workshop-lamps --strict
```

Captures and reports are written under `artifacts/tank-designs/`: `before/` contains the accepted baseline; `customization/` contains workshop comparisons and paint recording; `fantasy-final/` contains purchases, animated paired installation and actual special-set test matches; `utility-install-fixed/` contains 36 utility installation checks; `camera/` verifies framing and unoccluded accessory picking; `lamps/` shows the articulated room fixtures; `render/` contains multi-vehicle render measurements; `aim-regression/` contains accepted-control verification and recording. These are local-only verification records and are not included in a source checkout.

Local-only review filenames: `tank-designs/before/room-clean-hero.png`, `tank-designs/crew-bearings-final/bearing-aether_crown-quarter.png`, `tank-designs/render/compare-skiff-quarter.png`, `tank-designs/render/compare-warden-quarter.png`, `tank-designs/render/compare-bastion-quarter.png`, `tank-designs/fantasy-final/wedge-matched-install.webm`, and `tank-designs/customization/paint-editor-demo.webm`.

The `headlights/` captures passed eight groups with zero errors using the real Workshop light toggle and Drive test flow, with 17 m and 6 m camera distances established through wheel input. Daylight, low-sun and night views verify that the enabled lenses glow while disabled lamps and ordinary optics stay dark; these separate test worlds are state/persistence checks rather than a matched lighting benchmark. See `tank-designs/headlights/headlights-game-on-low-sun-close.png` and `tank-designs/headlights/headlights-game-off-low-sun-close.png`.
