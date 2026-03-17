import type { PlanMetrics } from "@mcp-cli/core";
import { Box, Text, useStdout } from "ink";
import React from "react";

interface MetricsPanelProps {
  /** Plan or step name shown in the panel header. */
  label: string;
  /** Server-defined key-value metrics. */
  metrics: PlanMetrics;
}

/** Format a metric value for display. */
function formatValue(value: string | number): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

/**
 * Renders plan metrics as a compact key-value grid.
 *
 * Metrics are server-defined `Record<string, string | number>` — rendered as-is
 * in a pipe-separated responsive row.
 */
export function MetricsPanel({ label, metrics }: MetricsPanelProps) {
  const entries = Object.entries(metrics);
  const { stdout } = useStdout();
  if (entries.length === 0) return null;

  const separator = "  |  ";
  // "── Metrics (" = 13 chars, ")" = 1 char, marginLeft=2
  const prefixLen = 2 + 13 + label.length + 2; // margin + prefix + label + ") "
  const cols = stdout?.columns ?? 80;
  const trailCount = Math.max(3, cols - prefixLen);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={2}>
        <Text dimColor>{"── Metrics ("}</Text>
        <Text bold>{label}</Text>
        <Text dimColor>
          {")"} {"─".repeat(trailCount)}
        </Text>
      </Box>
      <Box marginLeft={3} flexWrap="wrap">
        <Text>
          {entries.map(([key, value], i) => (
            <React.Fragment key={key}>
              <Text dimColor>{key}:</Text> <Text>{formatValue(value)}</Text>
              {i < entries.length - 1 ? separator : ""}
            </React.Fragment>
          ))}
        </Text>
      </Box>
    </Box>
  );
}
