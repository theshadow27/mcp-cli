import type { Plan } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import type { ExpandedPlanKey } from "../hooks/use-keyboard-plans.js";
import { statusIndicator } from "./step-pipeline.js";

interface PlanListProps {
  plans: Plan[];
  selectedIndex: number;
  expandedPlan: ExpandedPlanKey | null;
}

export function PlanList({ plans, selectedIndex, expandedPlan }: PlanListProps) {
  if (plans.length === 0) {
    return <Text dimColor>No plans available.</Text>;
  }

  return (
    <Box flexDirection="column">
      {plans.map((plan, i) => {
        const isSelected = i === selectedIndex;
        const isExpanded = expandedPlan !== null && expandedPlan.id === plan.id && expandedPlan.server === plan.server;
        const { symbol, color } = statusIndicator(plan.status);
        const prefix = isSelected ? ">" : " ";
        const completedSteps = plan.steps.filter((s) => s.status === "complete").length;
        const totalSteps = plan.steps.length;
        const progress = totalSteps > 0 ? `${completedSteps}/${totalSteps}` : "";

        return (
          <Box key={`${plan.server}::${plan.id}`} flexDirection="column">
            <Text bold={isSelected}>
              <Text color={isSelected ? "cyan" : undefined}>{prefix} </Text>
              <Text color={color}>{symbol}</Text>
              <Text bold={isSelected}> {plan.name}</Text>
              <Text dimColor> [{plan.server}]</Text>
              {progress ? <Text dimColor> ({progress} steps)</Text> : null}
              {isExpanded ? <Text dimColor> ▾</Text> : isSelected ? <Text dimColor> ▸</Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
