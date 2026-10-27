# The addon contract

An addon is a separate program, `mermdraw-NAME`, that `mermdraw NAME` runs. Addons can use any language and any
dependencies, so the core stays one std-only binary. They read and write diagrams only through the core's `--json`
commands, so mermdraw stays the only program that edits markdown, with one fence scanner, one atomic write path and
one conflict check. [mermdraw-mcp](https://github.com/berttoli/mermdraw-mcp) is the reference addon. The contract
first shipped in mermdraw 0.2.0, as `"contract": 1`.

This page is a public API: what it describes is covered by mermdraw's compatibility promise (see
[Stability](#stability) and [RELEASING.md](RELEASING.md#versioning)).

## How `mermdraw NAME` finds an addon

`mermdraw NAME ARGS…` resolves NAME in this order, and the first match wins:

1. **A built-in command**: `ls`, `cat`, `write`, `new`, `icons`, `addons`, `edit`, `open`, `help`. An addon can't
   replace one, and `addons add` refuses those names.
2. **The addons folder**: `$XDG_CONFIG_HOME/mermdraw/addons`, by default `~/.config/mermdraw/addons`
   (`%APPDATA%\mermdraw\addons` on Windows), where `mermdraw addons add` installs.
3. **`PATH`**, folder by folder.
4. **A path to open** in the editor.

Steps 2 and 3 apply only when NAME is made of `a-z`, `0-9` and `-` and doesn't start with `-`. So `mermdraw ./mcp`,
`mermdraw docs/a.md` and `mermdraw a.md:12` are always paths, and a folder named like an addon is opened with `./NAME`.
In each folder, mermdraw looks for:

| Platform | File, in the order tried |
| --- | --- |
| Linux, macOS | `mermdraw-NAME` (a file with an execute bit) |
| Windows | `mermdraw-NAME.exe`, then `mermdraw-NAME.cmd` |

The lookup happens before mermdraw parses any option, so the addon gets every argument after NAME exactly as given,
including `--help`, `--version`, `--json` and arguments that aren't valid UTF-8. NAME itself isn't passed (unlike cargo
subcommands).

### Environment

| Variable | Value |
| --- | --- |
| `MERMDRAW` | the path of the mermdraw binary that started the addon; run the JSON commands with it |
| `MERMDRAW_VERSION` | that binary's version, e.g. `0.2.0` |

Everything else in the environment is passed through. An addon that may also be started directly (`mermdraw-mcp` from
an MCP client's config) should fall back to `mermdraw` on `PATH` when `MERMDRAW` isn't set.

### Process

On Unix, mermdraw replaces itself with the addon (`exec`), so the addon owns the process: stdin, stdout and stderr
(which an MCP server over stdio needs), signals and the exit code. On Windows, mermdraw starts the addon with the same
stdin, stdout and stderr, waits for it, and exits with its exit code.

## Releases: what `addons add` downloads

`mermdraw addons add NAME [--version vX.Y.Z]` installs official addons only, from the GitHub releases of
`berttoli/mermdraw-NAME`: `releases/latest/download/` (the newest stable release), or `releases/download/vX.Y.Z/`
with `--version`. A release needs these assets, named like mermdraw's own (`scripts/release.sh package` makes them;
addon repositories use that script unchanged):

| Asset | Contents |
| --- | --- |
| `mermdraw-NAME-x86_64-unknown-linux-musl.tar.gz` | `mermdraw-NAME-x86_64-unknown-linux-musl/mermdraw-NAME`, plus README.md, LICENSE, CHANGELOG.md |
| `mermdraw-NAME-aarch64-unknown-linux-musl.tar.gz` | likewise |
| `mermdraw-NAME-aarch64-apple-darwin.tar.gz` | likewise |
| `mermdraw-NAME-x86_64-apple-darwin.tar.gz` | likewise |
| `mermdraw-NAME-x86_64-pc-windows-msvc.zip` | `mermdraw-NAME-x86_64-pc-windows-msvc/mermdraw-NAME.exe`, … |
| `SHA256SUMS.txt` | one `HEX  ASSET` line per archive, as `sha256sum mermdraw-NAME-*` prints |

plus a build-provenance attestation for each archive (`actions/attest`).

`addons add` downloads the archive for the platform it runs on, and `SHA256SUMS.txt`, with `curl`. It then:

1. Refuses the archive unless its SHA-256 matches its line in `SHA256SUMS.txt`.
2. Runs `gh attestation verify ARCHIVE -R berttoli/mermdraw-NAME` when `gh` is installed. It refuses the archive if
   `gh` rejects it, and says the check was skipped when `gh` is missing or not logged in.
3. Unpacks it with `tar` and moves `mermdraw-NAME[.exe]` into the addons folder, replacing an older copy.

Nothing is installed when a step fails. `addons rm NAME` deletes only what is in the addons folder, never a
`mermdraw-NAME` elsewhere on `PATH`.

`MERMDRAW_ADDONS_URL` replaces `https://github.com/berttoli` in the download URLs, so a test or a mirror can serve
the same layout, `file://` included:

```bash
MERMDRAW_ADDONS_URL=file:///tmp/releases mermdraw addons add mcp
# reads /tmp/releases/mermdraw-mcp/releases/latest/download/{mermdraw-mcp-TARGET.tar.gz,SHA256SUMS.txt}
```

The attestation is still checked against `berttoli/mermdraw-NAME`, wherever the archive came from.

## The JSON commands

Run `$MERMDRAW COMMAND … --json` and read one JSON object, on one line, from stdout. Every object starts with:

| Field | Meaning |
| --- | --- |
| `mermdraw` | mermdraw's version, e.g. `"0.2.0"` |
| `contract` | the version of this contract, an integer: `1`. Check it (see [Stability](#stability)) |

A failed command prints an error object instead, still on stdout, and exits non-zero:

```json
{"mermdraw":"0.2.0","contract":1,"error":{"code":"conflict","message":"docs/shop.md changed since version …","version":"1793076496415697402-135"}}
```

| Exit code | `error.code` | Meaning |
| --- | --- | --- |
| 0 | (no error) | done |
| 1 | `error` | anything else: no such file or diagram, bad arguments, an I/O error. `message` says what, for a person |
| 3 | `conflict` | `write` refused: the file changed since `--base`. `error.version` is the file's version now |

A mermdraw older than 0.2 has no `--json`: it exits 1 with `unknown option --json` on stderr and nothing on stdout.

Conventions: diagrams are numbered from 1 in file order; lines are 1-based; `null` means absent. A `version` is opaque:
compare versions for equality only. It is the value the editor's HTTP API sends as `X-Version`, so writes from addons
and from the editor check each other.

### `mermdraw ls [FILE|DIR] --json`

A file's diagrams, or those of every markdown file under a folder (default `.`) that has at least one; hidden folders,
`node_modules`, `target` and other build folders are skipped.

```json
{"mermdraw":"0.2.0","contract":1,"files":[{"file":"docs/shop.md","version":"1793076496405403096-116","title":"Shop",
  "diagrams":[{"index":1,"kind":"flowchart","title":"Checkout","start_line":5,"end_line":9,"layout":true}]}]}
```

| Field | Meaning |
| --- | --- |
| `files[].file` | the path, starting with the path given (relative paths stay relative) |
| `files[].version` | the file's version |
| `files[].title` | the file's first `# ` heading (a `.mmd` file: its diagram's title), or `null` |
| `files[].diagrams[].index` | 1-based number of the diagram in the file |
| `files[].diagrams[].kind` | the diagram's first keyword: `flowchart`, `graph`, `sequenceDiagram`, `architecture-beta`, … |
| `files[].diagrams[].title` | the diagram's frontmatter `title:`, else the nearest heading above it, else `null` |
| `files[].diagrams[].start_line`, `end_line` | the lines of its opening and closing fences; `mermdraw FILE:START_LINE` opens it |
| `files[].diagrams[].layout` | whether it has canvas positions (a `%% mermdraw:layout` comment) |

### `mermdraw cat FILE [N] --json`

Diagram N (default 1): the fields of an `ls` diagram, plus:

```json
{"mermdraw":"0.2.0","contract":1,"file":"docs/shop.md","version":"1793076496405403096-116","index":1,"kind":"flowchart",
  "title":"Checkout","start_line":5,"end_line":9,"layout":true,"source":"flowchart LR\n    web[Web] --> api[API]"}
```

| Field | Meaning |
| --- | --- |
| `file`, `version` | as in `ls`; pass `version` back to `write --base` |
| `source` | the diagram without its fences and without the `%% mermdraw:layout …` comment, dedented if the fence is indented |

### `mermdraw write FILE N --base VERSION --json < SOURCE`

Replaces diagram N with the source on stdin: UTF-8, without fences. The rest of the file is kept byte for byte, and the
new lines follow the file's line endings and the fence's indentation.

```json
{"mermdraw":"0.2.0","contract":1,"file":"docs/shop.md","index":1,"version":"1793076496415697402-135","layout":"kept","created":false}
```

| Field | Meaning |
| --- | --- |
| `file`, `index` | the diagram written |
| `version` | the file's new version, for the next write |
| `layout` | `kept`: the input had no layout comment and the diagram's was carried over; `input`: the input brought its own; `none`: neither had one |
| `created` | whether the file was created (only with `--append`) |

Send sources the way `cat --json` gives them, and canvas positions survive. The write is refused with exit code 3 and
`conflict` when the file's version isn't `--base`. Without `--base`, it is refused when the file changed while `write`
was running. A source with a line that would close the code fence, or an empty source, is refused with exit code 1.

### `mermdraw write FILE --append [--title TITLE] --json < SOURCE`

Appends a diagram, under a `## TITLE` heading when given, and creates FILE (and its folders) if it doesn't exist.
The output is `write`'s, with the new diagram's `index` and `created: true` for a new file. `--base` works here too.

### `mermdraw icons search QUERY [--limit N] --json`

```json
{"mermdraw":"0.2.0","contract":1,"query":"postgres","packs":[{"name":"logos","source":"project"}],
  "icons":[{"icon":"logos:postgresql","pack":"logos","name":"postgresql","source":"project"}],"total":2}
```

| Field | Meaning |
| --- | --- |
| `packs[]` | the installed packs: `name`, and `source`: `project` (the repository's `.mermdraw/icons`) or `global` (`~/.config/mermdraw/icons`) |
| `icons[]` | matches, best first (the exact name, then names starting with the query, then shorter names), at most `--limit` (default 50): `icon` (`pack:name`, what a diagram uses), `pack`, `name`, `source` |
| `total` | how many icons matched in all |

An icon matches when its `pack:name` contains every word of QUERY. Use it in a flowchart as
`db@{ icon: "logos:postgresql", label: "Orders DB" }`, or in an architecture diagram as
`service db(logos:postgresql)[Orders DB]`.

### Opening the editor

Not a JSON command, but part of the contract: `mermdraw FILE:LINE [--no-open]` opens the diagram at LINE. When a
server already serves FILE's repository, it prints `… already running for ROOT`, then `  → URL`, and exits.
Otherwise it starts one, prints `… root ROOT`, then `  → URL   (Ctrl+C to quit)`, and keeps running, so start it in
the background and read its second line. `--no-open` prints the URL without opening a browser.

## Stability

Within 0.x, the contract only grows:

- New commands, options and output fields may be added in any release. Addons must ignore fields they don't know.
- Existing fields, exit codes, error codes and the lookup rules above are not renamed, removed or given another
  meaning.
- A change that would break that bumps `contract` (to 2, and so on) and is called out in the changelog.

An addon checks `contract` on every response, alongside `mermdraw`: it refuses to go on when the number is not one it
supports, and tells the user which side to update. `mermdraw` alone says which release it is, not what it promises.
