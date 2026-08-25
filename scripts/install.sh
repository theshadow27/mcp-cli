#!/bin/sh
# Install mcp-cli from GitHub releases
# Usage: curl -fsSL https://github.com/theshadow27/mcp-cli/releases/latest/download/install.sh | sh
set -e

REPO="theshadow27/mcp-cli"
INSTALL_DIR="${MCP_CLI_INSTALL_DIR:-$HOME/.mcp-cli/bin}"

# Detect platform
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin|linux) ;;
  *) echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TARGET="${OS}-${ARCH}"

# Require curl
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not installed." >&2
  exit 1
fi

# Require tar
if ! command -v tar >/dev/null 2>&1; then
  echo "tar is required but not installed." >&2
  exit 1
fi

# Get latest release tag
VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "Failed to determine latest version." >&2
  exit 1
fi

URL="https://github.com/$REPO/releases/download/$VERSION/mcx-${TARGET}.tar.gz"

echo "Installing mcp-cli $VERSION ($TARGET) to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP/mcx.tar.gz"
tar xzf "$TMP/mcx.tar.gz" -C "$TMP"

# Install binaries (overwrites existing — idempotent)
for bin in mcx mcpd mcpctl; do
  mv "$TMP/${bin}-${TARGET}" "$INSTALL_DIR/$bin"
  chmod +x "$INSTALL_DIR/$bin"
done

# Transitional symlink: mcp -> mcx (deprecated name)
ln -sf "$INSTALL_DIR/mcx" "$INSTALL_DIR/mcp"

# git-remote-mcx: enables `git push`/`git pull` against mcx:// URLs.
# Invoking mcx through this symlink triggers remote-helper mode (see #1213).
ln -sf "$INSTALL_DIR/mcx" "$INSTALL_DIR/git-remote-mcx"

# Ad-hoc codesign on macOS (required for unsigned binaries)
if [ "$OS" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
  for bin in mcx mcpd mcpctl; do
    codesign -s - -f "$INSTALL_DIR/$bin" 2>/dev/null || true
  done
fi

# SHA-256 of a file, via whichever of the three usual tools this box has:
# sha256sum (coreutils/Linux), shasum -a 256 (macOS/perl), openssl dgst.
# Every field but the digest is discarded, so all three agree on the output.
# Returns non-zero when none is installed, which drops the whole marker.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    return 1
  fi
}

# Record install provenance (#3260), read back by `mcx upgrade --check`.
# Every compiled binary carries a `+epoch` BUILD_VERSION stamp, release
# artifacts included, so a binary cannot tell from its own version whether it
# arrived from an official release — only the installer knows, so it writes it
# down. Sizes use `wc -c`, matching the reader's statSync().size, and hashes
# are SHA-256, matching the reader's createHash("sha256") — both taken AFTER
# codesign, which rewrites the binaries on macOS.
#
# The hash, not the size, is what proves identity: two builds of the same
# version very often share a byte count (the embedded build stamps are
# fixed-width), so a size-only marker would vouch for a binary that had been
# overwritten in place. No hashing tool available means no marker, and the
# reader says "unknown" — the one thing it must never do is claim "release"
# on evidence this weak.
# Schema mirrors InstallMarker in packages/core/src/upgrade.ts; the reader
# looks under $HOME/.mcp-cli/bin, so a custom MCP_CLI_INSTALL_DIR simply
# leaves provenance unverifiable ("unknown") rather than wrong.
#
# Advisory, exactly as on the `mcx upgrade` side: a marker we fail to write
# costs a "release" verdict on the next --check, never the install itself. The
# script runs under `set -e`, so this is guarded — the binaries are already in
# place by now, and aborting here would turn a good install into a failed one.
# Staged through a temp file so a partial write never becomes the marker; a
# marker that is missing, truncated or unparseable reads back as "unknown",
# which is the honest answer, and never as "release".
record_provenance() {
  mkdir -p "$INSTALL_DIR/versions" || return 1
  # Collected before the temp file is opened, so a missing hashing tool aborts
  # without leaving a stray partial file behind.
  entries=""
  sep=""
  for bin in mcx mcpd mcpctl; do
    [ -f "$INSTALL_DIR/$bin" ] || continue
    size=$(wc -c < "$INSTALL_DIR/$bin" | tr -d ' ')
    # A binary we can't hash is not recorded on size alone — an unprovable
    # entry is worse than a missing one.
    hash=$(sha256_of "$INSTALL_DIR/$bin") || return 1
    [ -n "$hash" ] || return 1
    entries="$entries$sep{\"path\":\"$INSTALL_DIR/$bin\",\"size\":$size,\"sha256\":\"$hash\"}"
    sep=","
  done
  tmp="$INSTALL_DIR/versions/.installed.tmp.$$"
  printf '{"version":"%s","installedAt":%s,"source":"install.sh","binaries":[%s]}\n' \
    "${VERSION#v}" "$(date +%s)" "$entries" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$INSTALL_DIR/versions/.installed" || { rm -f "$tmp"; return 1; }
}

if ! record_provenance; then
  echo "Warning: could not record install provenance; 'mcx upgrade --check' will report this build as unverified." >&2
fi

echo "Installed mcx, mcpd, mcpctl to $INSTALL_DIR"

# Add install dir to PATH in shell rc files if not already present
add_to_path() {
  rc_file="$1"
  [ -f "$rc_file" ] || return 0
  if ! grep -q "$INSTALL_DIR" "$rc_file" 2>/dev/null; then
    printf '\n# mcp-cli\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$rc_file"
    echo "Added $INSTALL_DIR to PATH in $rc_file"
  fi
}

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    # Already in PATH
    ;;
  *)
    # Try to add to rc files
    added=false
    if [ -f "$HOME/.zshrc" ]; then
      add_to_path "$HOME/.zshrc"
      added=true
    fi
    if [ -f "$HOME/.bashrc" ]; then
      add_to_path "$HOME/.bashrc"
      added=true
    fi
    if [ "$added" = false ]; then
      # No rc file found — create .profile entry as fallback
      touch "$HOME/.profile"
      add_to_path "$HOME/.profile"
    fi
    echo "Restart your shell or run: export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
