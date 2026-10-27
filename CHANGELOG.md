# Changelog

## 0.1.0 — 2026-10-26

First public release.

Renamed from mmdr, the name of the v0.1.0-rc.1 and rc.2 pre-releases, because another Rust mermaid tool already
installs an `mmdr` binary. If you tried an rc, move `.mmdr/` to `.mermdraw/` and `~/.config/mmdr` to
`~/.config/mermdraw`, and replace `%% mmdr:layout` with `%% mermdraw:layout` in your diagrams.

- Visual canvas for mermaid flowcharts inside markdown: drag and drop, connect, group into subgraphs, text,
  images, links between diagrams with drill-down/back navigation, copy/paste as mermaid, undo/redo. Diagrams with
  their own mermaid theme sit on a paper card, so the canvas follows the light or dark UI and their text stays readable.
- Mermaid 11.17's architecture shapes (person, browser, console, folder and bucket) drawn the way mermaid does, with
  edges meeting their outlines; they are in the Shape menu, and person and browser in the palette. Collapsed
  subgraphs (`group@{ view: collapsed }`) show as one box with a ••• marker that edges to its contents end at; a View
  toggle in the Group inspector writes the statement, and Auto-layout handles collapsed groups as mermaid does.
- A Miro-style workspace: floating toolbars, a palette centered on the canvas's left edge, outline and inspector panels
  that collapse (`⌘\` and `⌥⌘\`), and a searchable file picker (`⌘P`) that groups files by folder and shows each file's
  title and diagram count. A toolbar over the selection edits line ends, style, a per-line curve (`A e1@--> B` with
  `e1@{ curve: linear }`) and color, node shape and colors, and group direction; double-click edits any label.
- Live code pane and mermaid 12.2.0 preview for every diagram type, the version GitHub renders with (ELK layout and
  the `neo` look by default, which Auto-layout follows too). Autosave into the markdown file with conflict-safe
  merging and live reload when the file changes on disk. Canvas saves are stable from the first save.
- `mermdraw ls`, `mermdraw cat`, `mermdraw new` terminal commands. `new` creates the file and any missing folders, works
  for `.mmd` files, and never overwrites a file it can't read.
- Icon packs: `mermdraw icons add logos devicon` (global cache or `--vendor` into the repo), an icon picker, and icons
  in the preview.
- Feature flags with a Labs panel, `.mermdraw/config.json` and `--enable/--disable`. Experiments: diagram styles
  (palettes, neo / classic / hand-drawn looks, orthogonal lines), smart guides, sticky notes.
- Examples: a full IT organization with an L1 org chart and landscape plus four L2 drill-downs, one of them with a
  hand-arranged canvas layout.
- Pre-built binaries for Linux (static, x86_64 and arm64), macOS (Apple silicon and Intel) and Windows x64, each
  tested on its own OS before release, with SHA-256 checksums and signed build-provenance attestations.
- Docs: a README with screenshots and examples, research notes on Lucidchart and Miro with a feature-flag roadmap, and
  `docs/RELEASING.md` for maintainers.
