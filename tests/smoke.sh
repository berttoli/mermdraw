#!/usr/bin/env bash
# End-to-end smoke test of a built mmdr binary: terminal commands and the HTTP API.
# usage: tests/smoke.sh [path/to/mmdr]      (default: target/release/mmdr)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_ARG="${1:-$ROOT/target/release/mmdr}"
BIN="$(cd "$(dirname "$BIN_ARG")" && pwd)/$(basename "$BIN_ARG")"
PORT="${MMDR_SMOKE_PORT:-7899}"
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
expect "--version" "$("$BIN" --version)" "mmdr "
expect "ls lists diagrams" "$("$BIN" ls "$WORK/docs/architecture.md")" "3 diagrams"
expect "cat prints a block" "$("$BIN" cat "$WORK/docs/architecture.md" 2)" "sequenceDiagram"
"$BIN" new "$WORK/docs/new.md" -t er --title "Data model" >/dev/null
expect "new creates a file with a diagram" "$("$BIN" ls "$WORK/docs/new.md")" "erDiagram"
expect "icons ls with an empty cache" "$("$BIN" icons ls)" "no icon packs installed"
mkdir -p "$WORK/docs/.mmdr/icons"
printf '{"prefix":"demo","icons":{"dot":{"body":"<circle r=\\"4\\"/>"}}}' >"$WORK/docs/.mmdr/icons/demo.json"
printf '{"flags":{"sticky-notes":true}}' >"$WORK/docs/.mmdr/config.json"
expect "icons ls finds vendored packs" "$(cd "$WORK/docs" && "$BIN" icons ls)" "project"
if "$BIN" icons add ../escape >/dev/null 2>&1; then fail "icons add accepted a path"; fi
pass "icons add rejects bad pack names"

# ---------------------------------------------------------------- server
"$BIN" "$WORK/docs" --no-open --port "$PORT" --enable themes --disable icons >"$WORK/server.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 100); do
  curl -fs "$U/api/info" >/dev/null 2>&1 && break
  sleep 0.1
done

expect "serves the editor" "$(curl -fs "$U/")" "<title>mmdr</title>"
for a in app.js model.js canvas.js flags.js icons.js app.css; do
  [[ "$(status GET "$U/$a")" == 200 ]] || fail "asset /$a"
done
pass "serves every web module"
expect "serves mermaid gzipped" "$(curl -s -D - -o /dev/null "$U/vendor/mermaid.min.js" | tr -d '\r')" "Content-Encoding: gzip"
expect "passes command-line flags" "$(curl -fs "$U/api/info")" '"flags":{"themes":true,"icons":false}'
expect "serves project config" "$(curl -fs "$U/api/config")" '"sticky-notes":true'
expect "lists markdown files" "$(curl -fs "$U/api/files")" '"path":"architecture.md","diagrams":3'
expect "lists icon packs" "$(curl -fs "$U/api/icons")" '"name":"demo","source":"project"'
expect "serves an icon pack" "$(curl -fs "$U/api/icons/demo.json")" '"prefix":"demo"'
[[ "$(status GET "$U/api/icons/nope.json")" == 404 ]] || fail "missing pack should 404"
pass "missing icon pack is a 404"

# reads and writes with optimistic concurrency
ver="$(curl -fs -D - -o /dev/null "$U/api/file?path=payments.md" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-version"{print $2}')"
[[ -n "$ver" ]] || fail "GET /api/file has no X-Version header"
[[ "$(status PUT "$U/api/file?path=payments.md" -H "X-Base-Version: $ver" --data-binary $'# Payments v2\n')" == 200 ]] || fail "save with the current version"
expect "saves to disk" "$(cat "$WORK/docs/payments.md")" "# Payments v2"
[[ "$(status PUT "$U/api/file?path=payments.md" -H "X-Base-Version: $ver" --data-binary 'stale')" == 409 ]] || fail "stale save should be 409"
expect "rejects stale saves and keeps the file" "$(cat "$WORK/docs/payments.md")" "# Payments v2"

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

# live change events for edits made outside mmdr
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
