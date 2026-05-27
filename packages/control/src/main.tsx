#!/usr/bin/env bun
/**
 * mcpctl — MCP CLI control panel
 *
 * TUI for managing the mcpd daemon: connection status, auth, logs.
 */

import { assertBunVersion } from "@mcp-cli/core";
import { render } from "ink";

assertBunVersion();
import React from "react";
import { App } from "./app";
import { ErrorBoundary } from "./components/error-boundary";

if (import.meta.main) {
  if (!process.stdout.isTTY) {
    console.error("mcpctl requires a terminal. Use 'mcx status' for non-interactive output.");
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
    {
      exitOnCtrlC: true,
    },
  );

  await waitUntilExit();
}
