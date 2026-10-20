# Gameplay images

Captured from this checkout on 18 October 2026 using the real game in Chromium with hardware WebGPU, at 1440×900. These are rendered game screenshots, not mockups or generated promotional scenes. No debug overlays, private rooms, credentials, or invented UI were added.

Reproduce with `npm run verify:browser -- release-gallery --strict`, using [the checked-in capture plan](../../scripts/capture-plans/release-gallery.json). The plan starts seeded solo artillery (`mode=bot`, seed 7), fires a shell, and opens the workshop through its public title-screen button. Timing-dependent effects will not be pixel-identical across machines.

| Published image | Original capture | Processing |
| --- | --- | --- |
| `gameplay.webp` | `artillery-ready.png` | Resize to 1280×800, WebP quality 82 |
| `impact.webp` | `artillery-impact.png` | Resize to 1280×800, WebP quality 82 |
| `workshop.webp` | `workshop-room.png` | Resize to 1280×800, WebP quality 82 |

Only resizing/compression was applied with the existing sharp dependency. Original PNGs, browser logs, and adapter details are retained locally under ignored `artifacts/release/gallery/`. The three published images total 170,678 bytes. The repository gate caps this directory at 1 MB and individual images at 400 KB.

Screenshots show project visuals and generated workshop props; [media provenance](../media.md) and [third-party notices](../../THIRD_PARTY.md) explain their sources. They are promotional documentation for this project; the root source-code license does not automatically relicense depicted media.
