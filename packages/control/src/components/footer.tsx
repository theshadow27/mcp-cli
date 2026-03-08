import { Box, Text } from "ink";
import React from "react";
import type { View } from "../hooks/use-keyboard.js";

interface FooterProps {
  view: View;
  filterMode: boolean;
  filterText: string;
}

export function Footer({ view, filterMode, filterText }: FooterProps) {
  if (filterMode) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">filter:</Text> {filterText}
          <Text dimColor>█</Text>
          {"  "}
          <Text dimColor>enter</Text> apply{"  "}
          <Text dimColor>esc</Text> clear
        </Text>
      </Box>
    );
  }

  if (view === "logs") {
    return (
      <Box marginTop={1}>
        <Text>
          <Text dimColor>l/esc</Text> back{"  "}
          <Text dimColor>j/k</Text> scroll{"  "}
          <Text dimColor>tab</Text> source{"  "}
          <Text dimColor>f</Text> filter{"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  return (
    <Box marginTop={1}>
      <Text>
        <Text dimColor>q</Text> quit{"  "}
        <Text dimColor>a</Text> auth{"  "}
        <Text dimColor>r</Text> restart{"  "}
        <Text dimColor>R</Text> restart-all{"  "}
        <Text dimColor>s</Text> shutdown{"  "}
        <Text dimColor>j/k</Text> navigate{"  "}
        <Text dimColor>enter</Text> details{"  "}
        <Text dimColor>l</Text> logs
      </Text>
    </Box>
  );
}
