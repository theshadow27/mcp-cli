class McpCli < Formula
  desc "MCP server tools from the command line — zero context overhead"
  homepage "https://github.com/theshadow27/mcp-cli"
  version "VERSION"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcx-darwin-arm64.tar.gz"
      sha256 "SHA256_DARWIN_ARM64"
    end
    on_intel do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcx-darwin-x64.tar.gz"
      sha256 "SHA256_DARWIN_X64"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcx-linux-arm64.tar.gz"
      sha256 "SHA256_LINUX_ARM64"
    end
    on_intel do
      url "https://github.com/theshadow27/mcp-cli/releases/download/vVERSION/mcx-linux-x64.tar.gz"
      sha256 "SHA256_LINUX_X64"
    end
  end

  def install
    bin.install "mcx"
    bin.install "mcpd"
    bin.install "mcpctl"
  end

  test do
    assert_match "mcp-cli", shell_output("#{bin}/mcx --version")
  end
end
