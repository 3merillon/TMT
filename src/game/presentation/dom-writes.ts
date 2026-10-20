/**
 * Per-frame DOM writes of the world overlays (labels, readouts) that skip values already written: a style write
 * invalidates style, and the next layout read pays for it. Only these helpers may write the properties they track.
 */
export function setHidden(element: HTMLElement, hidden: boolean): void { if (element.hidden !== hidden) element.hidden = hidden; }

const written = new WeakMap<HTMLElement, Record<string, string>>();
export function setStyle(element: HTMLElement, property: 'transform' | 'width' | 'height', value: string): void {
  let styles = written.get(element);
  if (!styles) written.set(element, styles = {});
  if (styles[property] === value) return;
  styles[property] = value;
  element.style[property] = value;
}

export function setData(element: HTMLElement, key: string, value: string): void { if (element.dataset[key] !== value) element.dataset[key] = value; }
