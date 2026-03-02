class McpCli < Formula
  desc "MCP server tools from the command line — zero context overhead"
  homepage "https://github.com/theshadow27/mcp-cli"
  version "VERSION"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcp-darwin-arm64.tar.gz"
      sha256 "SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcp-darwin-x64.tar.gz"
      sha256 "SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcp-linux-arm64.tar.gz"
      sha256 "SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcp-linux-x64.tar.gz"
      sha256 "SHA256_LINUX_X64"
    end
  end

  def install
    bin.install "mcp"
    bin.install "mcpd"
  end

  test do
    assert_match "mcp-cli", shell_output("#{bin}/mcp --version")
  end
end
