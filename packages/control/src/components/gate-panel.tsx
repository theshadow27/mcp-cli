import type { PlanGate } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface GatePanelProps {
  gates: PlanGate[];
  stepName: string;
}

export function GatePanel({ gates, stepName }: GatePanelProps) {
  if (gates.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingLeft={4} marginTop={1}>
      <Text bold color="yellow">
        Gates for {stepName}:
      </Text>
      {gates.map((gate) => (
        <Box key={gate.name} paddingLeft={2}>
          <Text color={gate.passed ? "green" : "yellow"}>
            {gate.passed ? "✓" : "○"} {gate.name}
          </Text>
          {gate.description ? <Text dimColor> — {gate.description}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}
