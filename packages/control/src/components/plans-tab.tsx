import type { Plan, PlanMetrics } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import { MetricsPanel } from "./metrics-panel.js";

/** Status → display color. */
function statusColor(status: string): string | undefined {
  switch (status) {
    case "active":
      return "cyan";
    case "complete":
      return "green";
    case "gated":
      return "yellow";
    case "failed":
    case "aborted":
      return "red";
    default:
      return undefined;
  }
}

interface PlansTabProps {
  plans: Plan[];
  loading: boolean;
  error: string | null;
  disconnected: boolean;
  selectedIndex: number;
  /** Metrics for the active step of the selected plan (null if unavailable). */
  metrics: PlanMetrics | null;
  metricsLoading: boolean;
}

export function PlansTab({
  plans,
  loading,
  error,
  disconnected,
  selectedIndex,
  metrics,
  metricsLoading,
}: PlansTabProps) {
  if (loading && plans.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>Loading plans...</Text>
      </Box>
    );
  }

  if (error && plans.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (plans.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No plans available.</Text>
      </Box>
    );
  }

  const selected = plans[selectedIndex];

  return (
    <Box flexDirection="column" marginTop={1}>
      {disconnected && (
        <Box marginLeft={2}>
          <Text color="yellow">⚠ stale data — connection lost</Text>
        </Box>
      )}
      {plans.map((plan, i) => {
        const isSelected = i === selectedIndex;
        const pointer = isSelected ? "▸" : " ";
        const activeStep = plan.steps.find((s) => s.id === plan.activeStepId);
        const progress = `${plan.steps.filter((s) => s.status === "complete").length}/${plan.steps.length}`;

        return (
          <Box key={`${plan.server}:${plan.id}`} marginLeft={2}>
            <Text>
              <Text color={isSelected ? "cyan" : undefined}>{pointer} </Text>
              <Text bold={isSelected}>{plan.name}</Text>
              {"  "}
              <Text color={statusColor(plan.status)}>[{plan.status}]</Text>
              {"  "}
              <Text dimColor>{progress} steps</Text>
              {activeStep && (
                <>
                  {"  "}
                  <Text dimColor>→ {activeStep.name}</Text>
                </>
              )}
              {"  "}
              <Text dimColor>({plan.server})</Text>
            </Text>
          </Box>
        );
      })}

      {/* Metrics panel for the selected plan's active step */}
      {selected && metrics && !metricsLoading && (
        <MetricsPanel
          label={selected.steps.find((s) => s.id === selected.activeStepId)?.name ?? selected.name}
          metrics={metrics}
        />
      )}
    </Box>
  );
}
