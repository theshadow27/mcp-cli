import type { Plan } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import type { ExpandedPlanKey } from "../hooks/use-keyboard-plans.js";
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
}

export function PlansTab({
  plans,
  loading,
  error,
  selectedIndex,
  expandedPlan,
  selectedStep,
  disconnected,
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
    </Box>
  );
}
