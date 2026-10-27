# Changelog

## Unreleased

- **One-line install.** `curl -fsSL https://github.com/berttoli/mermdraw/releases/latest/download/install.sh | sh` on
  macOS and Linux, and `powershell -ExecutionPolicy Bypass -c "irm …/install.ps1 | iex"` on Windows. The installer
  picks the build for the machine, checks it against `SHA256SUMS.txt` (and its attestation when `gh` is logged in),
  installs it into `~/.local/bin` and adds that folder to the PATH. `--version`, `--dir` and `--no-modify-path` (or
  `MERMDRAW_INSTALL_VERSION`, `MERMDRAW_INSTALL_DIR` and `MERMDRAW_NO_MODIFY_PATH=1`) change that. Both scripts are
  published with every release, covered by its checksums and attestation, and tested in CI.
- **Addons.** `mermdraw NAME [ARGS…]` runs `mermdraw-NAME` from `~/.config/mermdraw/addons` (or `$XDG_CONFIG_HOME`)
  or from `PATH`, with every argument passed as given and `MERMDRAW` / `MERMDRAW_VERSION` set; on Unix the addon
  replaces the mermdraw process, so it owns stdin and stdout. Built-in commands come first and paths last, so
  `mermdraw ./NAME` still opens a folder. `mermdraw addons add|ls|rm` installs official addons from
  `github.com/berttoli/mermdraw-NAME` releases (`--version vX.Y.Z` for a tag), checked against the release's
  `SHA256SUMS.txt` and, when `gh` is installed, its build-provenance attestation. The contract is in `docs/ADDONS.md`.
- **JSON commands.** `ls --json`, `cat --json` and `icons search QUERY --json` print JSON with a `mermdraw` version
  field; `--json` errors are JSON on stdout too. `cat --json` reports the file's `version` (the editor's `X-Version`)
  and leaves the `%% mermdraw:layout` comment out of the source, saying in `layout` whether there is one.
- `mermdraw write FILE N` replaces diagram N with the source on stdin, keeps its canvas positions when the input has
  no layout comment, and writes atomically through the same code as the editor. It refuses with exit code 3 when the
  file changed since `--base VERSION` (or since it read the file). `write FILE --append [--title T]` adds a diagram.
- `mermdraw ls` takes a folder (default `.`) and lists the diagrams of every markdown file under it.
- `mermdraw icons search QUERY` finds icons in the installed packs.
- Every JSON output carries `"contract": 1`, the version of the addon contract. Within 0.x the contract only gains
  fields; a breaking change bumps that number. On Windows, addons can be `mermdraw-NAME.exe` or `mermdraw-NAME.cmd`.
- `scripts/release.sh package` names archives after the binary (`mermdraw-TARGET`, `mermdraw-mcp-TARGET`, …), so addon
  repositories use it unchanged. mermdraw's own asset names don't change.
- `SECURITY.md`: what `addons add` verifies, the editor server's local-only guards, and how to report a vulnerability.
- `mermdraw FILE:LINE` (or `FILE:LINE:COL`, as editors pass it) opens the diagram at that line, so an editor task
  can jump to the diagram under the cursor. The README has tasks for VS Code / Cursor / Windsurf, Zed and JetBrains.
- A second `mermdraw` for a folder that a server already serves opens a tab on that server and exits, so one server
  serves the repo; `--new` starts a separate one.
- The editor follows `#d=N` changes in its URL, for a browser that reuses an open tab.
- Command-line fixes: output piped into `head` and the like ends quietly instead of panicking; a non-UTF-8 argument
  gets an error instead of a crash; `new` only writes `.md`/`.mmd` files and keeps a CRLF file's line endings;
  serving a file that isn't markdown is refused up front; `icons rm` exits non-zero when a pack isn't installed or none
  is named; a mistyped command says it isn't one.

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
