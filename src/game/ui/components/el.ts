/** A tiny hyperscript helper: DOM nodes without innerHTML, so text is never parsed as markup. */
export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | null | undefined | EventListener | ((event: never) => void)>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}
export function append(node: Node & ParentNode, children: readonly Child[]): void {
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(typeof child === 'object' ? child : String(child));
}
/** Replaces an element's children. */
export function fill(node: Element, ...children: Child[]): void {
  node.replaceChildren();
  append(node, children);
}
/** Sets text only when it changed (the HUD refreshes ten times a second). */
export function setText(node: Element | null | undefined, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
