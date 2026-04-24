import type { SessionStateEnum } from "@mcp-cli/core";

export interface StuckEvent {
  sessionId: string;
  tier: number;
  sinceMs: number;
  tokenDelta: number;
  lastTool: string | null;
  lastToolError: string | null;
}

export interface StuckDetectorConfig {
  thresholdsMs: number[];
  repeatMs: number;
}

export const DEFAULT_STUCK_CONFIG: StuckDetectorConfig = {
  thresholdsMs: [90_000, 180_000, 300_000],
  repeatMs: 300_000,
};

interface SessionSnapshot {
  state: SessionStateEnum;
  tokens: number;
  lastToolCall: { name: string; errorMessage?: string; at: number } | null;
  pendingPermissionCount: number;
}

export class StuckDetector {
  private timer: Timer | null = null;
  private lastProgressAt = 0;
  private emissionCount = 0;
  private tokenSnapshot = 0;
  private disposed = false;
  private readonly config: StuckDetectorConfig;
  private readonly sessionId: string;
  private readonly getSnapshot: () => SessionSnapshot;
  private readonly onStuck: (event: StuckEvent) => void;

  constructor(
    sessionId: string,
    config: StuckDetectorConfig,
    getSnapshot: () => SessionSnapshot,
    onStuck: (event: StuckEvent) => void,
  ) {
    if (config.thresholdsMs.length === 0) {
      throw new Error("StuckDetectorConfig.thresholdsMs must be non-empty");
    }
    for (let i = 0; i < config.thresholdsMs.length; i++) {
      if (!Number.isFinite(config.thresholdsMs[i]) || config.thresholdsMs[i] <= 0) {
        throw new Error(
          `StuckDetectorConfig.thresholdsMs[${i}] must be a positive finite number (got ${config.thresholdsMs[i]})`,
        );
      }
    }
    for (let i = 1; i < config.thresholdsMs.length; i++) {
      if (config.thresholdsMs[i] <= config.thresholdsMs[i - 1]) {
        throw new Error(
          `StuckDetectorConfig.thresholdsMs must be strictly ascending (index ${i}: ${config.thresholdsMs[i]} <= ${config.thresholdsMs[i - 1]})`,
        );
      }
    }
    if (config.repeatMs <= 0) {
      throw new Error(`StuckDetectorConfig.repeatMs must be positive (got ${config.repeatMs})`);
    }
    this.sessionId = sessionId;
    this.config = config;
    this.getSnapshot = getSnapshot;
    this.onStuck = onStuck;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get currentTier(): number {
    return this.tierForEmission(this.emissionCount);
  }

  recordProgress(tokens: number): void {
    if (this.disposed) return;
    this.lastProgressAt = performance.now();
    this.emissionCount = 0;
    this.tokenSnapshot = tokens;
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private scheduleNext(): void {
    this.stop();
    const delayMs = this.nextDelayMs(this.emissionCount);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.evaluate();
    }, delayMs);
  }

  private evaluate(): void {
    if (this.disposed) return;

    const snapshot = this.getSnapshot();

    if (snapshot.pendingPermissionCount > 0 || snapshot.state === "waiting_permission") {
      this.scheduleNext();
      return;
    }

    if (snapshot.state !== "active") {
      return;
    }

    const elapsed = performance.now() - this.lastProgressAt;
    const nextTier = this.tierForEmission(this.emissionCount);

    const tokenDelta = snapshot.tokens - this.tokenSnapshot;
    this.tokenSnapshot = snapshot.tokens;
    this.emissionCount++;

    this.onStuck({
      sessionId: this.sessionId,
      tier: nextTier,
      sinceMs: elapsed,
      tokenDelta,
      lastTool: snapshot.lastToolCall?.name ?? null,
      lastToolError: snapshot.lastToolCall?.errorMessage ?? null,
    });

    if (this.disposed) return;
    this.scheduleNext();
  }

  private tierForEmission(emissionCount: number): number {
    return Math.min(emissionCount + 1, this.config.thresholdsMs.length);
  }

  private nextDelayMs(emissionCount: number): number {
    const { thresholdsMs, repeatMs } = this.config;
    if (emissionCount === 0) return thresholdsMs[0];
    if (emissionCount < thresholdsMs.length) {
      return thresholdsMs[emissionCount] - thresholdsMs[emissionCount - 1];
    }
    return repeatMs;
  }
}
