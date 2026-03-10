import type { MetricsSnapshot } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React from "react";

interface StatsViewProps {
  metrics: MetricsSnapshot | null;
  loading: boolean;
  error: string | null;
}

/** Find a counter value by name and optional label match. */
export function findCounter(metrics: MetricsSnapshot, name: string, labels?: Record<string, string>): number {
  let total = 0;
  for (const c of metrics.counters) {
    if (c.name !== name) continue;
    if (labels && !labelsMatch(c.labels, labels)) continue;
    total += c.value;
  }
  return total;
}

/** Find a gauge value by name and optional label match. */
export function findGauge(metrics: MetricsSnapshot, name: string, labels?: Record<string, string>): number {
  for (const g of metrics.gauges) {
    if (g.name !== name) continue;
    if (labels && !labelsMatch(g.labels, labels)) continue;
    return g.value;
  }
  return 0;
}

/** Compute a percentile from histogram buckets. */
export function percentile(buckets: Array<{ le: number; count: number }>, totalCount: number, p: number): number {
  if (totalCount === 0) return 0;
  const target = totalCount * p;
  for (const b of buckets) {
    if (b.count >= target) return b.le;
  }
  return buckets.length > 0 ? buckets[buckets.length - 1].le : 0;
}

function labelsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

/** Aggregate tool call metrics grouped by server. */
export interface ServerToolStats {
  server: string;
  calls: number;
  errors: number;
  avgMs: number;
}

export function aggregateByServer(metrics: MetricsSnapshot): ServerToolStats[] {
  const map = new Map<string, { calls: number; errors: number; sumMs: number }>();

  for (const c of metrics.counters) {
    if (c.name === "mcpd_tool_calls_total" && c.labels.server) {
      const key = c.labels.server;
      const entry = map.get(key) ?? { calls: 0, errors: 0, sumMs: 0 };
      entry.calls += c.value;
      map.set(key, entry);
    }
    if (c.name === "mcpd_tool_errors_total" && c.labels.server) {
      const key = c.labels.server;
      const entry = map.get(key) ?? { calls: 0, errors: 0, sumMs: 0 };
      entry.errors += c.value;
      map.set(key, entry);
    }
  }

  for (const h of metrics.histograms) {
    if (h.name === "mcpd_tool_call_duration_ms" && h.labels.server) {
      const entry = map.get(h.labels.server);
      if (entry) entry.sumMs += h.sum;
    }
  }

  return Array.from(map.entries())
    .map(([server, s]) => ({
      server,
      calls: s.calls,
      errors: s.errors,
      avgMs: s.calls > 0 ? s.sumMs / s.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls);
}

/** Top tools by call count. */
export interface ToolCallStat {
  server: string;
  tool: string;
  calls: number;
}

export function topTools(metrics: MetricsSnapshot, limit = 10): ToolCallStat[] {
  const tools: ToolCallStat[] = [];
  for (const c of metrics.counters) {
    if (c.name === "mcpd_tool_calls_total" && c.labels.server && c.labels.tool) {
      tools.push({ server: c.labels.server, tool: c.labels.tool, calls: c.value });
    }
  }
  return tools.sort((a, b) => b.calls - a.calls).slice(0, limit);
}

function fmt(n: number, decimals = 1): string {
  return n % 1 === 0 ? String(n) : n.toFixed(decimals);
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function StatsView({ metrics, loading, error }: StatsViewProps) {
  if (loading && !metrics) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>Loading metrics...</Text>
      </Box>
    );
  }

  if (error && !metrics) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!metrics) {
    return (
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>No metrics available.</Text>
      </Box>
    );
  }

  const totalCalls = findCounter(metrics, "mcpd_tool_calls_total");
  const totalErrors = findCounter(metrics, "mcpd_tool_errors_total");
  const successRate = totalCalls > 0 ? ((totalCalls - totalErrors) / totalCalls) * 100 : 0;
  const ipcRequests = findCounter(metrics, "mcpd_ipc_requests_total");
  const ipcErrors = findCounter(metrics, "mcpd_ipc_errors_total");
  const uptime = findGauge(metrics, "mcpd_uptime_seconds");
  const serversTotal = findGauge(metrics, "mcpd_servers_total");
  const serversConnected = findGauge(metrics, "mcpd_servers_connected");
  const activeSessions = findGauge(metrics, "mcpd_active_sessions");

  // Aggregate tool call duration histogram for p50/p99
  let totalHistCount = 0;
  const mergedBuckets = new Map<number, number>();
  for (const h of metrics.histograms) {
    if (h.name === "mcpd_tool_call_duration_ms") {
      totalHistCount += h.count;
      for (const b of h.buckets) {
        mergedBuckets.set(b.le, (mergedBuckets.get(b.le) ?? 0) + b.count);
      }
    }
  }
  const sortedBuckets = Array.from(mergedBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([le, count]) => ({ le, count }));

  const p50 = percentile(sortedBuckets, totalHistCount, 0.5);
  const p99 = percentile(sortedBuckets, totalHistCount, 0.99);

  const serverStats = aggregateByServer(metrics);
  const topToolsList = topTools(metrics, 8);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Aggregate dashboard */}
      <Box marginLeft={2} flexDirection="column">
        <Text bold color="cyan">
          Dashboard
        </Text>
        <Box marginLeft={2} flexDirection="column">
          <Text>
            <Text dimColor>uptime:</Text> {formatUptime(uptime)}
            {"  "}
            <Text dimColor>servers:</Text> {serversConnected}/{serversTotal}
            {"  "}
            <Text dimColor>sessions:</Text> {activeSessions}
          </Text>
          <Text>
            <Text dimColor>tool calls:</Text> {totalCalls}
            {"  "}
            <Text dimColor>errors:</Text> <Text color={totalErrors > 0 ? "red" : undefined}>{totalErrors}</Text>
            {"  "}
            <Text dimColor>success:</Text>{" "}
            <Text color={successRate >= 99 ? "green" : successRate >= 90 ? "yellow" : "red"}>{fmt(successRate)}%</Text>
          </Text>
          <Text>
            <Text dimColor>p50:</Text> {fmt(p50)}ms{"  "}
            <Text dimColor>p99:</Text> {fmt(p99)}ms{"  "}
            <Text dimColor>ipc reqs:</Text> {ipcRequests}
            {"  "}
            <Text dimColor>ipc errs:</Text> {ipcErrors}
          </Text>
        </Box>
      </Box>

      {/* Per-server breakdown */}
      {serverStats.length > 0 && (
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            Servers
          </Text>
          {serverStats.map((s) => (
            <Box key={s.server} marginLeft={2}>
              <Text>
                <Text bold>{s.server}</Text>
                {"  "}
                <Text dimColor>calls:</Text> {s.calls}
                {"  "}
                <Text dimColor>errors:</Text> <Text color={s.errors > 0 ? "red" : undefined}>{s.errors}</Text>
                {"  "}
                <Text dimColor>avg:</Text> {fmt(s.avgMs)}ms
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Top tools */}
      {topToolsList.length > 0 && (
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text bold color="cyan">
            Top Tools
          </Text>
          {topToolsList.map((t) => (
            <Box key={`${t.server}:${t.tool}`} marginLeft={2}>
              <Text>
                <Text dimColor>{t.server}/</Text>
                <Text>{t.tool}</Text>
                {"  "}
                <Text dimColor>{t.calls} calls</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
