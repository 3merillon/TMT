export type Vec3 = [number, number, number];
export type Triangle = [number, number, number];
export type Tet = [number, number, number, number];
export interface Bounds { min: Vec3; max: Vec3 }
/** Portable analytic primitive parameters, shared by field sampling and GPU shading. */
export type FieldDefinition =
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'affine'; normal: Vec3; offset: number }
  | { kind: 'terrain'; center: Vec3; radius: number; waves: { amplitude: number; k: Vec3; phase: number }[] }
  | { kind: 'offset'; child: FieldDefinition; offset: number };
export interface Field {
  id: string;
  name: string;
  material: number;
  sample(p: Vec3): number;
  /** Optional authoritative affine primitive; exact kernel evaluates its coefficients directly. */
  affine?: { normal: Vec3; offset: number };
  gradient?(p: Vec3): Vec3;
  definition?: FieldDefinition;
  /** Conservative analytic range. Custom fields without it cannot certify empty cells. */
  range?(bounds: Bounds): [number, number];
  /** Conservative affine interpolation error in field-value units, on any simplex in bounds. */
  interpolationError?(bounds: Bounds): number;
}
export type MaterialPreference = 'left' | 'right';
export type Expr = { op: 'leaf'; id: string } | { op: 'material'; child: Expr; material: number } | {
  op: 'union' | 'intersection' | 'difference'; left: Expr; right: Expr;
  materialPreference?: MaterialPreference;
};
export interface Material { id: number; name: string; color: string }
export interface Scene { fields: Field[]; expression: Expr; materials: Material[] }
export interface OctreeLeaf extends Bounds { origin: Vec3; size: number; depth: number; active: boolean }
export interface GridStats {
  leaves: number; activeLeaves: number; tetrahedra: number; vertices: number;
  depthHistogram: Record<number, number>; unresolvedCells: number; uncertifiedCells: number;
  maxInterpolationError: number; milliseconds: number;
}
export interface TetMesh {
  vertices: Vec3[]; tets: Tet[]; leaves: OctreeLeaf[]; stats: GridStats;
  /** Authoritative dyadic grid coordinates; avoids distortion from a rounded world transform. */
  lattice?: { vertices: Vec3[]; bounds: Bounds; resolution: number };
}
export interface SurfaceMesh {
  positions: Vec3[];
  /** Canonical rational x,y,z identity, retained for differential testing and exact JSON export. */
  exactPositionKeys?: string[];
  triangles: Triangle[];
  /** Material of the occupied volume adjacent to each exterior triangle. */
  faceMaterials: number[];
  /** Primitive appearance material, retained separately from volume material. */
  faceSourceMaterials: number[];
  faceSources: string[];
  /** Opposite side material; zero is exterior air. */
  faceOtherMaterials?: number[];
  /** Internal material boundaries, oriented from materials[0] to materials[1]. */
  interfaces?: { vertices: number[]; materials: [number, number]; source: string }[];
  stats: Record<string, number>;
}
export interface GridOptions {
  bounds: Bounds; maxDepth: number; minDepth?: number; tolerance: number;
  adaptive?: boolean;
  /** Refuse an approximation when depth exhaustion or unknown field bounds remain. */
  requireResolved?: boolean;
  /** Optional application refinement constraint, useful for localized LOD. */
  refine?(bounds: Bounds, depth: number): boolean;
}
export interface MeshAudit {
  vertices: number; triangles: number; edges: number; boundaryEdges: number;
  nonManifoldEdges: number; orientationErrors: number; degenerateTriangles: number;
  duplicateTriangles: number; nonManifoldVertices: number; components: number;
  eulerCharacteristic: number; signedVolume: number; valid: boolean;
}
