// canvas.js — drag-and-drop SVG editor for a flowchart model (see model.js).
// The canvas mutates the model in place and reports through `hooks.change()`;
// the app turns the model back into mermaid text and saves it.

import * as M from './model.js';

const GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FONT = '14px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const LINE = 18;
const measureCtx = document.createElement('canvas').getContext('2d');
const widthCache = new Map();
function textWidth(s) {
  let w = widthCache.get(s);
  if (w === undefined) {
    measureCtx.font = FONT;
    w = measureCtx.measureText(s).width;
    if (widthCache.size > 5000) widthCache.clear();
    widthCache.set(s, w);
  }
  return w;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', apos: "'" };
/** Turns a mermaid label into display lines (<br>, #entities;, markdown strings). */
export function displayLines(label) {
  let s = String(label ?? '');
  if (/^`[\s\S]*`$/.test(s)) s = s.slice(1, -1).replace(/\*\*|__/g, '').replace(/\n/g, '<br>');
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/#(\w+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/&(\w+);/g, (m, n) => ENTITIES[n] ?? m)
    .replace(/fa:fa-([\w-]+)/g, '[$1]');
  return s.split('\n');
}
export const labelToEditor = (l) => String(l ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/#quot;/g, '"');
export const editorToLabel = (t) => t.replace(/\r?\n/g, '<br>');

const ROUND = new Set(['circle', 'dbl-circ', 'sm-circ', 'f-circ', 'fr-circ', 'cross-circ']);

export class Canvas {
  constructor(root, hooks) {
    this.root = root;
    this.hooks = hooks;
    this.m = null;
    this.view = { x: 0, y: 0, k: 1 };
    this.sel = { nodes: new Set(), edges: new Set(), groups: new Set() };
    this.drag = null;
    this.fresh = new Set();
    this.dropTarget = undefined;
    this.raf = 0;
    root.tabIndex = 0;
    root.innerHTML = `
      <svg class="cv" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" class="dot"/></pattern>
          <filter id="sketch" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="2" seed="7" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/></filter>
          ${['', '-sel'].map((s) => `
          <marker id="mk-arrow${s}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0.5 L10,5 L0,9.5 z" class="mk${s}"/></marker>
          <marker id="mk-circle${s}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><circle cx="5" cy="5" r="4" class="mk${s}"/></marker>
          <marker id="mk-cross${s}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M1,1 L9,9 M9,1 L1,9" class="mkx${s}"/></marker>`).join('')}
        </defs>
        <rect class="bg" width="100%" height="100%" fill="url(#grid)"/>
        <g class="vp"></g>
        <g class="ov"></g>
      </svg>
      <div class="cv-empty">Double-click to add a node · drag a shape from the palette · drop an image</div>`;
    this.svg = root.querySelector('svg');
    this.vp = root.querySelector('.vp');
    this.ov = root.querySelector('.ov');
    this.pattern = root.querySelector('#grid');
    this.empty = root.querySelector('.cv-empty');

    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    this.svg.addEventListener('dblclick', (e) => this.onDbl(e));
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    root.addEventListener('keydown', (e) => this.onKey(e));
    root.addEventListener('keyup', (e) => e.key === ' ' && (this.space = false));
    root.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].some((t) => t === 'Files' || t === 'text/x-mmdr-shape')) e.preventDefault();
    });
    root.addEventListener('drop', (e) => this.onDrop(e));
    // keep the diagram framed while the user hasn't panned/zoomed by hand
    new ResizeObserver(() => (this.autoFit ? this.fit() : this.requestRender())).observe(root);
  }

  // ---------------------------------------------------------------- model

  setModel(m, { fit = false } = {}) {
    this.m = m;
    for (const k of ['nodes', 'groups']) for (const id of [...this.sel[k]]) if (!(k === 'nodes' ? M.getNode(m, id) : M.getGroup(m, id))) this.sel[k].delete(id);
    for (const i of [...this.sel.edges]) if (!m.edges[i]) this.sel.edges.delete(i);
    this.placeMissing();
    this.render();
    if (fit) this.fit();
  }

  get horizontal() {
    return this.m.dir === 'LR' || this.m.dir === 'RL';
  }
  get flip() {
    return this.m.dir === 'BT' || this.m.dir === 'RL' ? -1 : 1;
  }

  changed(kind = 'edit') {
    this.render();
    this.hooks.change(kind);
  }

  selectionChanged() {
    this.render();
    this.hooks.select();
  }

  get selection() {
    return { nodes: [...this.sel.nodes], edges: [...this.sel.edges], groups: [...this.sel.groups] };
  }

  select({ nodes = [], edges = [], groups = [] } = {}, add = false) {
    if (!add) for (const k of ['nodes', 'edges', 'groups']) this.sel[k].clear();
    nodes.forEach((x) => this.sel.nodes.add(x));
    edges.forEach((x) => this.sel.edges.add(x));
    groups.forEach((x) => this.sel.groups.add(x));
    this.selectionChanged();
  }

  // ---------------------------------------------------------------- geometry

  sizeOf(n) {
    const lines = displayLines(n.label);
    const tw = Math.max(16, ...lines.map(textWidth));
    const th = lines.length * LINE;
    const p = n.props || {};
    let w = tw + 32;
    let h = th + 22;
    switch (n.shape) {
      case 'circle': case 'dbl-circ': case 'cross-circ': w = h = Math.max(w, h) + 6; break;
      case 'diam': w = tw + th * 2 + 40; h = th * 2 + 34 + tw * 0.12; break;
      case 'hex': w = tw + 50; break;
      case 'cyl': case 'lin-cyl': h += 18; break;
      case 'lean-r': case 'lean-l': case 'trap-b': case 'trap-t': w += 34; break;
      case 'odd': w += 18; break;
      case 'doc': case 'docs': case 'tag-doc': case 'lin-doc': h += 12; break;
      case 'cloud': w += 40; h += 24; break;
      case 'tri': case 'flip-tri': w = tw + 70; h = th + 54; break;
      case 'hourglass': w = tw + 40; h = th + 56; break;
      case 'text': w = tw + 10; h = th + 8; break;
      case 'sm-circ': case 'f-circ': w = h = 16; break;
      case 'fr-circ': w = h = 22; break;
      case 'fork': w = 90; h = 10; break;
      case 'image': {
        const iw = +p.w || 64;
        const ih = +p.h || 64;
        const hasLabel = lines.join('').trim() !== '';
        w = Math.max(iw, hasLabel ? tw + 8 : 0);
        h = ih + (hasLabel ? th + 6 : 0);
        break;
      }
      case 'icon': {
        const s = (+p.h || 48) + (p.form ? 20 : 0);
        const hasLabel = lines.join('').trim() !== '';
        w = Math.max(s, hasLabel ? tw + 8 : 0);
        h = s + (hasLabel ? th + 6 : 0);
        break;
      }
    }
    return { w: Math.max(w, 16), h: Math.max(h, 10) };
  }

  box(id) {
    const n = M.getNode(this.m, id);
    if (n) {
      const p = this.m.layout[id] || { x: 0, y: 0 };
      const s = this.sizeOf(n);
      return { x: p.x, y: p.y, w: s.w, h: s.h, shape: n.shape };
    }
    const g = this.gbox?.get(id);
    if (g) return { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2, w: g.x2 - g.x1, h: g.y2 - g.y1, shape: 'rect' };
    return null;
  }

  computeGroupBoxes() {
    const m = this.m;
    const boxes = new Map();
    const depth = new Map();
    const visit = (g, d) => {
      if (boxes.has(g.id)) return boxes.get(g.id);
      boxes.set(g.id, null);
      depth.set(g.id, d);
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      const add = (b) => {
        if (!b) return;
        x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
      };
      for (const n of m.nodes) {
        if (n.parent !== g.id) continue;
        const p = m.layout[n.id] || { x: 0, y: 0 };
        const s = this.sizeOf(n);
        add({ x1: p.x - s.w / 2, y1: p.y - s.h / 2, x2: p.x + s.w / 2, y2: p.y + s.h / 2 });
      }
      for (const c of m.groups) if (c.parent === g.id) add(visit(c, d + 1));
      let b;
      if (x1 === Infinity) {
        // a group that just became empty stays where it was
        const last = this.gbox?.get(g.id);
        if (!m.layout[g.id] && last) m.layout[g.id] = { x: snap((last.x1 + last.x2) / 2), y: snap((last.y1 + last.y2) / 2) };
        const p = m.layout[g.id] || { x: 0, y: 0 };
        b = { x1: p.x - 100, y1: p.y - 60, x2: p.x + 100, y2: p.y + 60, empty: true };
      } else b = { x1: x1 - 20, y1: y1 - 38, x2: x2 + 20, y2: y2 + 20 };
      const tw = textWidth(g.title) + 32;
      if (b.x2 - b.x1 < tw) b.x2 = b.x1 + tw;
      boxes.set(g.id, b);
      return b;
    };
    for (const g of m.groups) if (!g.parent || !M.getGroup(m, g.parent)) visit(g, 0);
    for (const g of m.groups) visit(g, 0);
    this.gbox = boxes;
    this.gdepth = depth;
    return boxes;
  }

  bounds() {
    const m = this.m;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const n of m.nodes) {
      const b = this.box(n.id);
      x1 = Math.min(x1, b.x - b.w / 2); y1 = Math.min(y1, b.y - b.h / 2);
      x2 = Math.max(x2, b.x + b.w / 2); y2 = Math.max(y2, b.y + b.h / 2);
    }
    for (const b of (this.gbox || new Map()).values()) {
      if (!b) continue;
      x1 = Math.min(x1, b.x1); y1 = Math.min(y1, b.y1); x2 = Math.max(x2, b.x2); y2 = Math.max(y2, b.y2);
    }
    return x1 === Infinity ? null : { x1, y1, x2, y2 };
  }

  overlaps(p, s, skip) {
    for (const n of this.m.nodes) {
      if (n.id === skip || !this.m.layout[n.id]) continue;
      const b = this.box(n.id);
      if (Math.abs(b.x - p.x) < (b.w + s.w) / 2 + 20 && Math.abs(b.y - p.y) < (b.h + s.h) / 2 + 16) return true;
    }
    return false;
  }

  freeSpot(p, s, skip) {
    p = { x: snap(p.x), y: snap(p.y) };
    for (let i = 0; i < 60 && this.overlaps(p, s, skip); i++) {
      if (this.horizontal) p.y += s.h + 30;
      else p.x += s.w + 40;
    }
    return p;
  }

  /** Gives nodes without a stored position one near a connected neighbour. */
  placeMissing() {
    const m = this.m;
    const missing = m.nodes.filter((n) => !m.layout[n.id]);
    if (!missing.length) return false;
    if (missing.length === m.nodes.length) {
      Object.assign(m.layout, M.layeredLayout(m, (id) => this.sizeOf(M.getNode(m, id))));
      return true;
    }
    this.computeGroupBoxes();
    for (const n of missing) {
      let ref = null;
      let sign = 1;
      for (const e of m.edges) {
        if (e.to === n.id && m.layout[e.from] && M.getNode(m, e.from)) { ref = this.box(e.from); break; }
        if (e.from === n.id && m.layout[e.to] && M.getNode(m, e.to)) { ref = this.box(e.to); sign = -1; break; }
      }
      const s = this.sizeOf(n);
      let p;
      if (ref) {
        const f = sign * this.flip;
        p = this.horizontal ? { x: ref.x + f * (ref.w / 2 + s.w / 2 + 90), y: ref.y } : { x: ref.x, y: ref.y + f * (ref.h / 2 + s.h / 2 + 70) };
      } else {
        const b = this.bounds() || { x1: 0, y1: 0, x2: 0, y2: 0 };
        p = this.horizontal ? { x: b.x1 + s.w / 2, y: b.y2 + 60 + s.h / 2 } : { x: b.x2 + 80 + s.w / 2, y: b.y1 + s.h / 2 };
      }
      m.layout[n.id] = this.freeSpot(p, s, n.id);
    }
    return true;
  }

  world(e) {
    const r = this.svg.getBoundingClientRect();
    return { x: (e.clientX - r.left - this.view.x) / this.view.k, y: (e.clientY - r.top - this.view.y) / this.view.k };
  }

  toScreen(x, y) {
    const r = this.svg.getBoundingClientRect();
    return { x: r.left + this.view.x + x * this.view.k, y: r.top + this.view.y + y * this.view.k };
  }

  center() {
    const r = this.svg.getBoundingClientRect();
    return { x: (r.width / 2 - this.view.x) / this.view.k, y: (r.height / 2 - this.view.y) / this.view.k };
  }

  fit() {
    this.computeGroupBoxes();
    const b = this.bounds();
    const r = this.svg.getBoundingClientRect();
    if (!b || !r.width) {
      this.view = { x: r.width / 2, y: r.height / 2, k: 1 };
    } else {
      const pad = 60;
      const k = Math.min(1.25, Math.max(0.15, Math.min((r.width - pad * 2) / (b.x2 - b.x1 || 1), (r.height - pad * 2) / (b.y2 - b.y1 || 1))));
      this.view = { k, x: r.width / 2 - ((b.x1 + b.x2) / 2) * k, y: r.height / 2 - ((b.y1 + b.y2) / 2) * k };
    }
    this.autoFit = true;
    this.render();
    this.hooks.zoom?.(this.view.k);
  }

  zoomAt(factor, sx, sy) {
    const r = this.svg.getBoundingClientRect();
    sx ??= r.width / 2;
    sy ??= r.height / 2;
    const k = Math.min(4, Math.max(0.1, this.view.k * factor));
    const f = k / this.view.k;
    this.view = { k, x: sx - (sx - this.view.x) * f, y: sy - (sy - this.view.y) * f };
    this.autoFit = false;
    this.requestRender();
    this.hooks.zoom?.(k);
  }

  // ---------------------------------------------------------------- render

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  /** Mirrors the diagram's mermaid config (palette, look, connector curve) on the canvas. */
  applyStyle() {
    const style = M.readStyle(this.m);
    this.curve = style.curve;
    const pal = M.canvasPalette(style);
    const vars = {
      '--cv-node-fill': 'primaryColor', '--cv-node-stroke': 'primaryBorderColor', '--cv-text': 'primaryTextColor',
      '--cv-edge': 'lineColor', '--cv-group-fill': 'clusterBkg', '--cv-group-stroke': 'clusterBorder',
      '--cv-label-bg': 'edgeLabelBackground', '--cv-bg': 'background',
    };
    for (const [prop, key] of Object.entries(vars)) {
      const v = pal?.[key];
      if (typeof v === 'string' && /^[#\w(),.%\s-]+$/.test(v)) this.root.style.setProperty(prop, v);
      else this.root.style.removeProperty(prop);
    }
    this.svg.classList.toggle('sketch', style.look === 'handDrawn');
  }

  render() {
    if (!this.m) return;
    const m = this.m;
    this.applyStyle();
    const { x, y, k } = this.view;
    this.vp.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    this.pattern.setAttribute('patternTransform', `translate(${x},${y}) scale(${k})`);
    this.empty.style.display = m.nodes.length || m.groups.length ? 'none' : '';
    const boxes = this.computeGroupBoxes();
    const out = [];

    const groups = [...m.groups].sort((a, b) => (this.gdepth.get(a.id) || 0) - (this.gdepth.get(b.id) || 0));
    for (const g of groups) {
      const b = boxes.get(g.id);
      if (!b) continue;
      const st = M.effectiveStyle(m, g.id);
      const cls = ['grp', this.sel.groups.has(g.id) && 'sel', this.dropTarget?.id === g.id && 'drop', b.empty && 'empty'].filter(Boolean).join(' ');
      out.push(`<g class="${cls}" data-group="${esc(g.id)}">
        <rect class="gbox" x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="${b.y2 - b.y1}" rx="10" style="${esc(styleAttr(st))}"/>
        <rect class="gbar" x="${b.x1}" y="${b.y1}" width="${b.x2 - b.x1}" height="28" rx="10"/>
        <text class="gtitle" x="${b.x1 + 14}" y="${b.y1 + 19}" style="${st.get('color') ? `fill:${esc(st.get('color'))}` : ''}">${esc(displayLines(g.title).join(' '))}${g.dir ? ` <tspan class="gdir">${g.dir}</tspan>` : ''}</text>
      </g>`);
    }

    // edges: parallel edges between the same pair fan out along the side
    const pairCount = new Map();
    const pairIndex = [];
    m.edges.forEach((e, i) => {
      const key = [e.from, e.to].sort().join('\u0000');
      pairIndex[i] = pairCount.get(key) || 0;
      pairCount.set(key, pairIndex[i] + 1);
    });
    m.edges.forEach((e, i) => {
      const A = this.box(e.from);
      const B = this.box(e.to);
      if (!A || !B) return;
      const key = [e.from, e.to].sort().join('\u0000');
      const off = (pairIndex[i] - (pairCount.get(key) - 1) / 2) * 14;
      const geo = e.from === e.to ? selfLoop(A) : connector(A, B, off, this.curve);
      const sel = this.sel.edges.has(i) ? '-sel' : '';
      const mk = (c) => (c === '>' || c === '<' ? 'arrow' : c === 'o' ? 'circle' : c === 'x' ? 'cross' : '');
      const ms = mk(e.start);
      const me = mk(e.end);
      const st = M.parseCss(e.style);
      const lineStyle = [st.get('stroke') && `stroke:${st.get('stroke')}`, st.get('stroke-width') && `stroke-width:${st.get('stroke-width')}`].filter(Boolean).join(';');
      out.push(`<g class="edge ${e.stroke}${sel ? ' sel' : ''}" data-edge="${i}">
        <path class="ehit" d="${geo.d}"/>
        <path class="eline" d="${geo.d}" style="${esc(lineStyle)}"${me ? ` marker-end="url(#mk-${me}${sel})"` : ''}${ms ? ` marker-start="url(#mk-${ms}${sel})"` : ''}/>`);
      if (e.label && e.stroke !== 'invisible') {
        const lines = displayLines(e.label);
        const tw = Math.max(...lines.map(textWidth)) + 12;
        const th = lines.length * LINE + 4;
        out.push(`<g class="elabel"><rect x="${geo.mx - tw / 2}" y="${geo.my - th / 2}" width="${tw}" height="${th}" rx="4"/>
          ${textLines(lines, geo.mx, geo.my, st.get('color'))}</g>`);
      }
      out.push('</g>');
    });

    for (const n of m.nodes) {
      const b = this.box(n.id);
      const st = M.effectiveStyle(m, n.id);
      const cls = ['node', `s-${n.shape}`, this.sel.nodes.has(n.id) && 'sel'].filter(Boolean).join(' ');
      const lines = displayLines(n.label);
      let inner = '';
      if (n.shape === 'image') {
        const p = n.props || {};
        const iw = +p.w || 64;
        const ih = +p.h || 64;
        const hasLabel = lines.join('').trim() !== '';
        const top = p.pos === 't';
        const iy = top && hasLabel ? b.h / 2 - ih : -b.h / 2;
        const src = this.hooks.asset ? this.hooks.asset(p.img || '') : p.img;
        inner += `<rect class="sh img-frame" x="${-b.w / 2}" y="${-b.h / 2}" width="${b.w}" height="${b.h}" rx="4"/>`;
        inner += `<image href="${esc(src)}" x="${-iw / 2}" y="${iy}" width="${iw}" height="${ih}" preserveAspectRatio="xMidYMid meet"/>`;
        if (hasLabel) inner += textLines(lines, 0, top ? -b.h / 2 + (lines.length * LINE) / 2 + 2 : b.h / 2 - (lines.length * LINE) / 2 - 1, st.get('color'));
      } else if (n.shape === 'icon') {
        const p = n.props || {};
        const s = +p.h || 48;
        const pad = p.form ? 10 : 0;
        const box = s + pad * 2;
        const hasLabel = lines.join('').trim() !== '';
        const top = p.pos === 't';
        const by = top && hasLabel ? b.h / 2 - box : -b.h / 2;
        const sty = esc(styleAttr(st));
        inner += `<rect class="sh img-frame" x="${-b.w / 2}" y="${-b.h / 2}" width="${b.w}" height="${b.h}" rx="4"/>`;
        if (p.form === 'circle') inner += `<circle class="sh" cx="0" cy="${by + box / 2}" r="${box / 2}" style="${sty}"/>`;
        else if (p.form) inner += `<rect class="sh" x="${-box / 2}" y="${by}" width="${box}" height="${box}" rx="${p.form === 'rounded' ? 12 : 3}" style="${sty}"/>`;
        const icon = this.hooks.icon?.(p.icon || '');
        if (icon) inner += `<svg x="${-s / 2}" y="${by + pad}" width="${s}" height="${s}" viewBox="0 0 ${icon.w} ${icon.h}">${icon.body}</svg>`;
        else {
          inner += `<rect class="icon-missing" x="${-s / 2}" y="${by + pad}" width="${s}" height="${s}" rx="8"><title>${esc(p.icon || 'no icon')}${icon === false ? ' — not installed (mmdr icons add …)' : ''}</title></rect>`;
          inner += `<text class="icon-name" x="0" y="${by + pad + s / 2 + 4}">${icon === null ? '…' : esc(String(p.icon || '?').replace(/^.*:/, '').slice(0, 10))}</text>`;
        }
        if (hasLabel) inner += textLines(lines, 0, top ? -b.h / 2 + (lines.length * LINE) / 2 + 2 : b.h / 2 - (lines.length * LINE) / 2 - 1, st.get('color'));
      } else {
        inner += shapeMarkup(n.shape, b.w, b.h, styleAttr(st));
        const dy = n.shape === 'cyl' || n.shape === 'lin-cyl' ? 6 : n.shape === 'tri' ? 12 : n.shape === 'flip-tri' ? -12 : n.shape.includes('doc') ? -4 : 0;
        if (!['sm-circ', 'f-circ', 'fr-circ', 'fork'].includes(n.shape)) inner += textLines(lines, 0, dy, textColor(st));
      }
      if (m.links[n.id]?.url) inner += `<text class="link-badge" x="${b.w / 2 - 4}" y="${-b.h / 2 + 12}">↗</text>`;
      const hw = b.w / 2 + 1;
      const hh = b.h / 2 + 1;
      for (const [hx, hy] of [[0, -hh], [hw, 0], [0, hh], [-hw, 0]]) inner += `<circle class="hd" data-handle="${esc(n.id)}" cx="${hx}" cy="${hy}" r="5"/>`;
      out.push(`<g class="${cls}" data-node="${esc(n.id)}" transform="translate(${b.x},${b.y})">${inner}</g>`);
    }
    this.vp.innerHTML = out.join('');
    this.renderOverlay();
  }

  renderOverlay() {
    const d = this.drag;
    const { x, y, k } = this.view;
    this.ov.setAttribute('transform', `translate(${x},${y}) scale(${k})`);
    if (d?.type === 'connect' && d.moved) {
      const A = this.box(d.from);
      const target = d.target && d.target !== d.from ? this.box(d.target) : null;
      const B = target || { x: d.cur.x, y: d.cur.y, w: 0, h: 0 };
      const geo = connector(A, B, 0, this.curve);
      this.ov.innerHTML = `<path class="connecting" d="${geo.d}" marker-end="url(#mk-arrow-sel)"/>`;
    } else if (d?.type === 'marquee') {
      const x1 = Math.min(d.start.x, d.cur.x), y1 = Math.min(d.start.y, d.cur.y);
      this.ov.innerHTML = `<rect class="marquee" x="${x1}" y="${y1}" width="${Math.abs(d.cur.x - d.start.x)}" height="${Math.abs(d.cur.y - d.start.y)}"/>`;
    } else if (d?.type === 'move' && this.guides?.length) {
      this.ov.innerHTML = this.guides.map((l) => `<line class="guide" x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}"/>`).join('');
    } else this.ov.innerHTML = '';
  }

  // ---------------------------------------------------------------- pointer

  hit(e) {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return {};
    const h = t.closest('[data-handle]');
    const n = t.closest('[data-node]');
    const ed = t.closest('[data-edge]');
    const g = t.closest('[data-group]');
    return { handle: h?.dataset.handle, node: n?.dataset.node, edge: ed ? +ed.dataset.edge : null, group: g?.dataset.group };
  }

  onDown(e) {
    if (!this.m || this.editor) return;
    this.root.focus({ preventScroll: true });
    const w = this.world(e);
    if (e.button === 1 || (e.button === 0 && this.space)) {
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: true };
      return;
    }
    if (e.button !== 0) return;
    const h = this.hit(e);
    if (h.handle || (h.node && e.altKey)) {
      this.drag = { type: 'connect', from: h.handle || h.node, cur: w, start: w, moved: false };
      return;
    }
    if (h.node) {
      const id = h.node;
      if ((e.metaKey || e.ctrlKey) && this.m.links[id]?.url) {
        this.hooks.openLink?.(this.m.links[id].url);
        return;
      }
      if (e.shiftKey) {
        if (this.sel.nodes.has(id)) this.sel.nodes.delete(id);
        else this.sel.nodes.add(id);
        this.selectionChanged();
      } else if (!this.sel.nodes.has(id)) this.select({ nodes: [id] });
      this.beginMove(w, id, null, !e.shiftKey && this.sel.nodes.size > 1);
      return;
    }
    if (h.edge != null) {
      if (e.shiftKey) {
        if (this.sel.edges.has(h.edge)) this.sel.edges.delete(h.edge);
        else this.sel.edges.add(h.edge);
        this.selectionChanged();
      } else this.select({ edges: [h.edge] });
      return;
    }
    if (h.group && !e.shiftKey) {
      if (!this.sel.groups.has(h.group)) this.select({ groups: [h.group] });
      this.beginMove(w, null, h.group, false);
      return;
    }
    if (e.shiftKey) this.drag = { type: 'marquee', start: w, cur: w, add: true };
    else this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
  }

  beginMove(w, primaryNode, primaryGroup, collapseOnClick) {
    const m = this.m;
    const ids = new Set(this.sel.nodes);
    const groups = new Set(this.sel.groups);
    for (const g of [...groups]) {
      const d = M.descendants(m, g);
      d.nodes.forEach((x) => ids.add(x));
      d.groups.forEach((x) => groups.add(x));
    }
    const orig = new Map();
    for (const id of ids) orig.set(id, { ...(m.layout[id] || { x: 0, y: 0 }) });
    for (const id of groups) if (m.layout[id]) orig.set(id, { ...m.layout[id] });
    const snapshot = new Map([...this.gbox].filter(([id, b]) => b && !groups.has(id)));
    this.drag = { type: 'move', start: w, orig, ids, groups, primaryNode, primaryGroup, snapshot, moved: false, collapseOnClick };
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pan') {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      this.view.x = d.vx + dx;
      this.view.y = d.vy + dy;
      if (d.moved) this.autoFit = false;
      this.requestRender();
      return;
    }
    const w = this.world(e);
    if (d.type === 'move') {
      let dx = w.x - d.start.x;
      let dy = w.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * this.view.k < 3) return;
      d.moved = true;
      let lock = { x: false, y: false };
      this.guides = [];
      if (d.primaryNode && !e.altKey && this.hooks.flag?.('smart-guides')) {
        const g = this.alignGuides(d, dx, dy);
        dx += g.dx;
        dy += g.dy;
        lock = g.lock;
        this.guides = g.lines;
      }
      for (const [id, p] of d.orig) {
        const nx = p.x + dx;
        const ny = p.y + dy;
        this.m.layout[id] = { x: e.altKey || lock.x ? nx : snap(nx), y: e.altKey || lock.y ? ny : snap(ny) };
      }
      // which group would the dragged thing land in?
      let target = null;
      let best = -1;
      for (const [id, b] of d.snapshot) {
        if (d.groups.has(id)) continue;
        if (w.x >= b.x1 && w.x <= b.x2 && w.y >= b.y1 && w.y <= b.y2) {
          const dep = this.gdepth.get(id) || 0;
          if (dep > best) (best = dep), (target = id);
        }
      }
      const current = d.primaryNode ? M.getNode(this.m, d.primaryNode)?.parent ?? null : M.getGroup(this.m, d.primaryGroup)?.parent ?? null;
      this.dropTarget = target !== current ? { id: target } : undefined;
      this.requestRender();
    } else if (d.type === 'connect') {
      d.cur = w;
      if (Math.hypot(w.x - d.start.x, w.y - d.start.y) * this.view.k > 4) d.moved = true;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      d.target = el?.closest?.('[data-node]')?.dataset.node || el?.closest?.('[data-group]')?.dataset.group || null;
      this.renderOverlay();
    } else if (d.type === 'marquee') {
      d.cur = w;
      this.renderOverlay();
    }
  }

  /** Smart guides: nudges a drag so the primary node lines up with a nearby node's edges or centre. */
  alignGuides(d, dx, dy) {
    const o = d.orig.get(d.primaryNode);
    const s = this.sizeOf(M.getNode(this.m, d.primaryNode));
    const px = o.x + dx;
    const py = o.y + dy;
    const tol = 7 / this.view.k;
    const mine = { x: [px - s.w / 2, px, px + s.w / 2], y: [py - s.h / 2, py, py + s.h / 2] };
    const best = { x: null, y: null };
    for (const n of this.m.nodes) {
      if (d.ids.has(n.id)) continue;
      const b = this.box(n.id);
      const theirs = { x: [b.x - b.w / 2, b.x, b.x + b.w / 2], y: [b.y - b.h / 2, b.y, b.y + b.h / 2] };
      for (const ax of ['x', 'y']) {
        for (let i = 0; i < 3; i++) {
          for (let j = 0; j < 3; j++) {
            if ((i === 1) !== (j === 1)) continue; // centre to centre, edge to edge
            const diff = theirs[ax][j] - mine[ax][i];
            const cost = Math.abs(diff) * (i === 1 ? 0.5 : 1); // prefer centre lines
            if (Math.abs(diff) < tol && (!best[ax] || cost < best[ax].cost)) best[ax] = { diff, cost, at: theirs[ax][j], b };
          }
        }
      }
    }
    const lines = [];
    if (best.x) {
      const { at, b } = best.x;
      lines.push({ x1: at, x2: at, y1: Math.min(py - s.h / 2, b.y - b.h / 2) - 14, y2: Math.max(py + s.h / 2, b.y + b.h / 2) + 14 });
    }
    if (best.y) {
      const { at, b } = best.y;
      lines.push({ y1: at, y2: at, x1: Math.min(px - s.w / 2, b.x - b.w / 2) - 14, x2: Math.max(px + s.w / 2, b.x + b.w / 2) + 14 });
    }
    return { dx: best.x?.diff || 0, dy: best.y?.diff || 0, lock: { x: !!best.x, y: !!best.y }, lines };
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.guides = [];
    const m = this.m;
    if (d.type === 'pan') {
      if (!d.moved && this.sel.nodes.size + this.sel.edges.size + this.sel.groups.size) this.select({});
      return;
    }
    if (d.type === 'move') {
      const drop = this.dropTarget;
      this.dropTarget = undefined;
      if (!d.moved) {
        if (d.collapseOnClick && d.primaryNode) this.select({ nodes: [d.primaryNode] });
        else this.render();
        return;
      }
      if (drop) {
        if (d.primaryGroup) {
          for (const gid of this.sel.groups) M.setGroupParent(m, gid, drop.id);
        } else {
          for (const id of d.ids) {
            const n = M.getNode(m, id);
            if (n && !d.groups.has(n.parent)) n.parent = drop.id;
          }
        }
      }
      this.changed(drop ? 'regroup' : 'move');
      return;
    }
    if (d.type === 'connect') {
      this.renderOverlay();
      if (!d.moved) return;
      const target = d.target;
      if (target && target !== d.from) {
        const dup = m.edges.findIndex((x) => x.from === d.from && x.to === target);
        if (dup >= 0) return this.select({ edges: [dup] });
        M.addEdge(m, d.from, target);
        this.select({ edges: [m.edges.length - 1] });
        this.changed('connect');
      } else if (!target) {
        const src = M.getNode(m, d.from);
        const n = this.createNode({ shape: 'rect', parent: src?.parent ?? null, at: d.cur });
        M.addEdge(m, d.from, n.id);
        this.select({ nodes: [n.id] });
        this.changed('connect');
        this.editLabel('node', n.id);
      }
      return;
    }
    if (d.type === 'marquee') {
      const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x);
      const y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
      const nodes = m.nodes.filter((n) => {
        const b = this.box(n.id);
        return b.x - b.w / 2 >= x1 && b.x + b.w / 2 <= x2 && b.y - b.h / 2 >= y1 && b.y + b.h / 2 <= y2;
      }).map((n) => n.id);
      const groups = [...this.gbox].filter(([, b]) => b && b.x1 >= x1 && b.x2 <= x2 && b.y1 >= y1 && b.y2 <= y2).map(([id]) => id);
      this.select({ nodes, groups }, d.add);
      this.renderOverlay();
    }
  }

  onDbl(e) {
    if (!this.m) return;
    const h = this.hit(e);
    if (h.node) return this.editLabel('node', h.node);
    if (h.edge != null) return this.editLabel('edge', h.edge);
    if (h.group) return this.editLabel('group', h.group);
    const n = this.createNode({ shape: 'rect', at: this.world(e), parent: this.groupAt(this.world(e)) });
    this.select({ nodes: [n.id] });
    this.changed('add');
    this.editLabel('node', n.id);
  }

  onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const r = this.svg.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), e.clientX - r.left, e.clientY - r.top);
    } else {
      const f = e.deltaMode ? 20 : 1;
      this.view.x -= e.deltaX * f;
      this.view.y -= e.deltaY * f;
      this.autoFit = false;
      this.requestRender();
    }
  }

  async onDrop(e) {
    e.preventDefault();
    const at = this.world(e);
    const shape = e.dataTransfer.getData('text/x-mmdr-shape');
    if (shape) return this.addShape(shape, at);
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    let i = 0;
    for (const f of files) {
      const path = await this.hooks.upload?.(f);
      if (path) this.addImage(path, { x: at.x + i * 90, y: at.y }, f.name.replace(/\.[^.]+$/, ''));
      i++;
    }
  }

  groupAt(p) {
    let target = null;
    let best = -1;
    for (const [id, b] of this.gbox || []) {
      if (b && p.x >= b.x1 && p.x <= b.x2 && p.y >= b.y1 && p.y <= b.y2 && (this.gdepth.get(id) || 0) > best) {
        best = this.gdepth.get(id) || 0;
        target = id;
      }
    }
    return target;
  }

  // ---------------------------------------------------------------- editing

  createNode({ shape = 'rect', label, parent = null, at, props = {} }) {
    const n = M.addNode(this.m, { label, shape, parent, props });
    if (!label) {
      n.label = shape === 'text' ? 'Text' : '';
      this.fresh.add(n.id);
    }
    if (shape === 'icon' && !props.icon) n.props.icon = 'fa:cube';
    const s = this.sizeOf({ ...n, label: n.label || 'Node' });
    const p = at || this.center();
    this.m.layout[n.id] = { x: snap(p.x), y: snap(p.y) };
    if (!at) this.m.layout[n.id] = this.freeSpot(this.m.layout[n.id], s, n.id);
    return n;
  }

  addShape(shape, at) {
    if (shape === 'group') return this.groupSelection(at);
    if (shape === 'image') return this.hooks.pickImage?.(at);
    if (shape === 'icon') return this.hooks.pickIcon?.(at);
    if (shape === 'sticky') return this.addSticky(at);
    const n = this.createNode({ shape, at, parent: at ? this.groupAt(at) : null });
    this.select({ nodes: [n.id] });
    this.changed('add');
    this.editLabel('node', n.id);
  }

  /** Adds an icon node (e.g. "logos:python") from the icon picker. */
  addIcon(ref, at, label) {
    const n = this.createNode({ shape: 'icon', label, at, parent: at ? this.groupAt(at) : null, props: { icon: ref, pos: 'b', h: '48' } });
    if (!at) this.m.layout[n.id] = this.freeSpot(this.m.layout[n.id], this.sizeOf(n), n.id);
    this.select({ nodes: [n.id] });
    this.changed('add');
  }

  /** Sticky notes are plain nodes with a `sticky` classDef, so they render everywhere. */
  addSticky(at) {
    const m = this.m;
    if (!m.classDefs.some((c) => c.name === 'sticky')) m.classDefs.push({ name: 'sticky', css: 'fill:#fff4a3,stroke:#e2c94b,color:#3d3300' });
    const n = this.createNode({ shape: 'rect', at, parent: at ? this.groupAt(at) : null });
    m.classes[n.id] = ['sticky'];
    this.select({ nodes: [n.id] });
    this.changed('add');
    this.editLabel('node', n.id);
  }

  addImage(path, at, label = '') {
    const n = M.addNode(this.m, { label: label || 'image', shape: 'image', props: { img: path, w: '64', h: '64', pos: 'b' } });
    n.label = label;
    const p = at || this.center();
    this.m.layout[n.id] = at ? { x: snap(p.x), y: snap(p.y) } : this.freeSpot(p, this.sizeOf(n), n.id);
    const g = at ? this.groupAt(at) : null;
    if (g) n.parent = g;
    this.select({ nodes: [n.id] });
    this.changed('add');
  }

  /** Opens an inline text editor over a node, edge label or group title. */
  editLabel(kind, id) {
    this.closeEditor(true);
    const m = this.m;
    let value;
    let at;
    let width;
    if (kind === 'node') {
      const n = M.getNode(m, id);
      if (!n) return;
      const b = this.box(id);
      value = n.label;
      at = this.toScreen(b.x, b.y);
      width = Math.max(140, b.w * this.view.k + 20);
    } else if (kind === 'edge') {
      const e = m.edges[id];
      if (!e) return;
      const A = this.box(e.from);
      const B = this.box(e.to);
      const geo = e.from === e.to ? selfLoop(A) : connector(A, B, 0, this.curve);
      value = e.label;
      at = this.toScreen(geo.mx, geo.my);
      width = 160;
    } else {
      const g = M.getGroup(m, id);
      const b = this.gbox.get(id);
      if (!g || !b) return;
      value = g.title;
      const p = this.toScreen(b.x1, b.y1);
      at = { x: p.x + 90, y: p.y + 14 * this.view.k };
      width = 180;
    }
    const ta = document.createElement('textarea');
    ta.className = 'inline-edit';
    ta.value = labelToEditor(value);
    ta.rows = Math.max(1, ta.value.split('\n').length);
    const host = this.root.getBoundingClientRect();
    Object.assign(ta.style, { left: `${at.x - host.left - width / 2}px`, top: `${at.y - host.top - 16 * ta.rows}px`, width: `${width}px` });
    this.root.appendChild(ta);
    this.editor = { ta, kind, id };
    ta.focus();
    ta.select();
    ta.addEventListener('input', () => (ta.rows = Math.max(1, ta.value.split('\n').length)));
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeEditor(false);
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.closeEditor(true);
      } else if (e.key === 'Tab' && kind === 'node') {
        e.preventDefault();
        const nodeId = this.closeEditor(true);
        this.addConnected(nodeId);
      }
    });
    ta.addEventListener('blur', () => this.closeEditor(true));
  }

  closeEditor(commit) {
    const ed = this.editor;
    if (!ed) return null;
    this.editor = null;
    ed.ta.remove();
    this.root.focus({ preventScroll: true });
    let id = ed.id;
    if (!commit) {
      if (this.fresh.has(id) && ed.kind === 'node') {
        const n = M.getNode(this.m, id);
        if (n && !n.label) n.label = 'Node';
        this.fresh.delete(id);
        this.changed('label');
      }
      return id;
    }
    const value = editorToLabel(ed.ta.value);
    const m = this.m;
    if (ed.kind === 'node') {
      const n = M.getNode(m, id);
      if (!n) return id;
      n.label = value || (n.shape === 'image' ? '' : 'Node');
      if (this.fresh.has(id)) {
        this.fresh.delete(id);
        const base = M.slug(n.label);
        const nid = base && M.uniqueId(m, base);
        if (nid && /^n\d+$/.test(id) && M.renameId(m, id, nid)) {
          if (this.sel.nodes.delete(id)) this.sel.nodes.add(nid);
          id = nid;
        }
      }
    } else if (ed.kind === 'edge') {
      if (m.edges[id]) m.edges[id].label = value;
    } else {
      const g = M.getGroup(m, id);
      if (g && value) g.title = value;
      if (g && this.fresh.delete(id)) {
        const base = M.slug(g.title);
        const nid = base && M.uniqueId(m, base);
        if (nid && /^group\d*$/.test(id) && M.renameId(m, id, nid)) {
          if (this.sel.groups.delete(id)) this.sel.groups.add(nid);
          id = nid;
        }
      }
    }
    this.changed('label');
    this.hooks.select();
    return id;
  }

  /** Tab: adds a node connected from `id`, placed downstream in the flow. */
  addConnected(id) {
    const m = this.m;
    const src = M.getNode(m, id);
    if (!src) return;
    const b = this.box(id);
    const f = this.flip;
    const guess = { w: 120, h: 40 };
    const p = this.horizontal ? { x: b.x + f * (b.w / 2 + 90 + guess.w / 2), y: b.y } : { x: b.x, y: b.y + f * (b.h / 2 + 70 + guess.h / 2) };
    const n = this.createNode({ shape: 'rect', parent: src.parent, at: this.freeSpot(p, guess) });
    M.addEdge(m, id, n.id);
    this.select({ nodes: [n.id] });
    this.changed('add');
    this.editLabel('node', n.id);
  }

  deleteSelection() {
    const m = this.m;
    const { nodes, edges, groups } = this.sel;
    if (!nodes.size && !edges.size && !groups.size) return;
    M.removeEdges(m, [...edges]);
    M.removeNodes(m, [...nodes]);
    for (const g of groups) M.removeGroup(m, g, false);
    this.select({});
    this.changed('delete');
  }

  groupSelection(at) {
    const m = this.m;
    const nodes = [...this.sel.nodes];
    const groups = [...this.sel.groups];
    const parents = new Set([...nodes.map((id) => M.getNode(m, id)?.parent ?? null), ...groups.map((id) => M.getGroup(m, id)?.parent ?? null)]);
    const parent = parents.size === 1 ? [...parents][0] : null;
    const p = at || this.center();
    const gid = M.addGroup(m, { title: 'Group', nodes, groups, parent: nodes.length || groups.length ? parent : at ? this.groupAt(at) : null, x: snap(p.x), y: snap(p.y) });
    this.fresh.add(gid);
    this.select({ groups: [gid] });
    this.changed('group');
    this.editLabel('group', gid);
  }

  ungroupSelection() {
    if (!this.sel.groups.size) return;
    for (const g of this.sel.groups) M.removeGroup(this.m, g, false);
    this.select({});
    this.changed('ungroup');
  }

  duplicateSelection() {
    const ids = [...this.sel.nodes];
    if (!ids.length) return;
    const sub = M.extract(this.m, ids);
    const parents = ids.map((id) => M.getNode(this.m, id).parent);
    const added = M.merge(this.m, sub, 40, 40);
    added.forEach((id, i) => (M.getNode(this.m, id).parent = parents[i]));
    this.select({ nodes: added });
    this.changed('duplicate');
  }

  copySelection() {
    const ids = [...this.sel.nodes];
    if (!ids.length) return null;
    return M.serializeFlowchart(M.extract(this.m, ids));
  }

  /** Pastes mermaid text (with or without a header) as new nodes. */
  paste(text) {
    let src = text.trim();
    if (!/^(flowchart|graph)\b/.test(src.replace(/^---[\s\S]*?---\s*/, ''))) src = `flowchart ${this.m.dir}\n${src}`;
    const sub = M.parseFlowchart(src);
    if (!sub || !sub.nodes.length || sub.warnings.length) return false;
    const c = this.center();
    const xs = sub.nodes.map((n) => sub.layout[n.id]?.x).filter((v) => v != null);
    const ys = sub.nodes.map((n) => sub.layout[n.id]?.y).filter((v) => v != null);
    const dx = xs.length ? c.x - (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
    const dy = ys.length ? c.y - (Math.min(...ys) + Math.max(...ys)) / 2 : 0;
    const added = M.merge(this.m, sub, dx, dy);
    this.placeMissing();
    this.select({ nodes: added });
    this.changed('paste');
    return true;
  }

  align(mode) {
    const ids = [...this.sel.nodes];
    if (ids.length < 2) return;
    const L = this.m.layout;
    const boxes = ids.map((id) => this.box(id));
    if (mode === 'x' || mode === 'y') {
      const v = boxes.reduce((s, b) => s + b[mode], 0) / boxes.length;
      ids.forEach((id) => (L[id] = { ...L[id], [mode]: snap(v) }));
    } else {
      const ax = mode === 'dist-x' ? 'x' : 'y';
      const sorted = ids.map((id, i) => [id, boxes[i][ax]]).sort((a, b) => a[1] - b[1]);
      const lo = sorted[0][1];
      const step = (sorted.at(-1)[1] - lo) / (sorted.length - 1);
      sorted.forEach(([id], i) => (L[id] = { ...L[id], [ax]: snap(lo + step * i) }));
    }
    this.changed('align');
  }

  onKey(e) {
    if (!this.m || this.editor) return;
    const mod = e.metaKey || e.ctrlKey;
    const one = this.sel.nodes.size === 1 ? [...this.sel.nodes][0] : null;
    if (e.key === ' ') {
      this.space = true;
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') this.deleteSelection();
    else if (mod && e.key.toLowerCase() === 'a') this.select({ nodes: this.m.nodes.map((n) => n.id), groups: this.m.groups.map((g) => g.id) });
    else if (mod && e.key.toLowerCase() === 'd') this.duplicateSelection();
    else if (mod && e.key.toLowerCase() === 'g') e.shiftKey ? this.ungroupSelection() : this.groupSelection();
    else if (e.key === 'Escape') this.select({});
    else if ((e.key === 'Enter' || e.key === 'F2') && !mod) {
      if (one) this.editLabel('node', one);
      else if (this.sel.edges.size === 1) this.editLabel('edge', [...this.sel.edges][0]);
      else if (this.sel.groups.size === 1) this.editLabel('group', [...this.sel.groups][0]);
      else return;
    } else if (e.key === 'Tab' && one) this.addConnected(one);
    else if (e.key.startsWith('Arrow') && !mod && (this.sel.nodes.size || this.sel.groups.size)) {
      const step = e.shiftKey ? GRID * 5 : GRID;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      const ids = new Set(this.sel.nodes);
      for (const g of this.sel.groups) M.descendants(this.m, g).nodes.forEach((x) => ids.add(x));
      for (const id of ids) {
        const p = this.m.layout[id] || { x: 0, y: 0 };
        this.m.layout[id] = { x: p.x + dx, y: p.y + dy };
      }
      for (const g of this.sel.groups) if (this.m.layout[g]) this.m.layout[g] = { x: this.m.layout[g].x + dx, y: this.m.layout[g].y + dy };
      this.changed('move');
    } else if (!mod && (e.key === '+' || e.key === '=')) this.zoomAt(1.2);
    else if (!mod && e.key === '-') this.zoomAt(1 / 1.2);
    else if (!mod && e.key === '0') this.fit();
    else return;
    e.preventDefault();
  }
}

// ------------------------------------------------------------------ drawing helpers

/** Explicit `color`, or dark/light text that stays readable on a custom fill. */
function textColor(st) {
  if (st.get('color') || !st.get('fill')) return st.get('color');
  measureCtx.fillStyle = '#000';
  measureCtx.fillStyle = st.get('fill').replace(/!important/, '');
  const hex = measureCtx.fillStyle;
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#1f1f23' : '#f4f4f6';
}

function styleAttr(st) {
  const parts = [];
  for (const k of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray']) if (st.get(k)) parts.push(`${k}:${st.get(k).replace(/!important/g, '')}`);
  return parts.join(';');
}

function textLines(lines, x, cy, color) {
  const y0 = cy - ((lines.length - 1) * LINE) / 2 + 5;
  const style = color ? ` style="fill:${esc(color)}"` : '';
  return `<text class="lbl"${style}>${lines.map((l, i) => `<tspan x="${x}" y="${y0 + i * LINE}">${esc(l) || ' '}</tspan>`).join('')}</text>`;
}

/**
 * Connector that leaves/enters the facing sides of two boxes, drawn like
 * mermaid's `flowchart.curve`: curved (default), straight (linear) or orthogonal (step*).
 */
function connector(A, B, off, curve = '') {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const horiz = Math.abs(dx) * (A.h + B.h + 1) > Math.abs(dy) * (A.w + B.w + 1);
  const sx = Math.sign(dx) || 1;
  const sy = Math.sign(dy) || 1;
  let p1, p2;
  if (horiz) {
    p1 = { x: A.x + (sx * A.w) / 2, y: A.y + off };
    p2 = { x: B.x - (sx * B.w) / 2, y: B.y + off };
  } else {
    p1 = { x: A.x + off, y: A.y + (sy * A.h) / 2 };
    p2 = { x: B.x + off, y: B.y - (sy * B.h) / 2 };
  }
  if (ROUND.has(A.shape) || A.shape === 'diam') (horiz ? (p1.y = A.y) : (p1.x = A.x));
  if (ROUND.has(B.shape) || B.shape === 'diam') (horiz ? (p2.y = B.y) : (p2.x = B.x));
  const c = Math.max(24, (horiz ? Math.abs(p2.x - p1.x) : Math.abs(p2.y - p1.y)) / 2);
  const c1 = horiz ? { x: p1.x + sx * c, y: p1.y } : { x: p1.x, y: p1.y + sy * c };
  const c2 = horiz ? { x: p2.x - sx * c, y: p2.y } : { x: p2.x, y: p2.y - sy * c };
  const r = (v) => Math.round(v * 10) / 10;
  if (curve === 'linear') return { d: `M${r(p1.x)},${r(p1.y)} L${r(p2.x)},${r(p2.y)}`, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2 };
  if (curve.startsWith('step')) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    return horiz
      ? { d: `M${r(p1.x)},${r(p1.y)} H${r(mx)} V${r(p2.y)} H${r(p2.x)}`, mx, my }
      : { d: `M${r(p1.x)},${r(p1.y)} V${r(my)} H${r(p2.x)} V${r(p2.y)}`, mx, my };
  }
  return {
    d: `M${r(p1.x)},${r(p1.y)} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${r(p2.x)},${r(p2.y)}`,
    mx: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    my: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
}

function selfLoop(A) {
  const x1 = A.x + A.w / 2;
  const y1 = A.y;
  const x2 = A.x;
  const y2 = A.y - A.h / 2;
  return { d: `M${x1},${y1} C${x1 + 50},${y1} ${x2},${y2 - 50} ${x2},${y2}`, mx: x1 + 18, my: y2 - 18 };
}

export function shapeMarkup(shape, w, h, st) {
  const L = -w / 2, R = w / 2, T = -h / 2, B = h / 2;
  const a = `class="sh" style="${esc(st)}"`;
  const line = (d) => `<path class="sh-line" d="${d}"/>`;
  const poly = (pts) => `<polygon ${a} points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
  const path = (d) => `<path ${a} d="${d}"/>`;
  const rect = (rx = 3, dx = 0, dy = 0) => `<rect ${a} x="${L + dx}" y="${T + dy}" width="${w}" height="${h}" rx="${rx}"/>`;
  const circle = (r, extra = '') => `<circle ${a} r="${r}"${extra}/>`;
  const s = Math.min(h / 2.5, 18);
  const doc = (dx = 0, dy = 0) => path(`M${L + dx},${T + dy}H${R + dx}V${B - 8 + dy}C${R * 0.5 + dx},${B + 6 + dy} ${L * 0.5 + dx},${B - 22 + dy} ${L + dx},${B - 6 + dy}Z`);
  switch (shape) {
    case 'rounded': return rect(10);
    case 'stadium': return rect(h / 2);
    case 'fr-rect': return rect(0) + line(`M${L + 8},${T}V${B}M${R - 8},${T}V${B}`);
    case 'cyl':
    case 'lin-cyl': {
      const ry = Math.min(10, h * 0.16);
      return path(`M${L},${T + ry}A${R},${ry} 0 0 1 ${R},${T + ry}A${R},${ry} 0 0 1 ${L},${T + ry}V${B - ry}A${R},${ry} 0 0 0 ${R},${B - ry}V${T + ry}`)
        + (shape === 'lin-cyl' ? line(`M${L},${T + ry * 2.4}A${R},${ry} 0 0 0 ${R},${T + ry * 2.4}`) : '');
    }
    case 'circle': return circle(R);
    case 'dbl-circ': return circle(R) + `<circle class="sh-line" r="${R - 4}"/>`;
    case 'sm-circ': return circle(R);
    case 'f-circ': return `<circle class="sh sh-solid" r="${R}"/>`;
    case 'fr-circ': return circle(R) + `<circle class="sh-solid" r="${R - 5}"/>`;
    case 'cross-circ': { const d = R * 0.707; return circle(R) + line(`M${-d},${-d}L${d},${d}M${d},${-d}L${-d},${d}`); }
    case 'diam': return poly([[0, T], [R, 0], [0, B], [L, 0]]);
    case 'hex': return poly([[L + s, T], [R - s, T], [R, 0], [R - s, B], [L + s, B], [L, 0]]);
    case 'odd': return poly([[L, T], [R, T], [R, B], [L, B], [L + s, 0]]);
    case 'lean-r': return poly([[L + s, T], [R, T], [R - s, B], [L, B]]);
    case 'lean-l': return poly([[L, T], [R - s, T], [R, B], [L + s, B]]);
    case 'trap-b': return poly([[L + s, T], [R - s, T], [R, B], [L, B]]);
    case 'trap-t': return poly([[L, T], [R, T], [R - s, B], [L + s, B]]);
    case 'doc': return doc();
    case 'lin-doc': return doc() + line(`M${L + 8},${T}V${B - 6}`);
    case 'docs': return doc(5, -5) + doc();
    case 'tag-doc': return doc() + poly([[R - 12, B - 9], [R, B - 9], [R, B - 21]]);
    case 'cloud': {
      const r = h / 3.2;
      return path(`M${L + r},${B - 2}A${r},${r} 0 0 1 ${L + r * 0.6},${T + h * 0.45}A${r * 1.1},${r * 1.1} 0 0 1 ${L + w * 0.32},${T + r * 0.7}A${r * 1.3},${r * 1.3} 0 0 1 ${R - w * 0.3},${T + r * 0.6}A${r},${r} 0 0 1 ${R - r * 0.5},${T + h * 0.5}A${r},${r} 0 0 1 ${R - r},${B - 2}Z`);
    }
    case 'bolt': return poly([[L, T], [w * 0.12, -h * 0.08], [-w * 0.05, h * 0.06], [R, B], [-w * 0.12, h * 0.08], [w * 0.05, -h * 0.06]]);
    case 'delay': return path(`M${L},${T}H${R - h / 2}A${h / 2},${h / 2} 0 0 1 ${R - h / 2},${B}H${L}Z`);
    case 'h-cyl': {
      const rx = Math.min(12, w * 0.12);
      return path(`M${L + rx},${T}H${R - rx}A${rx},${h / 2} 0 0 1 ${R - rx},${B}H${L + rx}A${rx},${h / 2} 0 0 1 ${L + rx},${T}Z`) + line(`M${R - rx},${T}A${rx},${h / 2} 0 0 0 ${R - rx},${B}`);
    }
    case 'notch-rect': return poly([[L + 12, T], [R, T], [R, B], [L, B], [L, T + 12]]);
    case 'lin-rect': return rect(0) + line(`M${L + 8},${T}V${B}`);
    case 'st-rect': return rect(0, 5, -5) + rect(0);
    case 'tag-rect': return rect(0) + poly([[R - 12, B], [R, B], [R, B - 12]]);
    case 'flag': return path(`M${L},${T + 5}Q${L / 2},${T - 5} 0,${T + 5}T${R},${T + 5}V${B - 5}Q${R / 2},${B + 5} 0,${B - 5}T${L},${B - 5}Z`);
    case 'hourglass': return poly([[L, T], [R, T], [L, B], [R, B]]);
    case 'tri': return poly([[0, T], [R, B], [L, B]]);
    case 'flip-tri': return poly([[L, T], [R, T], [0, B]]);
    case 'fork': return `<rect class="sh sh-solid" x="${L}" y="${T}" width="${w}" height="${h}" rx="2"/>`;
    case 'brace': return `<rect class="sh-hit" x="${L}" y="${T}" width="${w}" height="${h}"/>` + line(`M${L + 12},${T}Q${L + 4},${T} ${L + 4},${T + 8}V-6L${L - 2},0L${L + 4},6V${B - 8}Q${L + 4},${B} ${L + 12},${B}`);
    case 'brace-r': return `<rect class="sh-hit" x="${L}" y="${T}" width="${w}" height="${h}"/>` + line(`M${R - 12},${T}Q${R - 4},${T} ${R - 4},${T + 8}V-6L${R + 2},0L${R - 4},6V${B - 8}Q${R - 4},${B} ${R - 12},${B}`);
    case 'braces': return shapeMarkup('brace', w, h, st) + line(`M${R - 12},${T}Q${R - 4},${T} ${R - 4},${T + 8}V-6L${R + 2},0L${R - 4},6V${B - 8}Q${R - 4},${B} ${R - 12},${B}`);
    case 'text': return `<rect class="sh-text" x="${L}" y="${T}" width="${w}" height="${h}" rx="3"/>`;
    case 'win-pane': return rect(0) + line(`M${L + 10},${T}V${B}M${L},${T + 10}H${R}`);
    case 'div-rect': return rect(0) + line(`M${L},${T + 12}H${R}`);
    case 'bow-rect': return path(`M${L + 8},${T}H${R}A8,${h / 2} 0 0 0 ${R},${B}H${L + 8}A8,${h / 2} 0 0 1 ${L + 8},${T}Z`);
    case 'curv-trap': return path(`M${L + 14},${T}H${R - h / 2}A${h / 2},${h / 2} 0 0 1 ${R - h / 2},${B}H${L + 14}L${L},0Z`);
    case 'notch-pent': return poly([[L + 10, T], [R - 10, T], [R, T + 10], [R, B], [L, B], [L, T + 10]]);
    case 'sl-rect': return poly([[L, T + 10], [R, T], [R, B], [L, B]]);
    default: return rect(3);
  }
}
