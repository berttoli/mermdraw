// model.js — markdown block scanning plus a round-trippable model of mermaid
// flowcharts (parse → edit → serialize). Pure functions, no DOM, so the same
// file runs in the browser and under `node --test`.

// ------------------------------------------------------------------ markdown

export const isMmdPath = (p) => /\.(mmd|mermaid)$/i.test(p || '');

/** Finds ```mermaid blocks (and headings, for the outline) in a markdown text. */
export function scanDoc(text, wholeFile = false) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const headings = [];
  if (wholeFile) {
    const source = lines.join('\n').replace(/\n+$/, '');
    blocks.push({ index: 0, start: -1, end: lines.length, indent: '', fence: '', source, ...describe(source) });
    return { eol, lines, blocks, headings, wholeFile };
  }
  let heading = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.replace(/^ +/, '').length;
    const rest = line.slice(indent);
    const fm = indent <= 3 && /^(`{3,}|~{3,})(.*)$/.exec(rest);
    if (!fm || (fm[1][0] === '`' && fm[2].includes('`'))) {
      const hm = indent <= 3 && /^(#{1,6})(?:\s+(.*?))?\s*#*\s*$/.exec(rest);
      if (hm && hm[2]) {
        heading = hm[2];
        headings.push({ level: hm[1].length, text: hm[2], line: i });
      }
      continue;
    }
    const fence = fm[1];
    const info = fm[2].trim().replace(/^\{/, '').split(/[\s}]/)[0].toLowerCase();
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const r = lines[j].replace(/^ +/, '');
      if (lines[j].length - r.length <= 3 && r.startsWith(fence[0].repeat(fence.length)) && new RegExp(`^\\${fence[0]}+\\s*$`).test(r)) {
        end = j;
        break;
      }
    }
    if (info === 'mermaid') {
      const pad = ' '.repeat(indent);
      const body = lines.slice(i + 1, end).map((l) => (l.startsWith(pad) ? l.slice(indent) : l.replace(/^ +/, '')));
      const source = body.join('\n');
      const d = describe(source);
      blocks.push({ index: blocks.length, start: i, end, indent: pad, fence, source, kind: d.kind, title: d.title || heading });
    }
    i = end;
  }
  return { eol, lines, blocks, headings, wholeFile };
}

/** Diagram keyword + frontmatter title of a mermaid source. */
export function describe(src) {
  let title = null;
  const lines = src.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = /^\s*title:\s*(.*)$/.exec(lines[i]);
      if (m) title = m[1].trim().replace(/^["']|["']$/g, '');
    }
    i++;
  }
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) continue;
    return { kind: t.split(/[\s;]/)[0], title };
  }
  return { kind: 'empty', title };
}

export const isFlowchartKind = (k) => k === 'flowchart' || k === 'graph' || k === 'flowchart-elk';

/** Returns the markdown text with block `index` replaced by `source`. */
export function replaceBlock(text, scan, index, source) {
  const b = scan.blocks[index];
  if (!b) return text;
  const src = source.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (scan.wholeFile) return src.split('\n').join(scan.eol) + scan.eol;
  const body = src.split('\n').map((l) => (l ? b.indent + l : l));
  const tail = b.end < scan.lines.length ? scan.lines.slice(b.end) : [b.indent + b.fence];
  return [...scan.lines.slice(0, b.start + 1), ...body, ...tail].join(scan.eol);
}

/** Inserts a new mermaid block (with an optional `## title`) after block `after` (or at the end). */
export function insertBlock(text, scan, after, source, title) {
  const lines = scan.lines.slice();
  let at = lines.length;
  const prev = scan.blocks[after];
  if (prev) at = Math.min(prev.end + 1, lines.length);
  else while (at > 0 && lines[at - 1] === '') at--;
  const add = [''];
  if (title) add.push(`## ${title}`, '');
  add.push('```mermaid', ...source.replace(/\n+$/, '').split('\n'), '```');
  if (at < lines.length && lines[at] !== '') add.push('');
  if (at === lines.length) add.push('');
  if (at === 0 || lines[at - 1] === '') add.shift();
  lines.splice(at, 0, ...add);
  return lines.join(scan.eol);
}

export function deleteBlock(text, scan, index) {
  const b = scan.blocks[index];
  if (!b || scan.wholeFile) return text;
  const lines = scan.lines.slice();
  let end = Math.min(b.end, lines.length - 1);
  if (lines[end + 1] === '' && (b.start === 0 || lines[b.start - 1] === '')) end++;
  lines.splice(b.start, end - b.start + 1);
  return lines.join(scan.eol);
}

export const TEMPLATES = {
  flowchart: 'flowchart LR\n    client([Client]) --> api[API Gateway]\n    api --> svc[Service]\n    svc --> db[(Database)]',
  sequence: 'sequenceDiagram\n    participant C as Client\n    participant A as API\n    C->>A: request\n    A-->>C: response',
  class: 'classDiagram\n    class Service {\n        +handle(req) Response\n    }\n    class Repository\n    Service --> Repository',
  state: 'stateDiagram-v2\n    [*] --> Idle\n    Idle --> Running: start\n    Running --> Idle: stop',
  er: 'erDiagram\n    USER ||--o{ ORDER : places\n    ORDER ||--|{ LINE_ITEM : contains',
  architecture: 'architecture-beta\n    group api(cloud)[API]\n\n    service db(database)[Database] in api\n    service server(server)[Server] in api\n\n    db:L -- R:server',
  c4: 'C4Context\n    title System Context\n    Person(user, "User")\n    System(sys, "System")\n    Rel(user, sys, "Uses")',
  gantt: 'gantt\n    title Roadmap\n    dateFormat YYYY-MM-DD\n    section Build\n    Design :a1, 2026-01-01, 14d\n    Implement :after a1, 30d',
  mindmap: 'mindmap\n  root((System))\n    Frontend\n    Backend\n      API\n      Workers',
};

// ------------------------------------------------------------------ shapes

/** Classic bracket syntax for shapes that have one: name -> [open, close]. */
export const BRACKETS = {
  rect: ['[', ']'], rounded: ['(', ')'], stadium: ['([', '])'], 'fr-rect': ['[[', ']]'],
  cyl: ['[(', ')]'], circle: ['((', '))'], 'dbl-circ': ['(((', ')))'], odd: ['>', ']'],
  diam: ['{', '}'], hex: ['{{', '}}'], 'lean-r': ['[/', '/]'], 'lean-l': ['[\\', '\\]'],
  'trap-b': ['[/', '\\]'], 'trap-t': ['[\\', '/]'],
};
const OPENERS = ['(((', '([', '((', '(', '[[', '[(', '[/', '[\\', '[', '{{', '{', '>'];
const CLOSERS = {
  '(((': [[')))', 'dbl-circ']], '((': [['))', 'circle']], '([': [['])', 'stadium']], '(': [[')', 'rounded']],
  '[[': [[']]', 'fr-rect']], '[(': [[')]', 'cyl']], '[/': [['/]', 'lean-r'], ['\\]', 'trap-b']],
  '[\\': [['\\]', 'lean-l'], ['/]', 'trap-t']], '[': [[']', 'rect']], '{{': [['}}', 'hex']], '{': [['}', 'diam']], '>': [[']', 'odd']],
};

/** Shapes offered in the UI (mermaid ≥ 11.3 names). */
export const SHAPES = [
  ['rect', 'Process'], ['rounded', 'Rounded'], ['stadium', 'Terminal'], ['fr-rect', 'Subprocess'],
  ['cyl', 'Database'], ['circle', 'Circle'], ['dbl-circ', 'Double circle'], ['diam', 'Decision'],
  ['hex', 'Prepare'], ['lean-r', 'Input/Output'], ['lean-l', 'Output/Input'], ['trap-b', 'Priority'],
  ['trap-t', 'Manual'], ['odd', 'Odd'], ['doc', 'Document'], ['docs', 'Documents'], ['cloud', 'Cloud'],
  ['h-cyl', 'Direct storage'], ['lin-cyl', 'Disk'], ['notch-rect', 'Card'], ['lin-rect', 'Lined process'],
  ['st-rect', 'Stacked'], ['tag-rect', 'Tagged process'], ['tag-doc', 'Tagged doc'], ['delay', 'Delay'],
  ['bolt', 'Comm link'], ['flag', 'Paper tape'], ['hourglass', 'Collate'], ['tri', 'Extract'],
  ['sm-circ', 'Start'], ['fr-circ', 'Stop'], ['f-circ', 'Junction'], ['cross-circ', 'Summary'],
  ['fork', 'Fork/Join'], ['brace', 'Comment'], ['text', 'Text'], ['image', 'Image'], ['icon', 'Icon'],
];

const SHAPE_ALIASES = {
  rectangle: 'rect', proc: 'rect', process: 'rect', event: 'rounded', pill: 'stadium', terminal: 'stadium',
  subproc: 'fr-rect', subprocess: 'fr-rect', subroutine: 'fr-rect', 'framed-rectangle': 'fr-rect',
  cylinder: 'cyl', database: 'cyl', db: 'cyl', circ: 'circle', 'double-circle': 'dbl-circ',
  diamond: 'diam', decision: 'diam', question: 'diam', hexagon: 'hex', prepare: 'hex',
  'lean-right': 'lean-r', 'in-out': 'lean-r', 'lean-left': 'lean-l', 'out-in': 'lean-l',
  trapezoid: 'trap-b', priority: 'trap-b', 'trapezoid-bottom': 'trap-b',
  'inv-trapezoid': 'trap-t', manual: 'trap-t', 'trapezoid-top': 'trap-t',
  document: 'doc', documents: 'docs', 'st-doc': 'docs', 'stacked-document': 'docs',
  'com-link': 'bolt', 'lightning-bolt': 'bolt', 'half-rounded-rectangle': 'delay',
  das: 'h-cyl', 'horizontal-cylinder': 'h-cyl', disk: 'lin-cyl', 'lined-cylinder': 'lin-cyl',
  card: 'notch-rect', 'notched-rectangle': 'notch-rect', 'lined-rectangle': 'lin-rect', 'lin-proc': 'lin-rect',
  'lined-process': 'lin-rect', 'shaded-process': 'lin-rect', 'small-circle': 'sm-circ', start: 'sm-circ',
  'framed-circle': 'fr-circ', stop: 'fr-circ', 'filled-circle': 'f-circ', junction: 'f-circ',
  'crossed-circle': 'cross-circ', summary: 'cross-circ', 'tagged-document': 'tag-doc',
  'tagged-rectangle': 'tag-rect', 'tag-proc': 'tag-rect', 'tagged-process': 'tag-rect',
  'stacked-rectangle': 'st-rect', processes: 'st-rect', procs: 'st-rect', 'paper-tape': 'flag',
  collate: 'hourglass', comment: 'brace', 'brace-l': 'brace', triangle: 'tri', extract: 'tri', join: 'fork',
  'internal-storage': 'win-pane', 'window-pane': 'win-pane', 'curved-trapezoid': 'curv-trap', display: 'curv-trap',
  'div-proc': 'div-rect', 'divided-process': 'div-rect', 'divided-rectangle': 'div-rect',
  'stored-data': 'bow-rect', 'bow-tie-rectangle': 'bow-rect', 'loop-limit': 'notch-pent', 'notched-pentagon': 'notch-pent',
  'manual-input': 'sl-rect', 'sloped-rectangle': 'sl-rect', 'lined-document': 'lin-doc',
  'flipped-triangle': 'flip-tri', 'manual-file': 'flip-tri',
};
export const normShape = (s) => SHAPE_ALIASES[String(s).toLowerCase()] || String(s).toLowerCase();

// ------------------------------------------------------------------ flowchart model

const DIRS = { TB: 'TB', TD: 'TD', BT: 'BT', RL: 'RL', LR: 'LR' };
const ID = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_]|-(?=[\p{L}\p{N}_]))*`;
const ID_RE = new RegExp('^' + ID, 'u');
const RESERVED = new Set(['end', 'subgraph', 'graph', 'flowchart', 'style', 'class', 'classdef', 'click', 'linkstyle',
  'direction', 'call', 'href', 'default', 'tb', 'td', 'bt', 'rl', 'lr']);
const LAYOUT_TAG = 'mermdraw:layout';

export function emptyFlowchart(dir = 'TD') {
  return {
    keyword: 'flowchart', dir, preamble: [], nodes: [], groups: [], edges: [],
    classDefs: [], classes: {}, styles: {}, links: {}, extras: [], layout: {}, warnings: [],
  };
}

/**
 * Parses a mermaid flowchart into an editable model. Statements mermdraw does not
 * understand are kept verbatim in `extras` (and reported in `warnings`) so a
 * round trip never silently drops anything. Returns null if `src` is not a flowchart.
 */
export function parseFlowchart(src) {
  const m = emptyFlowchart();
  const lines = joinContinuations(src.replace(/\r\n/g, '\n').split('\n'));
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (close > 0) {
      m.preamble.push(...lines.slice(0, close + 1));
      i = close + 1;
    }
  }
  let rest = null;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('%%')) {
      if (t) m.preamble.push(lines[i]);
      continue;
    }
    const hm = /^(flowchart-elk|flowchart|graph)\b(?:\s+([A-Za-z]{2})\b)?\s*;?\s*(.*)$/.exec(t);
    if (!hm) return null;
    m.keyword = hm[1];
    m.dir = DIRS[(hm[2] || 'TD').toUpperCase()] || 'TD';
    rest = hm[3];
    i++;
    break;
  }
  if (rest === null) return null;

  const stack = [];
  const linkStyles = [];
  let implicitGroups = 0;
  const statement = (t, raw) => {
    if (!t) return;
    if (t.startsWith('%%')) {
      if (t.slice(2).trim().startsWith(LAYOUT_TAG)) parseLayout(m, t);
      else m.extras.push(t);
      return;
    }
    const word = t.split(/[\s;]/)[0];
    let mm;
    switch (word) {
      case 'subgraph': {
        const g = parseSubgraphHeader(t.slice(8));
        if (g.implicit) g.id = `__sg${++implicitGroups}`;
        g.parent = stack.at(-1) ?? null;
        m.groups.push(g);
        stack.push(g.id);
        return;
      }
      case 'end':
        if (/^end\s*;?\s*$/.test(t)) {
          if (!stack.pop()) m.warnings.push(`unmatched 'end'`);
          return;
        }
        break;
      case 'direction':
        if ((mm = /^direction\s+(\w{2})\s*;?$/.exec(t))) {
          const g = m.groups.find((x) => x.id === stack.at(-1));
          if (g) g.dir = DIRS[mm[1].toUpperCase()] || null;
          else m.dir = DIRS[mm[1].toUpperCase()] || m.dir;
          return;
        }
        break;
      case 'classDef':
        if ((mm = /^classDef\s+(\S+)\s+(.*?);?\s*$/.exec(t))) {
          for (const name of mm[1].split(',')) m.classDefs.push({ name, css: mm[2] });
          return;
        }
        break;
      case 'class':
        if ((mm = /^class\s+(.+?)\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*;?\s*$/.exec(t))) {
          for (const id of mm[1].split(/\s*,\s*/)) for (const c of mm[2].split(/\s*,\s*/)) addClass(m, id, c);
          return;
        }
        break;
      case 'style':
        if ((mm = /^style\s+(\S+)\s+(.*?);?\s*$/.exec(t))) {
          m.styles[mm[1]] = m.styles[mm[1]] ? `${m.styles[mm[1]]},${mm[2]}` : mm[2];
          return;
        }
        break;
      case 'linkStyle':
        if ((mm = /^linkStyle\s+([\d,\s]+?)\s+(.*?);?\s*$/.exec(t))) {
          for (const n of mm[1].split(/\s*,\s*/)) linkStyles.push([+n, mm[2]]);
          return;
        }
        break;
      case 'click':
        if ((mm = new RegExp(String.raw`^click\s+(${ID})\s+(?:href\s+)?"([^"]*)"(?:\s+"([^"]*)")?(?:\s+(_\w+))?\s*;?$`, 'u').exec(t))) {
          m.links[mm[1]] = { url: mm[2], tooltip: mm[3] || '', target: mm[4] || '' };
          return;
        }
        m.extras.push(t);
        return;
      case 'accTitle':
      case 'accDescr':
        m.extras.push(raw);
        return;
    }
    for (const piece of splitStatements(t)) {
      if (!piece) continue;
      const chain = parseChain(piece);
      if (!chain) {
        m.extras.push(piece);
        m.warnings.push(`kept verbatim: ${piece}`);
        continue;
      }
      registerChain(m, chain, stack.at(-1) ?? null);
    }
  };

  if (rest) statement(rest.trim(), rest);
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^accDescr\s*\{/.test(t) && !t.includes('}')) {
      const start = i;
      while (i < lines.length - 1 && !lines[i].includes('}')) i++;
      m.extras.push(lines.slice(start, i + 1).map((l) => l.trim()).join('\n'));
      continue;
    }
    statement(t, t);
  }
  if (stack.length) m.warnings.push(`${stack.length} subgraph(s) missing 'end'`);

  for (const [n, css] of linkStyles) {
    if (m.edges[n]) m.edges[n].style = m.edges[n].style ? `${m.edges[n].style},${css}` : css;
    else m.extras.push(`linkStyle ${n} ${css}`);
  }
  // Edges may reference subgraphs; drop the placeholder nodes that created.
  const gids = new Set(m.groups.map((g) => g.id));
  m.nodes = m.nodes.filter((n) => !(gids.has(n.id) && !n.explicit));
  for (const n of m.nodes) if (n.parent && !gids.has(n.parent)) n.parent = null;
  return m;
}

function joinContinuations(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.includes('@{')) {
      while (braceBalance(line) > 0 && i + 1 < lines.length) line += '\n' + lines[++i].trim();
    }
    out.push(line);
  }
  return out;
}

function braceBalance(s) {
  let d = 0;
  let q = false;
  for (const c of s) {
    if (c === '"') q = !q;
    else if (!q && c === '{') d++;
    else if (!q && c === '}') d--;
  }
  return d;
}

function splitStatements(t) {
  const out = [];
  let depth = 0;
  let q = false;
  let pipe = false;
  let cur = '';
  for (const c of t) {
    if (c === '"') q = !q;
    else if (!q && '([{'.includes(c)) depth++;
    else if (!q && ')]}'.includes(c)) depth = Math.max(0, depth - 1);
    else if (!q && !depth && c === '|') pipe = !pipe;
    if (c === ';' && !q && !depth && !pipe) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function parseSubgraphHeader(rest) {
  rest = rest.trim().replace(/;$/, '').trim();
  let mm;
  if ((mm = new RegExp(String.raw`^(${ID})\s*\[\s*(?:"([^"]*)"|([^\]]*))\s*\]$`, 'u').exec(rest))) {
    return { id: mm[1], title: (mm[2] ?? mm[3]).trim(), dir: null, implicit: false };
  }
  if ((mm = /^"([^"]*)"$/.exec(rest))) {
    const title = mm[1];
    return /\s/.test(title) ? { id: '', title, dir: null, implicit: true } : { id: title, title, dir: null, implicit: false };
  }
  if (ID_RE.exec(rest)?.[0] === rest) return { id: rest, title: rest, dir: null, implicit: false };
  return { id: '', title: rest, dir: null, implicit: true };
}

function parseLayout(m, t) {
  const body = t.slice(2).trim().slice(LAYOUT_TAG.length);
  for (const tok of body.trim().split(/\s+/)) {
    const mm = /^(.+):(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(tok);
    if (mm) m.layout[mm[1]] = { x: +mm[2], y: +mm[3] };
  }
}

const skipWs = (s, i) => {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
};

function parseChain(s) {
  let r = parseNodeGroup(s, 0);
  if (!r) return null;
  const groups = [r.nodes];
  const links = [];
  let i = r.next;
  for (;;) {
    i = skipWs(s, i);
    if (i >= s.length) break;
    const l = parseLink(s, i);
    if (!l) return null;
    const g = parseNodeGroup(s, l.next);
    if (!g) return null;
    links.push(l.link);
    groups.push(g.nodes);
    i = g.next;
  }
  return { groups, links };
}

function parseNodeGroup(s, i) {
  const nodes = [];
  for (;;) {
    i = skipWs(s, i);
    const r = parseNode(s, i);
    if (!r) return null;
    nodes.push(r.node);
    i = r.next;
    const j = skipWs(s, i);
    if (s[j] !== '&') return { nodes, next: i };
    i = j + 1;
  }
}

function parseNode(s, i) {
  const idm = ID_RE.exec(s.slice(i));
  if (!idm) return null;
  const node = { id: idm[0] };
  i += idm[0].length;
  for (const op of OPENERS) {
    if (!s.startsWith(op, i)) continue;
    const r = readLabel(s, i + op.length, CLOSERS[op]);
    if (!r) return null;
    Object.assign(node, { label: r.label, shape: r.shape });
    i = r.next;
    break;
  }
  if (s.startsWith('@{', i)) {
    const r = readBraces(s, i + 1);
    if (!r) return null;
    node.props = parseProps(r.body);
    i = r.next;
  }
  const cm = /^:::([\w-]+)/.exec(s.slice(i));
  if (cm) {
    node.cls = cm[1];
    i += cm[0].length;
  }
  return { node, next: i };
}

function readLabel(s, i, closers) {
  if (s[i] === '"') {
    const k = s.indexOf('"', i + 1);
    if (k < 0) return null;
    const j = skipWs(s, k + 1);
    for (const [c, shape] of closers) if (s.startsWith(c, j)) return { label: s.slice(i + 1, k), shape, next: j + c.length };
    return null;
  }
  let best = null;
  for (const [c, shape] of closers) {
    const k = s.indexOf(c, i);
    if (k >= 0 && (!best || k < best.k)) best = { k, c, shape };
  }
  if (!best) return null;
  return { label: s.slice(i, best.k).trim(), shape: best.shape, next: best.k + best.c.length };
}

function readBraces(s, i) {
  let depth = 0;
  let q = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === '"') q = false;
    } else if (c === '"') q = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: s.slice(i + 1, j), next: j + 1 };
  }
  return null;
}

function parseProps(body) {
  const props = {};
  let cur = '';
  let q = false;
  const flush = () => {
    const k = cur.indexOf(':');
    if (k > 0) {
      let v = cur.slice(k + 1).trim();
      if (/^".*"$/s.test(v) || /^'.*'$/s.test(v)) v = v.slice(1, -1);
      props[cur.slice(0, k).trim()] = v;
    }
    cur = '';
  };
  for (const c of body) {
    if (c === '"') q = !q;
    if ((c === ',' || c === '\n') && !q) flush();
    else cur += c;
  }
  flush();
  return props;
}

const LINK_RE = /^([<ox])?(-{2,}|={2,}|-\.+-|~{3,})([>ox])?/;
const TEXT_LINK_RE = /^([<ox])?(--|==|-\.)(?=\s)/;

function parseLink(s, i) {
  let rest = s.slice(i);
  const eid = /^([\p{L}\p{N}_]+)@(?=[-=~<ox])/u.exec(rest);
  if (eid) rest = rest.slice(eid[0].length);
  const consumed0 = eid ? eid[0].length : 0;
  let start = '';
  let body;
  let end = '';
  let label = '';
  let len;
  const tm = TEXT_LINK_RE.exec(rest);
  if (tm) {
    // `A -- text --> B` / `A == text ==> B` / `A -. text .-> B`
    start = tm[1] || '';
    const closeRe = tm[2] === '--' ? /\s*(-{3,}|-{2,}[>ox])/ : tm[2] === '==' ? /\s*(={3,}|={2,}[>ox])/ : /\s*(\.+-[>ox]?)/;
    const cm = closeRe.exec(rest.slice(tm[0].length));
    if (!cm) return null;
    label = rest.slice(tm[0].length, tm[0].length + cm.index).trim();
    let tok = cm[1];
    if (/[>ox]$/.test(tok)) {
      end = tok.at(-1);
      tok = tok.slice(0, -1);
    }
    body = tm[2] === '-.' ? '-' + tok : tok;
    rest = rest.slice(tm[0].length + cm.index + cm[0].length);
  } else {
    const lm = LINK_RE.exec(rest);
    if (!lm) return null;
    start = lm[1] || '';
    body = lm[2];
    end = lm[3] || '';
    if (body.length < 3 && !end && body[0] !== '~') return null;
    rest = rest.slice(lm[0].length);
  }
  if (body[0] === '~') len = body.length - 2;
  else if (body.includes('.')) len = body.length - 2;
  else len = end ? body.length - 1 : body.length - 2;
  const stroke = body[0] === '~' ? 'invisible' : body[0] === '=' ? 'thick' : body.includes('.') ? 'dotted' : 'normal';
  let k = skipWs(rest, 0);
  if (rest[k] === '|') {
    const q = rest[k + 1] === '"' ? rest.indexOf('"', k + 2) : k;
    const close = rest.indexOf('|', q + 1);
    if (close < 0) return null;
    label = rest.slice(k + 1, close).trim().replace(/^"(.*)"$/s, '$1');
    k = close + 1;
  } else k = 0;
  const consumed = s.length - i - (rest.length - k);
  return { link: { stroke, start, end, len: Math.max(1, len), label, style: '' }, next: i + Math.max(consumed, consumed0) };
}

function registerChain(m, chain, group) {
  for (const specs of chain.groups) for (const spec of specs) touchNode(m, spec, group);
  chain.links.forEach((link, k) => {
    for (const a of chain.groups[k]) for (const b of chain.groups[k + 1]) m.edges.push({ from: a.id, to: b.id, ...link });
  });
}

function touchNode(m, spec, group) {
  let n = m.nodes.find((x) => x.id === spec.id);
  if (!n) {
    n = { id: spec.id, label: spec.id, shape: 'rect', at: false, props: {}, parent: null, explicit: false };
    m.nodes.push(n);
  }
  if (spec.label !== undefined) {
    n.label = spec.label;
    n.shape = spec.shape;
    n.explicit = true;
  }
  if (spec.props) {
    const { shape, label, ...props } = spec.props;
    if (shape) n.shape = normShape(shape);
    if (label !== undefined) n.label = label;
    Object.assign(n.props, props);
    if (props.img) n.shape = 'image';
    else if (props.icon) n.shape = 'icon';
    n.at = true;
    n.explicit = true;
  }
  if (spec.cls) addClass(m, spec.id, spec.cls);
  if (group && !n.parent) n.parent = group;
}

function addClass(m, id, c) {
  const list = (m.classes[id] ||= []);
  if (!list.includes(c)) list.push(c);
}

// ------------------------------------------------------------------ serialize

const IND = '    ';

/** Serializes the model into canonical, diff-friendly mermaid. */
export function serializeFlowchart(m) {
  const out = [...m.preamble, `${m.keyword} ${m.dir}`];
  const gids = new Set(m.groups.map((g) => g.id));
  const kids = new Map();
  const bucket = (p) => {
    const k = gids.has(p) ? p : null;
    if (!kids.has(k)) kids.set(k, { nodes: [], groups: [] });
    return kids.get(k);
  };
  for (const n of m.nodes) bucket(n.parent).nodes.push(n);
  for (const g of m.groups) bucket(g.parent).groups.push(g);
  // Ids in the order they are written, which is also the order a re-parse sees them;
  // class and layout lines follow it so a second save produces no diff.
  const order = { nodes: [], groups: [] };
  const emit = (p, depth, seen) => {
    const b = kids.get(p);
    if (!b) return;
    const ind = IND.repeat(depth);
    for (const n of b.nodes) {
      out.push(ind + nodeDecl(n));
      order.nodes.push(n);
    }
    for (const g of b.groups) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      order.groups.push(g);
      out.push(ind + groupHeader(g));
      if (g.dir) out.push(ind + IND + 'direction ' + g.dir);
      emit(g.id, depth + 1, seen);
      out.push(ind + 'end');
    }
  };
  emit(null, 1, new Set());
  for (const e of m.edges) out.push(`${IND}${e.from} ${linkStr(e)}${edgeLabel(e)} ${e.to}`);

  const visibleId = (id) => {
    const g = m.groups.find((x) => x.id === id);
    return g?.implicit ? null : id;
  };
  for (const c of m.classDefs) out.push(`${IND}classDef ${c.name} ${c.css}`);
  // one `class` line per class: classDef order first, ids in diagram order (stable diffs)
  const byClass = new Map(m.classDefs.map((c) => [c.name, []]));
  const ordered = [...order.nodes.map((n) => n.id), ...order.groups.map((g) => g.id)];
  for (const id of Object.keys(m.classes)) if (!ordered.includes(id)) ordered.push(id);
  for (const id of ordered) {
    if (!visibleId(id)) continue;
    for (const c of m.classes[id] || []) {
      if (!byClass.has(c)) byClass.set(c, []);
      if (!byClass.get(c).includes(id)) byClass.get(c).push(id);
    }
  }
  for (const [c, ids] of byClass) if (!ids.length) byClass.delete(c);
  for (const [c, ids] of byClass) out.push(`${IND}class ${ids.join(',')} ${c}`);
  for (const [id, css] of Object.entries(m.styles)) if (css && visibleId(id)) out.push(`${IND}style ${id} ${css}`);
  m.edges.forEach((e, i) => e.style && out.push(`${IND}linkStyle ${i} ${e.style}`));
  for (const [id, l] of Object.entries(m.links)) {
    if (!l.url) continue;
    out.push(`${IND}click ${id} href "${l.url.replace(/"/g, '%22')}"${l.tooltip ? ` "${l.tooltip.replace(/"/g, "'")}"` : ''}${l.target ? ' ' + l.target : ''}`);
  }
  for (const x of m.extras) out.push(...x.split('\n').map((l) => IND + l));
  const layout = layoutLine(m, order);
  if (layout) out.push(IND + layout);
  return out.join('\n');
}

function layoutLine(m, order) {
  const parts = [];
  const r = (v) => Math.round(v);
  for (const n of order.nodes) {
    const p = m.layout[n.id];
    if (p) parts.push(`${n.id}:${r(p.x)},${r(p.y)}`);
  }
  for (const g of order.groups) {
    const p = m.layout[g.id];
    const empty = !m.nodes.some((n) => n.parent === g.id) && !m.groups.some((c) => c.parent === g.id);
    if (p && empty && !g.implicit) parts.push(`${g.id}:${r(p.x)},${r(p.y)}`);
  }
  return parts.length ? `%% ${LAYOUT_TAG} ${parts.join(' ')}` : '';
}

const quoteProp = (v) => `"${String(v).replace(/"/g, '#quot;')}"`;

export function nodeDecl(n) {
  const special = n.shape === 'image' || n.shape === 'icon';
  if (special || n.at || !BRACKETS[n.shape]) {
    const p = n.props || {};
    const parts = [];
    if (!special) parts.push(`shape: ${n.shape}`);
    if (n.shape === 'icon') {
      if (p.icon) parts.push(`icon: ${quoteProp(p.icon)}`);
      if (p.form) parts.push(`form: ${quoteProp(p.form)}`);
    }
    if (n.shape === 'image' && p.img) parts.push(`img: ${quoteProp(p.img)}`);
    if (n.label !== n.id || special) parts.push(`label: ${quoteProp(n.label)}`);
    if (special) {
      if (p.pos) parts.push(`pos: ${quoteProp(p.pos)}`);
      if (p.w) parts.push(`w: ${p.w}`);
      if (p.h) parts.push(`h: ${p.h}`);
      if (p.constraint) parts.push(`constraint: ${quoteProp(p.constraint)}`);
    }
    for (const [k, v] of Object.entries(p)) {
      if (!['img', 'icon', 'form', 'pos', 'w', 'h', 'constraint'].includes(k)) parts.push(`${k}: ${/^[\w.-]+$/.test(v) ? v : quoteProp(v)}`);
    }
    return `${n.id}@{ ${parts.join(', ')} }`;
  }
  if (n.shape === 'rect' && n.label === n.id) return n.id;
  const [o, c] = BRACKETS[n.shape];
  return n.id + o + labelText(n.label) + c;
}

function needsQuote(l) {
  return l === '' || /^\s|\s$/.test(l) || /[()[\]{}<>|"@;&\\/`]/.test(l) || /--|==|-\.|~~|:::/.test(l) || RESERVED.has(l.toLowerCase());
}

function labelText(l) {
  l = String(l).replace(/"/g, '#quot;');
  return needsQuote(l) ? `"${l}"` : l;
}

function groupHeader(g) {
  if (g.implicit) return `subgraph ${g.title}`;
  if (g.title === g.id) return `subgraph ${g.id}`;
  return `subgraph ${g.id} [${labelText(g.title)}]`;
}

export function linkStr(e) {
  const len = Math.max(1, e.len || 1);
  const st = e.start || '';
  const en = e.end || '';
  switch (e.stroke) {
    case 'invisible':
      return '~'.repeat(len + 2);
    case 'thick':
      return st + '='.repeat(en ? len + 1 : len + 2) + en;
    case 'dotted':
      return st + '-' + '.'.repeat(len) + '-' + en;
    default:
      return st + '-'.repeat(en ? len + 1 : len + 2) + en;
  }
}

function edgeLabel(e) {
  if (!e.label || e.stroke === 'invisible') return '';
  const l = e.label.replace(/"/g, '#quot;');
  return /[|()[\]{}<>]|^\s|\s$/.test(l) ? `|"${l}"|` : `|${l}|`;
}

// ------------------------------------------------------------------ edit operations

export const getNode = (m, id) => m.nodes.find((n) => n.id === id);
export const getGroup = (m, id) => m.groups.find((g) => g.id === id);
export const validId = (id) => ID_RE.exec(id)?.[0] === id && !RESERVED.has(id.toLowerCase());

/** camelCase identifier derived from a label ("Auth Service" -> "authService"). */
export function slug(label) {
  const words = String(label)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>|[`*_#]|&\w+;|#\w+;/g, ' ')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 4);
  let id = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase())).join('');
  if (/^\d/.test(id)) id = 'n' + id;
  return id;
}

export function uniqueId(m, base = 'n') {
  const taken = new Set([...m.nodes.map((n) => n.id), ...m.groups.map((g) => g.id)]);
  if (!base || !validId(base)) base = 'n';
  if (!taken.has(base) && base !== 'n') return base;
  for (let i = 1; ; i++) if (!taken.has(base + i)) return base + i;
}

export function addNode(m, { id, label, shape = 'rect', parent = null, x = 0, y = 0, props = {} } = {}) {
  id = id && validId(id) && !getNode(m, id) && !getGroup(m, id) ? id : uniqueId(m, label ? slug(label) : 'n');
  const n = { id, label: label ?? id, shape, at: false, props, parent, explicit: true };
  m.nodes.push(n);
  m.layout[id] = { x, y };
  return n;
}

export function addEdge(m, from, to, opts = {}) {
  const e = { from, to, stroke: 'normal', start: '', end: '>', len: 1, label: '', style: '', ...opts };
  m.edges.push(e);
  return e;
}

export function renameId(m, from, to) {
  if (from === to || !validId(to) || getNode(m, to) || getGroup(m, to)) return false;
  for (const n of m.nodes) {
    if (n.id === from) n.id = to;
    if (n.parent === from) n.parent = to;
  }
  for (const g of m.groups) {
    if (g.id === from) {
      if (g.title === from) g.title = to;
      g.id = to;
      g.implicit = false;
    }
    if (g.parent === from) g.parent = to;
  }
  for (const e of m.edges) {
    if (e.from === from) e.from = to;
    if (e.to === from) e.to = to;
  }
  for (const map of [m.classes, m.styles, m.links, m.layout]) {
    if (from in map) {
      map[to] = map[from];
      delete map[from];
    }
  }
  return true;
}

function dropKeys(m, ids) {
  for (const map of [m.classes, m.styles, m.links, m.layout]) for (const id of ids) delete map[id];
}

export function removeNodes(m, ids) {
  ids = new Set(ids);
  m.nodes = m.nodes.filter((n) => !ids.has(n.id));
  m.edges = m.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  dropKeys(m, ids);
}

export function removeEdges(m, indices) {
  const drop = new Set(indices);
  m.edges = m.edges.filter((_, i) => !drop.has(i));
}

/** All node and group ids nested (at any depth) inside group `gid`. */
export function descendants(m, gid) {
  const groups = new Set();
  const nodes = new Set();
  const visit = (id) => {
    for (const g of m.groups) if (g.parent === id && !groups.has(g.id)) groups.add(g.id), visit(g.id);
    for (const n of m.nodes) if (n.parent === id) nodes.add(n.id);
  };
  visit(gid);
  return { groups, nodes };
}

export function addGroup(m, { title = 'Group', nodes = [], groups = [], parent = null, x = 0, y = 0 } = {}) {
  const id = uniqueId(m, slug(title) || 'group');
  m.groups.push({ id, title, dir: null, parent, implicit: false });
  for (const n of m.nodes) if (nodes.includes(n.id)) n.parent = id;
  for (const g of m.groups) if (groups.includes(g.id) && g.id !== id) g.parent = id;
  if (!nodes.length && !groups.length) m.layout[id] = { x, y };
  return id;
}

/** Removes a group; its contents move to the group's parent unless `withContents`. */
export function removeGroup(m, gid, withContents = false) {
  const g = getGroup(m, gid);
  if (!g) return;
  if (withContents) {
    const d = descendants(m, gid);
    removeNodes(m, d.nodes);
    m.groups = m.groups.filter((x) => !d.groups.has(x.id));
  } else {
    for (const n of m.nodes) if (n.parent === gid) n.parent = g.parent;
    for (const c of m.groups) if (c.parent === gid) c.parent = g.parent;
  }
  m.groups = m.groups.filter((x) => x.id !== gid);
  m.edges = m.edges.filter((e) => e.from !== gid && e.to !== gid);
  dropKeys(m, [gid]);
}

export function setGroupParent(m, gid, pid) {
  if (gid === pid || (pid && descendants(m, gid).groups.has(pid))) return false;
  const g = getGroup(m, gid);
  if (g) g.parent = pid || null;
  return true;
}

/** Builds a standalone flowchart from a subset of nodes (used for copy). */
export function extract(m, ids) {
  ids = new Set(ids);
  const sub = emptyFlowchart(m.dir);
  sub.nodes = m.nodes.filter((n) => ids.has(n.id)).map((n) => ({ ...n, props: { ...n.props }, parent: null }));
  sub.edges = m.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ ...e }));
  for (const id of ids) {
    if (m.styles[id]) sub.styles[id] = m.styles[id];
    if (m.classes[id]) sub.classes[id] = [...m.classes[id]];
    if (m.links[id]) sub.links[id] = { ...m.links[id] };
    if (m.layout[id]) sub.layout[id] = { ...m.layout[id] };
  }
  return sub;
}

/** Merges `sub` into `m`, renaming clashing ids. Returns the new node ids. */
export function merge(m, sub, dx = 0, dy = 0) {
  const map = new Map();
  for (const n of sub.nodes) {
    const id = getNode(m, n.id) || getGroup(m, n.id) || map.has(n.id) ? uniqueId(m, n.id) : n.id;
    map.set(n.id, id);
    m.nodes.push({ ...n, id, parent: null });
    const p = sub.layout[n.id];
    if (p) m.layout[id] = { x: p.x + dx, y: p.y + dy };
    if (sub.styles[n.id]) m.styles[id] = sub.styles[n.id];
    if (sub.classes[n.id]) m.classes[id] = [...sub.classes[n.id]];
    if (sub.links[n.id]) m.links[id] = { ...sub.links[n.id] };
  }
  for (const e of sub.edges) if (map.has(e.from) && map.has(e.to)) m.edges.push({ ...e, from: map.get(e.from), to: map.get(e.to) });
  for (const c of sub.classDefs) if (!m.classDefs.some((x) => x.name === c.name)) m.classDefs.push({ ...c });
  return [...map.values()];
}

// ------------------------------------------------------------------ styles

export function parseCss(css) {
  const map = new Map();
  for (const part of String(css || '').split(',')) {
    const k = part.indexOf(':');
    if (k > 0) map.set(part.slice(0, k).trim(), part.slice(k + 1).trim());
  }
  return map;
}

export const cssString = (map) => [...map].filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}:${v}`).join(',');

/** Effective css for a node/group: classDef default + classes + style statement. */
export function effectiveStyle(m, id) {
  const out = new Map();
  const apply = (css) => parseCss(css).forEach((v, k) => out.set(k, v));
  // like mermaid's generated CSS: later classDefs win, regardless of the order classes were assigned
  const mine = new Set(m.classes[id] || []);
  for (const c of m.classDefs) if (c.name === 'default' || mine.has(c.name)) apply(c.css);
  if (m.styles[id]) apply(m.styles[id]);
  return out;
}

// ------------------------------------------------------------------ layout

/**
 * Small layered layout (longest-path ranks + barycenter ordering) used when
 * mermaid's own layout is unavailable. `size(id)` returns {w, h}.
 */
export function layeredLayout(m, size) {
  const ids = m.nodes.map((n) => n.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const N = ids.length;
  const out = ids.map(() => []);
  for (const e of m.edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a != null && b != null && a !== b) out[a].push(b);
  }
  // drop back edges (DFS) so ranks are well defined
  const state = new Array(N).fill(0);
  const dag = ids.map(() => []);
  const visit = (u) => {
    state[u] = 1;
    for (const v of out[u]) {
      if (state[v] === 1) continue;
      dag[u].push(v);
      if (!state[v]) visit(v);
    }
    state[u] = 2;
  };
  for (let u = 0; u < N; u++) if (!state[u]) visit(u);
  const indeg = new Array(N).fill(0);
  for (const vs of dag) for (const v of vs) indeg[v]++;
  const rank = new Array(N).fill(0);
  const queue = ids.map((_, i) => i).filter((i) => !indeg[i]);
  while (queue.length) {
    const u = queue.shift();
    for (const v of dag[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (!--indeg[v]) queue.push(v);
    }
  }
  const layers = [];
  for (let i = 0; i < N; i++) (layers[rank[i]] ||= []).push(i);
  const pos = new Array(N).fill(0);
  layers.forEach((l) => l.forEach((u, k) => (pos[u] = k)));
  const preds = ids.map(() => []);
  dag.forEach((vs, u) => vs.forEach((v) => preds[v].push(u)));
  const group = (u) => m.nodes[u].parent || '';
  for (let pass = 0; pass < 6; pass++) {
    const down = pass % 2 === 0;
    const order = down ? layers : [...layers].reverse();
    for (const l of order) {
      if (!l) continue;
      const bary = new Map();
      for (const u of l) {
        const nb = down ? preds[u] : dag[u];
        bary.set(u, nb.length ? nb.reduce((s, v) => s + pos[v], 0) / nb.length : pos[u]);
      }
      const gb = new Map();
      for (const u of l) {
        const g = group(u);
        if (!gb.has(g)) gb.set(g, []);
        gb.get(g).push(bary.get(u));
      }
      const gkey = (u) => {
        const g = group(u);
        if (!g) return bary.get(u);
        const xs = gb.get(g);
        return xs.reduce((a, b) => a + b, 0) / xs.length;
      };
      l.sort((a, b) => gkey(a) - gkey(b) || bary.get(a) - bary.get(b));
      l.forEach((u, k) => (pos[u] = k));
    }
  }
  const horizontal = m.dir === 'LR' || m.dir === 'RL';
  const flip = m.dir === 'BT' || m.dir === 'RL' ? -1 : 1;
  const sizes = ids.map((id) => size(id));
  const mainGap = horizontal ? Math.max(...sizes.map((s) => s.w), 80) + 80 : Math.max(...sizes.map((s) => s.h), 40) + 70;
  const layout = {};
  layers.forEach((l, r) => {
    if (!l) return;
    const across = l.map((u) => (horizontal ? sizes[u].h : sizes[u].w));
    const total = across.reduce((a, b) => a + b, 0) + (l.length - 1) * (horizontal ? 40 : 50);
    let c = -total / 2;
    l.forEach((u, k) => {
      const mid = c + across[k] / 2;
      c += across[k] + (horizontal ? 40 : 50);
      layout[ids[u]] = horizontal ? { x: r * mainGap * flip, y: mid } : { x: mid, y: r * mainGap * flip };
    });
  });
  return layout;
}

// ------------------------------------------------------------------ diagram style (frontmatter config)

/**
 * Palettes offered by the Styles experiment. Mermaid built-in themes carry a
 * `canvas` approximation for mermdraw's own renderer; mermdraw presets use mermaid's
 * `base` theme with themeVariables, which every mermaid ≥ 10.5 honours.
 */
export const STYLE_PRESETS = {
  '': { name: 'Mermaid default' },
  neutral: { name: 'Mermaid neutral', theme: 'neutral', canvas: { primaryColor: '#f4f4f4', primaryBorderColor: '#999999', primaryTextColor: '#333333', lineColor: '#666666', clusterBkg: '#fafafa', clusterBorder: '#cccccc' } },
  forest: { name: 'Mermaid forest', theme: 'forest', canvas: { primaryColor: '#cde498', primaryBorderColor: '#13540c', primaryTextColor: '#000000', lineColor: '#008000', clusterBkg: '#cdffb2', clusterBorder: '#6eaa49' } },
  dark: { name: 'Mermaid dark', theme: 'dark', canvas: { primaryColor: '#1f2020', primaryBorderColor: '#cccccc', primaryTextColor: '#e0e0e0', lineColor: '#d3d3d3', clusterBkg: '#262a33', clusterBorder: '#444a58', edgeLabelBackground: '#333333', background: '#333333' } },
  blueprint: {
    name: 'Blueprint',
    theme: 'base',
    vars: { primaryColor: '#EEF2FF', primaryBorderColor: '#4F6BED', primaryTextColor: '#1E2457', lineColor: '#6A74A8', secondaryColor: '#FFF4E6', tertiaryColor: '#F7F8FD', clusterBkg: '#F7F8FD', clusterBorder: '#C3CBF3', edgeLabelBackground: '#FFFFFF', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
  mint: {
    name: 'Mint',
    theme: 'base',
    vars: { primaryColor: '#E9F7EF', primaryBorderColor: '#2F9E6B', primaryTextColor: '#123A28', lineColor: '#4F8A6E', secondaryColor: '#FFF7E0', tertiaryColor: '#F4FBF7', clusterBkg: '#F4FBF7', clusterBorder: '#B6E2C9', edgeLabelBackground: '#FFFFFF', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
  sunset: {
    name: 'Sunset',
    theme: 'base',
    vars: { primaryColor: '#FFF1E6', primaryBorderColor: '#E8590C', primaryTextColor: '#4A1D05', lineColor: '#B4643A', secondaryColor: '#EEF2FF', tertiaryColor: '#FFF8F2', clusterBkg: '#FFF8F2', clusterBorder: '#F6C9A8', edgeLabelBackground: '#FFFFFF', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
  slate: {
    name: 'Slate',
    theme: 'base',
    vars: { primaryColor: '#F4F5F7', primaryBorderColor: '#3D4451', primaryTextColor: '#1F232B', lineColor: '#6B7280', secondaryColor: '#E8EAEE', tertiaryColor: '#FAFAFB', clusterBkg: '#FAFAFB', clusterBorder: '#D5D8DE', edgeLabelBackground: '#FFFFFF', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
  midnight: {
    name: 'Midnight',
    theme: 'base',
    vars: { darkMode: true, background: '#0F1626', primaryColor: '#18233A', primaryBorderColor: '#7AA2F7', primaryTextColor: '#E6ECF7', lineColor: '#7C8DB5', secondaryColor: '#22304D', tertiaryColor: '#121B2E', clusterBkg: '#121B2E', clusterBorder: '#2E3D63', edgeLabelBackground: '#18233A', fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif' },
  },
};

export const CURVES = { '': 'Curved', linear: 'Straight', step: 'Orthogonal' };

function splitFrontmatter(preamble) {
  if (preamble[0]?.trim() !== '---') return { fm: null, rest: preamble };
  const end = preamble.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end < 0 ? { fm: null, rest: preamble } : { fm: preamble.slice(1, end), rest: preamble.slice(end + 1) };
}

/** Parses the YAML subset mermaid frontmatter uses (nested maps of scalars); null if it can't. */
export function parseYaml(lines) {
  const root = new Map();
  const stack = [{ indent: -1, map: root }];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const mm = /^("[^"]*"|'[^']*'|[^\s:#"'-][^:#]*?)\s*:(?:\s+(.*?))?\s*$/.exec(t);
    if (!mm) return null;
    while (indent <= stack.at(-1).indent) stack.pop();
    const key = mm[1].replace(/^["']|["']$/g, '');
    const parent = stack.at(-1).map;
    if (mm[2] === undefined || mm[2] === '') {
      const child = new Map();
      parent.set(key, child);
      stack.push({ indent, map: child });
    } else parent.set(key, mm[2]);
  }
  return root;
}

function dumpYaml(map, indent = 0, out = []) {
  for (const [k, v] of map) {
    const key = /^[\w.-]+$/.test(k) ? k : JSON.stringify(k);
    if (v instanceof Map) {
      if (!v.size) continue;
      out.push(' '.repeat(indent) + key + ':');
      dumpYaml(v, indent + 2, out);
    } else out.push(`${' '.repeat(indent)}${key}: ${v}`);
  }
  return out;
}

const unquote = (v) => (typeof v === 'string' ? v.replace(/^"(.*)"$|^'(.*)'$/, '$1$2') : v);

/** Theme, look, connector curve and theme variables from the diagram's frontmatter. */
export function readStyle(m) {
  const { fm } = splitFrontmatter(m.preamble);
  const y = fm ? parseYaml(fm) : new Map();
  const cfg = y?.get('config') instanceof Map ? y.get('config') : new Map();
  const vars = {};
  const tv = cfg.get('themeVariables');
  if (tv instanceof Map) for (const [k, v] of tv) if (!(v instanceof Map)) vars[k] = unquote(v);
  const fc = cfg.get('flowchart');
  return {
    theme: unquote(cfg.get('theme') ?? '') || '',
    look: unquote(cfg.get('look') ?? '') || '',
    curve: (fc instanceof Map && unquote(fc.get('curve') ?? '')) || '',
    vars,
    editable: !!y,
  };
}

/** Updates the given style keys in the frontmatter config; false if the frontmatter is too exotic to edit. */
export function writeStyle(m, style) {
  const { fm, rest } = splitFrontmatter(m.preamble);
  const y = fm ? parseYaml(fm) : new Map();
  if (!y) return false;
  let cfg = y.get('config');
  if (!(cfg instanceof Map)) y.set('config', (cfg = new Map()));
  const scalar = (v) => (typeof v === 'boolean' || typeof v === 'number' ? String(v) : JSON.stringify(String(v)));
  const put = (map, k, v) => (v ? map.set(k, v) : map.delete(k));
  if ('theme' in style) put(cfg, 'theme', style.theme);
  if ('look' in style) put(cfg, 'look', style.look);
  if ('curve' in style) {
    let fc = cfg.get('flowchart');
    if (!(fc instanceof Map)) cfg.set('flowchart', (fc = new Map()));
    put(fc, 'curve', style.curve);
    if (!fc.size) cfg.delete('flowchart');
  }
  if ('vars' in style) {
    const entries = Object.entries(style.vars || {});
    if (entries.length) cfg.set('themeVariables', new Map(entries.map(([k, v]) => [k, scalar(v)])));
    else cfg.delete('themeVariables');
  }
  if (!cfg.size) y.delete('config');
  const body = dumpYaml(y);
  m.preamble = body.length ? ['---', ...body, '---', ...rest] : rest;
  return true;
}

/** Which STYLE_PRESETS entry the diagram currently uses ('custom' if none). */
export function presetOf(style) {
  for (const [id, p] of Object.entries(STYLE_PRESETS)) {
    if ((p.theme || '') !== style.theme) continue;
    if (!p.vars && !Object.keys(style.vars).length) return id;
    if (p.vars && p.vars.primaryColor === style.vars.primaryColor && p.vars.primaryBorderColor === style.vars.primaryBorderColor) return id;
  }
  return 'custom';
}

/** Colours mermdraw's canvas should use for this diagram (themeVariables or a built-in theme's approximation). */
export function canvasPalette(style) {
  const preset = Object.values(STYLE_PRESETS).find((p) => p.theme && p.theme === style.theme && p.canvas);
  const v = { ...(preset?.canvas || {}), ...style.vars };
  return Object.keys(v).length ? v : null;
}
