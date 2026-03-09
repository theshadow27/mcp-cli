/**
 * Lightweight Prometheus-style metrics collector.
 *
 * Zero external dependencies. Counters, gauges, and histograms with label support.
 * Serializes to Prometheus text exposition format or JSON for IPC consumption.
 */

// -- Public types --

export type Labels = Record<string, string>;

export interface Counter {
  inc(n?: number): void;
  value(): number;
}

export interface Gauge {
  set(n: number): void;
  inc(n?: number): void;
  dec(n?: number): void;
  value(): number;
}

export interface Histogram {
  observe(value: number): void;
  /** Start a timer; call the returned function to observe elapsed ms. */
  startTimer(): () => number;
}

export interface MetricsSnapshot {
  daemonId?: string;
  startedAt?: number;
  collectedAt: number;
  counters: Array<{ name: string; labels: Labels; value: number }>;
  gauges: Array<{ name: string; labels: Labels; value: number }>;
  histograms: Array<{
    name: string;
    labels: Labels;
    count: number;
    sum: number;
    buckets: Array<{ le: number; count: number }>;
  }>;
}

// -- Internal types --

type MetricType = "counter" | "gauge" | "histogram";

interface CounterEntry {
  type: "counter";
  value: number;
}

interface GaugeEntry {
  type: "gauge";
  value: number;
}

interface HistogramEntry {
  type: "histogram";
  bucketBounds: number[];
  bucketCounts: number[];
  count: number;
  sum: number;
}

type MetricEntry = CounterEntry | GaugeEntry | HistogramEntry;

// -- Series key --

/** Canonical series key: "name|k1=v1,k2=v2" with sorted labels. */
function seriesKey(name: string, labels?: Labels): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
  return `${name}|${sorted}`;
}

function parseSeriesKey(key: string): { name: string; labels: Labels } {
  const pipe = key.indexOf("|");
  if (pipe === -1) return { name: key, labels: {} };
  const name = key.slice(0, pipe);
  const labels: Labels = {};
  for (const pair of key.slice(pipe + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name, labels };
}

// -- Default histogram buckets (milliseconds) --

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// -- MetricsCollector --

export class MetricsCollector {
  private entries = new Map<string, MetricEntry>();
  private typeRegistry = new Map<string, MetricType>();

  private assertType(name: string, expected: MetricType): void {
    const existing = this.typeRegistry.get(name);
    if (existing && existing !== expected) {
      throw new Error(`Metric "${name}" already registered as ${existing}, cannot use as ${expected}`);
    }
    this.typeRegistry.set(name, expected);
  }

  counter(name: string, labels?: Labels): Counter {
    this.assertType(name, "counter");
    const key = seriesKey(name, labels);
    let entry = this.entries.get(key) as CounterEntry | undefined;
    if (!entry) {
      entry = { type: "counter", value: 0 };
      this.entries.set(key, entry);
    }
    return {
      inc(n = 1) {
        entry.value += n;
      },
      value() {
        return entry.value;
      },
    };
  }

  gauge(name: string, labels?: Labels): Gauge {
    this.assertType(name, "gauge");
    const key = seriesKey(name, labels);
    let entry = this.entries.get(key) as GaugeEntry | undefined;
    if (!entry) {
      entry = { type: "gauge", value: 0 };
      this.entries.set(key, entry);
    }
    return {
      set(n: number) {
        entry.value = n;
      },
      inc(n = 1) {
        entry.value += n;
      },
      dec(n = 1) {
        entry.value -= n;
      },
      value() {
        return entry.value;
      },
    };
  }

  histogram(name: string, labels?: Labels, buckets?: number[]): Histogram {
    this.assertType(name, "histogram");
    const key = seriesKey(name, labels);
    let entry = this.entries.get(key) as HistogramEntry | undefined;
    if (!entry) {
      const bounds = buckets ?? DEFAULT_BUCKETS;
      entry = {
        type: "histogram",
        bucketBounds: bounds,
        bucketCounts: new Array(bounds.length + 1).fill(0), // +1 for +Inf
        count: 0,
        sum: 0,
      };
      this.entries.set(key, entry);
    }
    return {
      observe(value: number) {
        entry.count++;
        entry.sum += value;
        // Increment all buckets where value <= bound
        for (let i = 0; i < entry.bucketBounds.length; i++) {
          if (value <= entry.bucketBounds[i]) {
            entry.bucketCounts[i]++;
          }
        }
        // +Inf bucket always incremented
        entry.bucketCounts[entry.bucketBounds.length]++;
      },
      startTimer() {
        const start = performance.now();
        return () => {
          const elapsed = performance.now() - start;
          entry.count++;
          entry.sum += elapsed;
          for (let i = 0; i < entry.bucketBounds.length; i++) {
            if (elapsed <= entry.bucketBounds[i]) {
              entry.bucketCounts[i]++;
            }
          }
          entry.bucketCounts[entry.bucketBounds.length]++;
          return elapsed;
        };
      },
    };
  }

  /** Serialize all metrics to Prometheus text exposition format. */
  toPrometheusText(): string {
    const lines: string[] = [];
    const emittedTypes = new Set<string>();

    for (const [key, entry] of this.entries) {
      const { name, labels } = parseSeriesKey(key);
      const sanitized = name.replace(/\./g, "_");
      const labelStr = formatLabels(labels);

      if (!emittedTypes.has(sanitized)) {
        emittedTypes.add(sanitized);
        lines.push(`# TYPE ${sanitized} ${entry.type}`);
      }

      if (entry.type === "counter" || entry.type === "gauge") {
        lines.push(`${sanitized}${labelStr} ${entry.value}`);
      } else {
        // Histogram: emit _bucket, _count, _sum
        for (let i = 0; i < entry.bucketBounds.length; i++) {
          const bucketLabels = { ...labels, le: String(entry.bucketBounds[i]) };
          lines.push(`${sanitized}_bucket${formatLabels(bucketLabels)} ${entry.bucketCounts[i]}`);
        }
        lines.push(
          `${sanitized}_bucket${formatLabels({ ...labels, le: "+Inf" })} ${entry.bucketCounts[entry.bucketBounds.length]}`,
        );
        lines.push(`${sanitized}_count${labelStr} ${entry.count}`);
        lines.push(`${sanitized}_sum${labelStr} ${entry.sum}`);
      }
    }

    if (lines.length > 0) lines.push(""); // trailing newline per spec
    return lines.join("\n");
  }

  /** Serialize all metrics to a JSON snapshot for IPC consumption. */
  toJSON(): MetricsSnapshot {
    const snap: MetricsSnapshot = {
      collectedAt: Date.now(),
      counters: [],
      gauges: [],
      histograms: [],
    };

    for (const [key, entry] of this.entries) {
      const { name, labels } = parseSeriesKey(key);

      if (entry.type === "counter") {
        snap.counters.push({ name, labels, value: entry.value });
      } else if (entry.type === "gauge") {
        snap.gauges.push({ name, labels, value: entry.value });
      } else {
        const buckets = entry.bucketBounds.map((le, i) => ({
          le,
          count: entry.bucketCounts[i],
        }));
        snap.histograms.push({
          name,
          labels,
          count: entry.count,
          sum: entry.sum,
          buckets,
        });
      }
    }

    return snap;
  }

  /** Reset all metrics (primarily for testing). */
  reset(): void {
    this.entries.clear();
    this.typeRegistry.clear();
  }
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}

// -- Singleton --

export const metrics = new MetricsCollector();
