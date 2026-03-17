import type { PlanStatus, PlanStep } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

/** Map plan status to display indicator and color. */
export function statusIndicator(status: PlanStatus): { symbol: string; color: string } {
  switch (status) {
    case "pending":
      return { symbol: "○", color: "gray" };
    case "active":
      return { symbol: "●", color: "blue" };
    case "gated":
      return { symbol: "◉", color: "yellow" };
    case "complete":
      return { symbol: "✓", color: "green" };
    case "aborted":
      return { symbol: "✗", color: "red" };
    case "failed":
      return { symbol: "✗", color: "red" };
    default:
      return { symbol: "?", color: "gray" };
  }
}

interface StepPipelineProps {
  steps: PlanStep[];
  selectedStep: number;
}

export function StepPipeline({ steps, selectedStep }: StepPipelineProps) {
  if (steps.length === 0) {
    return <Text dimColor> (no steps)</Text>;
  }

  return (
    <Box flexDirection="row" flexWrap="wrap" paddingLeft={2}>
      {steps.map((step, i) => {
        const { symbol, color } = statusIndicator(step.status);
        const isSelected = i === selectedStep;
        const connector = i < steps.length - 1 ? " → " : "";

        return (
          <React.Fragment key={step.id}>
            <Text bold={isSelected} color={color} inverse={isSelected}>
              {` ${symbol} ${step.name} `}
            </Text>
            {connector ? <Text dimColor>{connector}</Text> : null}
          </React.Fragment>
        );
      })}
    </Box>
  );
}
