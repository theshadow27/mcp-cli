import { Box, Text } from "ink";
import React from "react";
import { ALL_TABS, type View } from "../hooks/use-keyboard.js";

export interface TabBadge {
  count: number;
  color?: "red" | "yellow";
}

interface TabBarProps {
  activeTab: View;
  badges?: Partial<Record<View, TabBadge>>;
}

function capitalize(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/** Build badge map from session/server counts for the tab bar. */
export function buildBadges(opts: {
  sessionCount: number;
  pendingPermissionCount: number;
  errorServerCount: number;
  unreadMailCount?: number;
}): Partial<Record<View, TabBadge>> {
  const badges: Partial<Record<View, TabBadge>> = {};
  if (opts.sessionCount > 0) {
    badges.claude =
      opts.pendingPermissionCount > 0 ? { count: opts.sessionCount, color: "red" } : { count: opts.sessionCount };
  }
  if (opts.errorServerCount > 0) {
    badges.servers = { count: opts.errorServerCount, color: "red" };
  }
  if (opts.unreadMailCount && opts.unreadMailCount > 0) {
    badges.mail = { count: opts.unreadMailCount, color: "yellow" };
  }
  return badges;
}

const NO_BADGES: Partial<Record<View, TabBadge>> = {};

export function TabBar({ activeTab, badges = NO_BADGES }: TabBarProps) {
  return (
    <Box marginBottom={1}>
      <Text>
        {ALL_TABS.map((tab, i) => {
          const badge = badges[tab];
          const badgeText = badge && badge.count > 0 ? ` (${badge.count})` : "";
          const attentionColor = badge?.color;
          const label = ` ${i + 1}:${capitalize(tab)}${badgeText} `;
          const isActive = tab === activeTab;
          const sep = i < ALL_TABS.length - 1 ? "│" : "";

          return (
            <React.Fragment key={tab}>
              {isActive ? (
                <Text bold color="cyan" inverse>
                  {label}
                </Text>
              ) : attentionColor ? (
                <Text color={attentionColor}>{label}</Text>
              ) : (
                <Text dimColor>{label}</Text>
              )}
              {sep ? <Text dimColor>{sep}</Text> : null}
            </React.Fragment>
          );
        })}
      </Text>
    </Box>
  );
}
