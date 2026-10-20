/** Resident terrain diagnostics switches. The global connectivity/seam oracle is O(world): it never runs inside an
 * edit, only at idle behind ?residentCheck=1 (browser qualification) or when a test enables it explicitly. */
let override: boolean | undefined;
export function setResidentOracle(enabled: boolean | undefined): void { override = enabled; }
export function residentOracleEnabled(): boolean {
  if (override !== undefined) return override;
  const search = (globalThis as { location?: { search?: string } }).location?.search;
  return typeof search === 'string' && new URLSearchParams(search).has('residentCheck');
}
