import { Box, Text } from "ink";
import React, { type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.PureComponent<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const lines = error.stack?.split("\n").slice(1) ?? [];
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            mcpctl crashed: {error.message}
          </Text>
          <Text dimColor> </Text>
          {lines.map((line, i) => (
            <Text key={`${i}:${line}`} dimColor>
              {line}
            </Text>
          ))}
          <Text dimColor> </Text>
          <Text>Press Ctrl+C to exit.</Text>
        </Box>
      );
    }
    return this.props.children;
  }
}
