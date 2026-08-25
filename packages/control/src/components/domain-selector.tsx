import type { Domain } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface DomainSelectorProps {
  domains: Domain[];
  selectedDomain: Domain | null;
}

export function DomainSelector({ domains, selectedDomain }: DomainSelectorProps) {
  if (domains.length === 0) return null;

  const items = [
    ...domains.map((d) => ({ label: d.name, active: selectedDomain?.id === d.id })),
    { label: "all", active: selectedDomain === null },
  ];

  return (
    <Box>
      <Text dimColor>Domain: </Text>
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
