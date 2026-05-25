import { Text } from "ink";
import React, { useState, useEffect } from "react";

const DOT_ANIMATION_INTERVAL_MS = 400;

export function Loading() {
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => (d % 3) + 1);
    }, DOT_ANIMATION_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Text>
      <Text dimColor>Connecting to daemon</Text>
      <Text>{".".repeat(dots)}</Text>
    </Text>
  );
}
