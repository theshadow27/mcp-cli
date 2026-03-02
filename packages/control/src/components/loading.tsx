import { Text } from "ink";
import React, { useState, useEffect } from "react";

export function Loading() {
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => (d % 3) + 1);
    }, 400);
    return () => clearInterval(id);
  }, []);

  return (
    <Text>
      <Text dimColor>Connecting to daemon</Text>
      <Text>{".".repeat(dots)}</Text>
    </Text>
  );
}
