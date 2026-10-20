/** The whole game owns pointer gestures, including releases over menus and overlays. */
export function bindGameBrowserInput(target: EventTarget): () => void {
  const prevent = (event: Event) => event.preventDefault();
  const options = { capture: true, passive: false };
  const events = ['contextmenu', 'selectstart', 'dragstart'] as const;
  for (const type of events) target.addEventListener(type, prevent, options);
  return () => { for (const type of events) target.removeEventListener(type, prevent, options); };
}
