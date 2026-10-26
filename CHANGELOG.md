# Changelog

## Unreleased

- README: generated header, screenshots, feature tour and code examples; `scripts/screenshots.mjs` regenerates
  the images with headless Chrome.
- Themed diagrams render on a matching paper on the canvas, so their text stays readable in either UI theme.
- Canvas saves are stable from the first save when top-level nodes are declared after subgraphs.
- The IT-org digital-products L2 ships with a hand-arranged canvas layout.
- CI: the JS tests run on Node 22 and 24 (`node --test tests/*.test.mjs`).
- Release pipeline: static (musl) Linux binaries for x86_64 and arm64; the full CI runs on the tagged commit;
  the tag is checked against `Cargo.toml`, `Cargo.lock` and this changelog; every archive is smoke-tested on its own
  OS; checksums and signed build-provenance attestations; draft releases (pre-releases for `-rc` tags) and
  version-free asset names. Manual runs are dry runs.
- `scripts/release.sh` runs the release steps locally; `docs/RELEASING.md` is the runbook.
- CI packages and verifies the static Linux binary on every push, lints the shell scripts, and pins actions to commit
  SHAs (bumped weekly by Dependabot).

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
