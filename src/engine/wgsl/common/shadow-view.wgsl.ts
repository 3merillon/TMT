/**
 * Light-view uniforms bound at @group(0) of every depth-only shadow pass (ShadowView.bindGroup, layout
 * ctx.layouts.shadowView). Casters read only `view_proj`; the owner of the view fills the rest.
 * Raster convention: SHADOW_DEPTH (depth32float, reversed-Z: clear 0, compare 'greater').
 */
import { makeModule, wgslStruct } from '../module';

export const SHADOW_VIEW_UNIFORMS = wgslStruct('ShadowViewUniforms', [
  ['view_proj', 'mat4x4f'],
  ['light_dir', 'vec4f'],   // xyz toward the light, w = world size of one texel
  ['params', 'vec4f'],      // free for the view owner (bias, kind, ...)
]);

export const shadowViewWgsl = makeModule('shadow-view', /* wgsl */ `
@group(0) @binding(0) var<uniform> shadow_view: ShadowViewUniforms;
`, [SHADOW_VIEW_UNIFORMS.module]);
