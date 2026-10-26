<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/header-dark.png">
    <img alt="mmdr — drag-and-drop mermaid diagrams that live in your markdown and your git history" src="docs/images/header-light.png" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://github.com/berttoli/mmdr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/berttoli/mmdr/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Dependencies: 0" src="https://img.shields.io/badge/dependencies-0-brightgreen.svg">
  <img alt="mermaid 11.17" src="https://img.shields.io/badge/mermaid-11.17-ff3670.svg">
</p>

**mmdr** is a tiny local editor for the mermaid diagrams inside your markdown. Point it at a file, drag boxes
around, connect them, drop in logos, and every change is written straight back into the ```` ```mermaid ```` block, ready
to commit and review like any other change. It's a draw.io / Miro-style canvas that keeps your architecture as
plain text in your repo.

```bash
mmdr docs/architecture.md        # opens the editor in your browser
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.png">
  <img alt="The mmdr canvas editing an L2 architecture diagram with product icons, the node inspector and the generated mermaid" src="docs/images/hero-light.png">
</picture>

> **Status: 0.1, early.** Expect rough edges. [Issues](https://github.com/berttoli/mmdr/issues) and ideas are welcome.

## Features

**Visual canvas for flowcharts**
- Drag, drop and connect: pull a node's ● handle onto another node, or onto empty space to create the next node.
  Press <kbd>Tab</kbd> while naming a node to chain the next one.
- All 38 mermaid 11 shapes, plus free text, images (drop or paste one and it's saved to `assets/`) and product icons.
- Subgraphs: <kbd>⌘G</kbd> to group, drag nodes into or out of a box, nest groups, set a direction per group.
- Inspector: rename ids (every reference follows), labels, shapes, links, colours (`style` / `linkStyle`), classes,
  and edge style (solid, thick, dotted, invisible, arrowheads, length).
- Box-select, align and distribute, duplicate, copy as mermaid / paste mermaid, undo/redo, zoom, pan and fit.
  **Auto-layout** snaps the canvas to mermaid's own layout.

**Code and live preview for every diagram type**
- Four views: **Canvas**, **Split**, **Preview**, and **Markdown** for editing the whole file.
- A syntax-highlighted code pane. Typing updates the canvas and preview immediately.
- The real mermaid 11.17.2 renderer is embedded (works offline). The preview shows what GitHub draws; export it as SVG.
- An outline of the file's headings and diagrams. Add diagrams from nine templates (flowchart, sequence, class,
  state, ER, architecture, C4, gantt, mindmap) or delete them.

**Markdown-native and git-friendly**
- Only the block you edit changes. Prose, other blocks, line endings and indentation are left alone. `.md` and
  `.mmd` both work.
- Autosave (or <kbd>⌘S</kbd>) with atomic writes. Edits made in vim or VS Code reload live, and if both sides changed
  the file, mmdr re-applies your diagram on top of theirs instead of overwriting them.
- Stable, canonical output with readable ids (`Auth Service` → `authService`). Canvas positions live in a single
  `%% mmdr:layout` comment that mermaid ignores.

**Architecture tooling: L1 → L2**
- **Icon packs:** `mmdr icons add logos devicon` installs ~3,300 open-licensed logos (Python, Rust, nginx, Postgres,
  Kubernetes, Cloud Run, Okta, Grafana, Proxmox…), globally or vendored into the repo. Find them with a searchable picker.
- **Drill-down:** link a node to another diagram (`./l2-platform.md#2`). <kbd>⌘</kbd>-click drills in, and a
  **← back** chip (<kbd>⌘[</kbd>) returns.
- **Diagram styles** (Labs): palettes, a hand-drawn look and orthogonal lines, written as mermaid frontmatter config,
  so GitHub renders them too.

**Small and safe**
- One ~1.7 MB std-only Rust binary: no runtime, no dependencies, starts instantly. `--app` opens a chromeless window.
- Listens on `127.0.0.1` only, rejects foreign `Host` headers, never leaves the folder it serves, and only accepts
  image uploads.

| | |
| --- | --- |
| <img alt="L1 landscape in the mermaid preview with the outline" src="docs/images/l1-preview.png"> **L1** in the preview: exactly what GitHub renders | <img alt="Drilled down from L1 into the workplace IT L2, with the back chip" src="docs/images/drilldown.png"> **⌘-click drill-down** from L1 into an L2 |
| <img alt="Icon picker searching for cloud icons" src="docs/images/icon-picker.png"> **Icon picker** over installed Iconify packs | <img alt="Hand-drawn mint theme with orthogonal lines on canvas and preview" src="docs/images/styles.png"> **Diagram styles**: theme, hand-drawn, orthogonal |
| <img alt="Sequence diagram with live preview and code" src="docs/images/code-preview.png"> **Any diagram type** as code with a live preview | <img alt="Labs panel listing feature flags" src="docs/images/labs.png"> **Labs**: experiments behind feature flags |

## Install

Download a binary from the [releases page](https://github.com/berttoli/mmdr/releases). The Linux builds are static
and run on any distro. Asset names don't change between versions, so this always fetches the latest stable release:

```bash
# pick yours: aarch64-apple-darwin, x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
target=aarch64-apple-darwin
curl -fsSL "https://github.com/berttoli/mmdr/releases/latest/download/mmdr-$target.tar.gz" | tar xz
sudo mv "mmdr-$target/mmdr" /usr/local/bin/
```

`latest` skips pre-releases. To try a release candidate, put its tag in the URL instead, e.g.
`https://github.com/berttoli/mmdr/releases/download/v0.1.0-rc.2/mmdr-$target.tar.gz`, or grab it from the
[releases page](https://github.com/berttoli/mmdr/releases); `mmdr --version` tells you which build you have.

On Windows, download `mmdr-x86_64-pc-windows-msvc.zip`. Every archive is listed in `SHA256SUMS.txt` and carries a
signed build-provenance attestation (`gh attestation verify <archive> -R berttoli/mmdr`). If macOS refuses to open a
binary downloaded in a browser, run `xattr -d com.apple.quarantine mmdr`.

Or build it with Rust:

```bash
cargo install --git https://github.com/berttoli/mmdr
```

Optional, for L2 diagrams with product logos:

```bash
mmdr icons add logos devicon            # into ~/.config/mmdr/icons, available everywhere
mmdr icons add logos --vendor           # or into this repo's .mmdr/icons so teammates get them too
```

## Quick start

```bash
mmdr new docs/architecture.md --title "System overview"   # creates the file with a starter flowchart
mmdr docs/architecture.md                                  # edit it in the browser; changes save as you go
git diff docs/architecture.md                              # review it like any other change
```

Then try the [IT organization example](examples/it-org/README.md): `mmdr examples/it-org/README.md` and ⌘-click a
thick-bordered box to drill from the L1 landscape into an L2.

## Examples

**What a canvas edit writes.** Starting from a hand-written block, drag the nodes around and press <kbd>Tab</kbd> on
`Orders service` to add a cache. mmdr rewrites the block like this:

````markdown
```mermaid
graph LR
    client([Client])
    api[API Gateway]
    svc[Orders service]
    db[(Postgres)]
    redisCache[(Redis cache)]
    client --> api
    api --> svc
    svc --> db
    svc -->|sessions| redisCache
    %% mmdr:layout client:0,0 api:200,0 svc:400,0 db:600,-60 redisCache:600,60
```
````

**An L1 that renders anywhere**, linking down to its L2s. Only classic shapes, a theme and classDefs are used, so this
is GitHub rendering it right here:

```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#EEF2FF"
    primaryBorderColor: "#4F6BED"
    primaryTextColor: "#1E2457"
    lineColor: "#8A93BF"
---
flowchart LR
    customers([Customers]) -->|web · app| commerce[[Commerce platform]]
    commerce -->|orders| fulfilment[[Fulfilment]]
    commerce -.->|events| data[(Data & AI platform)]
    commerce ==>|runs on| runtime[Cloud platform · GCP]
    classDef drill stroke-width:3px
    class commerce,data,runtime drill
    click commerce href "./examples/it-org/l2-digital-products.md" "L2 · Digital products"
    click runtime href "./examples/it-org/l2-cloud-platform.md" "L2 · Cloud platform"
```

**L2 nodes with product icons**: mermaid's own icon syntax, drawn with the packs you installed:

````markdown
```mermaid
flowchart LR
    ingress@{ icon: "logos:nginx", label: "nginx ingress", pos: "b", h: 44 }
    cart@{ icon: "logos:python", label: "Cart API · Python", pos: "b", h: 44 }
    pricing@{ icon: "logos:rust", label: "Pricing engine · Rust", pos: "b", h: 44 }
    orders@{ icon: "logos:postgresql", label: "Orders DB · Cloud SQL", pos: "b", h: 44 }
    ingress --> cart
    cart --> pricing
    cart --> orders
```
````

**Diagram styles** chosen in the inspector (Labs → Diagram styles) become plain mermaid config:

````markdown
```mermaid
---
config:
  theme: base
  themeVariables:
    primaryColor: "#E9F7EF"
    primaryBorderColor: "#2F9E6B"
    lineColor: "#4F8A6E"
  look: handDrawn
  flowchart:
    curve: step
---
flowchart TD
    api[Payments API] --> router{Provider?}
```
````

**Team defaults** for experiments go in `.mmdr/config.json`:

```json
{ "flags": { "themes": true, "smart-guides": true } }
```

**Scripting** from the terminal or CI:

```bash
mmdr ls docs/architecture.md                       # inventory: index, type, line range, title
mmdr cat docs/architecture.md 2 > checkout.mmd     # extract one diagram's source
mmdr new docs/adr/0042.md -t sequence --title "Token refresh"
```

## Reference

<details>
<summary><b>Command line</b></summary>

```
mmdr [PATH]                  open a .md/.mmd file or a directory (default: .)
mmdr ls FILE                 list the diagrams in FILE
mmdr cat FILE [N]            print diagram N's source
mmdr new FILE [-t TYPE] [--title TITLE]
                             append a diagram (flowchart, sequence, class, state, er,
                             architecture, c4, gantt, mindmap); creates FILE if needed
mmdr icons [ls]              list installed icon packs
mmdr icons add PACK[@VER]... [--vendor]
                             install Iconify packs (logos, devicon, simple-icons, mdi, …)
mmdr icons rm PACK... [--vendor]

  -p, --port N               default 7788 (next free port if taken)
      --no-open              don't open a browser
      --app                  open as a chromeless Chrome/Edge/Brave app window
      --enable F1,F2         turn feature flags on (see Labs)
      --disable F1,F2        turn feature flags off
```

Opening a file serves its git repository (or its folder outside git), so the file picker lists every markdown file
in the repo and links between files work. Opening a directory serves that directory.

</details>

<details>
<summary><b>Canvas shortcuts</b></summary>

| Do this | To |
| --- | --- |
| double-click empty space, or drag a shape from the palette | add a node |
| drag a node's ● handle onto another node or group | connect them (drop on empty space to create the next node) |
| <kbd>⌥</kbd>-drag a node | connect from it |
| <kbd>Tab</kbd> on a node (also while typing its label) | add a connected node downstream |
| <kbd>Enter</kbd> / <kbd>F2</kbd>, <kbd>⇧Enter</kbd> | edit the label, new line |
| drag a node onto a group box, or out of it | move it into or out of that subgraph |
| <kbd>⌘G</kbd> / <kbd>⇧⌘G</kbd> | group the selection into a subgraph / ungroup |
| <kbd>⇧</kbd>-drag on empty space | box select |
| <kbd>⌘C</kbd> / <kbd>⌘V</kbd> | copy the selection as mermaid; paste mermaid snippets or images |
| <kbd>⌘</kbd>-click a node, <kbd>⌘[</kbd> | follow its link (drill down), go back |
| <kbd>⌘D</kbd>, arrows (<kbd>⇧</kbd> ×5) | duplicate, nudge |
| scroll / <kbd>space</kbd>-drag, <kbd>⌘</kbd>-scroll or pinch, <kbd>0</kbd> | pan, zoom, fit |
| <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd>, <kbd>⌘S</kbd> | undo / redo, save now |
| <kbd>⌥1</kbd>–<kbd>⌥4</kbd>, <kbd>?</kbd> | Canvas / Split / Preview / Markdown view, shortcut help |

Statements mmdr doesn't model on the canvas (comments, `accTitle`, click callbacks…) are kept verbatim.

</details>

<details>
<summary><b>Labs: features behind flags</b></summary>

Experiments ship behind feature flags so they can be tried and iterated on. Toggle them for yourself under **⚗ Labs**,
set team defaults in `.mmdr/config.json`, or per run with `mmdr --enable themes,smart-guides`.

| Flag | Stage | What it does |
| --- | --- | --- |
| `icons` | beta (on) | Icon packs on the canvas and the icon picker |
| `themes` | experimental | Diagram styles: palettes, hand-drawn look, straight/orthogonal lines, written as mermaid frontmatter `config` |
| `smart-guides` | experimental | Alignment lines and snapping to other nodes while dragging |
| `sticky-notes` | experimental | Yellow notes (a `sticky` classDef) from the palette |

The research behind these, with the roadmap of next flags (shape data, conditional formatting, smart containers,
layers, semantic L1→L2 zoom, cloud import, presentation mode), is in
[docs/research/lucidchart-miro.md](docs/research/lucidchart-miro.md).

</details>

## Things to know

- **Positions are mmdr-only.** Mermaid has no syntax for manual coordinates, so mmdr keeps them in a
  `%% mmdr:layout` comment. GitHub and every other renderer still draw mermaid's automatic layout, which the Preview
  pane shows exactly. Diagrams you never move on the canvas get no layout comment.
- **Canvas edits rewrite the block in canonical form** (declarations, subgraphs, edges, then styles). Edits in the code
  pane are kept exactly as typed.
- **Icon packs and relative image paths don't exist on GitHub.** Icon nodes render there with mermaid's placeholder
  icon, and relative images probably won't resolve. Keep diagrams that must look right everywhere (your L1) to classic
  shapes, as the IT-org example does.

## Develop

Rust (pinned in `rust-toolchain.toml`) and Node ≥ 22 for the JS tests; no other dependencies.

```bash
cargo test                                  # Rust unit tests (fence scanner, icon packs)
npm test                                    # parser / serializer / example round-trip tests (no npm deps)
cargo build --release && tests/smoke.sh     # end-to-end: CLI commands + HTTP API of the real binary
MMDR_WEB=web cargo run -- examples          # serve web/ from disk: edit JS/CSS, reload the page
node scripts/screenshots.mjs                # regenerate the README images with headless Chrome
./scripts/update-mermaid.sh 11.17.2         # re-vendor mermaid
```

CI runs all of the tests (plus `cargo fmt --check`, `clippy -D warnings` and shellcheck) on Linux, macOS and Windows,
and packages and verifies the static Linux binary on every push. Releases are cut by pushing a tag. The pipeline builds,
verifies and attests binaries for five targets and opens a draft release; see [docs/RELEASING.md](docs/RELEASING.md).

`web/model.js` is the heart: markdown block scanning plus a lossless mermaid-flowchart model (parse → edit →
serialize, including frontmatter styles). `web/canvas.js` is the SVG editor, `web/app.js` the glue (outline, code
pane, preview, inspector, autosave, sync, Labs), `web/flags.js` the feature-flag registry and `web/icons.js` the
icon-pack store. `src/main.rs` is the server and CLI, `src/icons.rs` the icon-pack manager.

## License

[MIT](LICENSE) © berttoli. The embedded mermaid bundle is MIT-licensed by the mermaid-js contributors. Icon packs are
downloaded separately under their own licenses (`logos`: CC0-1.0, `devicon`: MIT).
