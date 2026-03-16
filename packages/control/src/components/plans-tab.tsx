import type { Plan, ServerStatus } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import type { ExpandedPlanKey } from "../hooks/use-keyboard-plans.js";
import { hasCapability } from "../hooks/use-keyboard-plans.js";
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
  servers: ServerStatus[];
  statusMessage?: string | null;
  confirmAbort?: boolean;
}

export function PlansTab({
  plans,
  loading,
  error,
  selectedIndex,
  expandedPlan,
  selectedStep,
  disconnected,
  servers,
  statusMessage,
  confirmAbort,
}: PlansTabProps) {
  if (loading && plans.length === 0) {
    return <Text dimColor>Loading plans...</Text>;
  }

  if (error && plans.length === 0) {
    return <Text color="red">Error: {error}</Text>;
  }

  const expanded = expandedPlan
    ? plans.find((p) => p.id === expandedPlan.id && p.server === expandedPlan.server)
    : null;
  const currentStep = expanded?.steps[selectedStep];

  // Check if the selected/expanded plan's server is read-only
  const targetPlan = expanded ?? plans[selectedIndex];
  const readOnly =
    targetPlan &&
    !hasCapability(servers, targetPlan.server, "advance") &&
    !hasCapability(servers, targetPlan.server, "abort");

  return (
    <Box flexDirection="column">
      {disconnected ? (
        <Text color="yellow" dimColor>
          ⚠ Disconnected — showing stale data
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
          <Text
            color={
              confirmAbort
                ? "yellow"
                : statusMessage.startsWith("Gates blocking") || statusMessage.includes("failed")
                  ? "red"
                  : "green"
            }
          >
            {statusMessage}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
