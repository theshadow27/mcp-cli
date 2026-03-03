#!/bin/sh
# Install mcp-cli
# Usage: curl -fsSL https://raw.githubusercontent.com/theshadow27/mcp-cli/main/scripts/install.sh | sh
set -e

REPO="theshadow27/mcp-cli"
INSTALL_DIR="${MCP_CLI_INSTALL_DIR:-$HOME/.local/bin}"

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

# Get latest release tag
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required but not installed." >&2
  exit 1
fi

VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)
if [ -z "$VERSION" ]; then
  echo "Failed to determine latest version." >&2
  exit 1
fi

URL="https://github.com/$REPO/releases/download/$VERSION/mcp-${TARGET}.tar.gz"

echo "Installing mcp-cli $VERSION ($TARGET) to $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$URL" -o "$TMP/mcp.tar.gz"
tar xzf "$TMP/mcp.tar.gz" -C "$TMP"

mv "$TMP/mcp-${TARGET}" "$INSTALL_DIR/mcp"
mv "$TMP/mcpd-${TARGET}" "$INSTALL_DIR/mcpd"
mv "$TMP/mcpctl-${TARGET}" "$INSTALL_DIR/mcpctl"
chmod +x "$INSTALL_DIR/mcp" "$INSTALL_DIR/mcpd" "$INSTALL_DIR/mcpctl"

echo "Installed mcp, mcpd, and mcpctl to $INSTALL_DIR"

# Check if install dir is in PATH
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add $INSTALL_DIR to your PATH:"; echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac
