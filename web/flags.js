// flags.js — feature flags for iterating on experiments.
//
// Resolution (later wins): built-in default < project .mmdr/config.json
// ({"flags": {"themes": true}}) < command line (--enable/--disable) < this
// browser (the Labs panel). Stages: "experimental" ships off, "beta" ships on.

export const FLAGS = [
  {
    id: 'icons',
    name: 'Icon packs',
    stage: 'beta',
    default: true,
    inspiredBy: 'Lucidchart shape libraries · Miro shape packs',
    desc: 'Draw installed Iconify icons (logos, devicon, …) on the canvas and pick them from a searchable library. Install packs with `mmdr icons add logos devicon`.',
  },
  {
    id: 'themes',
    name: 'Diagram styles',
    stage: 'experimental',
    default: false,
    inspiredBy: 'Lucidchart preset themes',
    desc: 'One-click palettes, a hand-drawn look and orthogonal connectors. Stored as mermaid frontmatter config, so GitHub renders them too.',
  },
  {
    id: 'smart-guides',
    name: 'Smart guides',
    stage: 'experimental',
    default: false,
    inspiredBy: 'Lucidchart / Miro alignment guides',
    desc: 'Show alignment lines and snap to the edges and centres of nearby nodes while dragging.',
  },
  {
    id: 'sticky-notes',
    name: 'Sticky notes',
    stage: 'experimental',
    default: false,
    inspiredBy: 'Miro sticky notes',
    desc: 'A palette item for yellow notes. Written as a `sticky` classDef, so they render everywhere.',
  },
];

const KEY = 'mmdr:flags';
const layers = { project: {}, cli: {}, user: {} };
const listeners = new Set();

const clean = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([, v]) => typeof v === 'boolean'));

function loadUser() {
  try {
    return clean(JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch {
    return {};
  }
}

export function initFlags({ project, cli } = {}) {
  layers.project = clean(project);
  layers.cli = clean(cli);
  layers.user = loadUser();
}

/** Where the current value of a flag comes from: user, cli, project or default. */
export function flagSource(id) {
  for (const k of ['user', 'cli', 'project']) if (id in layers[k]) return k;
  return 'default';
}

export function flag(id) {
  const src = flagSource(id);
  if (src !== 'default') return layers[src][id];
  return FLAGS.find((f) => f.id === id)?.default ?? false;
}

/** Sets this browser's override; `undefined` goes back to the inherited value. */
export function setFlag(id, value) {
  if (value === undefined) delete layers.user[id];
  else layers.user[id] = !!value;
  try {
    localStorage.setItem(KEY, JSON.stringify(layers.user));
  } catch {}
  for (const fn of listeners) fn(id);
}

/** Value the flag would have without this browser's override. */
export function inheritedFlag(id) {
  for (const k of ['cli', 'project']) if (id in layers[k]) return layers[k][id];
  return FLAGS.find((f) => f.id === id)?.default ?? false;
}

export const onFlags = (fn) => listeners.add(fn);
