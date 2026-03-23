import type { MailMessage } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";
import { getMessageLines } from "../hooks/use-keyboard-mail.js";

const MAIL_VIEW_HEIGHT = 20;

interface MailViewerProps {
  messages: MailMessage[];
  selectedIndex: number;
  expandedMessage: number | null;
  scrollOffset: number;
  height?: number;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function MailListItem({ msg, selected }: { msg: MailMessage; selected: boolean }) {
  const readFlag = msg.read ? " " : "N";
  const subject = msg.subject ?? "(no subject)";
  const ts = formatTimestamp(msg.createdAt);

  return (
    <Box>
      <Text inverse={selected}>
        <Text color={msg.read ? undefined : "yellow"} bold={!msg.read}>
          {readFlag}
        </Text>
        {"  "}
        <Text>{Bun.sliceAnsi(msg.sender.padEnd(16), 0, 16)}</Text>
        {"  "}
        <Text>{Bun.sliceAnsi(subject.padEnd(40), 0, 40)}</Text>
        {"  "}
        <Text dimColor>{ts}</Text>
      </Text>
    </Box>
  );
}

function MailDetail({ msg, scrollOffset, height }: { msg: MailMessage; scrollOffset: number; height: number }) {
  const lines = getMessageLines(msg);
  const maxOffset = Math.max(0, lines.length - height);
  const effectiveOffset = Math.min(scrollOffset, maxOffset);
  const visible = lines.slice(effectiveOffset, effectiveOffset + height);

  return (
    <Box flexDirection="column" marginLeft={2} marginTop={1}>
      {visible.map((line, i) => (
        <Text key={`line-${effectiveOffset + i}`}>{line}</Text>
      ))}
      {lines.length > height && (
        <Text dimColor>
          [{effectiveOffset + 1}-{Math.min(effectiveOffset + height, lines.length)}/{lines.length}]
        </Text>
      )}
    </Box>
  );
}

export function MailViewer({ messages, selectedIndex, expandedMessage, scrollOffset, height }: MailViewerProps) {
  const viewHeight = height ?? MAIL_VIEW_HEIGHT;

  if (messages.length === 0) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No messages.</Text>
      </Box>
    );
  }

  const expandedMsg = expandedMessage !== null ? messages.find((m) => m.id === expandedMessage) : null;

  if (expandedMsg) {
    return <MailDetail msg={expandedMsg} scrollOffset={scrollOffset} height={viewHeight} />;
  }

  // List mode: show messages with scroll window
  const maxOffset = Math.max(0, messages.length - viewHeight);
  const listOffset = Math.min(Math.max(0, selectedIndex - Math.floor(viewHeight / 2)), maxOffset);
  const visible = messages.slice(listOffset, listOffset + viewHeight);

  const unreadCount = messages.filter((m) => !m.read).length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box marginLeft={2}>
        <Text>
          <Text bold color="cyan">
            Mail
          </Text>
          {"  "}
          <Text dimColor>
            {messages.length} message{messages.length !== 1 ? "s" : ""}
            {unreadCount > 0 ? `, ${unreadCount} unread` : ""}
          </Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={2} marginTop={1}>
        {visible.map((msg, i) => (
          <MailListItem key={msg.id} msg={msg} selected={listOffset + i === selectedIndex} />
        ))}
      </Box>
      {messages.length > viewHeight && (
        <Box marginLeft={2}>
          <Text dimColor>
            [{listOffset + 1}-{Math.min(listOffset + viewHeight, messages.length)}/{messages.length}]
          </Text>
        </Box>
      )}
    </Box>
  );
}
