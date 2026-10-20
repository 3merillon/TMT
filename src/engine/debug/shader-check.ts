/**
 * Shader check: compile every pipeline in the warm-up list and collect the (module:line mapped) errors.
 * Used by the sandbox (`__tmtEngineSandbox.shaderCheck()`) and later by `?shaderCheck=1` in play.
 */
import type { PipelineCache, PipelineError } from '../gpu/pipeline-cache';

export interface ShaderCheckResult { pipelines: number; ok: boolean; errors: PipelineError[]; compileMs: { key: string; ms: number }[] }

export async function shaderCheck(cache: PipelineCache): Promise<ShaderCheckResult> {
  await cache.warmup();
  await cache.whenIdle();
  return { pipelines: cache.keys().length, ok: cache.errors.length === 0, errors: [...cache.errors], compileMs: cache.compileTimes() };
}
