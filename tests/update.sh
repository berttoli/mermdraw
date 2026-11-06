#!/usr/bin/env bash
# Exercises the explicit update command against local release files; never touches the user's installation.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_ARG="${1:-$ROOT/target/release/mermdraw}"
BIN="$(cd "$(dirname "$BIN_ARG")" && pwd)/$(basename "$BIN_ARG")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok   $*"; }
expect() {
  [[ "$2" == *"$3"* ]] || fail "$1: expected '$3' in: ${2:0:500}"
  pass "$1"
}
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }

[[ -x "$BIN" ]] || fail "no executable at $BIN"
case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) fail "run on macOS or Linux; tests/update.ps1 covers Windows" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no release build for $(uname -m)" ;;
esac
if [[ "$os" == apple-darwin && "$arch" == x86_64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
  arch=aarch64
fi
target="$arch-$os"

mkdir -p "$WORK/bin" "$WORK/home" "$WORK/tools" "$WORK/stage/mermdraw-$target"
cp "$BIN" "$WORK/bin/mermdraw"
RUN="$WORK/bin/mermdraw"
current="$("$RUN" --version)"

# A newer release containing a stand-in executable, laid out exactly like a published archive.
cat >"$WORK/stage/mermdraw-$target/mermdraw" <<'EOF'
#!/bin/sh
if [ "${1:-}" = --version ]; then echo 'mermdraw 999.0.0'; else echo 'updated'; fi
EOF
chmod +x "$WORK/stage/mermdraw-$target/mermdraw"
release="$WORK/releases/mermdraw/releases/download/v999.0.0"
mkdir -p "$release"
asset="mermdraw-$target.tar.gz"
tar -czf "$release/$asset" -C "$WORK/stage" "mermdraw-$target"
echo "$(sha256 "$release/$asset")  $asset" >"$release/SHA256SUMS.txt"
mkdir -p "$WORK/bad/mermdraw/releases/download/v999.0.0"
cp "$release/$asset" "$release/SHA256SUMS.txt" "$WORK/bad/mermdraw/releases/download/v999.0.0/"
printf x >>"$WORK/bad/mermdraw/releases/download/v999.0.0/$asset"

cat >"$WORK/tools/gh" <<'EOF'
#!/bin/sh
exit 4
EOF
chmod +x "$WORK/tools/gh"
export PATH="$WORK/tools:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="$WORK/home"
export MERMDRAW_UPDATE_URL="file://$WORK/latest.json"
export MERMDRAW_INSTALL_URL="file://$WORK/releases"

printf '{"tag_name":"v%s"}\n' "${current#mermdraw }" >"$WORK/latest.json"
expect "reports the installed version is current" "$("$RUN" update --check)" "$current is current"
[[ "$("$RUN" --version)" == "$current" ]] || fail "--check changed the binary"
pass "--check leaves the binary alone"

printf '{"tag_name":"v0.0.1"}\n' >"$WORK/latest.json"
expect "does not offer a downgrade" "$("$RUN" update --check)" "newer than the latest stable release"

printf '{"tag_name":"v999.0.0;bad"}\n' >"$WORK/latest.json"
if out="$("$RUN" update --check 2>&1)"; then fail "accepted an invalid release tag"; fi
expect "rejects an unsafe release tag" "$out" "invalid tag"

printf '{"tag_name":"v999.0.0"}\n' >"$WORK/latest.json"
expect "shows a newer release" "$("$RUN" update --check)" "Update available: $current → 999.0.0"
if out="$("$RUN" update 2>&1)"; then fail "updated without confirmation"; fi
expect "requires a terminal confirmation" "$out" "confirmation needs a terminal"
[[ "$("$RUN" --version)" == "$current" ]] || fail "unconfirmed update changed the binary"

if out="$(MERMDRAW_INSTALL_URL="file://$WORK/bad" "$RUN" update --yes 2>&1)"; then fail "installed a bad archive"; fi
expect "refuses a bad checksum" "$out" "checksum mismatch"
[[ "$("$RUN" --version)" == "$current" ]] || fail "a bad archive replaced the binary"
pass "a failed verification leaves the old binary"

wrong="$WORK/wrong/mermdraw/releases/download/v999.0.0"
mkdir -p "$wrong" "$WORK/wrong-stage/mermdraw-$target"
cp "$BIN" "$WORK/wrong-stage/mermdraw-$target/mermdraw"
tar -czf "$wrong/$asset" -C "$WORK/wrong-stage" "mermdraw-$target"
echo "$(sha256 "$wrong/$asset")  $asset" >"$wrong/SHA256SUMS.txt"
if out="$(MERMDRAW_INSTALL_URL="file://$WORK/wrong" "$RUN" update --yes 2>&1)"; then fail "installed a binary with the wrong version"; fi
expect "restores the old binary when a release reports the wrong version" "$out" "the previous binary was restored"
[[ "$("$RUN" --version)" == "$current" ]] || fail "a wrong-version archive replaced the binary"

out="$("$RUN" update --yes 2>&1)"
expect "installs the selected release" "$out" "Updated $RUN to v999.0.0"
[[ "$("$RUN" --version)" == "mermdraw 999.0.0" ]] || fail "the updated binary does not run"
pass "the updated binary runs"

echo "update test passed"
