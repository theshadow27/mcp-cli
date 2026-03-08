import { Box, Text } from "ink";
import React from "react";
import { ALL_TABS, type View } from "../hooks/use-keyboard.js";

interface TabBarProps {
  activeTab: View;
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

export function TabBar({ activeTab }: TabBarProps) {
  return (
    <Box marginBottom={1}>
      <Text>
        {ALL_TABS.map((tab, i) => {
          const label = ` ${i + 1}:${capitalize(tab)} `;
          const isActive = tab === activeTab;
          const sep = i < ALL_TABS.length - 1 ? "│" : "";

          return (
            <React.Fragment key={tab}>
              {isActive ? (
                <Text bold color="cyan" inverse>
                  {label}
                </Text>
              ) : (
                <Text dimColor>{label}</Text>
              )}
              {sep ? <Text dimColor>{sep}</Text> : null}
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
}
