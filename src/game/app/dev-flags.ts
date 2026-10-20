/**
 * play.html URL parameters (deep links every capture plan relies on): ?mode=drive|local|bot, ?seed=<n>, ?residentCheck.
 * Rendering dev: ?dev (the live panel, app/dev-panel.ts, with ?view= and ?off=), ?lightView=, ?dayOffset=, ?sdfSize=.
 */
export type PracticeMode = 'bot' | 'local' | 'drive';
const params = () => new URLSearchParams(location.search);

export const devFlags = {
  /** Mode of the first match. The shell rewrites ?mode as the mode changes, keeping ?seed. */
  mode: ((mode: string | null): PracticeMode => mode === 'drive' || mode === 'local' ? mode : 'bot')(params().get('mode')),
  /** Publishes resident terrain diagnostics as JSON in #resident-diagnostics. */
  residentCheck: params().has('residentCheck'),
  /** The live rendering panel: views, effect switches, time of day (app/dev-panel.ts). */
  devPanel: params().has('dev') || params().get('mode') === 'dev',
};

/** ?seed pins every match to one planet; without it each new match draws a fresh random seed. */
export function matchSeed(): number {
  const configured = params().get('seed');
  return configured === null ? crypto.getRandomValues(new Uint32Array(1))[0] : Number(configured);
}
