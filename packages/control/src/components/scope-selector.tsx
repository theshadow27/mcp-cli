import type { ScopeMatch } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface ScopeSelectorProps {
  scopes: ScopeMatch[];
  selectedScope: ScopeMatch | null;
}

export function ScopeSelector({ scopes, selectedScope }: ScopeSelectorProps) {
  if (scopes.length === 0) return null;

  const items = [
    ...scopes.map((s) => ({ label: s.name, active: selectedScope?.root === s.root })),
    { label: "all", active: selectedScope === null },
  ];

  return (
    <Box>
      <Text dimColor>Scope: </Text>
      <Text>
        {items.map((item, i) => (
          <React.Fragment key={item.label}>
            {i > 0 && <Text> </Text>}
            {item.active ? (
              <Text bold color="cyan" inverse>
                {` ${item.label} `}
              </Text>
            ) : (
              <Text dimColor>{`[${item.label}]`}</Text>
            )}
          </React.Fragment>
        ))}
      </Text>
      <Text dimColor> S:switch</Text>
    </Box>
  );
}
