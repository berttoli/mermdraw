import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../web/model.js';

const strip = (m) => JSON.parse(JSON.stringify({ ...m, warnings: undefined }));
const roundTrip = (src) => M.serializeFlowchart(M.parseFlowchart(src));

test('scanDoc finds mermaid blocks, titles and line ranges', () => {
  const text = '# Doc\n\n## Overview\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\n```mermaid\n```\n\n````mermaid\n---\ntitle: Seq\n---\nsequenceDiagram\n````\n';
  const s = M.scanDoc(text);
  assert.equal(s.blocks.length, 2);
  assert.deepEqual([s.blocks[0].start, s.blocks[0].end, s.blocks[0].kind, s.blocks[0].title], [4, 7, 'flowchart', 'Overview']);
  assert.equal(s.blocks[0].source, 'flowchart LR\n  A --> B');
  assert.equal(s.blocks[1].title, 'Seq');
  assert.deepEqual(s.headings.map((h) => h.text), ['Doc', 'Overview']);
});

test('replaceBlock only touches the block and keeps CRLF + indentation', () => {
  const text = 'intro\r\n\r\n- item\r\n  ```mermaid\r\n  graph TD\r\n    A\r\n  ```\r\ntail\r\n';
  const s = M.scanDoc(text);
  assert.equal(s.blocks[0].source, 'graph TD\n  A');
  const out = M.replaceBlock(text, s, 0, 'graph LR\n  B --> C\n');
  assert.equal(out, 'intro\r\n\r\n- item\r\n  ```mermaid\r\n  graph LR\r\n    B --> C\r\n  ```\r\ntail\r\n');
});

test('replaceBlock closes an unterminated fence', () => {
  const text = '# x\n```mermaid\ngraph TD\n';
  const s = M.scanDoc(text);
  assert.equal(M.replaceBlock(text, s, 0, 'graph LR'), '# x\n```mermaid\ngraph LR\n```');
});

test('insertBlock and deleteBlock', () => {
  const text = '# A\n\n```mermaid\ngraph TD\n```\n';
  let s = M.scanDoc(text);
  const added = M.insertBlock(text, s, 0, 'flowchart LR\n  x', 'Second');
  assert.equal(added, '# A\n\n```mermaid\ngraph TD\n```\n\n## Second\n\n```mermaid\nflowchart LR\n  x\n```\n');
  s = M.scanDoc(added);
  assert.equal(s.blocks.length, 2);
  assert.equal(s.blocks[1].title, 'Second');
  assert.equal(M.deleteBlock(added, s, 1), '# A\n\n```mermaid\ngraph TD\n```\n\n## Second\n');
  assert.equal(M.insertBlock('', M.scanDoc(''), -1, 'graph TD', 'T'), '## T\n\n```mermaid\ngraph TD\n```\n');
});

test('whole-file .mmd documents', () => {
  const s = M.scanDoc('graph TD\n  A\n', true);
  assert.equal(s.blocks[0].source, 'graph TD\n  A');
  assert.equal(M.replaceBlock('graph TD\n  A\n', s, 0, 'graph LR'), 'graph LR\n');
});

test('parses shapes, quoted labels and the @{} syntax', () => {
  const m = M.parseFlowchart(`flowchart LR
  a[Rect] --> b(Round) --> c([Stadium]) --> d[[Sub]] --> e[(DB)]
  f((Circle)) & g(((Dbl))) & h>Odd] --> i{Decision}
  j{{Hex}} --- k[/In/] --- l[\\Out\\] --- m2[/Prio\\] --- n[\\Man/]
  o1["Label (with) [brackets]"]
  p@{ shape: cloud, label: "Internet" }
  q@{
    shape: database
    label: "Multi line"
  }
  img@{ img: "./assets/logo.png", label: "Logo", pos: "t", w: 60, h: 60, constraint: "on" }
  bare`);
  const shape = Object.fromEntries(m.nodes.map((n) => [n.id, n.shape]));
  assert.deepEqual(shape, {
    a: 'rect', b: 'rounded', c: 'stadium', d: 'fr-rect', e: 'cyl', f: 'circle', g: 'dbl-circ', h: 'odd', i: 'diam',
    j: 'hex', k: 'lean-r', l: 'lean-l', m2: 'trap-b', n: 'trap-t', o1: 'rect', p: 'cloud', q: 'cyl', img: 'image', bare: 'rect',
  });
  assert.equal(M.getNode(m, 'o1').label, 'Label (with) [brackets]');
  assert.equal(M.getNode(m, 'q').label, 'Multi line');
  assert.deepEqual(M.getNode(m, 'img').props, { img: './assets/logo.png', pos: 't', w: '60', h: '60', constraint: 'on' });
  assert.equal(m.edges.length, 4 + 3 + 4);
  assert.deepEqual(m.warnings, []);
});

test('parses every link flavour', () => {
  const cases = {
    'A --> B': ['normal', '', '>', 1, ''],
    'A --- B': ['normal', '', '', 1, ''],
    'A ---> B': ['normal', '', '>', 2, ''],
    'A -.-> B': ['dotted', '', '>', 1, ''],
    'A -..- B': ['dotted', '', '', 2, ''],
    'A ==> B': ['thick', '', '>', 1, ''],
    'A === B': ['thick', '', '', 1, ''],
    'A ~~~ B': ['invisible', '', '', 1, ''],
    'A --o B': ['normal', '', 'o', 1, ''],
    'A --x B': ['normal', '', 'x', 1, ''],
    'A <--> B': ['normal', '<', '>', 1, ''],
    'A o--o B': ['normal', 'o', 'o', 1, ''],
    'A -->|calls| B': ['normal', '', '>', 1, 'calls'],
    'A -- uses --> B': ['normal', '', '>', 1, 'uses'],
    'A -- uses--> B': ['normal', '', '>', 1, 'uses'],
    'A -. maybe .-> B': ['dotted', '', '>', 1, 'maybe'],
    'A == must ==> B': ['thick', '', '>', 1, 'must'],
    'A-->|"a|b"|B': ['normal', '', '>', 1, 'a|b'],
    'A-->B': ['normal', '', '>', 1, ''],
    'A---oB': ['normal', '', 'o', 2, ''],
  };
  for (const [src, [stroke, start, end, len, label]] of Object.entries(cases)) {
    const m = M.parseFlowchart('graph TD\n' + src);
    assert.equal(m.edges.length, 1, src);
    const e = m.edges[0];
    assert.deepEqual([e.from, e.to, e.stroke, e.start, e.end, e.len, e.label], ['A', 'B', stroke, start, end, len, label], src);
    const again = M.parseFlowchart(roundTrip('graph TD\n' + src)).edges[0];
    assert.deepEqual(again, e, `round trip of ${src}`);
  }
});

test('chains and & groups expand to edges', () => {
  const m = M.parseFlowchart('graph TD\n a & b --> c & d --> e; f --> g');
  assert.deepEqual(m.edges.map((e) => e.from + e.to), ['ac', 'ad', 'bc', 'bd', 'ce', 'de', 'fg']);
});

test('subgraphs, nesting, direction and edges to subgraphs', () => {
  const m = M.parseFlowchart(`flowchart TB
  subgraph cloud [Cloud Platform]
    direction LR
    lb --> app
    subgraph data["Data (tier)"]
      db[(Postgres)]
    end
  end
  subgraph Other things
    x
  end
  user --> cloud
  app --> db`);
  assert.deepEqual(m.groups.map((g) => [g.id, g.title, g.parent, g.dir]), [
    ['cloud', 'Cloud Platform', null, 'LR'],
    ['data', 'Data (tier)', 'cloud', null],
    ['__sg1', 'Other things', null, null],
  ]);
  const parent = Object.fromEntries(m.nodes.map((n) => [n.id, n.parent]));
  assert.deepEqual(parent, { lb: 'cloud', app: 'cloud', db: 'data', x: '__sg1', user: null });
  assert.ok(!M.getNode(m, 'cloud'), 'edge target that is a subgraph is not a node');
  const out = roundTrip(M.serializeFlowchart(m));
  assert.equal(out, M.serializeFlowchart(m));
  assert.match(out, /subgraph Other things\n {8}x\n {4}end/);
});

test('styles, classes, linkStyle, click and comments survive', () => {
  const src = `---
title: Demo
---
%%{init: {"theme": "forest"}}%%
graph LR
  %% a comment
  A:::hot --> B
  B --> C
  classDef hot fill:#f96,stroke:#333;
  class B,C cool
  style A fill:#fff,stroke-width:2px
  linkStyle 1 stroke:#f00
  click A href "https://example.com" "Docs" _blank
  click B call cb()
  accTitle: Title`;
  const m = M.parseFlowchart(src);
  assert.deepEqual(m.preamble, ['---', 'title: Demo', '---', '%%{init: {"theme": "forest"}}%%']);
  assert.deepEqual(m.classes, { A: ['hot'], B: ['cool'], C: ['cool'] });
  assert.equal(m.styles.A, 'fill:#fff,stroke-width:2px');
  assert.equal(m.edges[1].style, 'stroke:#f00');
  assert.deepEqual(m.links.A, { url: 'https://example.com', tooltip: 'Docs', target: '_blank' });
  assert.deepEqual(m.extras, ['%% a comment', 'click B call cb()', 'accTitle: Title']);
  const out = M.serializeFlowchart(m);
  assert.equal(out, `---
title: Demo
---
%%{init: {"theme": "forest"}}%%
graph LR
    A
    B
    C
    A --> B
    B --> C
    classDef hot fill:#f96,stroke:#333
    class A hot
    class B,C cool
    style A fill:#fff,stroke-width:2px
    linkStyle 1 stroke:#f00
    click A href "https://example.com" "Docs" _blank
    %% a comment
    click B call cb()
    accTitle: Title`);
  assert.deepEqual(strip(M.parseFlowchart(out)), strip(m));
});

test('layout comment is parsed and written', () => {
  const m = M.parseFlowchart('graph TD\n  A --> B\n  %% mermdraw:layout A:10,20 B:-5,80.5');
  assert.deepEqual(m.layout, { A: { x: 10, y: 20 }, B: { x: -5, y: 80.5 } });
  assert.match(M.serializeFlowchart(m), /%% mermdraw:layout A:10,20 B:-5,81$/);
});

test('serialization is idempotent on a realistic diagram', () => {
  const src = `flowchart LR
  user([User]) -->|HTTPS| cdn{{CDN}}
  cdn --> web[Web App]
  subgraph backend [Backend]
    web --> api[API]
    api -.->|events| queue>Queue]
    api ==> db[(Postgres)]
  end
  queue --> worker[[Worker]]
  worker --> db
  note@{ shape: text, label: "All services run on k8s" }`;
  const once = roundTrip(src);
  assert.equal(roundTrip(once), once);
  const m = M.parseFlowchart(once);
  assert.equal(M.getNode(m, 'web').parent, 'backend');
  assert.equal(M.getNode(m, 'note').shape, 'text');
});

test('labels that need quoting are quoted', () => {
  const m = M.emptyFlowchart('LR');
  M.addNode(m, { id: 'a', label: 'calls (v2) <br> retry' });
  M.addNode(m, { id: 'b', label: 'Plain label' });
  M.addNode(m, { id: 'c', label: 'say "hi"', shape: 'diam' });
  M.addEdge(m, 'a', 'b', { label: 'x|y' });
  const out = M.serializeFlowchart(m);
  assert.match(out, /a\["calls \(v2\) <br> retry"\]/);
  assert.match(out, /b\[Plain label\]/);
  assert.match(out, /c\{"say #quot;hi#quot;"\}/);
  assert.match(out, /a -->\|"x\|y"\| b/);
  const back = M.parseFlowchart(out);
  assert.equal(M.getNode(back, 'a').label, 'calls (v2) <br> retry');
  assert.equal(back.edges[0].label, 'x|y');
});

test('edit operations keep references consistent', () => {
  const m = M.parseFlowchart('graph TD\n  A --> B\n  subgraph g [G]\n    B\n  end\n  style A fill:#f00\n  click A "x.md"\n  %% mermdraw:layout A:0,0 B:0,100');
  assert.ok(M.renameId(m, 'A', 'start'));
  assert.equal(m.edges[0].from, 'start');
  assert.equal(m.styles.start, 'fill:#f00');
  assert.equal(m.links.start.url, 'x.md');
  assert.deepEqual(m.layout.start, { x: 0, y: 0 });
  assert.ok(!M.renameId(m, 'start', 'B'), 'cannot rename onto an existing id');
  assert.ok(!M.renameId(m, 'start', 'end'), 'reserved word');
  M.removeGroup(m, 'g');
  assert.equal(M.getNode(m, 'B').parent, null);
  const gid = M.addGroup(m, { title: 'Core Services', nodes: ['start', 'B'] });
  assert.equal(gid, 'coreServices');
  assert.equal(M.getNode(m, 'B').parent, 'coreServices');
  M.removeNodes(m, ['B']);
  assert.equal(m.edges.length, 0);
  M.removeGroup(m, gid, true);
  assert.equal(m.nodes.length, 0);
  assert.deepEqual(m.styles, {});
});

test('slug and uniqueId produce readable ids', () => {
  const m = M.emptyFlowchart();
  assert.equal(M.slug('Auth Service'), 'authService');
  assert.equal(M.slug('2FA <br> check'), 'n2faCheck');
  assert.equal(M.addNode(m, { label: 'Auth Service' }).id, 'authService');
  assert.equal(M.addNode(m, { label: 'Auth Service' }).id, 'authService1');
  assert.equal(M.addNode(m, { label: 'end' }).id, 'n1');
  assert.equal(M.addNode(m, {}).id, 'n2');
});

test('extract + merge (copy/paste) renames clashing ids', () => {
  const m = M.parseFlowchart('graph TD\n  A[One] --> B[Two]\n  B --> C\n  %% mermdraw:layout A:0,0 B:0,100 C:0,200');
  const sub = M.extract(m, ['A', 'B']);
  assert.equal(sub.edges.length, 1);
  const ids = M.merge(m, M.parseFlowchart(M.serializeFlowchart(sub)), 50, 0);
  assert.deepEqual(ids, ['A1', 'B1']);
  assert.deepEqual(m.edges.at(-1), { ...m.edges[0], from: 'A1', to: 'B1' });
  assert.deepEqual(m.layout.A1, { x: 50, y: 0 });
});

test('unknown statements are kept verbatim with a warning', () => {
  const m = M.parseFlowchart('graph TD\n  A --> B\n  A -- broken B\n');
  assert.equal(m.warnings.length, 1);
  assert.match(M.serializeFlowchart(m), /A -- broken B/);
});

test('non-flowcharts are rejected', () => {
  assert.equal(M.parseFlowchart('sequenceDiagram\n A->>B: hi'), null);
  assert.equal(M.describe('---\ntitle: x\n---\n%% c\nsequenceDiagram').kind, 'sequenceDiagram');
});

test('layered layout ranks along the flow direction', () => {
  const m = M.parseFlowchart('graph LR\n  A --> B --> C\n  A --> C\n  C --> A');
  const pos = M.layeredLayout(m, () => ({ w: 100, h: 40 }));
  assert.ok(pos.A.x < pos.B.x && pos.B.x < pos.C.x);
});

test('css helpers', () => {
  const m = M.parseFlowchart('graph TD\n  A:::x\n  classDef default fill:#111\n  classDef x stroke:#222\n  style A color:#333');
  assert.deepEqual(Object.fromEntries(M.effectiveStyle(m, 'A')), { fill: '#111', stroke: '#222', color: '#333' });
  const css = M.parseCss('fill:#f00,stroke:#0f0');
  css.set('fill', '');
  assert.equal(M.cssString(css), 'stroke:#0f0');
});

test('icon nodes keep their props in canonical order', () => {
  const src = 'flowchart LR\n  py@{ icon: "logos:python", form: "circle", label: "Cart API", pos: "t", h: 40 }';
  const m = M.parseFlowchart(src);
  const n = M.getNode(m, 'py');
  assert.equal(n.shape, 'icon');
  assert.deepEqual(n.props, { icon: 'logos:python', form: 'circle', pos: 't', h: '40' });
  assert.match(M.serializeFlowchart(m), /py@\{ icon: "logos:python", form: "circle", label: "Cart API", pos: "t", h: 40 \}/);
});

test('style config is written to frontmatter without touching other keys', () => {
  const m = M.parseFlowchart('---\ntitle: Org\nconfig:\n  flowchart:\n    htmlLabels: false\n---\nflowchart LR\n  A --> B');
  assert.ok(M.writeStyle(m, { theme: 'base', look: 'handDrawn', curve: 'step', vars: M.STYLE_PRESETS.mint.vars }));
  const out = M.serializeFlowchart(m);
  assert.match(out, /^---\ntitle: Org\nconfig:\n  flowchart:\n    htmlLabels: false\n    curve: step\n  theme: base\n  look: handDrawn\n  themeVariables:\n    primaryColor: "#E9F7EF"/);
  const st = M.readStyle(M.parseFlowchart(out));
  assert.deepEqual([st.theme, st.look, st.curve, M.presetOf(st)], ['base', 'handDrawn', 'step', 'mint']);
  M.writeStyle(m, { theme: '', look: '', curve: '', vars: null });
  assert.equal(M.serializeFlowchart(m), '---\ntitle: Org\nconfig:\n  flowchart:\n    htmlLabels: false\n---\nflowchart LR\n    A\n    B\n    A --> B');
  const plain = M.parseFlowchart('flowchart LR\n  A');
  M.writeStyle(plain, { theme: 'forest' });
  assert.equal(M.serializeFlowchart(plain), '---\nconfig:\n  theme: forest\n---\nflowchart LR\n    A');
  assert.equal(M.presetOf(M.readStyle(plain)), 'forest');
});

test('exotic frontmatter is left alone', () => {
  const m = M.parseFlowchart('---\nconfig:\n  themeCSS:\n    - a\n---\nflowchart LR\n  A');
  assert.equal(M.readStyle(m).editable, false);
  assert.equal(M.writeStyle(m, { theme: 'dark' }), false);
});

test('bundled examples parse cleanly and round-trip', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = new URL('../examples/', import.meta.url).pathname;
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.md'));
  let flowcharts = 0;
  for (const f of files) {
    for (const b of M.scanDoc(fs.readFileSync(path.join(dir, f), 'utf8')).blocks) {
      if (!M.isFlowchartKind(b.kind)) continue;
      flowcharts++;
      const m = M.parseFlowchart(b.source);
      assert.deepEqual(m.warnings, [], `${f}#${b.index + 1}`);
      const once = M.serializeFlowchart(m);
      assert.equal(M.serializeFlowchart(M.parseFlowchart(once)), once, `${f}#${b.index + 1} is stable`);
    }
  }
  assert.ok(flowcharts >= 8);
});

test('nodes declared after subgraphs still serialize stably on the first save', () => {
  const src = 'flowchart LR\n  a\n  subgraph g [G]\n    b:::x\n  end\n  c:::x\n  classDef x fill:#fff\n  %% mermdraw:layout a:0,0 b:10,0 c:20,0';
  const once = M.serializeFlowchart(M.parseFlowchart(src));
  assert.equal(M.serializeFlowchart(M.parseFlowchart(once)), once);
  assert.match(once, /class c,b x/);
  assert.match(once, /%% mermdraw:layout a:0,0 c:20,0 b:10,0$/);
});

test('metadata on a subgraph (view: collapsed) is kept as-is, not turned into a node', () => {
  for (const src of [
    'flowchart LR\n  subgraph core [Core]\n    a --> b\n  end\n  core@{ view: collapsed }',
    'flowchart LR\n  core@{ view: collapsed }\n  subgraph core [Core]\n    a --> b\n  end',
  ]) {
    const m = M.parseFlowchart(src);
    assert.deepEqual(m.nodes.map((n) => n.id), ['a', 'b']);
    assert.deepEqual(m.extras, ['core@{ view: collapsed }']);
    const out = M.serializeFlowchart(m);
    assert.doesNotMatch(out, /shape: rect/);
    assert.match(out, /\n {4}core@\{ view: collapsed \}$/);
    assert.equal(roundTrip(out), out);
  }
});

test('mermaid 11.17 architecture shapes round-trip', () => {
  const src = 'flowchart LR\n    u@{ shape: person, label: "User" }\n    w@{ shape: browser, label: "Web" }\n    t@{ shape: console, label: "CLI" }\n    f@{ shape: folder, label: "Repo" }\n    s@{ shape: bucket, label: "Assets" }\n    u --> w\n    w --> s';
  assert.deepEqual(M.parseFlowchart(src).nodes.map((n) => n.shape), ['person', 'browser', 'console', 'folder', 'bucket']);
  assert.equal(roundTrip(src), src);
});
