#!/usr/bin/env bun
/**
 * mcpctl — MCP CLI control panel
 *
 * TUI for managing the mcpd daemon: connection status, auth, logs.
 */

import { render } from "ink";
import React from "react";
import { App } from "./app.js";

if (!process.stdout.isTTY) {
  console.error("mcpctl requires a terminal. Use 'mcx status' for non-interactive output.");
  process.exit(1);
}

const { waitUntilExit } = render(<App />, {
  exitOnCtrlC: true,
});

await waitUntilExit();
