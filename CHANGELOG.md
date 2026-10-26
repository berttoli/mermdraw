# Changelog

## 0.1.0 — 2026-10-26

First public release.

- Visual canvas for mermaid flowcharts inside markdown: drag and drop, connect, group into subgraphs, text,
  images, links between diagrams with drill-down/back navigation, copy/paste as mermaid, undo/redo.
- Live code pane and mermaid 11.17.2 preview for every diagram type; autosave into the markdown file with
  conflict-safe merging and live reload when the file changes on disk.
- `mmdr ls`, `mmdr cat`, `mmdr new` terminal commands.
- Icon packs: `mmdr icons add logos devicon` (global cache or `--vendor` into the repo), an icon picker, and icons in
  the preview.
- Feature flags with a Labs panel, `.mmdr/config.json` and `--enable/--disable`. Experiments: diagram styles
  (palettes, hand-drawn look, orthogonal lines), smart guides, sticky notes.
- Examples: a full IT organization with L1 org chart and landscape plus four L2 drill-downs.
- Research notes on Lucidchart and Miro with a feature-flag roadmap.
