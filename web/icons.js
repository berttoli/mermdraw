// icons.js — installed Iconify packs (see `mermdraw icons add`): lazy loading,
// lookup for the canvas, search for the picker, and registration with mermaid.

export class IconStore {
  constructor(onLoad) {
    this.packs = new Map(); // name -> {name, source, size}
    this.data = new Map(); // name -> Iconify JSON
    this.loading = new Map();
    this.cache = new Map(); // "prefix:name" -> {body, w, h} | false
    this.onLoad = onLoad;
  }

  async refresh() {
    try {
      const r = await fetch('/api/icons');
      this.packs = new Map((await r.json()).packs.map((p) => [p.name, p]));
    } catch {
      this.packs = new Map();
    }
    return this.packs;
  }

  load(name) {
    if (this.data.has(name)) return Promise.resolve(this.data.get(name));
    if (!this.packs.has(name)) return Promise.resolve(null);
    if (!this.loading.has(name)) {
      const p = fetch(`/api/icons/${encodeURIComponent(name)}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((json) => {
          if (json?.icons) {
            this.data.set(name, json);
            this.onLoad?.(name);
          }
          return json;
        });
      this.loading.set(name, p);
    }
    return this.loading.get(name);
  }

  loadAll() {
    return Promise.all([...this.packs.keys()].map((n) => this.load(n)));
  }

  /**
   * Icon markup for "prefix:name": {body, w, h}; null while its pack loads
   * (onLoad fires when ready); false if the pack or icon isn't installed.
   */
  get(ref) {
    if (this.cache.has(ref)) return this.cache.get(ref);
    const i = String(ref).indexOf(':');
    if (i < 1) return false;
    const prefix = ref.slice(0, i);
    const pack = this.data.get(prefix);
    if (!pack) {
      if (!this.packs.has(prefix)) return false;
      this.load(prefix);
      return null;
    }
    let name = ref.slice(i + 1);
    for (let hops = 0; !pack.icons[name] && pack.aliases?.[name] && hops < 5; hops++) name = pack.aliases[name].parent;
    const icon = pack.icons[name];
    const out = icon ? { body: sanitize(icon.body), w: icon.width ?? pack.width ?? 16, h: icon.height ?? pack.height ?? 16 } : false;
    this.cache.set(ref, out);
    return out;
  }

  /** Ranked matches across installed packs: [{ref, name, prefix}]. */
  async search(query, limit = 96) {
    await this.loadAll();
    const terms = query.toLowerCase().split(/[\s:]+/).filter(Boolean);
    const out = [];
    for (const [prefix, pack] of this.data) {
      for (const name of [...Object.keys(pack.icons), ...Object.keys(pack.aliases || {})]) {
        if (/-wordmark$/.test(name) && !terms.some((t) => t.includes('word'))) continue;
        let score = 0;
        for (const t of terms) {
          if (name === t) score += 100;
          else if (name.startsWith(t)) score += 40;
          else if (name.includes(t)) score += 15;
          else if (t !== prefix) {
            score = -1;
            break;
          }
        }
        if (score < 0 || (!terms.length && out.length >= limit)) continue;
        out.push({ ref: `${prefix}:${name}`, name, prefix, score: score - name.length * 0.1 - (name.endsWith('-icon') ? 0 : 0.5) });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Lets mermaid's preview resolve the same packs. */
  registerWithMermaid(mermaid) {
    if (!this.packs.size || !mermaid.registerIconPacks) return;
    mermaid.registerIconPacks([...this.packs.keys()].map((name) => ({ name, loader: () => this.load(name) })));
  }
}

/** Icon bodies come from downloaded packs; strip anything executable. */
function sanitize(body) {
  return String(body)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/((?:xlink:)?href\s*=\s*["'])\s*(?!#|data:image\/(?:png|jpeg|gif|webp))[^"']*/gi, '$1#');
}

/** "google-cloud-run" -> "Google Cloud Run" */
export const prettyIconName = (ref) =>
  String(ref).replace(/^[^:]*:/, '').replace(/-(icon|wordmark)$/, '').split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
