import { Box, Text } from "ink";
import React from "react";
import type { RegistryMode } from "../hooks/use-keyboard-registry.js";
import { ALL_TABS, type View } from "../hooks/use-keyboard.js";

interface FooterProps {
  view: View;
  filterMode: boolean;
  filterText: string;
  denyReasonMode: boolean;
  denyReasonText: string;
  promptMode: boolean;
  promptText: string;
  transcriptExpanded: boolean;
  mailExpanded?: boolean;
  planExpanded?: boolean;
  planConfirmAbort?: boolean;
  canAdvance?: boolean;
  canAbort?: boolean;
  addServerMode?: boolean;
  confirmRemove?: boolean;
  confirmRemoveServer?: string;
  confirmKillServe?: boolean;
  confirmKillServeCount?: number;
  registryMode?: RegistryMode;
}

export function Footer({
  view,
  filterMode,
  filterText,
  denyReasonMode,
  denyReasonText,
  promptMode,
  promptText,
  transcriptExpanded,
  mailExpanded,
  planExpanded,
  planConfirmAbort,
  canAdvance,
  canAbort,
  addServerMode,
  confirmRemove,
  confirmRemoveServer,
  confirmKillServe,
  confirmKillServeCount,
  registryMode,
}: FooterProps) {
  if (confirmRemove) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="yellow">Remove {confirmRemoveServer ?? "server"}?</Text>
          {"  "}
          <Text dimColor>y</Text> confirm{"  "}
          <Text dimColor>n</Text> cancel
        </Text>
      </Box>
    );
  }

  if (confirmKillServe) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="yellow">
            Kill {confirmKillServeCount ?? "all"} serve instance{(confirmKillServeCount ?? 0) !== 1 ? "s" : ""}?
          </Text>
          {"  "}
          <Text dimColor>y</Text> confirm{"  "}
          <Text dimColor>n</Text> cancel
        </Text>
      </Box>
    );
  }

  if (addServerMode) {
    return (
      <Box marginTop={1}>
        <Text dimColor>esc cancel (see form hints above)</Text>
      </Box>
    );
  }

  if (denyReasonMode) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="red">deny reason:</Text> {denyReasonText}
          <Text dimColor>█</Text>
          {"  "}
          <Text dimColor>enter</Text> deny{"  "}
          <Text dimColor>esc</Text> cancel
        </Text>
      </Box>
    );
  }

  if (promptMode) {
    return (
      <Box marginTop={1}>
        <Text>
          <Text color="cyan">prompt:</Text> {promptText}
          <Text dimColor>█</Text>
          {"  "}
          <Text dimColor>enter</Text> send{"  "}
          <Text dimColor>esc</Text> cancel
        </Text>
      </Box>
    );
  }

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

  const tabHints = (
    <>
      <Text dimColor>tab</Text> next{"  "}
      <Text dimColor>1-{ALL_TABS.length}</Text> jump{"  "}
    </>
  );

  if (view === "logs") {
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>l/esc</Text> back{"  "}
          <Text dimColor>j/k</Text> scroll{"  "}
          <Text dimColor>t</Text> source{"  "}
          <Text dimColor>f</Text> filter{"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  if (view === "servers") {
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>n</Text> add{"  "}
          <Text dimColor>d</Text> remove{"  "}
          <Text dimColor>a</Text> auth{"  "}
          <Text dimColor>r</Text> restart{"  "}
          <Text dimColor>R</Text> restart-all{"  "}
          <Text dimColor>s</Text> shutdown{"  "}
          <Text dimColor>j/k</Text> navigate{"  "}
          <Text dimColor>enter</Text> details{"  "}
          <Text dimColor>l</Text> logs{"  "}
          <Text dimColor>b</Text> browse registry
        </Text>
      </Box>
    );
  }

  if (view === "agents") {
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>j/k</Text> {transcriptExpanded ? "messages" : "navigate"}
          {"  "}
          <Text dimColor>enter</Text> {transcriptExpanded ? "expand" : "transcript"}
          {"  "}
          <Text dimColor>ctrl+o</Text> pager{"  "}
          <Text dimColor>a</Text> approve{"  "}
          <Text dimColor>d</Text> deny{"  "}
          <Text dimColor>p</Text> prompt{"  "}
          <Text dimColor>x</Text> end session{"  "}
          <Text dimColor>esc</Text> {transcriptExpanded ? "collapse" : "back"}
          {"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  if (view === "stats") {
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>j/k</Text> scroll{"  "}
          <Text dimColor>esc</Text> back{"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  if (view === "plans") {
    if (planConfirmAbort) {
      return (
        <Box marginTop={1}>
          <Text>
            <Text color="yellow">Confirm abort:</Text>
            {"  "}
            <Text dimColor>y</Text> confirm{"  "}
            <Text dimColor>n</Text> cancel
          </Text>
        </Box>
      );
    }
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>j/k</Text> navigate{"  "}
          <Text dimColor>enter</Text> {planExpanded ? "collapse" : "expand"}
          {"  "}
          {planExpanded ? (
            <>
              <Text dimColor>←/→</Text> steps{"  "}
            </>
          ) : null}
          {canAdvance ? (
            <>
              <Text dimColor>a</Text> advance{"  "}
            </>
          ) : null}
          {canAbort ? (
            <>
              <Text dimColor>x</Text> abort{"  "}
            </>
          ) : null}
          <Text dimColor>r</Text> refresh{"  "}
          <Text dimColor>esc</Text> {planExpanded ? "collapse" : "back"}
          {"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  if (view === "registry") {
    if (registryMode === "search") {
      return (
        <Box marginTop={1}>
          <Text>
            <Text dimColor>enter</Text> search{"  "}
            <Text dimColor>esc</Text> cancel
          </Text>
        </Box>
      );
    }
    if (registryMode === "env-input" || registryMode === "scope-pick" || registryMode === "confirm-install") {
      return (
        <Box marginTop={1}>
          <Text dimColor>esc cancel (see form hints above)</Text>
        </Box>
      );
    }
    return (
      <Box marginTop={1}>
        <Text>
          {tabHints}
          <Text dimColor>j/k</Text> navigate{"  "}
          <Text dimColor>enter</Text> details{"  "}
          <Text dimColor>i</Text> install{"  "}
          <Text dimColor>/</Text> search{"  "}
          <Text dimColor>esc</Text> back{"  "}
          <Text dimColor>q</Text> quit{"  "}
          <Text dimColor>s</Text> shutdown
        </Text>
      </Box>
    );
  }

  // Mail view
  return (
    <Box marginTop={1}>
      <Text>
        {tabHints}
        <Text dimColor>j/k</Text> {mailExpanded ? "scroll" : "navigate"}
        {"  "}
        <Text dimColor>enter</Text> {mailExpanded ? "collapse" : "read"}
        {"  "}
        <Text dimColor>m</Text> mark read{"  "}
        <Text dimColor>esc</Text> {mailExpanded ? "collapse" : "back"}
        {"  "}
        <Text dimColor>q</Text> quit{"  "}
        <Text dimColor>s</Text> shutdown
      </Text>
    </Box>
  );
}
