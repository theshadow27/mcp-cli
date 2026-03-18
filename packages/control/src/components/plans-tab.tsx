import type { Plan, ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import type { ExpandedPlanKey, StatusType } from "../hooks/use-keyboard-plans.js";
import { findExpanded, getTargetPlan, isPlanReadOnly } from "../hooks/use-keyboard-plans.js";
import { GatePanel } from "./gate-panel.js";
import { PlanList } from "./plan-list.js";
import { StepPipeline } from "./step-pipeline.js";

interface PlansTabProps {
  plans: Plan[];
  loading: boolean;
  error: string | null;
  selectedIndex: number;
  expandedPlan: ExpandedPlanKey | null;
  selectedStep: number;
  disconnected?: boolean;
  failedServers?: string[];
  servers: ServerStatus[];
  statusMessage?: string | null;
  statusType?: StatusType | null;
  confirmAbort?: boolean;
}

export const STATUS_COLORS: Record<StatusType, string> = {
  error: "red",
  success: "green",
  warning: "yellow",
  info: "cyan",
};

export function PlansTab({
  plans,
  loading,
  error,
  selectedIndex,
  expandedPlan,
  selectedStep,
  disconnected,
  failedServers,
  servers,
  statusMessage,
  statusType,
  confirmAbort,
}: PlansTabProps) {
  if (loading && plans.length === 0) {
    return <Text dimColor>Loading plans...</Text>;
  }

  if (error && plans.length === 0) {
    return <Text color="red">Error: {error}</Text>;
  }

  const expanded = findExpanded(plans, expandedPlan) ?? null;
  const currentStep = expanded?.steps[selectedStep];

  // Check if the selected/expanded plan's server is read-only
  const targetPlan = getTargetPlan(plans, expandedPlan, selectedIndex);
  const readOnly = targetPlan ? isPlanReadOnly(servers, targetPlan) : false;

  // Determine status message color from semantic type
  const statusColor = confirmAbort ? "yellow" : statusType ? STATUS_COLORS[statusType] : "green";

  return (
    <Box flexDirection="column">
      {disconnected ? (
        <Text color="yellow" dimColor>
          ⚠ Disconnected — showing stale data
        </Text>
      ) : failedServers && failedServers.length > 0 ? (
        <Text color="yellow" dimColor>
          ⚠ {failedServers.length} server(s) unavailable: {failedServers.join(", ")}
        </Text>
      ) : null}
      <PlanList plans={plans} selectedIndex={selectedIndex} expandedPlan={expandedPlan} />
      {expanded ? (
        <Box flexDirection="column" marginTop={1}>
          <StepPipeline steps={expanded.steps} selectedStep={selectedStep} />
          {currentStep?.gates && currentStep.gates.length > 0 ? (
            <GatePanel gates={currentStep.gates} stepName={currentStep.name} />
          ) : null}
        </Box>
      ) : null}
      {readOnly ? (
        <Box marginTop={1}>
          <Text color="yellow" dimColor>
            (read-only)
          </Text>
        </Box>
      ) : null}
      {statusMessage ? (
        <Box marginTop={readOnly ? 0 : 1}>
          <Text color={statusColor}>{statusMessage}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
