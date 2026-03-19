import type { Plan } from "@mcp-cli/core";
import { Box, Text } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSessionList } from "./components/agent-session-list.js";
import { AuthBanner, type AuthStatus, isAuthError } from "./components/auth-banner.js";
import { Footer } from "./components/footer.js";
import { Header } from "./components/header.js";
import { Loading } from "./components/loading.js";
import { LogViewer } from "./components/log-viewer.js";
import { MailViewer } from "./components/mail-viewer.js";
import { PlansTab } from "./components/plans-tab.js";
import { ServerList } from "./components/server-list.js";
import { StatsView, buildStatsLines } from "./components/stats-view.js";
import { TabBar, buildBadges } from "./components/tab-bar.js";
import { useAgentSessions } from "./hooks/use-agent-sessions.js";
import { useDaemonProcessCount } from "./hooks/use-daemon-process-count.js";
import { useDaemon } from "./hooks/use-daemon.js";
import { type ExpandedPlanKey, type StatusType, getTargetPlan, hasCapability } from "./hooks/use-keyboard-plans.js";
import type { View } from "./hooks/use-keyboard.js";
import { useKeyboard } from "./hooks/use-keyboard.js";
import { filterLogLines, useLogs } from "./hooks/use-logs.js";
import { useMail } from "./hooks/use-mail.js";
import { useMetrics } from "./hooks/use-metrics.js";
import { usePlanMetrics, usePlans } from "./hooks/use-plans.js";
import { useTranscript } from "./hooks/use-transcript.js";
import { useUnreadMail } from "./hooks/use-unread-mail.js";

const LOG_VIEW_HEIGHT = 20;
const STATS_VIEW_HEIGHT = 20;
const TRANSCRIPT_VIEW_HEIGHT = 15;

export function App() {
  const { status, error, loading, refresh } = useDaemon({ intervalMs: 2500 });
  const daemonProcessCount = useDaemonProcessCount();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const authTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [view, setView] = useState<View>("servers");
  const [logScrollOffset, setLogScrollOffset] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [claudeSelectedIndex, setClaudeSelectedIndex] = useState(0);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [permissionIndex, setPermissionIndex] = useState(0);
  const [denyReasonMode, setDenyReasonMode] = useState(false);
  const [denyReasonText, setDenyReasonText] = useState("");
  const [promptMode, setPromptMode] = useState(false);
  const [promptText, setPromptText] = useState("");
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<ReadonlySet<string>>(new Set());
  const [transcriptScrollOffset, setTranscriptScrollOffset] = useState(0);
  const [statsScrollOffset, setStatsScrollOffset] = useState(0);
  const [mailSelectedIndex, setMailSelectedIndex] = useState(0);
  const [expandedMessage, setExpandedMessage] = useState<number | null>(null);
  const [mailScrollOffset, setMailScrollOffset] = useState(0);
  const [plansSelectedIndex, setPlansSelectedIndex] = useState(0);
  const [expandedPlan, setExpandedPlan] = useState<ExpandedPlanKey | null>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  /** Track which plan is selected by identity so refreshes don't shift selection. */
  const plansSelectionIdRef = useRef<{ server: string; id: string } | null>(null);
  const plansRef = useRef<Plan[]>([]);
  const [planConfirmAbort, setPlanConfirmAbort] = useState(false);
  const [planStatusMessage, setPlanStatusMessage] = useState<string | null>(null);
  const [planStatusType, setPlanStatusType] = useState<StatusType | null>(null);
  const [planInflight, setPlanInflight] = useState(false);
  const [planRefreshing, setPlanRefreshing] = useState(false);

  const servers = status?.servers ?? [];
  // Poll faster on agents tab, slower off-tab (badge still updates)
  const {
    sessions,
    loading: claudeLoading,
    error: claudeError,
  } = useAgentSessions({ intervalMs: view === "agents" ? 2500 : 10_000 });

  // Determine provider for expanded session's transcript
  const expandedProvider = sessions.find((s) => s.sessionId === expandedSession)?.provider ?? "claude";
  const { entries: transcriptEntries, error: transcriptError } = useTranscript(
    view === "agents" ? expandedSession : null,
    expandedProvider,
  );
  const {
    metrics: metricsData,
    error: metricsError,
    loading: metricsLoading,
    restartedAt: metricsRestartedAt,
  } = useMetrics({ enabled: view === "stats" });
  const {
    lines: logLines,
    source: logSource,
    setSource: setLogSource,
  } = useLogs(servers, { enabled: view === "logs" });

  const { messages: mailMessages } = useMail({ enabled: view === "mail" });
  const { unreadCount: unreadMailCount } = useUnreadMail({ enabled: view !== "mail" });

  // Plans: poll list on plans tab, poll metrics only when visible and metrics-capable
  const plansEnabled = view === "plans";
  const {
    plans,
    loading: plansLoading,
    error: plansError,
    disconnected: plansDisconnected,
    failedServers: plansFailedServers,
    refresh: plansRefresh,
  } = usePlans({ enabled: plansEnabled });
  plansRef.current = plans;
  const setPlansSelectedIndexTracked = useCallback((updater: number | ((i: number) => number)) => {
    setPlansSelectedIndex((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      const plan = plansRef.current[next];
      if (plan) plansSelectionIdRef.current = { server: plan.server, id: plan.id };
      return next;
    });
  }, []);
  const selectedPlan = plans[plansSelectedIndex] ?? null;
  const targetPlan = useMemo(
    () => getTargetPlan(plans, expandedPlan, plansSelectedIndex),
    [plans, expandedPlan, plansSelectedIndex],
  );
  const selectedPlanServer = selectedPlan?.server ?? "";
  const supportsMetrics =
    servers.find((s) => s.name === selectedPlanServer)?.planCapabilities?.capabilities.includes("metrics") ?? false;
  const { metrics: planMetrics, loading: planMetricsLoading } = usePlanMetrics(
    selectedPlan?.id ?? "",
    selectedPlan?.activeStepId,
    selectedPlanServer,
    {
      enabled: plansEnabled && !!selectedPlan,
      supportsMetrics,
    },
  );
  const filteredLogLines = useMemo(() => filterLogLines(logLines, filterText), [logLines, filterText]);
  const statsLineCount = useMemo(
    () => (metricsData ? buildStatsLines(metricsData, metricsError).length : 0),
    [metricsData, metricsError],
  );
  const prevFilterRef = useRef(filterText);

  // Auto-scroll: follow new lines at the tail, or force-jump when filter changes
  useEffect(() => {
    const filterChanged = prevFilterRef.current !== filterText;
    prevFilterRef.current = filterText;

    const maxOffset = Math.max(0, filteredLogLines.length - LOG_VIEW_HEIGHT);
    setLogScrollOffset((prev) => {
      if (filterChanged) return maxOffset;
      if (prev >= maxOffset - 1 || prev === 0) return maxOffset;
      return prev;
    });
  }, [filteredLogLines.length, filterText]);

  // Reset transcript navigation when expanded session changes
  const prevExpandedRef = useRef(expandedSession);
  if (prevExpandedRef.current !== expandedSession) {
    prevExpandedRef.current = expandedSession;
    setTranscriptCursor(null);
    setExpandedEntries(new Set());
    setTranscriptScrollOffset(0);
  }

  // Clamp claudeSelectedIndex when sessions list shrinks
  useEffect(() => {
    setClaudeSelectedIndex((i) => Math.min(i, Math.max(0, sessions.length - 1)));
  }, [sessions.length]);

  // Clamp mailSelectedIndex when messages list shrinks
  useEffect(() => {
    setMailSelectedIndex((i) => Math.min(i, Math.max(0, mailMessages.length - 1)));
  }, [mailMessages.length]);

  // Restore selection by identity when plans list refreshes, fall back to clamp.
  // Prioritize snapping to the expanded plan so cursor and detail panel stay in sync.
  useEffect(() => {
    if (expandedPlan && plans.length > 0) {
      const idx = plans.findIndex((p) => p.server === expandedPlan.server && p.id === expandedPlan.id);
      if (idx >= 0) {
        setPlansSelectedIndex(idx);
        plansSelectionIdRef.current = { server: expandedPlan.server, id: expandedPlan.id };
        return;
      }
    }
    const id = plansSelectionIdRef.current;
    if (id && plans.length > 0) {
      const idx = plans.findIndex((p) => p.server === id.server && p.id === id.id);
      if (idx >= 0) {
        setPlansSelectedIndex(idx);
        return;
      }
    }
    setPlansSelectedIndex((i) => Math.min(i, Math.max(0, plans.length - 1)));
  }, [plans, expandedPlan]);

  // Clear orphaned expandedMessage when the message disappears from the list
  useEffect(() => {
    if (expandedMessage !== null && !mailMessages.some((m) => m.id === expandedMessage)) {
      setExpandedMessage(null);
    }
  }, [mailMessages, expandedMessage]);

  // Clear orphaned expandedPlan when the plan disappears
  useEffect(() => {
    if (expandedPlan !== null && !plans.some((p) => p.id === expandedPlan.id && p.server === expandedPlan.server)) {
      setExpandedPlan(null);
      setSelectedStep(0);
    }
  }, [plans, expandedPlan]);

  // Clamp selectedStep when expanded plan's step count changes
  useEffect(() => {
    if (expandedPlan === null) return;
    const expanded = plans.find((p) => p.id === expandedPlan.id && p.server === expandedPlan.server);
    if (expanded) {
      setSelectedStep((i) => Math.min(i, Math.max(0, expanded.steps.length - 1)));
    }
  }, [plans, expandedPlan]);

  // Clamp permission index when selected session or permission count changes
  const selectedSessionId = sessions[claudeSelectedIndex]?.sessionId;
  const permCount = sessions[claudeSelectedIndex]?.pendingPermissionDetails?.length ?? 0;
  const prevSessionRef = useRef(selectedSessionId);
  useEffect(() => {
    if (prevSessionRef.current !== selectedSessionId) {
      prevSessionRef.current = selectedSessionId;
      setPermissionIndex(0);
    } else {
      setPermissionIndex((i) => Math.min(i, Math.max(0, permCount - 1)));
    }
  }, [selectedSessionId, permCount]);

  // Auto-clear success/error auth status after 5 seconds
  useEffect(() => {
    if (authStatus && authStatus.state !== "pending") {
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
      authTimerRef.current = setTimeout(() => setAuthStatus(null), 5000);
    }
    return () => {
      if (authTimerRef.current) clearTimeout(authTimerRef.current);
    };
  }, [authStatus]);

  useKeyboard({
    view,
    setView,
    serversNav: {
      servers,
      selectedIndex,
      setSelectedIndex,
      expandedServer,
      setExpandedServer,
      refresh,
      authStatus,
      setAuthStatus,
    },
    logsNav: {
      logSource,
      setLogSource,
      logScrollOffset,
      setLogScrollOffset,
      logLineCount: filteredLogLines.length,
      filterMode,
      setFilterMode,
      filterText,
      setFilterText,
    },
    claudeNav: {
      sessions,
      selectedIndex: claudeSelectedIndex,
      setSelectedIndex: setClaudeSelectedIndex,
      expandedSession,
      setExpandedSession,
      permissionIndex,
      setPermissionIndex,
      denyReasonMode,
      setDenyReasonMode,
      denyReasonText,
      setDenyReasonText,
      transcriptCursor,
      setTranscriptCursor,
      transcriptEntries,
      expandedEntries,
      setExpandedEntries,
      transcriptScrollOffset,
      setTranscriptScrollOffset,
      transcriptViewHeight: TRANSCRIPT_VIEW_HEIGHT,
      promptMode,
      setPromptMode,
      promptText,
      setPromptText,
    },
    statsNav: {
      scrollOffset: statsScrollOffset,
      setScrollOffset: setStatsScrollOffset,
      lineCount: statsLineCount,
    },
    plansNav: {
      plans,
      selectedIndex: plansSelectedIndex,
      setSelectedIndex: setPlansSelectedIndexTracked,
      expandedPlan,
      setExpandedPlan,
      selectedStep,
      setSelectedStep,
      servers,
      confirmAbort: planConfirmAbort,
      setConfirmAbort: setPlanConfirmAbort,
      statusMessage: planStatusMessage,
      setStatusMessage: setPlanStatusMessage,
      statusType: planStatusType,
      setStatusType: setPlanStatusType,
      inflight: planInflight,
      setInflight: setPlanInflight,
      refreshing: planRefreshing,
      setRefreshing: setPlanRefreshing,
      refresh: plansRefresh,
    },
    mailNav: {
      messages: mailMessages,
      selectedIndex: mailSelectedIndex,
      setSelectedIndex: setMailSelectedIndex,
      expandedMessage,
      setExpandedMessage,
      scrollOffset: mailScrollOffset,
      setScrollOffset: setMailScrollOffset,
    },
  });

  if (loading && !status) return <Loading />;

  const needsAuth = servers.filter((s) => s.state === "error" && isAuthError(s.lastError));
  const pendingPermissionCount = sessions.reduce((n, s) => n + s.pendingPermissions, 0);
  const errorServerCount = servers.filter((s) => s.state === "error").length;
  const badges = buildBadges({
    sessionCount: sessions.length,
    pendingPermissionCount,
    errorServerCount,
    unreadMailCount,
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header status={status} error={error} daemonProcessCount={daemonProcessCount} />
      <TabBar activeTab={view} badges={badges} />
      {view === "servers" ? (
        <>
          {(needsAuth.length > 0 || authStatus) && <AuthBanner servers={needsAuth} authStatus={authStatus} />}
          <ServerList
            servers={servers}
            selectedIndex={selectedIndex}
            expandedServer={expandedServer}
            usageStats={status?.usageStats ?? []}
            serveInstances={status?.serveInstances}
          />
        </>
      ) : view === "logs" ? (
        <LogViewer
          lines={filteredLogLines}
          source={logSource}
          servers={servers}
          scrollOffset={logScrollOffset}
          height={LOG_VIEW_HEIGHT}
          filterText={filterText}
          totalCount={logLines.length}
        />
      ) : view === "agents" ? (
        <AgentSessionList
          sessions={sessions}
          selectedIndex={claudeSelectedIndex}
          expandedSession={expandedSession}
          loading={claudeLoading}
          error={claudeError}
          permissionIndex={permissionIndex}
          transcriptEntries={transcriptEntries}
          transcriptError={transcriptError}
          transcriptSelectedEntry={transcriptCursor}
          transcriptExpandedEntries={expandedEntries}
          transcriptScrollOffset={transcriptScrollOffset}
          transcriptViewHeight={TRANSCRIPT_VIEW_HEIGHT}
        />
      ) : view === "stats" ? (
        <StatsView
          metrics={metricsData}
          loading={metricsLoading}
          error={metricsError}
          restartedAt={metricsRestartedAt}
          scrollOffset={statsScrollOffset}
          height={STATS_VIEW_HEIGHT}
        />
      ) : view === "plans" ? (
        <PlansTab
          plans={plans}
          loading={plansLoading}
          error={plansError}
          disconnected={plansDisconnected}
          failedServers={plansFailedServers}
          selectedIndex={plansSelectedIndex}
          expandedPlan={expandedPlan}
          selectedStep={selectedStep}
          servers={servers}
          statusMessage={planStatusMessage}
          statusType={planStatusType}
          confirmAbort={planConfirmAbort}
        />
      ) : (
        <MailViewer
          messages={mailMessages}
          selectedIndex={mailSelectedIndex}
          expandedMessage={expandedMessage}
          scrollOffset={mailScrollOffset}
        />
      )}
      <Footer
        view={view}
        filterMode={filterMode}
        filterText={filterText}
        denyReasonMode={denyReasonMode}
        denyReasonText={denyReasonText}
        promptMode={promptMode}
        promptText={promptText}
        transcriptExpanded={expandedSession !== null}
        mailExpanded={expandedMessage !== null}
        planExpanded={expandedPlan !== null}
        planConfirmAbort={planConfirmAbort}
        canAdvance={targetPlan ? hasCapability(servers, targetPlan.server, "advance") : false}
        canAbort={targetPlan ? hasCapability(servers, targetPlan.server, "abort") : false}
      />
    </Box>
  );
}
