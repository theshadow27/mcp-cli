import { Box, Text } from "ink";
import React from "react";
import type { View } from "../hooks/use-keyboard.js";

interface FooterProps {
  view?: View;
}

export function Footer({ view = "servers" }: FooterProps) {
  if (view === "logs") {
    return (
      <Box marginTop={1}>
        <Text>
          <Text dimColor>l/esc</Text> back{"  "}
          <Text dimColor>j/k</Text> scroll{"  "}
          <Text dimColor>tab</Text> source{"  "}
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
