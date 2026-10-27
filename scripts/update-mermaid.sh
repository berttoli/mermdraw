#!/bin/sh
# Re-vendors the mermaid bundle that mermdraw embeds: ./scripts/update-mermaid.sh 11.17.2
set -eu
v="${1:?usage: $0 MERMAID_VERSION}"
cd "$(dirname "$0")/.."
curl -fsSL "https://cdn.jsdelivr.net/npm/mermaid@$v/dist/mermaid.min.js" | gzip -9 > web/vendor/mermaid.min.js.gz
echo "mermaid $v -> web/vendor/mermaid.min.js.gz ($(wc -c < web/vendor/mermaid.min.js.gz) bytes); rebuild with: cargo build --release"
