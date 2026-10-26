# mmdr

A tiny, local, drag-and-drop editor for the mermaid diagrams that live inside your markdown.

```bash
mmdr docs/architecture.md
```

opens a browser tab where every ```` ```mermaid ```` block in the file is listed in an outline. Flowcharts get a
visual canvas (drag, connect, group, drop images, add text, link to other diagrams); every diagram type gets a live
code editor and a real mermaid preview. Each change is written straight back into the markdown block, so your
architecture lives in the repo and changes show up as normal, reviewable diffs.

- **One 1.6 MB binary, zero dependencies.** std-only Rust: HTTP server, file watcher and CLI. The UI and a gzipped
  mermaid 11.17.2 are embedded, so it works offline and starts instantly.
- **Markdown stays the source of truth.** Only the selected block is rewritten; prose, other blocks, line endings and
  indentation are untouched. Edit the file in vim/VS Code at the same time — mmdr reloads on change, and if both sides
  edited, it re-applies your diagram on top of the newer file instead of clobbering it.
- **Clean mermaid out.** Readable ids derived from labels (`Auth Service` → `authService`), one statement per line,
  stable ordering — so diffs are small and the output works anywhere mermaid does (GitHub, GitLab, Obsidian, docs sites).

## Install

```bash
cargo install --path .
```

or `cargo build --release` and put `target/release/mmdr` on your `PATH`.

## Use

```
mmdr [PATH]                  open a .md/.mmd file or a directory (default: .)
mmdr ls FILE                 list the diagrams in FILE
mmdr cat FILE [N]            print diagram N's source
mmdr new FILE [-t TYPE] [--title TITLE]
                             append a diagram (flowchart, sequence, class, state, er,
                             architecture, c4, gantt, mindmap); creates FILE if needed

  -p, --port N               default 7788 (next free port if taken)
      --no-open              don't open a browser
      --app                  open as a chromeless Chrome/Edge/Brave app window
```

Opening a file serves its git repository (or its folder outside git), so the file picker lists every markdown file in the repo and links between
files work. Opening a directory serves that directory.

### On the canvas (flowcharts)

| Do this | To |
| --- | --- |
| double-click empty space, or drag a shape from the palette | add a node |
| drag a node's ● handle onto another node / group | connect them (drop on empty space to create the next node) |
| <kbd>Tab</kbd> on a node (also while typing its label) | add a connected node downstream — fast keyboard entry |
| drag a node onto a group box / out of it | move it into / out of that subgraph |
| <kbd>⌘G</kbd> / <kbd>⇧⌘G</kbd> | group the selection into a subgraph / ungroup |
| palette **T** | free text on the canvas (mermaid `text` shape) |
| drop or paste an image | uploads it to `assets/` next to the markdown file and adds an `img` node |
| set **Link** in the inspector, <kbd>⌘</kbd>-click the node | `click … href`; `./other.md#2` opens diagram 2 of that file in mmdr |
| <kbd>⌘C</kbd> / <kbd>⌘V</kbd> | copy the selection as mermaid; paste mermaid snippets or images |
| <kbd>⌘Z</kbd> <kbd>⇧⌘Z</kbd>, <kbd>⌘D</kbd>, arrows, <kbd>0</kbd> | undo/redo, duplicate, nudge, fit |

The inspector edits ids, labels, all 38 mermaid 11 shapes, image/icon options, edge style (solid/thick/dotted/hidden,
arrowheads, length, label), group direction, colours (`style` / `linkStyle`) and classes. Statements mmdr doesn't model
(`classDef`, comments, `accTitle`, callbacks …) are kept verbatim.

Sequence, class, state, ER, C4, architecture-beta and the rest are edited as code with a live preview.

## Things to know

- **Positions are mmdr-only.** Mermaid has no syntax for manual coordinates, so mmdr stores them in a comment at the end
  of the block — `%% mmdr:layout api:120,40 db:300,40` — which mermaid ignores. GitHub (and anything else) still renders
  mermaid's automatic layout; the Preview pane shows exactly that. **Auto-layout** in the inspector snaps the canvas to
  mermaid's layout. Diagrams you never moved on the canvas get no layout comment.
- **Editing on the canvas rewrites the block in canonical form** (node declarations, then subgraphs, then edges, then
  styles). Edits in the code pane are kept exactly as typed.
- **Relative image paths** (`assets/x.png`) render in mmdr; GitHub renders mermaid in a sandboxed frame and probably
  won't resolve them, so use absolute URLs for images that must show up there.
- The server binds to `127.0.0.1` only, rejects requests for other hosts (DNS rebinding), never leaves the opened root,
  and writes files atomically.

## Develop

```bash
node --test tests/              # parser/serializer/markdown tests
cargo test                      # CLI fence scanner tests
MMDR_WEB=web cargo run -- examples/architecture.md   # serve web/ from disk: edit JS/CSS, reload
./scripts/update-mermaid.sh 11.17.2                  # re-vendor mermaid
```

`web/model.js` is the heart: markdown block scanning plus a lossless mermaid-flowchart model (parse → edit →
serialize). `web/canvas.js` is the SVG editor, `web/app.js` the glue (outline, code pane, preview, inspector, autosave,
sync), `src/main.rs` the server/CLI.
