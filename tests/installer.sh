#!/usr/bin/env bash
# Tests scripts/install.sh against a local copy of a release (MERMDRAW_INSTALL_URL=file://…): the build it picks,
# checksums, the attestation check (with a stand-in gh), --version, --dir, PATH handling and updates. It runs the
# installer with sh, and with dash and bash too where they exist, as `curl … | sh` would. HOME points into a
# temporary folder, so your own startup files and ~/.local/bin are never touched.
# usage: tests/installer.sh [path/to/mermdraw]      (default: target/release/mermdraw)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_ARG="${1:-$ROOT/target/release/mermdraw}"
BIN="$(cd "$(dirname "$BIN_ARG")" && pwd)/$(basename "$BIN_ARG")"
INSTALLER="$ROOT/scripts/install.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "ok   $*"; }
expect() { # DESC ACTUAL SUBSTRING
  [[ "$2" == *"$3"* ]] || fail "$1: expected '$3' in: ${2:0:900}"
  pass "$1"
}
sha256() { # FILE -> hex digest
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi
}

[[ -x "$BIN" ]] || fail "no executable at $BIN (build with: cargo build --release)"
VERSION="$("$BIN" --version)"

# the build install.sh should pick here, worked out separately from the script
case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) fail "run this on macOS or Linux; tests/installer.ps1 covers Windows" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=aarch64 ;;
  *) fail "no release build for $(uname -m)" ;;
esac
if [[ "$os" == apple-darwin && "$arch" == x86_64 && "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" == 1 ]]; then
  arch=aarch64 # Rosetta
fi
TARGET="$arch-$os"

# release folders laid out like GitHub's, every Unix build holding this machine's binary, so a wrong pick shows up
# in the "from" line rather than as a download error
release() { # DIR
  mkdir -p "$1"
  for t in aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-musl x86_64-unknown-linux-musl; do
    "$ROOT/scripts/release.sh" package "$t" "$BIN" "$1" >/dev/null
  done
  (cd "$1" && for f in mermdraw-*.tar.gz; do echo "$(sha256 "$f")  $f"; done >SHA256SUMS.txt)
}
URL="file://$WORK/releases"
LATEST="$WORK/releases/mermdraw/releases/latest/download"
release "$LATEST"
release "$WORK/releases/mermdraw/releases/download/v9.9.9"
BAD="file://$WORK/bad"
release "$WORK/bad/mermdraw/releases/latest/download"
printf 'x' >>"$WORK/bad/mermdraw/releases/latest/download/mermdraw-$TARGET.tar.gz"

# a stand-in gh: exits with $FAKE_GH (4 is gh's "not logged in")
mkdir -p "$WORK/gh"
cat >"$WORK/gh/gh" <<'EOF'
#!/bin/sh
echo "fake gh: attestation does not match" >&2
exit "${FAKE_GH:-4}"
EOF
chmod +x "$WORK/gh/gh"
CLEAN_PATH="$WORK/gh:/usr/bin:/bin:/usr/sbin:/sbin"

run() { # HOME SHELL [env NAME=VALUE…] -- [installer args…]: runs install.sh with sh, prints its output
  local home="$1" shell="$2"
  shift 2
  local vars=()
  while [[ $# -gt 0 && "$1" != -- ]]; do
    vars+=("$1")
    shift
  done
  shift
  env -i HOME="$home" SHELL="$shell" PATH="$CLEAN_PATH" MERMDRAW_INSTALL_URL="$URL" ${vars[@]+"${vars[@]}"} \
    "${INSTALL_SH:-sh}" "$INSTALLER" "$@" 2>&1
}

# ---------------------------------------------------------------- a first install, with each shell that's here
shells=(sh)
for s in dash bash; do command -v "$s" >/dev/null && shells+=("$s"); done
for s in "${shells[@]}"; do
  home="$WORK/home-$s"
  out="$(INSTALL_SH="$s" run "$home" /bin/zsh --)"
  expect "$s: installs into ~/.local/bin" "$out" "installed $VERSION → $home/.local/bin/mermdraw"
  expect "$s: picks the $TARGET build of the latest release" "$out" "from         $URL/mermdraw/releases/latest/download/mermdraw-$TARGET.tar.gz"
  expect "$s: checks the checksum" "$out" "$(sha256 "$LATEST/mermdraw-$TARGET.tar.gz") matches SHA256SUMS.txt"
  expect "$s: says the attestation wasn't checked when gh isn't logged in" "$out" "attestation  not checked: gh is not logged in"
  expect "$s: adds ~/.local/bin to the PATH in .zshrc" "$out" "added $home/.local/bin to your PATH in $home/.zshrc"
  [[ "$("$home/.local/bin/mermdraw" --version)" == "$VERSION" ]] || fail "$s: the installed binary doesn't run"
  pass "$s: the installed binary runs"
done
home="$WORK/home-sh"
grep -qxF "export PATH=\"\$HOME/.local/bin:\$PATH\"" "$home/.zshrc" || fail ".zshrc has no PATH line: $(cat "$home/.zshrc")"
pass "the .zshrc line puts \$HOME/.local/bin first"

# ---------------------------------------------------------------- running it again, and updates
out="$(run "$home" /bin/zsh --)"
expect "a second run reinstalls" "$out" "installed $VERSION → $home/.local/bin/mermdraw"
expect "a second run leaves .zshrc alone" "$out" "$home/.zshrc already adds $home/.local/bin to your PATH"
[[ "$(grep -c 'mermdraw installer' "$home/.zshrc")" == 1 ]] || fail ".zshrc got the PATH line twice"
pass ".zshrc has the PATH line once"
printf '#!/bin/sh\necho "mermdraw 0.0.1"\n' >"$home/.local/bin/mermdraw"
expect "an older version is updated" "$(run "$home" /bin/zsh --)" "updated mermdraw 0.0.1 → ${VERSION#mermdraw } at $home/.local/bin/mermdraw"

# ---------------------------------------------------------------- options
out="$(run "$WORK/home-v" /bin/zsh -- --version v9.9.9 --no-modify-path)"
expect "--version picks that release" "$out" "$URL/mermdraw/releases/download/v9.9.9/mermdraw-$TARGET.tar.gz"
expect "--no-modify-path says how to add the folder" "$out" "is not on your PATH; add it with: export PATH="
[[ ! -e "$WORK/home-v/.zshrc" ]] || fail "--no-modify-path wrote .zshrc"
pass "--no-modify-path leaves the startup files alone"
expect "a version without its v works too" "$(run "$WORK/home-v" /bin/zsh -- --version=9.9.9 --no-modify-path)" "/download/v9.9.9/"
out="$(run "$WORK/home-e" /bin/zsh MERMDRAW_INSTALL_VERSION=9.9.9 MERMDRAW_INSTALL_DIR="$WORK/env-bin" MERMDRAW_NO_MODIFY_PATH=1 --)"
expect "environment variables set the version" "$out" "/download/v9.9.9/"
expect "environment variables set the folder" "$out" "→ $WORK/env-bin/mermdraw"
[[ ! -e "$WORK/home-e/.zshrc" ]] || fail "MERMDRAW_NO_MODIFY_PATH=1 wrote .zshrc"
pass "MERMDRAW_NO_MODIFY_PATH=1 leaves the startup files alone"
out="$(env -i HOME="$WORK/home-p" SHELL=/bin/zsh PATH="$CLEAN_PATH" MERMDRAW_INSTALL_URL="$URL" sh -s -- --dir "$WORK/piped" --no-modify-path <"$INSTALLER" 2>&1)"
expect "runs from a pipe, as curl … | sh -s -- ARGS does" "$out" "installed $VERSION → $WORK/piped/mermdraw"
expect "--help shows usage" "$(run "$WORK/home-h" /bin/zsh -- --help)" "usage: install.sh"
if out="$(run "$WORK/home-x" /bin/zsh -- --bogus)"; then fail "an unknown option was accepted"; fi
expect "rejects unknown options" "$out" "unknown option --bogus"

# ---------------------------------------------------------------- PATH handling per shell
out="$(run "$WORK/home-b" /bin/bash --)"
if [[ "$(uname -s)" == Darwin ]]; then rc="$WORK/home-b/.bash_profile"; else rc="$WORK/home-b/.bashrc"; fi
expect "bash: adds the folder in its startup file" "$out" "to your PATH in $rc"
out="$(run "$WORK/home-f" /usr/bin/fish --)"
expect "fish: adds the folder in conf.d" "$out" "to your PATH in $WORK/home-f/.config/fish/conf.d/mermdraw.fish"
grep -qxF "contains \"\$HOME/.local/bin\" \$PATH; or set -gx PATH \"\$HOME/.local/bin\" \$PATH" "$WORK/home-f/.config/fish/conf.d/mermdraw.fish" ||
  fail "the fish line isn't fish syntax: $(cat "$WORK/home-f/.config/fish/conf.d/mermdraw.fish")"
pass "fish gets fish syntax"
expect "other shells: adds the folder in .profile" "$(run "$WORK/home-k" /bin/ksh --)" "to your PATH in $WORK/home-k/.profile"
out="$(CLEAN_PATH="$WORK/onpath:$CLEAN_PATH" run "$WORK/home-o" /bin/zsh -- --dir "$WORK/onpath")"
expect "a folder already on the PATH is left as it is" "$out" "$WORK/onpath is on your PATH"
[[ ! -e "$WORK/home-o/.zshrc" ]] || fail "wrote .zshrc for a folder already on the PATH"
pass "no startup file changes for a folder already on the PATH"
mkdir -p "$WORK/old"
printf '#!/bin/sh\necho "mermdraw 0.0.1"\n' >"$WORK/old/mermdraw"
chmod +x "$WORK/old/mermdraw"
out="$(CLEAN_PATH="$WORK/old:$CLEAN_PATH" run "$WORK/home-s" /bin/zsh --)"
expect "points out an older mermdraw on the PATH" "$out" "$WORK/old/mermdraw is another mermdraw on your PATH"

# ---------------------------------------------------------------- refusals: nothing is installed
if out="$(URL="$BAD" run "$WORK/home-c" /bin/zsh --)"; then fail "a corrupted download was installed"; fi
expect "refuses a download that doesn't match SHA256SUMS.txt" "$out" "checksum mismatch for mermdraw-$TARGET.tar.gz"
[[ ! -e "$WORK/home-c/.local/bin/mermdraw" ]] || fail "installed a corrupted download"
pass "a checksum mismatch installs nothing"
if out="$(run "$WORK/home-g" /bin/zsh FAKE_GH=1 --)"; then fail "installed although gh rejected the attestation"; fi
expect "stops when gh rejects the attestation" "$out" "gh attestation verify rejected mermdraw-$TARGET.tar.gz"
expect "shows what gh said" "$out" "fake gh: attestation does not match"
[[ ! -e "$WORK/home-g/.local/bin/mermdraw" ]] || fail "installed although gh rejected the attestation"
pass "a rejected attestation installs nothing"
expect "says when gh verified the attestation" "$(run "$WORK/home-a" /bin/zsh FAKE_GH=0 --)" "verified with gh: built by berttoli/mermdraw's release workflow"
if out="$(run "$WORK/home-m" /bin/zsh -- --version v0.0.1)"; then fail "installed a release that doesn't exist"; fi
expect "says which release is missing" "$out" "does the v0.0.1 release have a build for $TARGET?"
if out="$(run "$WORK/home-d" /bin/zsh -- --dir /dev/null/bin)"; then fail "accepted a folder it can't create"; fi
expect "says when it can't create the folder" "$out" "could not create /dev/null/bin"

echo "installer test passed"
