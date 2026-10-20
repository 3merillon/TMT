/** The single status toast under the turn banner. */
import { byId } from './components/el';

let until = 0;
export function toast(message: string, seconds = 3): void {
  const node = byId('toast');
  node.textContent = message;
  node.classList.add('visible');
  until = performance.now() + seconds * 1000;
}
export function tickToast(now: number): void {
  if (now <= until) return;
  const node = document.getElementById('toast');
  if (node?.classList.contains('visible')) node.classList.remove('visible');
}
export function clearToast(): void { until = 0; tickToast(performance.now()); }
