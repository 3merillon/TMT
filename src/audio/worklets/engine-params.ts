/** Shared between the main thread (loops.ts) and the render thread (engine-processor.ts): the processor name and its
 * k-rate parameters. Kept apart so the main bundle never imports the processor module (which calls registerProcessor). */
export const ENGINE_PROCESSOR = 'tmt-engine';
export const ENGINE_PARAMS = ['fundamental', 'load', 'tread', 'slip', 'servo', 'level', 'turn', 'damage'] as const;
export type EngineParamName = (typeof ENGINE_PARAMS)[number];
export const ENGINE_PARAM_DESCRIPTORS: readonly { name: EngineParamName; defaultValue: number; minValue: number; maxValue: number; automationRate: 'k-rate' }[] = [
  { name: 'fundamental', defaultValue: 50, minValue: 10, maxValue: 400, automationRate: 'k-rate' },
  { name: 'load', defaultValue: 0.25, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  { name: 'tread', defaultValue: 0, minValue: 0, maxValue: 80, automationRate: 'k-rate' },
  { name: 'slip', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  { name: 'servo', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  { name: 'level', defaultValue: 0, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
  /** Hard-turn intensity 0..1 (yaw rate against track speed): metallic track clatter. */
  { name: 'turn', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
  /** Damage 0..1 (low health): uneven firing, misfires and backfires. */
  { name: 'damage', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
];
