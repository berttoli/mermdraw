// app.js — wires the file, the outline, the canvas, the code pane and the
// mermaid preview together, and keeps the markdown file on disk in sync.

import * as M from './model.js';
import { Canvas, shapeMarkup, labelToEditor, editorToLabel } from './canvas.js';
import { FLAGS, flag, flagSource, inheritedFlag, initFlags, onFlags, setFlag } from './flags.js';
import { IconStore, prettyIconName } from './icons.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;
const clientId = Math.random().toString(36).slice(2);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('mmdr:' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('mmdr:' + k, JSON.stringify(v));
    } catch {}
  },
};

const S = {
  info: null,
  files: [],
  path: null,
  text: '',
  version: null,
  scan: null,
  index: 0,
  src: '',
  kind: '',
  model: null,
  view: store.get('view', 'split'),
  autosave: store.get('autosave', true),
  dirty: false,
  editSeq: 0,
  scope: 'block',
  hist: new Map(),
  layoutToken: 0,
  nav: [], // drill-down history: [{path, index, title}]
};

let canvas;
const iconStore = new IconStore(() => canvas?.render());
const codeTa = $('#code textarea');
const codePre = $('#code pre');
const docTa = $('#doc');

// ------------------------------------------------------------------ boot

async function init() {
  applyTheme(store.get('theme', 'auto'));
  canvas = new Canvas($('#canvas'), {
    change: commitFromCanvas,
    select: () => renderInspector(),
    upload: uploadImage,
    asset: assetUrl,
    openLink: followLink,
    pickImage: (at) => {
      pendingImageAt = at;
      $('#img-input').click();
    },
    pickIcon: (at) => openIconPicker((ref) => canvas.addIcon(ref, at, prettyIconName(ref))),
    icon: (ref) => (flag('icons') ? iconStore.get(ref) : false),
    flag,
    zoom: (k) => ($('#zoom-label').textContent = Math.round(k * 100) + '%'),
  });
  window.mmdr = { S, canvas }; // handy from the devtools console
  buildPalette();
  bindUI();
  setView(S.view);
  $('#autosave').checked = S.autosave;
  try {
    S.info = await (await fetch('/api/info')).json();
  } catch {
    return showFatal('Cannot reach the mmdr server. Is it still running?');
  }
  const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  initFlags({ project: config?.flags, cli: S.info.flags });
  onFlags(applyFlags);
  await iconStore.refresh();
  iconStore.registerWithMermaid(mermaid);
  buildPalette();
  await refreshFiles();
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || S.info.initial || S.files.find((f) => f.diagrams)?.path || S.files[0]?.path;
  if (!file) return showFatal(`No markdown files under <code>${esc(S.info.root)}</code>.<br>Create one with <code>mmdr new docs/architecture.md</code>.`);
  const d = +(new URLSearchParams(location.hash.slice(1)).get('d') || 1) - 1;
  await openFile(file, d);
  connectEvents();
}

function showFatal(html) {
  $('#cv-msg').innerHTML = `<div>${html}</div>`;
  $('#cv-msg').hidden = false;
  setView('canvas');
}

async function refreshFiles() {
  try {
    S.files = (await (await fetch('/api/files')).json()).files;
  } catch {
    S.files = [];
  }
  const sel = $('#file');
  const paths = S.files.map((f) => f.path);
  if (S.path && !paths.includes(S.path)) paths.unshift(S.path);
  sel.innerHTML = paths.map((p) => {
    const f = S.files.find((x) => x.path === p);
    return `<option value="${esc(p)}">${esc(p)}${f?.diagrams ? ` (${f.diagrams})` : ''}</option>`;
  }).join('');
  if (S.path) sel.value = S.path;
}

async function openFile(path, index = 0) {
  if (S.dirty) await saveNow();
  let r;
  try {
    r = await fetch('/api/file?path=' + enc(path));
  } catch {
    return toast('mmdr server is not reachable');
  }
  if (!r.ok) return toast(`Cannot open ${path}`);
  S.path = path;
  S.text = await r.text();
  S.version = r.headers.get('X-Version');
  S.dirty = false;
  S.scope = 'block';
  setStatus('saved');
  rescan();
  if (![...$('#file').options].some((o) => o.value === path)) await refreshFiles();
  $('#file').value = path;
  document.title = `${path.split('/').pop()} · mmdr`;
  if (S.view === 'doc') docTa.value = S.text;
  selectBlock(Math.max(0, Math.min(index, S.scan.blocks.length - 1)), { fit: true });
}

function rescan() {
  S.scan = M.scanDoc(S.text, M.isMmdPath(S.path));
  renderOutline();
}

function selectBlock(i, { fit = false } = {}) {
  S.index = i;
  const b = S.scan.blocks[i];
  $('#cv-msg').hidden = true;
  if (!b) {
    S.src = '';
    S.kind = '';
    S.model = null;
    setCode('');
    $('#preview').innerHTML = '';
    $('#cv-msg').innerHTML = `<div><b>No mermaid diagrams in this file yet.</b><br><br><button class="btn primary" id="first-diagram">Add a flowchart</button></div>`;
    $('#cv-msg').hidden = false;
    $('#first-diagram').onclick = () => addDiagram('flowchart', 'Overview');
    renderOutline();
    renderInspector(true);
    updateUrl();
    return;
  }
  if (canvas) for (const k of ['nodes', 'edges', 'groups']) canvas.sel[k].clear();
  const h = S.hist.get(histKey());
  if (!h || h.stack[h.i] !== b.source) S.hist.set(histKey(), { stack: [b.source], i: 0, t: 0, key: '' });
  loadSource(b.source, { fit });
  renderOutline();
  updateUrl();
}

/** Makes `src` the current diagram source and refreshes every view of it. */
function loadSource(src, { fit = false, fromCode = false, keep = false } = {}) {
  const prev = S.model;
  S.src = src;
  S.kind = M.describe(src).kind;
  S.model = M.isFlowchartKind(S.kind) ? M.parseFlowchart(src) : null;
  if (S.model && prev && keep) {
    for (const n of S.model.nodes) if (!S.model.layout[n.id] && prev.layout[n.id]) S.model.layout[n.id] = prev.layout[n.id];
    for (const g of S.model.groups) if (!S.model.layout[g.id] && prev.layout[g.id]) S.model.layout[g.id] = prev.layout[g.id];
  }
  if (!fromCode) setCode(src);
  updateModeUI();
  if (S.model) {
    const m = S.model;
    const token = ++S.layoutToken;
    if (m.nodes.length && m.nodes.every((n) => !m.layout[n.id])) {
      mermaidLayout(src).then((pos) => {
        if (token !== S.layoutToken) return;
        // only trust mermaid's layout if it placed (nearly) everything; else lay out from scratch
        const placed = pos ? m.nodes.filter((n) => pos[n.id]).length : 0;
        if (placed >= m.nodes.length * 0.8) for (const [id, p] of Object.entries(pos)) if (M.getNode(m, id)) m.layout[id] = p;
        canvas.setModel(m, { fit: true });
        renderInspector(true);
      });
    } else canvas.setModel(m, { fit });
  }
  updateCodeInfo();
  schedulePreview();
  renderInspector(true);
}

function commitFromCanvas(kind) {
  const src = M.serializeFlowchart(S.model);
  if (src === S.src) return;
  S.src = src;
  setCode(src);
  pushHistory(src, kind === 'inspect' || kind === 'move' ? kind : '');
  applyToDoc();
  schedulePreview();
  updateCodeInfo();
  renderInspector();
}

function applyToDoc() {
  S.text = M.replaceBlock(S.text, S.scan, S.index, S.src);
  S.scan = M.scanDoc(S.text, M.isMmdPath(S.path));
  renderOutline();
  S.scope = 'block';
  markDirty();
}

function updateModeUI() {
  const flow = !!S.model;
  $('#palette').hidden = !flow;
  $$('#views button').forEach((b) => (b.disabled = !flow && (b.dataset.view === 'canvas' || b.dataset.view === 'split')));
  setView(S.view);
}

function setView(v) {
  S.view = v;
  store.set('view', v);
  const eff = v === 'doc' ? 'doc' : !S.model && S.scan?.blocks[S.index] ? 'preview' : v;
  const stage = $('#stage');
  stage.className = `stage view-${eff}`;
  $$('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  docTa.hidden = eff !== 'doc';
  if (eff === 'doc') {
    docTa.value = S.text;
  } else {
    if (S.view !== 'doc' && docDirty) {
      docDirty = false;
      rescan();
      selectBlock(Math.min(S.index, Math.max(0, S.scan.blocks.length - 1)));
    }
    if (eff === 'preview' || eff === 'split') schedulePreview();
  }
}
let docDirty = false;

// ------------------------------------------------------------------ outline

const KIND_ICON = { flowchart: '◇', graph: '◇', sequenceDiagram: '⇄', classDiagram: '▤', 'stateDiagram-v2': '◎', stateDiagram: '◎', erDiagram: '⊞', 'architecture-beta': '☁', gantt: '▭', mindmap: '✺', C4Context: '⬚' };

function renderOutline() {
  const el = $('#outline');
  if (!S.scan) return;
  const items = [];
  for (const h of S.scan.headings) items.push([h.line, `<div class="ol-h l${h.level}">${esc(h.text)}</div>`]);
  for (const b of S.scan.blocks) {
    items.push([b.start, `<div class="ol-d${b.index === S.index ? ' active' : ''}" data-block="${b.index}" title="${esc(b.kind)} · line ${b.start + 2}">
      <span class="ol-ico">${KIND_ICON[b.kind] || '◆'}</span><span class="ol-t">${esc(b.title || `Diagram ${b.index + 1}`)}</span>
      <span class="ol-k">${esc(b.kind.replace(/Diagram.*$|-beta$|-v2$/, ''))}</span>${S.scan.wholeFile ? '' : `<button class="ol-x" data-del="${b.index}" title="Delete diagram">×</button>`}</div>`]);
  }
  items.sort((a, b) => a[0] - b[0]);
  el.innerHTML = items.map((x) => x[1]).join('') || '<div class="ol-empty">No headings or diagrams yet.</div>';
  const b = S.scan.blocks[S.index];
  $('#crumb').textContent = b ? `› ${b.title || `Diagram ${S.index + 1}`}` : '';
}

function addDiagram(type, title) {
  const after = S.scan.blocks.length ? S.index : -1;
  S.text = M.insertBlock(S.text, S.scan, after, M.TEMPLATES[type] || M.TEMPLATES.flowchart, title || '');
  S.scope = 'doc';
  rescan();
  markDirty();
  selectBlock(after + 1, { fit: true });
}

function deleteDiagram(i) {
  const b = S.scan.blocks[i];
  if (!b || !confirm(`Delete "${b.title || `Diagram ${i + 1}`}" from ${S.path}?`)) return;
  S.text = M.deleteBlock(S.text, S.scan, i);
  S.scope = 'doc';
  rescan();
  markDirty();
  selectBlock(Math.max(0, Math.min(i, S.scan.blocks.length - 1)), { fit: true });
}

// ------------------------------------------------------------------ code pane

function setCode(src) {
  if (codeTa.value !== src) {
    const focused = document.activeElement === codeTa;
    const { selectionStart: a, selectionEnd: b, scrollTop } = codeTa;
    codeTa.value = src;
    if (focused) codeTa.setSelectionRange(Math.min(a, src.length), Math.min(b, src.length));
    codeTa.scrollTop = scrollTop;
  }
  highlight();
}

const KW = /^(\s*)(flowchart-elk|flowchart|graph|subgraph|end|direction|classDef|class|style|linkStyle|click|sequenceDiagram|participant|actor|loop|alt|else|opt|par|and|critical|break|rect|Note|note|activate|deactivate|autonumber|box|classDiagram|stateDiagram-v2|stateDiagram|state|erDiagram|gantt|section|title|dateFormat|axisFormat|journey|pie|mindmap|timeline|gitGraph|commit|branch|checkout|merge|architecture-beta|group|service|junction|C4Context|C4Container|C4Component|C4Dynamic|C4Deployment|block-beta|block|columns|quadrantChart|xychart-beta|sankey-beta|requirementDiagram|kanban|packet-beta|radar-beta|accTitle|accDescr)\b/;
const TOKENS = /("[^"\n]*")|(\|[^|\n]*\|)|(<{0,2}[ox*]?(?:-{2,}|={2,}|-\.+-|~{3,}|-{1,2}>{1,2}|-[x)]|-{2}[x)])[>ox*]?(?:\|>)?)/g;

function highlight() {
  const out = codeTa.value.split('\n').map((line) => {
    if (/^\s*%%\s*mmdr:/.test(line)) return `<span class="hl-m">${esc(line)}</span>`;
    if (/^\s*%%/.test(line)) return `<span class="hl-c">${esc(line)}</span>`;
    let head = '';
    let rest = line;
    const k = KW.exec(line);
    if (k) {
      head = esc(k[1]) + `<span class="hl-k">${esc(k[2])}</span>`;
      rest = line.slice(k[0].length);
    }
    let html = '';
    let last = 0;
    for (const t of rest.matchAll(TOKENS)) {
      html += esc(rest.slice(last, t.index));
      const cls = t[1] ? 'hl-s' : t[2] ? 'hl-l' : 'hl-a';
      html += `<span class="${cls}">${esc(t[0])}</span>`;
      last = t.index + t[0].length;
    }
    return head + html + esc(rest.slice(last));
  });
  codePre.innerHTML = out.join('\n') + '\n';
  codePre.scrollTop = codeTa.scrollTop;
  codePre.scrollLeft = codeTa.scrollLeft;
}

function updateCodeInfo() {
  const m = S.model;
  $('#code-info').textContent = m ? `· ${m.nodes.length} nodes · ${m.edges.length} edges${m.groups.length ? ` · ${m.groups.length} groups` : ''}` : S.kind ? `· ${S.kind}` : '';
}

let codeTimer = 0;
function onCodeInput() {
  highlight();
  clearTimeout(codeTimer);
  codeTimer = setTimeout(() => {
    const src = codeTa.value;
    if (src === S.src || !S.scan?.blocks[S.index]) return;
    loadSource(src, { fromCode: true, keep: true });
    pushHistory(src, 'code');
    applyToDoc();
  }, 160);
}

// ------------------------------------------------------------------ history

const histKey = () => `${S.path}#${S.index}`;

function pushHistory(src, key = '') {
  let h = S.hist.get(histKey());
  if (!h) S.hist.set(histKey(), (h = { stack: [src], i: 0, t: 0, key: '' }));
  if (h.stack[h.i] === src) return;
  const now = Date.now();
  h.stack.splice(h.i + 1);
  // coalesce bursts of typing / nudging into one undo step
  if (key && key === h.key && now - h.t < 900 && h.i > 0) h.stack[h.i] = src;
  else h.stack.push(src);
  if (h.stack.length > 300) h.stack.shift();
  h.i = h.stack.length - 1;
  h.t = now;
  h.key = key;
}

function undo(dir = -1) {
  const h = S.hist.get(histKey());
  if (!h) return;
  const j = h.i + dir;
  if (j < 0 || j >= h.stack.length) return;
  h.i = j;
  h.key = '';
  loadSource(h.stack[j], { keep: false });
  applyToDoc();
}

// ------------------------------------------------------------------ preview + layout

function setupMermaid() {
  mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict' });
}

let pvTimer = 0;
let pvSeq = 0;
function schedulePreview() {
  clearTimeout(pvTimer);
  pvTimer = setTimeout(renderPreview, 180);
}

async function renderPreview() {
  const eff = $('#stage').className;
  if (!/view-(split|preview)/.test(eff)) return;
  const seq = ++pvSeq;
  const src = previewSource(S.src);
  const err = $('#pv-err');
  if (!src.trim()) {
    $('#preview').innerHTML = '';
    err.hidden = true;
    return;
  }
  const id = `mmdr-pv-${seq}`;
  try {
    const { svg } = await mermaid.render(id, src);
    if (seq !== pvSeq) return;
    $('#preview').innerHTML = svg;
    err.hidden = true;
  } catch (e) {
    if (seq !== pvSeq) return;
    err.textContent = String(e?.message || e).split('\n').slice(0, 6).join('\n');
    err.hidden = false;
  } finally {
    // mermaid renders inside a temporary #d<id> container (left behind on errors)
    document.getElementById('d' + id)?.remove();
  }
}

/** Mermaid resolves image paths against the page URL; point them at /raw/. */
function previewSource(src) {
  return src.replace(/(\bimg:\s*")([^"]+)(")/g, (_, a, p, b) => a + assetUrl(p) + b);
}

let laySeq = 0;
/** Lets mermaid lay the diagram out and reads back node centres from its SVG. */
async function mermaidLayout(src) {
  const id = `mmdr-lay-${++laySeq}`;
  const host = $('#layout-host');
  try {
    const clean = src.split('\n').filter((l) => !/^\s*%%\s*mmdr:layout/.test(l)).join('\n');
    const { svg } = await mermaid.render(id, previewSource(clean));
    host.innerHTML = svg;
    const root = host.querySelector('svg');
    const vb = root.viewBox.baseVal;
    const rect = root.getBoundingClientRect();
    const scale = vb && vb.width && rect.width ? vb.width / rect.width : 1;
    const pos = {};
    // plain nodes are g.node; icon/image nodes are g.icon-shape / g.image-shape
    for (const el of root.querySelectorAll('g[id]')) {
      const mm = /(?:^|-)flowchart-(.+)-\d+$/.exec(el.id);
      if (/\b(cluster|edge|label)/.test(el.getAttribute('class') || '')) continue;
      if (!mm) continue;
      const r = el.getBoundingClientRect();
      pos[mm[1]] = {
        x: Math.round(((r.left + r.width / 2 - rect.left) * scale + (vb?.x || 0)) * 1.15),
        y: Math.round(((r.top + r.height / 2 - rect.top) * scale + (vb?.y || 0)) * 1.15),
      };
    }
    return Object.keys(pos).length ? pos : null;
  } catch {
    return null;
  } finally {
    host.innerHTML = '';
    document.getElementById('d' + id)?.remove();
  }
}

async function autoLayout() {
  if (!S.model) return;
  const m = S.model;
  let pos = await mermaidLayout(S.src);
  if (pos && m.nodes.filter((n) => pos[n.id]).length < m.nodes.length * 0.8) pos = null;
  const fallback = !pos;
  const layout = pos || M.layeredLayout(m, (id) => canvas.sizeOf(M.getNode(m, id)));
  for (const n of m.nodes) if (layout[n.id]) m.layout[n.id] = layout[n.id];
  canvas.setModel(m, { fit: true });
  commitFromCanvas('layout');
  toast(fallback ? 'Laid out (built-in)' : 'Laid out like mermaid renders it');
}

// ------------------------------------------------------------------ inspector

let inspKey = '';
let inspTimer = 0;
const inspectCommit = () => {
  canvas.render();
  clearTimeout(inspTimer);
  inspTimer = setTimeout(() => canvas.changed('inspect'), 250);
};
const commitNow = () => {
  clearTimeout(inspTimer);
  canvas.changed('inspect');
};

const row = (label, html) => `<div class="row"><label>${label}</label><div>${html}</div></div>`;
const seg = (name, value, opts) => `<div class="seg" data-seg="${name}">${opts.map(([v, l, t]) => `<button data-v="${esc(v)}" class="${v === value ? 'on' : ''}"${t ? ` title="${esc(t)}"` : ''}>${l}</button>`).join('')}</div>`;

function toHex(c) {
  if (!c) return '';
  c = c.trim().replace(/!important/, '').trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + [...c.slice(1)].map((x) => x + x).join('').toLowerCase();
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillStyle = c;
  return /^#[0-9a-f]{6}$/i.test(ctx.fillStyle) ? ctx.fillStyle : '';
}

function colorFields(css, keys = [['fill', 'Fill'], ['stroke', 'Stroke'], ['color', 'Text']]) {
  return `<div class="colors">${keys.map(([k, l]) => {
    const v = toHex(css.get(k));
    return `<label class="sw${v ? '' : ' unset'}"><input type="color" data-css="${k}" value="${v || '#ffffff'}"><i style="${v ? `background:${v}` : ''}"></i>${l}${v ? `<button data-clear="${k}" title="Clear">×</button>` : ''}</label>`;
  }).join('')}</div>`;
}

/** Wires color swatches to a css string getter/setter. */
function bindColors(el, get, set) {
  for (const inp of $$('[data-css]', el)) {
    inp.addEventListener('input', () => {
      const css = M.parseCss(get());
      css.set(inp.dataset.css, inp.value);
      set(M.cssString(css));
      const sw = inp.parentElement;
      sw.classList.remove('unset');
      sw.querySelector('i').style.background = inp.value;
      inspectCommit();
    });
    inp.addEventListener('change', () => renderInspector(true));
  }
  for (const b of $$('[data-clear]', el)) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const css = M.parseCss(get());
      css.delete(b.dataset.clear);
      set(M.cssString(css));
      commitNow();
      renderInspector(true);
    });
  }
}

function setStyle(id, css) {
  if (css) S.model.styles[id] = css;
  else delete S.model.styles[id];
}

function shapeOptions(cur) {
  const known = M.SHAPES.some(([s]) => s === cur);
  return (known ? '' : `<option value="${esc(cur)}" selected>${esc(cur)}</option>`) + M.SHAPES.map(([s, l]) => `<option value="${s}"${s === cur ? ' selected' : ''}>${l} · ${s}</option>`).join('');
}

function groupOptions(cur, exclude = new Set()) {
  return `<option value="">(top level)</option>` + S.model.groups.filter((g) => !exclude.has(g.id)).map((g) => `<option value="${esc(g.id)}"${g.id === cur ? ' selected' : ''}>${esc(g.title)}${g.implicit ? '' : ` · ${esc(g.id)}`}</option>`).join('');
}

function endpointOptions(cur) {
  const m = S.model;
  return m.nodes.map((n) => `<option value="${esc(n.id)}"${n.id === cur ? ' selected' : ''}>${esc(n.id)}</option>`).join('')
    + m.groups.filter((g) => !g.implicit).map((g) => `<option value="${esc(g.id)}"${g.id === cur ? ' selected' : ''}>▢ ${esc(g.id)}</option>`).join('');
}

function renderInspector(force = false) {
  const el = $('#inspector');
  const m = S.model;
  const sel = canvas?.selection || { nodes: [], edges: [], groups: [] };
  const key = JSON.stringify([S.path, S.index, sel]);
  if (!force && key === inspKey && el.contains(document.activeElement)) return;
  inspKey = key;
  if (!S.scan?.blocks[S.index]) {
    el.innerHTML = `<div class="ins-note">Open or create a diagram to start.</div>`;
    return;
  }
  if (!m) {
    el.innerHTML = `<div class="ins-h"><span class="tag">${esc(S.kind || 'diagram')}</span></div>
      <p class="ins-note">The visual canvas edits <b>flowcharts</b> (<code>flowchart</code> / <code>graph</code>). For this diagram type, edit the mermaid below — the preview updates as you type and every change is saved into <code>${esc(S.path)}</code>.</p>`;
    return;
  }
  const nodes = sel.nodes.filter((id) => M.getNode(m, id));
  const edges = sel.edges.filter((i) => m.edges[i]);
  const groups = sel.groups.filter((id) => M.getGroup(m, id));
  const total = nodes.length + edges.length + groups.length;
  if (total === 1 && nodes.length) return nodeInspector(el, M.getNode(m, nodes[0]));
  if (total === 1 && edges.length) return edgeInspector(el, edges[0]);
  if (total === 1 && groups.length) return groupInspector(el, M.getGroup(m, groups[0]));
  if (total > 1) return multiInspector(el, { nodes, edges, groups });
  diagramInspector(el);
}

function nodeInspector(el, n) {
  const m = S.model;
  const link = m.links[n.id] || {};
  const p = n.props || {};
  el.innerHTML = `<div class="ins-h"><span class="tag">Node</span><code>${esc(n.id)}</code></div>
    ${row('ID', `<input data-k="id" value="${esc(n.id)}" spellcheck="false" title="Mermaid identifier (used by edges)">`)}
    ${row('Label', `<textarea data-k="label" rows="2">${esc(labelToEditor(n.label))}</textarea>`)}
    ${row('Shape', `<select data-k="shape">${shapeOptions(n.shape)}</select>`)}
    ${n.shape === 'image' ? row('Image', `<div class="inline"><input data-p="img" value="${esc(p.img || '')}" placeholder="./assets/logo.png or https://…"><button class="btn small" data-act="pick">…</button></div>`)
      + row('Size', `<div class="inline"><input data-p="w" value="${esc(p.w || '')}" placeholder="w"><input data-p="h" value="${esc(p.h || '')}" placeholder="h"></div>`)
      + row('Caption', seg('pos', p.pos || 'b', [['t', 'Top'], ['b', 'Bottom']])) : ''}
    ${n.shape === 'icon' ? row('Icon', `<div class="inline"><span class="icon-prev">${iconPreview(p.icon)}</span><input data-p="icon" value="${esc(p.icon || '')}" placeholder="logos:python" spellcheck="false"><button class="btn small" data-act="pick-icon">Browse…</button></div>`)
      + row('Form', seg('form', p.form || '', [['', 'None'], ['square', 'Square'], ['circle', 'Circle'], ['rounded', 'Rounded']]))
      + row('Size', `<input data-p="h" value="${esc(p.h || '')}" placeholder="48 (height in px)">`)
      + row('Caption', seg('pos', p.pos || 'b', [['t', 'Top'], ['b', 'Bottom']])) : ''}
    ${row('Group', `<select data-k="parent">${groupOptions(n.parent)}</select>`)}
    ${row('Link', `<div class="inline"><input data-k="url" value="${esc(link.url || '')}" placeholder="https://… or ./service.md#2"><button class="btn small" data-act="follow"${link.url ? '' : ' disabled'} title="Open link">↗</button></div>`)}
    ${link.url ? row('Tooltip', `<input data-k="tooltip" value="${esc(link.tooltip || '')}">`) : ''}
    ${row('Colors', colorFields(M.parseCss(m.styles[n.id])))}
    ${m.classDefs.length || m.classes[n.id] ? row('Classes', `<input data-k="classes" value="${esc((m.classes[n.id] || []).join(', '))}" placeholder="${esc(m.classDefs.map((c) => c.name).join(', '))}">`) : ''}
    <div class="ins-actions"><button class="btn" data-act="connect">+ Connected <kbd>Tab</kbd></button><button class="btn" data-act="dup">Duplicate</button><button class="btn danger" data-act="delete">Delete</button></div>`;
  let id = n.id;
  const node = () => M.getNode(m, id);
  $('[data-k="id"]', el).addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v === id) return;
    if (!M.renameId(m, id, v)) {
      toast(M.validId(v) ? `"${v}" is already used` : `"${v}" is not a valid mermaid id`);
      e.target.value = id;
      return;
    }
    canvas.sel.nodes.delete(id);
    canvas.sel.nodes.add(v);
    id = v;
    commitNow();
    renderInspector(true);
  });
  $('[data-k="label"]', el).addEventListener('input', (e) => {
    node().label = editorToLabel(e.target.value);
    inspectCommit();
  });
  $('[data-k="shape"]', el).addEventListener('change', (e) => {
    const nd = node();
    nd.shape = e.target.value;
    if (nd.shape === 'image' && !nd.props.img) Object.assign(nd.props, { img: '', w: '64', h: '64' });
    if (nd.shape === 'icon' && !nd.props.icon) nd.props.icon = 'fa:cube';
    if (nd.shape !== 'image') for (const k of ['img', 'pos', 'w', 'h', 'constraint']) delete nd.props[k];
    if (nd.shape !== 'icon') for (const k of ['icon', 'form']) delete nd.props[k];
    if (!M.BRACKETS[nd.shape]) nd.at = true;
    commitNow();
    renderInspector(true);
  });
  for (const inp of $$('[data-p]', el)) {
    inp.addEventListener('input', () => {
      node().props[inp.dataset.p] = inp.value.trim();
      inspectCommit();
    });
  }
  bindSeg(el, 'pos', (v) => ((node().props.pos = v), commitNow()));
  bindSeg(el, 'form', (v) => {
    if (v) node().props.form = v;
    else delete node().props.form;
    commitNow();
  });
  $('[data-k="parent"]', el).addEventListener('change', (e) => {
    node().parent = e.target.value || null;
    commitNow();
  });
  $('[data-k="url"]', el).addEventListener('change', (e) => {
    const url = e.target.value.trim();
    if (url) m.links[id] = { tooltip: '', target: '', ...m.links[id], url };
    else delete m.links[id];
    commitNow();
    renderInspector(true);
  });
  $('[data-k="tooltip"]', el)?.addEventListener('input', (e) => {
    if (m.links[id]) m.links[id].tooltip = e.target.value;
    inspectCommit();
  });
  $('[data-k="classes"]', el)?.addEventListener('change', (e) => {
    const list = e.target.value.split(/[\s,]+/).filter(Boolean);
    if (list.length) m.classes[id] = list;
    else delete m.classes[id];
    commitNow();
  });
  bindColors(el, () => m.styles[id], (css) => setStyle(id, css));
  bindActions(el, {
    follow: () => m.links[id]?.url && followLink(m.links[id].url),
    pick: () => {
      pendingImageFor = id;
      $('#img-input').click();
    },
    'pick-icon': () =>
      openIconPicker((ref) => {
        const nd = node();
        const auto = !nd.label || nd.label === nd.id || nd.label === prettyIconName(nd.props.icon || '');
        nd.props.icon = ref;
        if (auto) nd.label = prettyIconName(ref);
        commitNow();
        renderInspector(true);
      }, String(p.icon || '').replace(/^[^:]*:/, '')),
    connect: () => canvas.addConnected(id),
    dup: () => canvas.duplicateSelection(),
    delete: () => canvas.deleteSelection(),
  });
}

function edgeInspector(el, i) {
  const m = S.model;
  const e = m.edges[i];
  if (!e) return diagramInspector(el);
  const arrows = [['', 'None'], ['>', 'Arrow'], ['o', 'Circle'], ['x', 'Cross']];
  el.innerHTML = `<div class="ins-h"><span class="tag">Edge</span><code>${esc(e.from)} ${esc(M.linkStr(e))} ${esc(e.to)}</code></div>
    ${row('From', `<div class="inline"><select data-k="from">${endpointOptions(e.from)}</select><button class="btn small" data-act="reverse" title="Reverse direction">⇄</button></div>`)}
    ${row('To', `<select data-k="to">${endpointOptions(e.to)}</select>`)}
    ${row('Label', `<input data-k="label" value="${esc(labelToEditor(e.label))}" placeholder="e.g. HTTPS, publishes">`)}
    ${row('Line', seg('stroke', e.stroke, [['normal', 'Solid'], ['thick', 'Thick'], ['dotted', 'Dotted'], ['invisible', 'Hidden', 'Invisible link (layout only)']]))}
    ${row('Start', seg('start', e.start === '<' ? '>' : e.start, arrows))}
    ${row('End', seg('end', e.end, arrows))}
    ${row('Length', seg('len', String(e.len), [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]))}
    ${row('Color', colorFields(M.parseCss(e.style), [['stroke', 'Line'], ['color', 'Label']]))}
    <div class="ins-actions"><button class="btn danger" data-act="delete">Delete edge</button></div>`;
  $('[data-k="from"]', el).addEventListener('change', (ev) => ((e.from = ev.target.value), commitNow(), renderInspector(true)));
  $('[data-k="to"]', el).addEventListener('change', (ev) => ((e.to = ev.target.value), commitNow(), renderInspector(true)));
  $('[data-k="label"]', el).addEventListener('input', (ev) => ((e.label = editorToLabel(ev.target.value)), inspectCommit()));
  bindSeg(el, 'stroke', (v) => ((e.stroke = v), commitNow(), renderInspector(true)));
  bindSeg(el, 'start', (v) => ((e.start = v === '>' ? '<' : v), commitNow(), renderInspector(true)));
  bindSeg(el, 'end', (v) => ((e.end = v), commitNow(), renderInspector(true)));
  bindSeg(el, 'len', (v) => ((e.len = +v), commitNow(), renderInspector(true)));
  bindColors(el, () => e.style, (css) => (e.style = css));
  bindActions(el, {
    reverse: () => {
      [e.from, e.to] = [e.to, e.from];
      commitNow();
      renderInspector(true);
    },
    delete: () => canvas.deleteSelection(),
  });
}

function groupInspector(el, g) {
  const m = S.model;
  if (!g) return diagramInspector(el);
  const d = M.descendants(m, g.id);
  el.innerHTML = `<div class="ins-h"><span class="tag">Group</span><code>subgraph ${esc(g.implicit ? g.title : g.id)}</code></div>
    ${row('ID', `<input data-k="id" value="${esc(g.implicit ? '' : g.id)}" placeholder="(none — title only)" spellcheck="false">`)}
    ${row('Title', `<input data-k="title" value="${esc(labelToEditor(g.title))}">`)}
    ${row('Direction', seg('dir', g.dir || '', [['', 'Inherit'], ['TB', 'TB'], ['LR', 'LR'], ['BT', 'BT'], ['RL', 'RL']]))}
    ${row('Parent', `<select data-k="parent">${groupOptions(g.parent, new Set([g.id, ...d.groups]))}</select>`)}
    ${g.implicit ? '' : row('Colors', colorFields(M.parseCss(m.styles[g.id])))}
    <p class="ins-note">${d.nodes.size} node${d.nodes.size === 1 ? '' : 's'} inside. Drag nodes onto the box to add them, or out of it to remove them.</p>
    <div class="ins-actions"><button class="btn" data-act="ungroup">Ungroup <kbd>⇧⌘G</kbd></button><button class="btn danger" data-act="delete-all">Delete with contents</button></div>`;
  let id = g.id;
  $('[data-k="id"]', el).addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (!v || v === id) return;
    if (!M.renameId(m, id, v)) {
      toast(`"${v}" is not a valid, unused id`);
      e.target.value = g.implicit ? '' : id;
      return;
    }
    canvas.sel.groups.delete(id);
    canvas.sel.groups.add(v);
    id = v;
    commitNow();
    renderInspector(true);
  });
  $('[data-k="title"]', el).addEventListener('input', (e) => {
    const grp = M.getGroup(m, id);
    grp.title = editorToLabel(e.target.value) || grp.title;
    inspectCommit();
  });
  bindSeg(el, 'dir', (v) => ((M.getGroup(m, id).dir = v || null), commitNow()));
  $('[data-k="parent"]', el).addEventListener('change', (e) => {
    M.setGroupParent(m, id, e.target.value || null);
    commitNow();
  });
  bindColors(el, () => m.styles[id], (css) => setStyle(id, css));
  bindActions(el, {
    ungroup: () => canvas.ungroupSelection(),
    'delete-all': () => {
      if (!confirm(`Delete "${g.title}" and everything inside it?`)) return;
      M.removeGroup(m, id, true);
      canvas.select({});
      canvas.changed('delete');
    },
  });
}

function multiInspector(el, sel) {
  const m = S.model;
  const n = sel.nodes.length;
  el.innerHTML = `<div class="ins-h"><span class="tag">Selection</span><code>${n} nodes · ${sel.edges.length} edges · ${sel.groups.length} groups</code></div>
    ${n ? row('Fill', colorFields(new Map(), [['fill', 'Fill'], ['stroke', 'Stroke'], ['color', 'Text']])) : ''}
    ${n > 1 ? row('Align', `<div class="seg"><button data-act="align-x" title="Same x">│ center</button><button data-act="align-y" title="Same y">— middle</button></div>`) : ''}
    ${n > 2 ? row('Spread', `<div class="seg"><button data-act="dist-x">↔ evenly</button><button data-act="dist-y">↕ evenly</button></div>`) : ''}
    ${n ? row('Move to', `<select data-k="parent"><option value="__keep">…</option>${groupOptions(undefined)}</select>`) : ''}
    <div class="ins-actions"><button class="btn" data-act="group">Group <kbd>⌘G</kbd></button>${n ? '<button class="btn" data-act="dup">Duplicate</button>' : ''}<button class="btn danger" data-act="delete">Delete</button></div>`;
  for (const inp of $$('[data-css]', el)) {
    inp.addEventListener('input', () => {
      for (const id of sel.nodes) {
        const css = M.parseCss(m.styles[id]);
        css.set(inp.dataset.css, inp.value);
        setStyle(id, M.cssString(css));
      }
      inp.parentElement.classList.remove('unset');
      inp.parentElement.querySelector('i').style.background = inp.value;
      inspectCommit();
    });
  }
  $('[data-k="parent"]', el)?.addEventListener('change', (e) => {
    if (e.target.value === '__keep') return;
    for (const id of sel.nodes) M.getNode(m, id).parent = e.target.value || null;
    commitNow();
  });
  bindActions(el, {
    'align-x': () => canvas.align('x'),
    'align-y': () => canvas.align('y'),
    'dist-x': () => canvas.align('dist-x'),
    'dist-y': () => canvas.align('dist-y'),
    group: () => canvas.groupSelection(),
    dup: () => canvas.duplicateSelection(),
    delete: () => canvas.deleteSelection(),
  });
}

function styleSection(m) {
  if (!flag('themes')) return '';
  const style = M.readStyle(m);
  const preset = M.presetOf(style);
  const curve = style.curve.startsWith('step') ? 'step' : style.curve === 'linear' ? 'linear' : '';
  return `<div class="ins-sub">Style <span class="stage-chip experimental">labs</span></div>
    ${row('Theme', `<select data-k="preset">${Object.entries(M.STYLE_PRESETS).map(([id, p]) => `<option value="${id}"${id === preset ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}${preset === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}</select>`)}
    ${row('Look', seg('look', style.look === 'handDrawn' ? 'handDrawn' : '', [['', 'Classic'], ['handDrawn', 'Hand-drawn']]))}
    ${row('Lines', seg('curve', curve, Object.entries(M.CURVES)))}
    ${style.editable ? '' : '<p class="warn">This diagram\'s frontmatter uses YAML mmdr can\'t rewrite safely — edit the style in the code.</p>'}`;
}

function bindStyleSection(el, m) {
  const write = (patch) => {
    if (!M.writeStyle(m, patch)) return toast('Frontmatter is too complex to edit here');
    commitNow();
    renderInspector(true);
  };
  $('[data-k="preset"]', el)?.addEventListener('change', (e) => {
    const p = M.STYLE_PRESETS[e.target.value];
    if (p) write({ theme: p.theme || '', vars: p.vars || null });
  });
  bindSeg(el, 'look', (v) => write({ look: v }));
  bindSeg(el, 'curve', (v) => write({ curve: v }));
}

function diagramInspector(el) {
  const m = S.model;
  el.innerHTML = `<div class="ins-h"><span class="tag">Diagram</span><code>${esc(m.keyword)} ${esc(m.dir)}</code></div>
    ${row('Direction', seg('dir', m.dir === 'TB' ? 'TD' : m.dir, [['TD', '↓ TD'], ['LR', '→ LR'], ['BT', '↑ BT'], ['RL', '← RL']]))}
    ${row('Keyword', seg('kw', m.keyword, [['flowchart', 'flowchart'], ['graph', 'graph']]))}
    ${styleSection(m)}
    <div class="ins-actions"><button class="btn" data-act="layout" title="Reposition everything the way mermaid lays it out">Auto-layout</button><button class="btn" data-act="fit">Fit view <kbd>0</kbd></button></div>
    ${m.warnings.length ? `<div class="warn">Kept verbatim (not editable on the canvas):<ul>${m.warnings.slice(0, 8).map((w) => `<li>${esc(w.replace(/^kept verbatim: /, ''))}</li>`).join('')}</ul></div>` : ''}
    <p class="ins-note">Double-click the canvas to add a node, drag from a node's ● handle to connect, drop images from Finder, press <kbd>?</kbd> for all shortcuts.</p>`;
  bindSeg(el, 'dir', (v) => ((m.dir = v), commitNow(), renderInspector(true)));
  bindSeg(el, 'kw', (v) => ((m.keyword = v), commitNow(), renderInspector(true)));
  bindStyleSection(el, m);
  bindActions(el, { layout: autoLayout, fit: () => canvas.fit() });
}

function bindSeg(el, name, fn) {
  const s = $(`[data-seg="${name}"]`, el);
  if (!s) return;
  for (const b of $$('button', s)) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      $$('button', s).forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    });
  }
}

function bindActions(el, map) {
  for (const b of $$('[data-act]', el)) {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      map[b.dataset.act]?.();
    });
  }
}

// ------------------------------------------------------------------ saving + sync

let saveTimer = 0;
let saving = null;
let saveAgain = false;

function markDirty() {
  S.dirty = true;
  S.editSeq++;
  setStatus('unsaved');
  clearTimeout(saveTimer);
  if (S.autosave) saveTimer = setTimeout(saveNow, 450);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!S.dirty || !S.path) return Promise.resolve();
  if (saving) {
    saveAgain = true;
    return saving;
  }
  const seq = S.editSeq;
  const path = S.path;
  setStatus('saving');
  saving = (async () => {
    let text = S.text;
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = { 'X-Client': clientId };
      if (S.version) headers['X-Base-Version'] = S.version;
      const r = await fetch('/api/file?path=' + enc(path), { method: 'PUT', headers, body: text });
      if (r.ok) {
        S.version = r.headers.get('X-Version');
        if (S.editSeq === seq) S.dirty = false;
        setStatus(S.dirty ? 'unsaved' : 'saved');
        return;
      }
      if (r.status !== 409) throw new Error(await r.text());
      // Someone else changed the file: re-apply our diagram onto their version.
      const disk = await r.text();
      S.version = r.headers.get('X-Version');
      text = rebase(disk);
      S.text = text;
      rescan();
      toast('Merged with changes made outside mmdr');
    }
    throw new Error('file keeps changing on disk');
  })()
    .catch((e) => setStatus('error', e.message || String(e)))
    .finally(() => {
      saving = null;
      if (saveAgain) {
        saveAgain = false;
        if (S.dirty) saveNow();
      }
    });
  return saving;
}

function rebase(disk) {
  if (S.scope === 'doc') return S.text;
  const scan = M.scanDoc(disk, M.isMmdPath(S.path));
  return scan.blocks[S.index] ? M.replaceBlock(disk, scan, S.index, S.src) : S.text;
}

function setStatus(kind, detail = '') {
  const el = $('#status');
  el.className = `status ${kind}`;
  el.textContent = { saved: '✓ Saved', saving: 'Saving…', unsaved: '● Unsaved', error: '⚠ Not saved', offline: '⚠ Offline' }[kind] || '';
  el.title = detail || (kind === 'saved' ? `Written to ${S.path}` : '');
}

function connectEvents() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('#status').classList.contains('offline') && setStatus(S.dirty ? 'unsaved' : 'saved');
  es.onerror = () => setStatus('offline', 'Lost connection to the mmdr server');
  es.onmessage = (ev) => {
    let e;
    try {
      e = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (e.type === 'change' && e.path === S.path && e.origin !== clientId && e.version !== S.version) onExternalChange();
  };
}

async function onExternalChange() {
  if (S.dirty) return; // the pending save merges via 409
  const r = await fetch('/api/file?path=' + enc(S.path)).catch(() => null);
  if (!r?.ok || S.dirty) return;
  const text = await r.text();
  S.version = r.headers.get('X-Version');
  if (text === S.text) return;
  S.text = text;
  rescan();
  if (S.view === 'doc' && document.activeElement !== docTa) docTa.value = text;
  const i = Math.min(S.index, S.scan.blocks.length - 1);
  const b = S.scan.blocks[i];
  if (!b) return selectBlock(0);
  if (i !== S.index || b.source !== S.src) {
    S.index = i;
    loadSource(b.source, { keep: true });
    pushHistory(b.source);
  }
  renderOutline();
  toast('Reloaded — file changed on disk');
}

// ------------------------------------------------------------------ assets + links

let pendingImageAt = null;
let pendingImageFor = null;

async function uploadImage(file) {
  const ext = (file.type.split('/')[1] || 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg');
  const name = file.name && file.name !== 'image.png' ? file.name : `image-${Date.now()}.${ext}`;
  const r = await fetch(`/api/upload?file=${enc(S.path)}&name=${enc(name)}`, { method: 'POST', body: file }).catch(() => null);
  if (!r?.ok) {
    toast(`Upload failed${r ? ': ' + (await r.text()) : ''}`);
    return null;
  }
  const { path } = await r.json();
  toast(`Saved ${path}`);
  return path;
}

function dirOf(p) {
  return p.split('/').slice(0, -1);
}

function resolveRel(p) {
  const parts = p.startsWith('/') ? [] : dirOf(S.path);
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function assetUrl(p) {
  if (!p || /^([a-z][\w+.-]*:|\/\/)/i.test(p)) return p;
  return '/raw/' + resolveRel(p).split('/').map(enc).join('/');
}

const currentTitle = () => S.scan?.blocks[S.index]?.title || S.path?.split('/').pop() || '';

/** Opens a node link: another diagram (drill-down, with a way back) or an external page. */
function followLink(url) {
  if (/^[a-z][\w+.-]*:/i.test(url)) return window.open(url, '_blank', 'noopener');
  const [p, hash = ''] = url.split('#');
  const n = (parseInt(hash.replace(/^d=?/, ''), 10) || 1) - 1;
  const from = { path: S.path, index: S.index, title: currentTitle() };
  if (!p) {
    S.nav.push(from);
    selectBlock(Math.min(n, S.scan.blocks.length - 1), { fit: true });
    return updateBack();
  }
  const target = resolveRel(p);
  if (!/\.(md|markdown|mmd|mermaid)$/i.test(target)) return window.open(assetUrl(p), '_blank', 'noopener');
  S.nav.push(from);
  return openFile(target, n).then(() => {
    updateUrl();
    updateBack();
  });
}

async function goBack() {
  const prev = S.nav.pop();
  if (!prev) return;
  if (prev.path === S.path) selectBlock(prev.index, { fit: true });
  else await openFile(prev.path, prev.index);
  updateUrl();
  updateBack();
}

function updateBack() {
  const prev = S.nav.at(-1);
  $('#back').hidden = !prev;
  $('#back span').textContent = prev ? prev.title : '';
}

function updateUrl() {
  if (!S.path) return;
  history.replaceState(null, '', `?file=${enc(S.path)}#d=${S.index + 1}`);
}

// ------------------------------------------------------------------ UI chrome

const PALETTE = [
  ['rect', 'Process'], ['rounded', 'Rounded'], ['stadium', 'Terminal'], ['diam', 'Decision'], ['cyl', 'Database'],
  ['circle', 'Circle'], ['hex', 'Prepare'], ['fr-rect', 'Subprocess'], ['lean-r', 'Input / output'], ['doc', 'Document'],
  ['cloud', 'Cloud'], ['h-cyl', 'Queue / stream'], null, ['text', 'Text'], ['image', 'Image'], ['group', 'Group (subgraph)'],
];

function paletteItems() {
  const items = [...PALETTE];
  if (flag('icons')) items.splice(items.indexOf(null) + 1, 0, ['icon', 'Icon (logos, devicon…)']);
  if (flag('sticky-notes')) items.push(['sticky', 'Sticky note']);
  return items;
}

function buildPalette() {
  const el = $('#palette');
  el.innerHTML = paletteItems().map((p) => {
    if (!p) return '<div class="sep"></div>';
    const [shape, label] = p;
    let icon;
    if (shape === 'text') icon = '<span class="glyph">T</span>';
    else if (shape === 'image') icon = '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l5-5 4 4 2-2 3 3" style="fill:none"/></svg>';
    else if (shape === 'group') icon = '<svg viewBox="0 0 24 24" width="24" height="22"><rect x="2" y="4" width="20" height="16" rx="3" style="stroke-dasharray:3 2;fill:none"/><rect x="6" y="10" width="7" height="5" rx="1"/></svg>';
    else if (shape === 'icon') icon = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 3l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.4 6.8 19.2l1-5.9-4.3-4.1 5.9-.8z"/></svg>';
    else if (shape === 'sticky') icon = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 4h16v11l-5 5H4z" style="fill:#fff4a3;stroke:#c9ad2c"/><path d="M15 20v-5h5" style="fill:none;stroke:#c9ad2c"/></svg>';
    else {
      const [w, h] = shape === 'circle' ? [22, 22] : shape === 'diam' ? [30, 22] : [30, 19];
      icon = `<svg viewBox="-17 -13 34 26" width="30" height="24">${shapeMarkup(shape, w, h, '')}</svg>`;
    }
    return `<button class="pi" draggable="true" data-shape="${shape}" title="${label} — drag onto the canvas or click">${icon}</button>`;
  }).join('');
  for (const b of $$('.pi', el)) {
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-mmdr-shape', b.dataset.shape);
      e.dataTransfer.effectAllowed = 'copy';
    });
    b.addEventListener('click', () => canvas.addShape(b.dataset.shape, null));
  }
}

// ------------------------------------------------------------------ labs (feature flags)

const mdLite = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>');

function renderLabs() {
  const el = $('#labs-list');
  el.innerHTML = FLAGS.map((f) => {
    const src = flagSource(f.id);
    const from =
      src === 'user' ? `set in this browser · <button data-reset="${f.id}">reset to ${inheritedFlag(f.id) ? 'on' : 'off'}</button>`
      : src === 'cli' ? 'set on the command line'
      : src === 'project' ? 'set by .mmdr/config.json'
      : `default ${f.default ? 'on' : 'off'}`;
    return `<div class="flag"><h4>${esc(f.name)} <span class="stage-chip ${f.stage}">${f.stage}</span></h4>
      <label class="switch" title="${flag(f.id) ? 'On' : 'Off'}"><input type="checkbox" data-flag="${f.id}"${flag(f.id) ? ' checked' : ''}><i></i></label>
      <p>${mdLite(f.desc)}</p>
      <div class="src">Inspired by ${esc(f.inspiredBy)} · <code>${f.id}</code> · ${from}</div></div>`;
  }).join('');
  for (const inp of $$('[data-flag]', el)) inp.addEventListener('change', () => setFlag(inp.dataset.flag, inp.checked));
  for (const b of $$('[data-reset]', el)) b.addEventListener('click', () => setFlag(b.dataset.reset, undefined));
}

function applyFlags() {
  buildPalette();
  renderInspector(true);
  canvas.render();
  if (!$('#labs-modal').hidden) renderLabs();
}

// ------------------------------------------------------------------ icon picker

let pickerCb = null;
let pickerSeq = 0;

function iconPreview(ref) {
  const ic = ref && flag('icons') ? iconStore.get(ref) : false;
  return ic ? `<svg viewBox="0 0 ${ic.w} ${ic.h}">${ic.body}</svg>` : '<span class="muted">?</span>';
}

function openIconPicker(onPick, query = '') {
  pickerCb = onPick;
  $('#icon-modal').hidden = false;
  $('#icon-packs').textContent = iconStore.packs.size ? `· ${[...iconStore.packs.keys()].join(', ')}` : '';
  const q = $('#icon-q');
  q.value = query;
  q.focus();
  q.select();
  runIconSearch();
}

async function runIconSearch() {
  const grid = $('#icon-grid');
  if (!iconStore.packs.size) {
    grid.innerHTML = `<div class="picker-empty">No icon packs installed yet. In a terminal run<br><br><code>mmdr icons add logos devicon</code><br><br>and reload this page. Add <code>--vendor</code> to keep the packs in this repository for your team.</div>`;
    return;
  }
  const seq = ++pickerSeq;
  if (!iconStore.data.size) grid.innerHTML = '<div class="picker-empty">Loading icon packs…</div>';
  const results = await iconStore.search($('#icon-q').value);
  if (seq !== pickerSeq) return;
  grid.innerHTML = results.map((r) => {
    const ic = iconStore.get(r.ref);
    return ic ? `<button class="icon-cell" data-ref="${esc(r.ref)}" title="${esc(r.ref)}"><svg viewBox="0 0 ${ic.w} ${ic.h}">${ic.body}</svg><span>${esc(r.name)}</span></button>` : '';
  }).join('') || '<div class="picker-empty">No icons match.</div>';
}

function pickIcon(ref) {
  $('#icon-modal').hidden = true;
  const cb = pickerCb;
  pickerCb = null;
  if (ref && cb) cb(ref);
}

function bindUI() {
  $('#file').addEventListener('change', (e) => {
    S.nav = [];
    updateBack();
    openFile(e.target.value).then(updateUrl);
  });
  $('#back').addEventListener('click', goBack);
  $('#labs').addEventListener('click', () => {
    renderLabs();
    $('#labs-modal').hidden = false;
  });
  let iconTimer = 0;
  $('#icon-q').addEventListener('input', () => {
    clearTimeout(iconTimer);
    iconTimer = setTimeout(runIconSearch, 120);
  });
  $('#icon-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pickIcon($('#icon-grid .icon-cell')?.dataset.ref);
  });
  $('#icon-grid').addEventListener('click', (e) => pickIcon(e.target.closest('[data-ref]')?.dataset.ref));
  for (const modal of $$('.modal')) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('[data-close]')) modal.hidden = true;
    });
  }
  $('#file').addEventListener('focus', () => refreshFiles());
  $$('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#autosave').addEventListener('change', (e) => {
    S.autosave = e.target.checked;
    store.set('autosave', S.autosave);
    if (S.autosave && S.dirty) saveNow();
  });
  $('#save').addEventListener('click', () => {
    if (!S.dirty) S.dirty = true;
    saveNow();
  });
  $('#theme').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(store.get('theme', 'auto')) + 1) % 3];
    store.set('theme', next);
    applyTheme(next);
  });
  $('#help').addEventListener('click', () => ($('#help-modal').hidden = false));
  $('#add-diagram').addEventListener('click', () => {
    const f = $('#new-form');
    f.hidden = !f.hidden;
    if (!f.hidden) f.title.focus();
  });
  $('#new-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    addDiagram(f.type.value, f.title.value.trim());
    f.title.value = '';
    f.hidden = true;
  });
  $('#outline').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return deleteDiagram(+del.dataset.del);
    const d = e.target.closest('[data-block]');
    if (d) {
      if (S.view === 'doc') setView('split');
      selectBlock(+d.dataset.block, { fit: true });
    }
  });
  codeTa.addEventListener('input', onCodeInput);
  codeTa.addEventListener('scroll', () => {
    codePre.scrollTop = codeTa.scrollTop;
    codePre.scrollLeft = codeTa.scrollLeft;
  });
  codeTa.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '    ');
    }
  });
  let docTimer = 0;
  docTa.addEventListener('input', () => {
    S.text = docTa.value;
    S.scope = 'doc';
    docDirty = true;
    markDirty();
    clearTimeout(docTimer);
    docTimer = setTimeout(() => {
      S.scan = M.scanDoc(S.text, M.isMmdPath(S.path));
      renderOutline();
    }, 250);
  });
  $('#copy-src').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(S.src);
      toast('Mermaid source copied');
    } catch {
      codeTa.select();
      document.execCommand('copy');
    }
  });
  $('#dl-svg').addEventListener('click', () => {
    const svg = $('#preview svg');
    if (!svg) return toast('Nothing rendered yet');
    const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    const b = S.scan.blocks[S.index];
    a.href = URL.createObjectURL(blob);
    a.download = `${M.slug(b?.title || S.path.split('/').pop().replace(/\.\w+$/, '')) || 'diagram'}-${S.index + 1}.svg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $$('.zoom button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.z === 'fit') canvas.fit();
    else canvas.zoomAt(b.dataset.z === 'in' ? 1.2 : 1 / 1.2);
    $('#zoom-label').textContent = Math.round(canvas.view.k * 100) + '%';
  }));
  $('#img-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const path = await uploadImage(f);
    if (!path) return;
    if (pendingImageFor && M.getNode(S.model, pendingImageFor)) {
      M.getNode(S.model, pendingImageFor).props.img = path;
      commitNow();
      renderInspector(true);
    } else canvas.addImage(path, pendingImageAt, f.name.replace(/\.[^.]+$/, ''));
    pendingImageAt = pendingImageFor = null;
  });

  const typing = (t) => t && (t.closest?.('input, textarea, select, [contenteditable]') || false);
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!S.dirty) S.dirty = true;
      return saveNow();
    }
    if (e.altKey && !mod && /^Digit[1-4]$/.test(e.code)) {
      e.preventDefault();
      return setView(['canvas', 'split', 'preview', 'doc'][+e.code.slice(5) - 1]);
    }
    if (e.key === 'Escape') $$('.modal').forEach((m) => (m.hidden = true));
    if (typing(e.target)) return;
    if (mod && e.key === '[') {
      e.preventDefault();
      return goBack();
    }
    if (mod && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      return undo(e.key.toLowerCase() === 'y' || e.shiftKey ? 1 : -1);
    }
    if (e.key === '?') $('#help-modal').hidden = !$('#help-modal').hidden;
    if (e.key === 'Escape') $('#help-modal').hidden = true;
  });
  const canvasActive = () => document.activeElement === $('#canvas') && S.model;
  document.addEventListener('copy', (e) => {
    if (!canvasActive()) return;
    const t = canvas.copySelection();
    if (!t) return;
    e.clipboardData.setData('text/plain', t);
    e.preventDefault();
    toast('Copied as mermaid');
  });
  document.addEventListener('cut', (e) => {
    if (!canvasActive()) return;
    const t = canvas.copySelection();
    if (!t) return;
    e.clipboardData.setData('text/plain', t);
    e.preventDefault();
    canvas.deleteSelection();
  });
  document.addEventListener('paste', async (e) => {
    if (!canvasActive()) return;
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      for (const f of files) {
        const p = await uploadImage(f);
        if (p) canvas.addImage(p, null, '');
      }
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (text && canvas.paste(text)) e.preventDefault();
    else if (text) toast('Clipboard is not mermaid flowchart text');
  });
  window.addEventListener('beforeunload', (e) => {
    if (!S.dirty) return;
    fetch('/api/file?path=' + enc(S.path), { method: 'PUT', keepalive: true, headers: { 'X-Client': clientId, ...(S.version ? { 'X-Base-Version': S.version } : {}) }, body: S.text });
    e.preventDefault();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme', 'auto')));
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('#theme').textContent = { auto: '◐', light: '☀', dark: '☾' }[t];
  $('#theme').title = `Theme: ${t}`;
  setupMermaid();
  if (S.scan) schedulePreview();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

init();
