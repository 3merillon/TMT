# Media inventory and provenance

The current public inventory was checked on 18 October 2026 during final release polish. Sizes are file bytes (decimal MB). Earlier source inventories and loading measurements are labeled below; [release readiness](release-readiness.md) separates fresh checks from prior evidence.

## What ships

Vite copies all of `public/` into the production output, including any ignored files left there. The current directory contains 351 files totaling 52,680,238 bytes (52.68 MB), including manifests and license notices. Its main media groups are:

| Public media | Files | Bytes | Notes |
|---|---:|---:|---|
| `public/audio/` | 206 | 40,641,936 | Music, sound effects, campaign dialogue, manifests, and notices |
| `public/workshop/` | 45 | 7,678,628 | Compact runtime room, textures, and manifest |
| `public/brand/` | 8 | 3,690,221 | Product identity and favicon images |

There are no tracked video files (`mp4`, `webm`, `mov`, `m4v`, `avi`, or `mkv`). README images are captures of the actual game; [capture details](images/README.md) record their source.

## Sources and provenance

The score and sound effects are synthesized by the checked-in `scripts/audio-forge` recipes. [Audio continuity](audio-continuity.md) records their original procedural compositions, integration contracts and rebuild commands, with no downloaded or sampled recordings. Lossless masters, alternate mixes, previews, and analysis belong in ignored artifacts or an external working directory; the game ships only the Ogg files and small manifests.

Procedural terrain noise adapts modular Worley tiling and domain-warp ideas from the same author's MIT-licensed looptile project. The current implementation is in `src/engine/wgsl/common/noise.wgsl.ts`. Its attribution and complete license are retained in [the source notices](../THIRD_PARTY.md#looptile-procedural-noise) and [the shipped notices](../public/THIRD-PARTY-NOTICES.txt).

Campaign speech is generated offline. `public/audio/campaign/NOTICE.txt`, its Apache-2.0, HeadTTS, and Misaki license texts, and `manifest.json` record the pinned Kokoro model revision and pipeline. Model weights and the inference runtime are not shipped. The notice also records upstream dataset acknowledgements; those datasets are not included.

The workshop scene is built from authored Blender source, local texture sources, and seven Meshy 7.1 generated props. `assets/workshop/meshy/provenance.txt` and `receipts.json` record the reference-image origin, model settings, task IDs and generation receipts. The source props and Blender project are used by the workshop export tooling and must remain available for regeneration. They are not copied into `public/`; the game downloads the compact package from `public/workshop/`. On 18 October 2026 the owner confirmed these assets were generated on a paid Meshy plan and were not published to Meshy Community. Meshy's [ownership guidance](https://help.meshy.ai/en/articles/10137554-what-is-the-ownership-of-the-generated-models) and [terms](https://www.meshy.ai/terms-of-use) describe paid-plan ownership subject to rights in the inputs. These art files are outside the source-code MIT grant; obtain an explicit art reuse license from the maintainer before redistributing them separately. Retain provenance and third-party notices.

## Source size and runtime loading

The Blender source retains editable scenes, materials and texture references for regeneration. Its saved file-browser directory is cleared before export so workstation home paths are not distributed. Runtime WASM builds remap compiler source paths to generic build locations; the repository gate rejects binaries containing personal home-directory paths.

At baseline, tracked raster, vector, audio, and 3D media totaled 634,058,511 bytes (634.1 MB). The `assets/` subset is 578,197,708 bytes (578.2 MB), of which `assets/workshop/` is 571,648,484 bytes (571.6 MB). Seven Meshy GLBs alone are 249,595,216 bytes (249.6 MB); the editable workshop `.blend` is about 25 MB. These are source/build inputs, not production downloads. The small public package is the deployable workshop asset set.

| Loading path | Initial behavior |
|---|---|
| Score music | The title score begins after audio starts and fetches only the active track's stems. The score cache targets 128 MiB; active, retiring and pending decks can temporarily exceed it. Later tracks load as scenes change. |
| Campaign dialogue | Fetches and decodes only the requested voice clip; the voice cache keeps at most 12 decoded clips. |
| Sound effects | `TankAudioIntegrator.start()` starts both public Ogg banks in parallel after the audio engine starts: about 1.7 MB encoded and 32.4 MB decoded at the browser's audio rate. Procedural recipes cover sounds until their bank is ready. |
| Workshop room | The title schedules low-priority prefetch of the workshop scene code and full `public/workshop` package after 1.5 seconds and idle time, unless Save-Data is enabled. Hover/focus/open also prefetches it, and its renderer may prewarm after battle-renderer initialization. Source GLBs, Blender projects, original maps, and references are never browser downloads. |

The application has a bounded eager audio cost after the user starts audio: the two SFX banks. The score and spoken dialogue are loaded on demand. Loading byte/memory figures above are recorded preparation measurements, not newly measured transfer or memory use. Earlier release preparation removed a byte-identical 2,010,357-byte gauge-image source duplicate, six reproducible reflection preview PNGs, and an ignored obsolete 759,690-byte WASM artifact that Vite was still shipping. Originals were preserved outside the checkout; the canonical texture, reflection EXRs, and build sources remain. No runtime artwork/audio was replaced or reduced. See the release report for comparable totals. At preparation time, `git count-objects -vH` reported an 818.40 MiB packed Git object database for the whole repository. Git does not report a media-only historical cost in that summary, and no history rewrite was performed.


## Release budgets and optional media

`npm run verify:repo` enforces `budgets/repository.json`: public payload at most 54,000,000 bytes; source assets at most 700,000,000 bytes; source GLBs at most 270,000,000 bytes; documentation images at most 1,000,000 bytes total and 400,000 bytes each. Video formats are ignored and rejected by default; an explicit allowlist entry is required alongside verified rights before adding one. The checker scans the physical public directory because Vite also copies ignored files there.

Keep development recordings in ignored `artifacts/` or outside the checkout. Any video proposed for distribution needs a source, license, and checksum record before it can be added to the release package.
