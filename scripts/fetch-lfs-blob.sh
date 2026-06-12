#!/usr/bin/env bash
# Fetch the archived claude-2.1.119 binary directly from the GitHub LFS batch
# API — no `lfs: true` checkout (and no per-checkout LFS bandwidth) required.
#
# The blob was removed from HEAD in #2741 to stop CI dragging 59 MB on every
# run. It still lives in LFS storage, kept referenced by the tag
# `archive/agent-grid-claude-2.1.119`. This script is the on-demand retrieval
# path for anyone (local dev, or a future job) that actually needs the binary.
#
# Caches by OID: a re-run with the blob already present and intact is a no-op.
set -euo pipefail

REPO="theshadow27/mcp-cli"
OID="5035cb068148a66444a8b8642b3d5eab926c086961101840dbe1baa62957bbc0"
SIZE=61891998
REL="agent-grid/binaries/claude-2.1.119.tgz"
: "${GITHUB_TOKEN:?set GITHUB_TOKEN (the default GITHUB_TOKEN in Actions works)}"

# Resolve the output path relative to the repo root so the script works from
# any working directory.
ROOT="$(git rev-parse --show-toplevel)"
OUT="${ROOT}/${REL}"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Skip if already present and intact (cache hit).
if [[ -f "$OUT" ]] && [[ "$(sha256 "$OUT")" == "$OID" ]]; then
  echo "blob already present and verified: $OUT"
  exit 0
fi

href="$(curl -sf \
  -X POST "https://github.com/${REPO}.git/info/lfs/objects/batch" \
  -u "x-access-token:${GITHUB_TOKEN}" \
  -H 'Accept: application/vnd.git-lfs+json' \
  -H 'Content-Type: application/vnd.git-lfs+json' \
  -d "{\"operation\":\"download\",\"transfers\":[\"basic\"],\"objects\":[{\"oid\":\"${OID}\",\"size\":${SIZE}}]}" \
  | jq -r '.objects[0].actions.download.href')"

if [[ -z "$href" || "$href" == "null" ]]; then
  echo "could not resolve LFS download href for $OID" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
curl -sf -L "$href" -o "$OUT"

actual="$(sha256 "$OUT")"
if [[ "$actual" != "$OID" ]]; then
  echo "checksum mismatch: $actual != $OID" >&2
  exit 1
fi
echo "fetched and verified: $OUT (${SIZE} bytes)"
