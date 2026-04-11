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

# Ad-hoc codesign on macOS (required for unsigned binaries)
if [ "$OS" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
  for bin in mcx mcpd mcpctl; do
    codesign -s - -f "$INSTALL_DIR/$bin" 2>/dev/null || true
  done
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
      printf '\n# mcp-cli\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$HOME/.profile"
      echo "Added $INSTALL_DIR to PATH in ~/.profile"
    fi
    echo "Restart your shell or run: export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
