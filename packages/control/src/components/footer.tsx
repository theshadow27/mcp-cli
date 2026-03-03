import { Box, Text } from "ink";
import React from "react";

export function Footer() {
  return (
    <Box marginTop={1}>
      <Text>
        <Text dimColor>q</Text> quit{"  "}
        <Text dimColor>a</Text> auth{"  "}
        <Text dimColor>r</Text> restart{"  "}
        <Text dimColor>R</Text> restart-all{"  "}
        <Text dimColor>s</Text> shutdown{"  "}
        <Text dimColor>j/k</Text> navigate{"  "}
        <Text dimColor>enter</Text> details
      </Text>
    </Box>
  );
}
