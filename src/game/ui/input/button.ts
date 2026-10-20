/** HUD presses must also work for a second finger: browsers may omit its compatibility click. */
export function bindButtonPress(button: HTMLButtonElement, press: () => void): () => void {
  let pointer: number | null = null;
  let lastTouchUp = -Infinity;
  const reset = () => {
    const id = pointer;
    pointer = null;
    try { if (id !== null && button.hasPointerCapture(id)) button.releasePointerCapture(id); } catch { /* detached */ }
  };
  const down = (event: PointerEvent) => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0 || button.disabled || pointer !== null) return;
    event.preventDefault();
    pointer = event.pointerId;
    try { button.setPointerCapture(pointer); } catch { /* synthetic events */ }
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    lastTouchUp = performance.now();
    reset();
    const rect = button.getBoundingClientRect();
    if (!button.disabled && event.clientX >= rect.left && event.clientX < rect.right && event.clientY >= rect.top && event.clientY < rect.bottom) press();
  };
  const cancel = (event: PointerEvent) => { if (event.pointerId === pointer) reset(); };
  const click = (event: MouseEvent) => {
    const type = (event as PointerEvent).pointerType;
    // Pointer releases above already activate touch/pen. Older browsers may omit the click's pointerType.
    if (type === 'touch' || type === 'pen' || (event.detail > 0 && type !== 'mouse' && performance.now() - lastTouchUp < 500)) {
      event.preventDefault();
      return;
    }
    if (!button.disabled) press();
  };
  const doc = button.ownerDocument, win = doc.defaultView;
  const visibility = () => { if (doc.hidden) reset(); };
  button.addEventListener('pointerdown', down);
  button.addEventListener('pointerup', up);
  button.addEventListener('pointercancel', cancel);
  button.addEventListener('lostpointercapture', cancel);
  button.addEventListener('click', click);
  win?.addEventListener('blur', reset);
  doc.addEventListener('visibilitychange', visibility);
  return () => {
    reset();
    button.removeEventListener('pointerdown', down);
    button.removeEventListener('pointerup', up);
    button.removeEventListener('pointercancel', cancel);
    button.removeEventListener('lostpointercapture', cancel);
    button.removeEventListener('click', click);
    win?.removeEventListener('blur', reset);
    doc.removeEventListener('visibilitychange', visibility);
  };
}
