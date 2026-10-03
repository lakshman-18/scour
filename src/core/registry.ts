import type { Adapter } from './types.js';

/**
 * Adapter registry. Highest priority match wins, so a site-specific adapter
 * always beats the generic one. Adding a platform is one `register()` call.
 */
export class Registry {
  private adapters: Adapter[] = [];

  register(...adapters: Adapter[]): this {
    this.adapters.push(...adapters);
    this.adapters.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return this;
  }

  resolve(url: URL): Adapter {
    const hit = this.adapters.find((a) => {
      try {
        return a.match(url);
      } catch {
        return false;
      }
    });
    if (!hit) throw new Error(`No adapter matched ${url.href} (is the generic adapter registered?)`);
    return hit;
  }

  byName(name: string): Adapter | undefined {
    return this.adapters.find((a) => a.name === name);
  }

  get all(): Adapter[] {
    return [...this.adapters];
  }

  /** Adapters that expose a `search()`. */
  get searchable(): Adapter[] {
    return this.adapters.filter((a) => typeof a.search === 'function');
  }
}
