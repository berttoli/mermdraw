#!/bin/sh
# Installs mermdraw from its GitHub releases (macOS and Linux; Windows has install.ps1):
#
#   curl -fsSL https://github.com/berttoli/mermdraw/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/berttoli/mermdraw/releases/latest/download/install.sh | sh -s -- --version v0.2.0
#
# It picks the build for this OS and processor, checks it against the release's SHA256SUMS.txt (and its
# build-provenance attestation when gh is installed and logged in), installs it into ~/.local/bin and adds that folder
# to your shell's PATH. Run it again to update. Options, or the environment variables that set them:
#
#   --version TAG       MERMDRAW_INSTALL_VERSION    a release tag such as v0.2.0 (default: the latest release)
#   --dir DIR           MERMDRAW_INSTALL_DIR        where to put the binary (default: ~/.local/bin)
#   --no-modify-path    MERMDRAW_NO_MODIFY_PATH=1   leave your shell's startup files alone
#
# MERMDRAW_INSTALL_URL replaces https://github.com/berttoli in the download URLs, so a test or a mirror can serve the
# same layout (file:// included), like MERMDRAW_ADDONS_URL does for addons. The attestation is still checked against
# berttoli/mermdraw. Everything runs from main at the end, so a download cut short runs nothing.
set -eu

REPO=berttoli/mermdraw

say() {
  printf '%s\n' "$*"
}

err() {
  printf 'mermdraw installer: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: install.sh [--version TAG] [--dir DIR] [--no-modify-path]

Installs mermdraw from https://github.com/berttoli/mermdraw/releases into ~/.local/bin (or DIR) and adds that folder to
your shell's PATH. Run it again to update.

  --version TAG       a release tag such as v0.2.0 (default: the latest release)
  --dir DIR           where to put the binary (default: ~/.local/bin)
  --no-modify-path    don't add DIR to your shell's startup file
EOF
}

# sets target to the release build for this machine
detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      # a shell running under Rosetta reports x86_64 on Apple silicon; the native build is the better choice
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        arch=arm64
      fi
      suffix=apple-darwin
      ;;
    Linux) suffix=unknown-linux-musl ;; # static builds that run on any distro
    MINGW* | MSYS* | CYGWIN*)
      err "on Windows, run this in PowerShell instead:
  powershell -ExecutionPolicy Bypass -c \"irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex\""
      ;;
    *) err "there is no prebuilt mermdraw for $os; build it with: cargo install --git https://github.com/$REPO" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x86_64 ;;
    arm64 | aarch64) arch=aarch64 ;;
    *) err "there is no prebuilt mermdraw for $arch $os; build it with: cargo install --git https://github.com/$REPO" ;;
  esac
  target="$arch-$suffix"
}

download() { # URL FILE
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto-redir =https --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    err "needs curl or wget to download mermdraw"
  fi
}

sha256_of() { # FILE
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  fi
}

# sets attestation to what gh said about the archive; stops if gh rejects it
check_attestation() { # ARCHIVE
  if ! command -v gh >/dev/null 2>&1; then
    attestation="not checked: gh is not installed (https://cli.github.com)"
    return
  fi
  if gh_out=$(gh attestation verify "$1" -R "$REPO" 2>&1); then
    gh_status=0
  else
    gh_status=$?
  fi
  case "$gh_status" in
    0) attestation="verified with gh: built by $REPO's release workflow" ;;
    4) attestation="not checked: gh is not logged in (gh auth login)" ;; # gh's exit code for "not logged in"
    *)
      printf 'mermdraw installer: gh attestation verify rejected %s; nothing was installed\n' "$asset" >&2
      printf '%s\n' "$gh_out" | sed 's/^/  /' >&2
      exit 1
      ;;
  esac
}

on_path() { # DIR
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
  esac
  return 1
}

# sets path_note to what happened to the PATH; adds DIR to the startup file of the user's shell
update_path() { # DIR
  if on_path "$1"; then
    path_note="$1 is on your PATH"
    return
  fi
  if [ "$modify_path" = no ]; then
    path_note="$1 is not on your PATH; add it with: export PATH=\"$1:\$PATH\""
    return
  fi
  # $HOME/… rather than the expanded path, so the line still works in dotfiles shared between machines
  case "$1" in
    "$HOME"/*) folder="\$HOME/${1#"$HOME"/}" ;;
    *) folder="$1" ;;
  esac
  line="export PATH=\"$folder:\$PATH\""
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # Terminal.app starts login shells, which read .bash_profile; other systems read .bashrc
      if [ "$(uname -s)" = Darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/mermdraw.fish"
      line="contains \"$folder\" \$PATH; or set -gx PATH \"$folder\" \$PATH"
      ;;
    *) rc="$HOME/.profile" ;;
  esac
  if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
    path_note="$rc already adds $1 to your PATH; open a new terminal to use it"
    return
  fi
  mkdir -p "$(dirname "$rc")"
  if printf '\n# added by the mermdraw installer\n%s\n' "$line" >>"$rc"; then
    path_note="added $1 to your PATH in $rc; open a new terminal to use it"
  else
    path_note="could not write $rc; add $1 to your PATH yourself"
  fi
}

main() {
  version="${MERMDRAW_INSTALL_VERSION:-}"
  dir="${MERMDRAW_INSTALL_DIR:-}"
  modify_path=yes
  if [ "${MERMDRAW_NO_MODIFY_PATH:-}" = 1 ]; then modify_path=no; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --version)
        [ $# -ge 2 ] || err "--version needs a release tag, e.g. --version v0.2.0"
        version="$2"
        shift
        ;;
      --version=*) version="${1#*=}" ;;
      --dir)
        [ $# -ge 2 ] || err "--dir needs a folder"
        dir="$2"
        shift
        ;;
      --dir=*) dir="${1#*=}" ;;
      --no-modify-path) modify_path=no ;;
      -h | --help)
        usage
        return 0
        ;;
      *) err "unknown option $1 (try --help)" ;;
    esac
    shift
  done
  if [ -z "$dir" ]; then
    [ -n "${HOME:-}" ] || err "HOME is not set; pass --dir DIR"
    dir="$HOME/.local/bin"
  fi
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
    err "needs sha256sum, shasum or openssl to check the download"
  fi

  detect_target
  asset="mermdraw-$target.tar.gz"
  base="${MERMDRAW_INSTALL_URL:-https://github.com/berttoli}"
  base="${base%/}/mermdraw/releases"
  if [ -n "$version" ]; then
    case "$version" in
      v*) ;;
      *) version="v$version" ;;
    esac
    url="$base/download/$version"
  else
    url="$base/latest/download"
  fi

  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t mermdraw)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM

  download "$url/$asset" "$tmp/$asset" ||
    err "could not download $url/$asset
  does the ${version:-latest} release have a build for $target? see https://github.com/$REPO/releases"
  download "$url/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" || err "could not download $url/SHA256SUMS.txt"

  expected=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/SHA256SUMS.txt" | tr 'A-F' 'a-f')
  [ -n "$expected" ] || err "SHA256SUMS.txt does not list $asset"
  actual=$(sha256_of "$tmp/$asset" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] ||
    err "checksum mismatch for $asset: SHA256SUMS.txt says $expected, the download is ${actual:-unreadable}; nothing was installed"
  check_attestation "$tmp/$asset"

  mkdir "$tmp/unpacked"
  tar -xzf "$tmp/$asset" -C "$tmp/unpacked" || err "could not unpack $asset"
  bin="$tmp/unpacked/mermdraw-$target/mermdraw"
  # a regular file, not a link out of the archive
  if [ ! -f "$bin" ] || [ -L "$bin" ]; then err "$asset has no mermdraw-$target/mermdraw"; fi

  mkdir -p "$dir" 2>/dev/null || err "could not create $dir; pass --dir DIR"
  dir=$(cd "$dir" && pwd)
  previous=""
  if [ -x "$dir/mermdraw" ]; then previous=$("$dir/mermdraw" --version 2>/dev/null || true); fi
  new="$dir/.mermdraw.new.$$"
  if ! cp "$bin" "$new" 2>/dev/null || ! chmod 755 "$new" || ! mv -f "$new" "$dir/mermdraw"; then
    rm -f "$new"
    err "could not write to $dir; pass --dir DIR, or run it with sudo for a system folder"
  fi
  installed=$("$dir/mermdraw" --version 2>/dev/null) || err "installed $dir/mermdraw, but it doesn't run on this machine"

  update_path "$dir"
  if [ -n "$previous" ] && [ "$previous" != "$installed" ]; then
    say "updated $previous → ${installed#mermdraw } at $dir/mermdraw"
  else
    say "installed $installed → $dir/mermdraw"
  fi
  say "  from         $url/$asset"
  say "  sha256       $actual matches SHA256SUMS.txt"
  say "  attestation  $attestation"
  say "  PATH         $path_note"
  # an older copy, from an earlier manual install for example, can come first on the PATH
  found=$(command -v mermdraw 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$dir/mermdraw" ]; then
    say "  note         $found is another mermdraw on your PATH; remove it if it's an old copy"
  fi
  say "  next         mermdraw                  open the editor for the repo you're in"
  say "               mermdraw addons add mcp   let coding agents read and edit your diagrams"
}

main "$@"
