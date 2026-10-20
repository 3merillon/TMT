# Algorithm and robustness contract

This describes the exact TypeScript reference kernel in [`src/core`](../src/core/), retained for geometry verification and comparison. The game's current Rust/WASM resident terrain has separate ownership and numeric limits described in [architecture](architecture.md#terrain-and-simulation). The two paths share implicit-arrangement concepts; this reference contract does not certify every runtime terrain operation.

## Representation

A scene stores primitive functions `f_i`, material IDs, and a Boolean expression. Inside is `f_i <= 0`. The octree covers a finite rectangular domain. Every tetrahedral vertex has a globally shared position and exactly one sample of each primitive per extraction batch. An affine primitive can additionally provide coefficients, evaluated exactly by the kernel.

For curved fields, the represented function within tetrahedron T is

`f_i^T(x) = sum_j lambda_j(x) * sample_i(vertex_j)`.

These are separate functions; TMT never interpolates `min(f_A, f_B)` or `max(f_A, -f_B)` as a replacement for their arrangement. The Boolean expression is evaluated on region signs after the planes intersect. This preserves the intersection edge in the chosen piecewise-linear representation.

## 1. Adaptive octree

An interval range excluding zero certifies that a primitive has no boundary in a cell. Cells intersecting a primitive refine when its supplied interpolation-error bound exceeds the requested tolerance. A curved field with a zero-containing range and same-sign corner samples also triggers refinement, guarding against an enclosed feature. User refinement constraints allow spatial LOD experiments. Unknown range/error information forces conservative refinement to the depth cap and marks the result uncertified.

For the sphere field `||x-c||²-r²`, the interpolation error on any simplex inside an axis-aligned cell is bounded by `sum_axis(width_axis²)/4`, plus a floating evaluation allowance. This follows from the variance bound for a coordinate confined to an interval. Plane interpolation is exact when coefficients are authoritative.

The terrain field adds six oblique sine waves: `f(x) = ||x-c||²-r² + sum_j a_j sin(k_j·(x-c)+phase_j)`. An integer seed sets repeatable phases; bumpiness controls total amplitude and terrain detail scales the wave vectors. With `sum |a_j| = bumpiness*r²` and bumpiness at most 0.9, the surface stays within radii `r*sqrt(1-bumpiness)` and `r*sqrt(1+bumpiness)`. The center stays inside; this does not assert star-shapedness or forbid additional components at high detail.

Each wave contributes at most `|a_j|*(sum_axis |k_j,axis|*width_axis)²/8` to the interpolation error, by the scalar Taylor remainder and projected barycentric variance bound. Ranges combine the sphere interval with sine's 1-Lipschitz enclosures and intersect that result with a midpoint Taylor enclosure using the total gradient. Outward rounding and a floating safety allowance protect routine numeric evaluation. JavaScript's `sin`/`cos` are not a formally certified interval math library: the bound implementation assumes ordinary engine accuracy at lab scales. Regression tests check samples, gradients, arbitrary-simplex interpolation and matching complementary terrain cuts. No change is made to the exact rational arrangement after sampling.

These field-value bounds do **not** establish Hausdorff error or isotopy of the analytic Boolean surface. In particular, small scalar errors near tangencies may change contact topology. Certifying analytic topology requires additional gradient/transversality bounds and interval subdivision of intersection strata. A custom function's supplied bounds are a contract with its author, not something arbitrary black-box sampling can prove.

## 2. Conforming tetrahedralization

1. Start with dyadic octree leaf cubes.
2. Partition each shared face into rectangles at the finer neighbor's face resolution. Both owners refer to the same patch.
3. Register every patch corner on its global axis-aligned edge line.
4. Insert every registered point lying on every patch perimeter. This step handles a third finer leaf meeting an edge, which face-neighbor matching alone misses.
5. Fan each face patch from its shared center through the segmented perimeter.
6. Cone each face triangle to the owning leaf's interior center.

Each internal triangular face has two tetrahedral owners, on opposite sides. Every other face lies on the domain boundary. The face triangulation is shared before contour extraction, so there is no contour stitching pass and no LOD cap to conceal cracks. Root/face/cell positions are registered by integer or half-integer lattice coordinates; all subsequent identity is exact rational world position.

The exact kernel maps authoritative lattice coordinates into the domain using rational arithmetic. Rounding a symmetric domain such as `[-1.6, 1.6]` into floating world coordinates first can create spurious micro-slivers; retaining the lattice avoids this failure. Floating grid coordinates remain available for callbacks and display.

The implementation does not require 2:1 balancing. Arbitrarily deep transitions can create poor tetrahedron aspect ratios, but topology remains conforming. Aspect-ratio optimization is a later performance/quality concern.

## 3. Exact volume arrangement

Begin with each tetrahedron as a convex polyhedron. For each primitive's affine restriction:

1. Evaluate its sign at each exact polyhedron vertex.
2. If vertices occur on both sides, clip every polygonal face into both half-spaces and construct the intersection cap.
3. Retain both full-dimensional convex children with their sign labels.
4. Otherwise retain the region with its existing geometry and constant sign, including a declared zero plateau.

Intersections, polygon order, orientation and classification use reduced BigInt rationals. The input floating values are decoded as their exact binary rationals. There is no epsilon offset for deciding which material is across a thin sheet. Coincident planes and exact-on-vertex/edge/face cases follow the same clipping rules.

An arrangement of `k` planes in 3D has polynomial worst-case cell complexity O(k³); the actual implementation also pays for per-face clipping and arbitrary-precision arithmetic. It is deliberately a reference kernel. There is no throughput guarantee for long histories of explosions.

## 4. Labels and extraction

Evaluate the expression in each full-dimensional convex region. Material 0 is air. Union and intersection select the left or right operand's material in their overlap (left by default). Difference retains the left material only when the right is empty. A `material` expression node overrides the label only where its child is occupied. These nodes change labels, not geometry; both operands' layer boundaries remain in the shared arrangement.

Cancel matching polygon faces when both incident regions have the same material. Emit a boundary face when exactly one side is air, and retain a labeled material interface when both are solid with different materials. Domain exterior is treated as air.

Faces are matched by their exact vertex coordinates. All collinear polygon-perimeter vertices are retained. Each emitted polygon is triangulated by an exact centroid fan, preserving boundary segmentation. This avoids creating T-junctions by discarding an apparently redundant boundary vertex. It spends more triangles than optimized constrained triangulation would.

Material interface polygons are available in `SurfaceMesh.interfaces`. Exterior rendering uses `faceSources` to keep normals separate across primitive intersections and `faceMaterials` for the occupied-side volume label. `faceOtherMaterials` is air on exterior triangles; interface polygons explicitly store both occupied material IDs. `faceSourceMaterials` retains the original primitive material separately. Thus a spherical cutter can expose several planetary materials without losing its geometric provenance. This reference mesh does not export full per-region volume cells/masses; internal interface labels are not a complete physics model. See the [mesh types](../src/core/types.ts) and [expression evaluator](../src/core/evaluator.ts).

## 5. Complementary explosions

Construct both `remaining = A \\ B` and `removed = A ∩ B` over the same primitive samples and grid. `meshArrangementMany` shares input validation, exact samples, tetrahedron partitions and geometric face matching across every requested expression. Only region labels and emitted outputs differ. Each output is independently closed for regular inputs, their cut surfaces agree with opposite orientation, and their signed volumes sum to the sampled original's signed volume.

For repeated explosions, preserve the expression for remaining terrain. For debris fragmentation, apply another paired split to the removed solid with one or more plane/volume cutters. Rigid-body motion belongs after extraction. Independently remeshing the two complementary objects at different LODs would break the matching-interface contract; retain the shared arrangement or synchronously refine their interface.

## Verification

The test suite checks input tetrahedron incidence, positive volume, total domain coverage, arbitrary octree transitions, hidden enclosed spheres, exact zeros and plateaus, coincident/opposite fields, Boolean identities, thin sheets, materials, sharp box faces, deterministic extraction, complementary volume and matching oriented seams.

The independent output audit checks edge incidence, opposite local winding, duplicate triangles, floating degeneracy, connected components, vertex-link cycles, Euler characteristic and signed volume. Edge incidence alone cannot detect two closed sheets touching at a vertex; vertex-link checks address that case. Signed volume is a reported diagnostic; `valid` alone does not rule out a globally inverted shell. These checks do not constitute a general analytic-topology or floating self-intersection proof.

The reference kernel is deliberately expensive. Exact predicates over sampled fields do not establish certified topology for arbitrary analytic fields, optimal triangulation, or realtime performance for long edit histories. Runtime terrain performance and failure handling must be qualified through the resident implementation and its tests.
