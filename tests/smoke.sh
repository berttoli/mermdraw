#!/usr/bin/env bash
# End-to-end smoke test of a built mermdraw binary: terminal commands and the HTTP API.
# usage: tests/smoke.sh [path/to/mermdraw]      (default: target/release/mermdraw)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_ARG="${1:-$ROOT/target/release/mermdraw}"
BIN="$(cd "$(dirname "$BIN_ARG")" && pwd)/$(basename "$BIN_ARG")"
PORT="${MERMDRAW_SMOKE_PORT:-7899}"
U="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
export XDG_CONFIG_HOME="$WORK/config" # never touch the real icon cache
PIDS=()

cleanup() {
  for p in "${PIDS[@]:-}"; do
    [[ -n "$p" ]] || continue
    kill "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT
fail() {
  echo "FAIL: $*" >&2
  [[ -f "$WORK/server.log" ]] && sed 's/^/  server: /' "$WORK/server.log" >&2
  exit 1
}
pass() { echo "ok   $*"; }
jfield() { # NAME JSON -> the value of the last string member NAME
  sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' <<<"$2"
}
code_of() { # COMMAND... -> its exit code, without tripping set -e
  local c=0
  "$@" >/dev/null 2>&1 || c=$?
  echo "$c"
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
withbin() { PATH="$WORK/bin:$PATH" "$@"; } # with the fake addons on PATH
stand_in() { # SCRIPT...: make stand-in addons runnable; Windows only runs mermdraw-NAME.exe or .cmd, so wrap them there
  local f
  for f in "$@"; do
    chmod +x "$f"
    case "$(uname -s)" in
      MINGW* | MSYS* | CYGWIN*) printf '@"%s" "%s" %%*\r\n' "$(cygpath -w "$(command -v sh)")" "$(cygpath -w "$f")" >"$f.cmd" ;;
    esac
  done
}
expect() { # DESC ACTUAL SUBSTRING
  [[ "$2" == *"$3"* ]] || fail "$1: expected '$3' in: ${2:0:400}"
  pass "$1"
}
status() { # METHOD URL [curl args...] -> HTTP status code
  local method="$1" url="$2"
  shift 2
  curl -s -o /dev/null -w '%{http_code}' -X "$method" "$@" "$url"
}

[[ -x "$BIN" ]] || fail "no executable at $BIN (build with: cargo build --release)"
cp -R "$ROOT/examples" "$WORK/docs"

# ---------------------------------------------------------------- terminal commands
expect "--version" "$("$BIN" --version)" "mermdraw "
expect "ls lists diagrams" "$("$BIN" ls "$WORK/docs/architecture.md")" "3 diagrams"
expect "cat prints a block" "$("$BIN" cat "$WORK/docs/architecture.md" 2)" "sequenceDiagram"
"$BIN" new "$WORK/docs/new.md" -t er --title "Data model" >/dev/null
expect "new creates a file with a diagram" "$("$BIN" ls "$WORK/docs/new.md")" "erDiagram"
expect "new creates missing folders" "$("$BIN" new "$WORK/fresh/docs/architecture.md" --title Overview)" "created"
expect "the new file lists its diagram" "$("$BIN" ls "$WORK/fresh/docs/architecture.md")" "Overview"
expect "new creates .mmd files" "$("$BIN" new "$WORK/fresh/flows/login.mmd" -t sequence)" "created"
if "$BIN" new "$WORK/fresh/flows/login.mmd" >/dev/null 2>&1; then fail "a second diagram was added to a .mmd file"; fi
pass "new refuses a second diagram in a .mmd file"
printf '# notes\n\377\376\n' >"$WORK/binary.md"
cp "$WORK/binary.md" "$WORK/binary.expected"
if "$BIN" new "$WORK/binary.md" >/dev/null 2>&1; then fail "new wrote into a file it could not read as text"; fi
cmp -s "$WORK/binary.md" "$WORK/binary.expected" || fail "new modified a file it could not read"
pass "new leaves unreadable files untouched"
if "$BIN" new "$WORK/notes.txt" >/dev/null 2>&1 || [[ -e "$WORK/notes.txt" ]]; then fail "new wrote a non-markdown file"; fi
pass "new refuses non-markdown files"
printf '# CRLF\r\n\r\nText.\r\n' >"$WORK/crlf.md"
"$BIN" new "$WORK/crlf.md" --title Added >/dev/null
[[ "$(wc -l <"$WORK/crlf.md")" -eq "$(grep -c $'\r$' "$WORK/crlf.md")" ]] || fail "new mixed LF lines into a CRLF file"
pass "new keeps a CRLF file's line endings"
expect "refuses to serve a non-markdown file" "$("$BIN" "$ROOT/Cargo.toml" --no-open --port "$PORT" 2>&1 || true)" "is not a markdown"
expect "says when a word is not a command" "$("$BIN" lsx 2>&1 || true)" "not a command"
expect "rejects non-UTF-8 arguments cleanly" "$("$BIN" ls "$WORK/$(printf 'bad\377').md" 2>&1 || true)" "not valid UTF-8"
{
  printf '# Big\n\n\140\140\140mermaid\nflowchart TD\n' # \140 is a backtick
  seq 1 60000 | awk '{ print "    n" $1 " --> n" $1 + 1 }'
  printf '\140\140\140\n'
} >"$WORK/big.md"
"$BIN" cat "$WORK/big.md" 2>"$WORK/pipe.err" | head -1 >/dev/null || true
[[ ! -s "$WORK/pipe.err" ]] || fail "cat into a closed pipe: $(head -c 200 "$WORK/pipe.err")"
pass "stops quietly when its output pipe closes early"
expect "icons ls with an empty cache" "$("$BIN" icons ls)" "no icon packs installed"
mkdir -p "$WORK/docs/.mermdraw/icons"
printf '{"prefix":"demo","icons":{"dot":{"body":"<circle r=\\"4\\"/>"}}}' >"$WORK/docs/.mermdraw/icons/demo.json"
printf '{"flags":{"sticky-notes":true}}' >"$WORK/docs/.mermdraw/config.json"
expect "icons ls finds vendored packs" "$(cd "$WORK/docs" && "$BIN" icons ls)" "project"
if "$BIN" icons add ../escape >/dev/null 2>&1; then fail "icons add accepted a path"; fi
pass "icons add rejects bad pack names"
expect "icons rm without a name shows usage" "$("$BIN" icons rm 2>&1 || true)" "usage: mermdraw icons rm"
if "$BIN" icons rm nothere >/dev/null 2>&1; then fail "icons rm of a pack that isn't installed exited 0"; fi
pass "icons rm fails for a pack that isn't installed"
expect "icons search finds icons in vendored packs" "$(cd "$WORK/docs" && "$BIN" icons search dot --json)" '"icon":"demo:dot","pack":"demo","name":"dot","source":"project"'
expect "icons search says when nothing matches" "$(cd "$WORK/docs" && "$BIN" icons search kafka)" "no icons match"

# ---------------------------------------------------------------- JSON commands (what addons build on)
F="$WORK/docs/it-org/l2-digital-products.md" # its diagram has a canvas layout
json="$("$BIN" ls --json "$F")"
expect "ls --json carries mermdraw's version" "$json" "\"mermdraw\":\"$("$BIN" --version | cut -d' ' -f2)\""
expect "ls --json carries the addon contract" "$json" '"contract":1,'
expect "ls --json lists diagrams with their lines" "$json" '"index":1,"kind":"flowchart","title":"L2 · Digital products","start_line":7,"end_line":69,"layout":true'
expect "ls --json walks a folder" "$("$BIN" ls --json "$WORK/docs")" "\"file\":\"$WORK/docs/it-org/README.md\""
expect "ls walks a folder" "$(cd "$WORK/docs" && "$BIN" ls)" "it-org/l2-data-ai.md — 1 diagram"
json="$("$BIN" cat --json "$F")"
expect "cat --json says the diagram has a layout comment" "$json" '"layout":true'
expect "cat --json prints the source" "$json" '"source":"---\nconfig:'
[[ "$json" != *"mermdraw:layout"* ]] || fail "cat --json printed the layout comment"
pass "cat --json leaves the layout comment out of the source"
ver="$(jfield version "$json")"
[[ -n "$ver" ]] || fail "cat --json has no version: $json"
cp "$F" "$WORK/before.md"
out="$(printf 'flowchart LR\n    shopper([Shopper]) --> cdn[CDN]\n' | "$BIN" write "$F" 1 --base "$ver" --json)"
expect "write --json reports the diagram" "$out" '"index":1,"version":"'
expect "write says it kept the layout" "$out" '"layout":"kept"'
expect "write replaces the diagram" "$("$BIN" cat "$F")" "shopper([Shopper]) --> cdn[CDN]"
expect "write keeps the canvas positions" "$("$BIN" cat "$F")" "    %% mermdraw:layout shopper:0,0 stripe:1100,260"
end="$("$BIN" ls --json "$F" | sed -n 's/.*"end_line":\([0-9]*\).*/\1/p')"
[[ "$(head -7 "$F")" == "$(head -7 "$WORK/before.md")" && "$(tail -n +"$end" "$F")" == "$(tail -n +69 "$WORK/before.md")" ]] ||
  fail "write changed the file outside the diagram"
pass "write leaves the rest of the file alone"
cp "$F" "$WORK/before.md"
out="$(printf 'flowchart LR\n  x --> y\n' | "$BIN" write "$F" 1 --base "$ver" --json || echo "exit=$?")"
expect "write refuses a stale version" "$out" '"error":{"code":"conflict"'
expect "write exits 3 on a conflict" "$out" "exit=3"
expect "the conflict carries the current version" "$out" "\"version\":\"$(jfield version "$("$BIN" cat --json "$F")")\""
cmp -s "$F" "$WORK/before.md" || fail "a stale write changed the file"
pass "a refused write leaves the file alone"
[[ "$(printf 'graph TD\n  x --> y\n' | code_of "$BIN" write "$F" 1 --base stale)" == 3 ]] || fail "plain write exit code on a conflict"
pass "write exits 3 on a conflict without --json too"
out="$(printf 'flowchart LR\n  a --> b\n  %%%% mermdraw:layout a:1,2 b:3,4\n' | "$BIN" write "$F" 1 --json)"
expect "a layout comment in the input replaces the old one" "$out" '"layout":"input"'
[[ "$(grep -c "mermdraw:layout" "$F")" == 1 ]] || fail "write left two layout comments"
expect "only the new layout is left" "$("$BIN" cat "$F")" "%% mermdraw:layout a:1,2 b:3,4"
cp "$F" "$WORK/before.md"
[[ "$(printf 'graph TD\n```\n' | code_of "$BIN" write "$F" 1)" == 1 ]] || fail "write accepted a source that closes the code fence"
cmp -s "$F" "$WORK/before.md" || fail "write let the input close the code fence"
pass "write refuses a source that would close the code fence"
[[ "$(code_of "$BIN" write "$F" 1 </dev/null)" == 1 ]] || fail "write with an empty stdin"
pass "write refuses an empty source"
expect "write errors are JSON with --json" "$("$BIN" write "$F" 9 --json <<<"graph TD" || true)" '"error":{"code":"error","message":"'
expect "JSON errors carry the addon contract" "$("$BIN" cat --json "$WORK/nothere.md" || true)" '"contract":1,"error":'
A="$WORK/docs/adr/0001.md"
out="$(printf 'sequenceDiagram\n  A->>B: hi\n' | "$BIN" write "$A" --append --title "Token refresh" --json)"
expect "write --append creates the file" "$out" '"index":1,"version":"'
expect "write --append says it created the file" "$out" '"created":true'
expect "write --append adds a diagram" "$(printf 'graph TD\n  a --> b\n' | "$BIN" write "$A" --append --title Second --json)" '"index":2'
expect "the appended diagrams are listed with their titles" "$("$BIN" ls "$A")" "2  graph              L12-15     Second"

# ---------------------------------------------------------------- addons: mermdraw NAME runs mermdraw-NAME
mkdir -p "$WORK/bin"
cat >"$WORK/bin/mermdraw-hello" <<'EOF'
#!/bin/sh
printf 'hello from PATH:'
for a in "$@"; do printf ' [%s]' "$a"; done
printf '\nMERMDRAW=%s\nMERMDRAW_VERSION=%s\n' "$MERMDRAW" "$MERMDRAW_VERSION"
if [ "${1:-}" = --stdin ]; then cat; fi
exit "${HELLO_EXIT:-0}"
EOF
printf '#!/bin/sh\necho "the ls addon"\n' >"$WORK/bin/mermdraw-ls"
printf '#!/bin/sh\necho "the docs addon"\n' >"$WORK/bin/mermdraw-docs"
stand_in "$WORK/bin/mermdraw-hello" "$WORK/bin/mermdraw-ls" "$WORK/bin/mermdraw-docs"
out="$(withbin "$BIN" hello --port nope -x "a b" '' --help --version --json)"
expect "an addon gets every argument untouched" "$out" "hello from PATH: [--port] [nope] [-x] [a b] [] [--help] [--version] [--json]"
expect "an addon learns mermdraw's version" "$out" "MERMDRAW_VERSION=$("$BIN" --version | cut -d' ' -f2)"
expect "an addon learns where mermdraw is" "$("$(sed -n 's/^MERMDRAW=//p' <<<"$out")" --version)" "mermdraw "
expect "an addon gets non-UTF-8 arguments as they are" "$(withbin "$BIN" hello "$(printf 'bad\377')")" "[$(printf 'bad\377')]"
expect "an addon reads mermdraw's stdin" "$(echo ping | withbin "$BIN" hello --stdin)" "ping"
[[ "$(HELLO_EXIT=7 code_of withbin "$BIN" hello)" == 7 ]] || fail "the addon's exit code did not pass through"
pass "an addon's exit code is mermdraw's"
expect "built-in commands win over addons" "$(withbin "$BIN" ls "$WORK/docs/architecture.md")" "3 diagrams"
mkdir -p "$XDG_CONFIG_HOME/mermdraw/addons"
printf '#!/bin/sh\necho "hello from the addons folder"\n' >"$XDG_CONFIG_HOME/mermdraw/addons/mermdraw-hello"
stand_in "$XDG_CONFIG_HOME/mermdraw/addons/mermdraw-hello"
expect "the addons folder wins over PATH" "$(withbin "$BIN" hello)" "hello from the addons folder"
rm -f "$XDG_CONFIG_HOME/mermdraw/addons/mermdraw-hello" "$XDG_CONFIG_HOME/mermdraw/addons/mermdraw-hello.cmd"
expect "addons ls lists addons on PATH" "$(withbin "$BIN" addons ls)" "PATH"
expect "an unknown word is still not a command" "$(withbin "$BIN" nothere 2>&1 || true)" "not a command"

# ---------------------------------------------------------------- addons add / ls / rm from a fake release
REL="$WORK/releases"
fake_release() { # NAME TAG|latest SCRIPT-BODY: what github.com/berttoli/mermdraw-NAME/releases would serve
  local name="$1" dir="$REL/mermdraw-$1/releases/download/$2" stage="$WORK/stage" t
  [[ "$2" == latest ]] && dir="$REL/mermdraw-$name/releases/latest/download"
  mkdir -p "$dir"
  for t in aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
    rm -rf "$stage" && mkdir -p "$stage/mermdraw-$name-$t"
    printf '#!/bin/sh\n%s\n' "$3" >"$stage/mermdraw-$name-$t/mermdraw-$name"
    chmod +x "$stage/mermdraw-$name-$t/mermdraw-$name"
    cp "$ROOT/LICENSE" "$stage/mermdraw-$name-$t/"
    tar -C "$stage" -czf "$dir/mermdraw-$name-$t.tar.gz" "mermdraw-$name-$t"
  done
  (cd "$dir" && sha256 mermdraw-* >SHA256SUMS.txt)
}
fake_release hello latest 'echo "hello 0.2.0 from a release"'
fake_release hello v0.1.0 'echo "hello 0.1.0 from a release"'
fake_release broken latest 'echo broken'
for f in "$REL"/mermdraw-broken/releases/latest/download/*.tar.gz; do printf 'tampered' >>"$f"; done
export MERMDRAW_ADDONS_URL="file://$REL"
# PATH without gh: just the tools addons add needs (tar may call gzip)
mkdir -p "$WORK/nogh" "$WORK/gh"
for t in curl tar gzip; do p="$(command -v "$t")" && ln -s "$p" "$WORK/nogh/$t"; done
cat >"$WORK/gh/gh" <<'EOF'
#!/bin/sh
echo "$@" >>"$GH_LOG"
exit "${GH_EXIT:-0}"
EOF
chmod +x "$WORK/gh/gh"
export GH_LOG="$WORK/gh.log"
ADDONS="$XDG_CONFIG_HOME/mermdraw/addons"

out="$(PATH="$WORK/nogh" "$BIN" addons add hello)"
expect "addons add installs the latest release" "$out" "installed hello → $ADDONS/mermdraw-hello"
expect "addons add downloads the asset for this platform" "$out" "from         file://$REL/mermdraw-hello/releases/latest/download/mermdraw-hello-"
expect "addons add checks SHA256SUMS.txt" "$out" "matches SHA256SUMS.txt"
expect "addons add says when the attestation was not checked" "$out" "not checked: gh is not installed"
expect "an installed addon runs as a mermdraw command" "$(withbin "$BIN" hello)" "hello 0.2.0 from a release"
expect "addons ls lists it" "$("$BIN" addons ls)" "hello"
expect "addons ls says where it came from" "$("$BIN" addons ls)" "addons  $ADDONS/mermdraw-hello"
out="$(PATH="$WORK/gh:$WORK/nogh" "$BIN" addons add hello --version v0.1.0)"
expect "addons add --version installs that release" "$("$BIN" hello)" "hello 0.1.0 from a release"
expect "addons add verifies the attestation when gh is installed" "$out" "verified with gh"
expect "gh verifies the archive against the addon's repository" "$(cat "$GH_LOG")" "attestation verify $ADDONS/.mermdraw-hello.download/mermdraw-hello-"
expect "gh is given the addon's repository" "$(cat "$GH_LOG")" "-R berttoli/mermdraw-hello"
out="$(GH_EXIT=1 PATH="$WORK/gh:$WORK/nogh" "$BIN" addons add hello 2>&1 || echo "exit=$?")"
expect "a rejected attestation stops the install" "$out" "gh attestation verify rejected"
expect "a rejected install exits 1" "$out" "exit=1"
expect "a rejected install keeps the installed version" "$("$BIN" hello)" "hello 0.1.0 from a release"
expect "a gh that is not logged in is a skipped check" "$(GH_EXIT=4 PATH="$WORK/gh:$WORK/nogh" "$BIN" addons add hello)" "not checked: gh is not logged in"
out="$(PATH="$WORK/nogh" "$BIN" addons add broken 2>&1 || echo "exit=$?")"
expect "addons add refuses an archive that does not match SHA256SUMS.txt" "$out" "checksum mismatch for mermdraw-broken-"
expect "a checksum mismatch exits 1" "$out" "exit=1"
[[ ! -e "$ADDONS/mermdraw-broken" ]] || fail "a tampered archive was installed"
pass "a tampered archive is not installed"
expect "addons add says when there is no release" "$(PATH="$WORK/nogh" "$BIN" addons add nothere 2>&1 || true)" "is there a release of berttoli/mermdraw-nothere"
[[ -z "$(find "$ADDONS" -name '.mermdraw-*')" ]] || fail "addons add left download folders behind: $(ls -a "$ADDONS")"
pass "addons add cleans up its downloads"
for bad in ../x Hello ls 'a b'; do
  [[ "$(code_of "$BIN" addons add "$bad")" == 1 ]] || fail "addons add accepted '$bad'"
done
pass "addons add only takes official addon names"
expect "addons add only takes release tags" "$("$BIN" addons add hello --version 'v1;rm' 2>&1 || true)" "is not a release tag"
expect "addons rm removes an addon" "$("$BIN" addons rm hello)" "removed $ADDONS/mermdraw-hello"
expect "the PATH addon runs again once it is removed" "$(withbin "$BIN" hello)" "hello from PATH"
expect "addons rm does not touch addons on PATH" "$(withbin "$BIN" addons rm hello 2>&1 || true)" "was not installed by mermdraw"
[[ "$(code_of "$BIN" addons rm hello)" == 1 ]] || fail "addons rm of an addon that isn't installed exited 0"
pass "addons rm fails for an addon that isn't installed"
unset MERMDRAW_ADDONS_URL

# ---------------------------------------------------------------- server
"$BIN" "$WORK/docs" --no-open --port "$PORT" --enable themes --disable icons >"$WORK/server.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 100); do
  curl -fs "$U/api/info" >/dev/null 2>&1 && break
  sleep 0.1
done

expect "serves the editor" "$(curl -fs "$U/")" "<title>mermdraw</title>"
for a in app.js model.js canvas.js flags.js icons.js app.css; do
  [[ "$(status GET "$U/$a")" == 200 ]] || fail "asset /$a"
done
pass "serves every web module"
expect "serves mermaid gzipped" "$(curl -s -D - -o /dev/null "$U/vendor/mermaid.min.js" | tr -d '\r')" "Content-Encoding: gzip"
expect "passes command-line flags" "$(curl -fs "$U/api/info")" '"flags":{"themes":true,"icons":false}'
expect "serves project config" "$(curl -fs "$U/api/config")" '"sticky-notes":true'
expect "lists markdown files" "$(curl -fs "$U/api/files")" '"path":"architecture.md","diagrams":3,"title":"Shop Platform Architecture"'
expect "lists icon packs" "$(curl -fs "$U/api/icons")" '"name":"demo","source":"project"'
expect "serves an icon pack" "$(curl -fs "$U/api/icons/demo.json")" '"prefix":"demo"'
[[ "$(status GET "$U/api/icons/nope.json")" == 404 ]] || fail "missing pack should 404"
pass "missing icon pack is a 404"

# FILE:LINE, and a second `mermdraw` for the same folder reusing this server instead of starting one
line="$("$BIN" ls "$WORK/docs/architecture.md" | awk '$1 == 2 { split($3, r, /[L-]/); print r[2] + 1 }')"
[[ -n "$line" ]] || fail "no line range for diagram 2 in mermdraw ls"
out="$("$BIN" "$WORK/docs/architecture.md:$line" --port "$PORT" --no-open 2>&1)"
expect "reuses the running server" "$out" "already running"
expect "FILE:LINE opens the diagram at that line" "$out" "?file=architecture.md#d=2"
expect "FILE:LINE:COL works too" "$("$BIN" "$WORK/docs/architecture.md:$line:5" --port "$PORT" --no-open 2>&1)" "#d=2"
expect "an addon wins over a folder of the same name" "$(cd "$WORK" && withbin "$BIN" docs)" "the docs addon"
expect "./NAME is always a path" "$(cd "$WORK" && withbin "$BIN" ./docs --port "$PORT" --no-open 2>&1)" "already running"

# reads and writes with optimistic concurrency
ver="$(curl -fs -D - -o /dev/null "$U/api/file?path=payments.md" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-version"{print $2}')"
[[ -n "$ver" ]] || fail "GET /api/file has no X-Version header"
[[ "$(status PUT "$U/api/file?path=payments.md" -H "X-Base-Version: $ver" --data-binary $'# Payments v2\n')" == 200 ]] || fail "save with the current version"
expect "saves to disk" "$(cat "$WORK/docs/payments.md")" "# Payments v2"
[[ "$(status PUT "$U/api/file?path=payments.md" -H "X-Base-Version: $ver" --data-binary 'stale')" == 409 ]] || fail "stale save should be 409"
expect "rejects stale saves and keeps the file" "$(cat "$WORK/docs/payments.md")" "# Payments v2"
ver="$(curl -fs -D - -o /dev/null "$U/api/file?path=architecture.md" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-version"{print $2}')"
expect "cat --json reports the version the HTTP API uses" "$("$BIN" cat --json "$WORK/docs/architecture.md")" "\"version\":\"$ver\""

# uploads
printf 'PNG' >"$WORK/logo.png"
expect "uploads images next to the document" "$(curl -fs -X POST --data-binary @"$WORK/logo.png" "$U/api/upload?file=architecture.md&name=logo.png")" '"path":"assets/logo.png"'
expect "serves uploaded files" "$(curl -fs "$U/raw/assets/logo.png")" "PNG"
[[ "$(status POST "$U/api/upload?file=architecture.md&name=run.sh" --data-binary x)" == 400 ]] || fail "non-image upload should be 400"
pass "uploads accept images only"

# guards
[[ "$(status GET "$U/api/info" -H 'Host: evil.example')" == 403 ]] || fail "foreign Host header should be 403"
pass "rejects foreign Host headers (DNS rebinding)"
[[ "$(status GET "$U/api/file?path=../../etc/passwd.md")" == 400 ]] || fail "path escape should be 400"
pass "refuses paths outside the root"
[[ "$(status PUT "$U/api/file?path=notes.txt" --data-binary x)" == 400 ]] || fail "non-markdown write should be 400"
pass "writes markdown files only"

# live change events for edits made outside mermdraw
curl -sN --max-time 6 "$U/api/events" >"$WORK/events.log" &
PIDS+=("$!")
curl -fs "$U/api/file?path=architecture.md" >/dev/null # opening a file starts watching it
sleep 0.5
echo "<!-- edited elsewhere -->" >>"$WORK/docs/architecture.md"
for _ in $(seq 1 40); do
  grep -q '"path":"architecture.md"' "$WORK/events.log" 2>/dev/null && break
  sleep 0.1
done
expect "streams change events" "$(cat "$WORK/events.log")" '"type":"change","path":"architecture.md"'

echo "smoke test passed"
