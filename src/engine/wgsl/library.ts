/** WgslLibrary: a name → module registry so streams can depend on each other's WGSL by name (plus link()). */
import type { LinkedWgsl, WgslLibrary, WgslModule } from '../contracts';
import { link } from './module';

export class WgslRegistry implements WgslLibrary {
  private readonly modules = new Map<string, WgslModule>();

  constructor(initial: readonly WgslModule[] = []) {
    for (const m of initial) this.register(m);
  }

  register(m: WgslModule): void {
    const seen = this.modules.get(m.name);
    if (seen && seen.code !== m.code) throw new Error(`WgslLibrary: module "${m.name}" is already registered with different code`);
    this.modules.set(m.name, m);
    for (const d of m.deps) if (!this.modules.has(d.name)) this.register(d);
  }

  get(name: string): WgslModule | undefined { return this.modules.get(name); }

  names(): string[] { return [...this.modules.keys()].sort(); }

  link(...roots: (WgslModule | string)[]): LinkedWgsl {
    return link(...roots.map(r => {
      if (typeof r !== 'string') return r;
      const m = this.modules.get(r);
      if (!m) throw new Error(`WgslLibrary: unknown module "${r}"`);
      return m;
    }));
  }
}
