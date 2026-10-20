# Third-party materials

This inventory records the locked runtime dependencies and source-build tools for Tiny Metal Tank. Package versions and SPDX license expressions come from the local npm package metadata and offline Cargo metadata for the checked-in lockfiles. Recheck it when either lockfile changes.

## Looptile procedural noise

The periodic tile noise in `src/engine/wgsl/common/noise.wgsl.ts` adapts modular Worley tiling and domain-warp ideas from the same author's looptile project. The original MIT notice is preserved verbatim below and in the shipped notice file. The adaptation uses native WGSL and does not include looptile's water/lava presets or an Ashima Arts/Ian McEwan 4D simplex implementation.

```text
MIT License

Copyright (c) 2026 3merillon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Browser runtime

The browser bundle includes the Rapier JavaScript compatibility package. Its original package license text is copied verbatim under `public/licenses/third-party/npm/` and is also served with the game.

| Package | License | Source | Local license text |
|---|---|---|---|
| [@dimforge/rapier3d-compat 0.20.0](https://www.npmjs.com/package/@dimforge/rapier3d-compat/v/0.20.0) | Apache-2.0 | [rapier.js](https://github.com/dimforge/rapier.js) | [LICENSE](public/licenses/third-party/npm/rapier3d-compat/LICENSE) |

## Adapted Three.js math

The game uses local scalar camera, transform, quaternion, and triangle-query routines adapted from Three.js r180. The original MIT notice, Copyright © 2010-2025 three.js authors, remains verbatim in [the served license](public/licenses/third-party/npm/three/LICENSE) and is indexed in the shipped notices. This attribution applies to the adapted routines even though the Three.js package itself is excluded from the production game bundle.

[Three.js 0.180.0](https://github.com/mrdoob/three.js/tree/r180) remains a development dependency for diagnostic lab renderers and test oracles. Its package license is also MIT; it is listed with the build and test tools below.

## Rust WebAssembly dependency graph

The table lists the 46 third-party packages in the normal dependency graph for `rust/terrain-core` targeting `wasm32-unknown-unknown`, including transitive and procedural-macro packages. The SPDX expressions are taken from each locked crate's Cargo metadata. License files supplied with the local crate package are copied verbatim. For the crate archives that omitted license text files, the listed license files were copied from the upstream repositories linked on their crates.io package pages. The source link for each package points to its locked crates.io version.

| Crate | SPDX license expression | Local license text |
|---|---|---|
| [approx 0.5.1](https://crates.io/crates/approx/0.5.1) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/approx-0.5.1/LICENSE) |
| [arrayvec 0.7.8](https://crates.io/crates/arrayvec/0.7.8) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/arrayvec-0.7.8/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/arrayvec-0.7.8/LICENSE-MIT) |
| [bitflags 2.13.2](https://crates.io/crates/bitflags/2.13.2) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/bitflags-2.13.2/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/bitflags-2.13.2/LICENSE-MIT) |
| [bytemuck 1.25.2](https://crates.io/crates/bytemuck/1.25.2) | Zlib OR Apache-2.0 OR MIT | [LICENSE-APACHE](public/licenses/third-party/rust/bytemuck-1.25.2/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/bytemuck-1.25.2/LICENSE-MIT), [LICENSE-ZLIB](public/licenses/third-party/rust/bytemuck-1.25.2/LICENSE-ZLIB) |
| [byteorder 1.5.0](https://crates.io/crates/byteorder/1.5.0) | Unlicense OR MIT | [COPYING](public/licenses/third-party/rust/byteorder-1.5.0/COPYING), [LICENSE-MIT](public/licenses/third-party/rust/byteorder-1.5.0/LICENSE-MIT) |
| [downcast-rs 2.0.2](https://crates.io/crates/downcast-rs/2.0.2) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/downcast-rs-2.0.2/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/downcast-rs-2.0.2/LICENSE-MIT) |
| [either 1.19.0](https://crates.io/crates/either/1.19.0) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/either-1.19.0/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/either-1.19.0/LICENSE-MIT) |
| [ena 0.14.4](https://crates.io/crates/ena/0.14.4) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/ena-0.14.4/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/ena-0.14.4/LICENSE-MIT) |
| [foldhash 0.2.0](https://crates.io/crates/foldhash/0.2.0) | Zlib | [LICENSE](public/licenses/third-party/rust/foldhash-0.2.0/LICENSE) |
| [glam 0.33.12](https://crates.io/crates/glam/0.33.12) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/glam-0.33.12/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/glam-0.33.12/LICENSE-MIT) |
| [glamx 0.3.1](https://crates.io/crates/glamx/0.3.1) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/glamx-0.3.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/glamx-0.3.1/LICENSE-MIT) |
| [hash32 0.3.1](https://crates.io/crates/hash32/0.3.1) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/hash32-0.3.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/hash32-0.3.1/LICENSE-MIT) |
| [hashbrown 0.17.1](https://crates.io/crates/hashbrown/0.17.1) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/hashbrown-0.17.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/hashbrown-0.17.1/LICENSE-MIT) |
| [heapless 0.8.0](https://crates.io/crates/heapless/0.8.0) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/heapless-0.8.0/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/heapless-0.8.0/LICENSE-MIT) |
| [libm 0.2.16](https://crates.io/crates/libm/0.2.16) | MIT | [LICENSE.txt](public/licenses/third-party/rust/libm-0.2.16/LICENSE.txt) |
| [log 0.4.34](https://crates.io/crates/log/0.4.34) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/log-0.4.34/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/log-0.4.34/LICENSE-MIT) |
| [matrixmultiply 0.3.11](https://crates.io/crates/matrixmultiply/0.3.11) | MIT/Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/matrixmultiply-0.3.11/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/matrixmultiply-0.3.11/LICENSE-MIT) |
| [nalgebra 0.35.0](https://crates.io/crates/nalgebra/0.35.0) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/nalgebra-0.35.0/LICENSE) |
| [nalgebra-macros 0.3.0](https://crates.io/crates/nalgebra-macros/0.3.0) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/nalgebra-macros-0.3.0/LICENSE) |
| [num-bigint 0.4.6](https://crates.io/crates/num-bigint/0.4.6) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-bigint-0.4.6/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-bigint-0.4.6/LICENSE-MIT) |
| [num-complex 0.4.6](https://crates.io/crates/num-complex/0.4.6) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-complex-0.4.6/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-complex-0.4.6/LICENSE-MIT) |
| [num-derive 0.4.2](https://crates.io/crates/num-derive/0.4.2) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-derive-0.4.2/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-derive-0.4.2/LICENSE-MIT) |
| [num-integer 0.1.47](https://crates.io/crates/num-integer/0.1.47) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-integer-0.1.47/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-integer-0.1.47/LICENSE-MIT) |
| [num-rational 0.4.2](https://crates.io/crates/num-rational/0.4.2) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-rational-0.4.2/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-rational-0.4.2/LICENSE-MIT) |
| [num-traits 0.2.19](https://crates.io/crates/num-traits/0.2.19) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/num-traits-0.2.19/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/num-traits-0.2.19/LICENSE-MIT) |
| [ordered-float 5.5.0](https://crates.io/crates/ordered-float/5.5.0) | MIT | [LICENSE-MIT](public/licenses/third-party/rust/ordered-float-5.5.0/LICENSE-MIT) |
| [parry3d 0.30.2](https://crates.io/crates/parry3d/0.30.2) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/parry3d-0.30.2/LICENSE) |
| [proc-macro2 1.0.107](https://crates.io/crates/proc-macro2/1.0.107) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/proc-macro2-1.0.107/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/proc-macro2-1.0.107/LICENSE-MIT) |
| [profiling 1.0.18](https://crates.io/crates/profiling/1.0.18) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/profiling-1.0.18/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/profiling-1.0.18/LICENSE-MIT) |
| [profiling-procmacros 1.0.18](https://crates.io/crates/profiling-procmacros/1.0.18) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/profiling-procmacros-1.0.18/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/profiling-procmacros-1.0.18/LICENSE-MIT) |
| [quote 1.0.47](https://crates.io/crates/quote/1.0.47) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/quote-1.0.47/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/quote-1.0.47/LICENSE-MIT) |
| [rapier3d 0.35.1](https://crates.io/crates/rapier3d/0.35.1) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/rapier3d-0.35.1/LICENSE) |
| [rawpointer 0.2.1](https://crates.io/crates/rawpointer/0.2.1) | MIT/Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/rawpointer-0.2.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/rawpointer-0.2.1/LICENSE-MIT) |
| [rstar 0.13.0](https://crates.io/crates/rstar/0.13.0) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/rstar-0.13.0/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/rstar-0.13.0/LICENSE-MIT) |
| [simba 0.10.2](https://crates.io/crates/simba/0.10.2) | Apache-2.0 | [LICENSE](public/licenses/third-party/rust/simba-0.10.2/LICENSE) |
| [slab 0.4.12](https://crates.io/crates/slab/0.4.12) | MIT | [LICENSE](public/licenses/third-party/rust/slab-0.4.12/LICENSE) |
| [smallvec 1.16.3](https://crates.io/crates/smallvec/1.16.3) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/smallvec-1.16.3/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/smallvec-1.16.3/LICENSE-MIT) |
| [stable_deref_trait 1.2.1](https://crates.io/crates/stable_deref_trait/1.2.1) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/stable_deref_trait-1.2.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/stable_deref_trait-1.2.1/LICENSE-MIT) |
| [static_assertions 1.1.0](https://crates.io/crates/static_assertions/1.1.0) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/static_assertions-1.1.0/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/static_assertions-1.1.0/LICENSE-MIT) |
| [syn 2.0.119](https://crates.io/crates/syn/2.0.119) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/syn-2.0.119/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/syn-2.0.119/LICENSE-MIT) |
| [syn 3.0.9](https://crates.io/crates/syn/3.0.9) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/syn-3.0.9/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/syn-3.0.9/LICENSE-MIT) |
| [thiserror 2.0.21](https://crates.io/crates/thiserror/2.0.21) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/thiserror-2.0.21/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/thiserror-2.0.21/LICENSE-MIT) |
| [thiserror-impl 2.0.21](https://crates.io/crates/thiserror-impl/2.0.21) | MIT OR Apache-2.0 | [LICENSE-APACHE](public/licenses/third-party/rust/thiserror-impl-2.0.21/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/thiserror-impl-2.0.21/LICENSE-MIT) |
| [typenum 1.20.1](https://crates.io/crates/typenum/1.20.1) | MIT OR Apache-2.0 | [LICENSE](public/licenses/third-party/rust/typenum-1.20.1/LICENSE), [LICENSE-APACHE](public/licenses/third-party/rust/typenum-1.20.1/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/typenum-1.20.1/LICENSE-MIT) |
| [unicode-ident 1.0.27](https://crates.io/crates/unicode-ident/1.0.27) | (MIT OR Apache-2.0) AND Unicode-3.0 | [LICENSE-APACHE](public/licenses/third-party/rust/unicode-ident-1.0.27/LICENSE-APACHE), [LICENSE-MIT](public/licenses/third-party/rust/unicode-ident-1.0.27/LICENSE-MIT), [LICENSE-UNICODE](public/licenses/third-party/rust/unicode-ident-1.0.27/LICENSE-UNICODE) |
| [wide 1.7.1](https://crates.io/crates/wide/1.7.1) | Zlib OR Apache-2.0 OR MIT | [LICENSE-APACHE.txt](public/licenses/third-party/rust/wide-1.7.1/LICENSE-APACHE.txt), [LICENSE-MIT.txt](public/licenses/third-party/rust/wide-1.7.1/LICENSE-MIT.txt), [LICENSE-ZLIB.txt](public/licenses/third-party/rust/wide-1.7.1/LICENSE-ZLIB.txt) |

The realtime Rust crate currently has no third-party Cargo dependencies. Its root license metadata is separate from this inventory.

## Build and test tools

These are direct `devDependencies`; they support local build, asset preparation, type checking, browser capture, and tests. They are not included in the deployed browser bundle. Their locked local package versions and license metadata are listed separately to distinguish them from runtime packages.

| Package | License metadata |
|---|---|
| `@cloudflare/workers-types` 5.20261016.1 | MIT OR Apache-2.0 |
| `@types/node` 22.20.4 | MIT |
| `@types/three` 0.180.0 | MIT |
| `esbuild` 0.28.2 | MIT |
| `magic-string` 0.30.21 | MIT |
| `meshoptimizer` 1.2.0 | MIT |
| `miniflare` 5.20261012.1-beta | MIT |
| `playwright-core` 1.61.0 | Apache-2.0 |
| `sharp` 0.35.5 | Apache-2.0 |
| `three` 0.180.0 | MIT |
| `tsx` 4.23.15 | MIT |
| `typescript` 5.9.3 | Apache-2.0 |
| `vite` 7.3.6 | MIT |
| `vitest` 4.1.11 | MIT |
| `wrangler` 4.151.1 | MIT OR Apache-2.0 |

The Rust build graph is included conservatively as provenance; it contains procedural-macro crates used during compilation as well as runtime dependencies. See [public/THIRD-PARTY-NOTICES.txt](public/THIRD-PARTY-NOTICES.txt) for the shipped notice index. Existing shader and campaign speech notices remain in that file and in `public/audio/campaign/`.

## Generated workshop art

The public workshop package includes props generated with Meshy 7.1. Their source models, task provenance and credit record are in `assets/workshop/`; the build packs these models into `public/workshop/`. On 2026-10-18, the user confirmed that the assets were generated under a paid plan and none were published to Meshy's Community. Their use remains subject to the applicable [Meshy terms](https://www.meshy.ai/terms-of-use) and [generated-model ownership conditions](https://help.meshy.ai/en/articles/10137554-what-is-the-ownership-of-the-generated-models), including the condition that inputs do not infringe third-party rights. These generated assets are not covered by the source-code license. See [the recorded provenance](assets/workshop/meshy/provenance.txt).
