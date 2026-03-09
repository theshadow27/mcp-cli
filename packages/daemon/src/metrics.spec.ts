import { describe, expect, test } from "bun:test";
import { MetricsCollector } from "./metrics";

describe("MetricsCollector", () => {
  // -- Counter --

  test("counter starts at 0", () => {
    const m = new MetricsCollector();
    expect(m.counter("requests").value()).toBe(0);
  });

  test("counter inc() increments by 1", () => {
    const m = new MetricsCollector();
    const c = m.counter("requests");
    c.inc();
    c.inc();
    expect(c.value()).toBe(2);
  });

  test("counter inc(n) increments by n", () => {
    const m = new MetricsCollector();
    const c = m.counter("requests");
    c.inc(5);
    expect(c.value()).toBe(5);
  });

  test("counter with same name and labels returns same instance", () => {
    const m = new MetricsCollector();
    const c1 = m.counter("requests", { server: "a" });
    c1.inc(3);
    const c2 = m.counter("requests", { server: "a" });
    expect(c2.value()).toBe(3);
    c2.inc(2);
    expect(c1.value()).toBe(5);
  });

  test("counter with different labels are independent", () => {
    const m = new MetricsCollector();
    const c1 = m.counter("requests", { server: "a" });
    const c2 = m.counter("requests", { server: "b" });
    c1.inc(10);
    c2.inc(3);
    expect(c1.value()).toBe(10);
    expect(c2.value()).toBe(3);
  });

  // -- Gauge --

  test("gauge starts at 0", () => {
    const m = new MetricsCollector();
    expect(m.gauge("connections").value()).toBe(0);
  });

  test("gauge set() replaces value", () => {
    const m = new MetricsCollector();
    const g = m.gauge("connections");
    g.set(42);
    expect(g.value()).toBe(42);
    g.set(0);
    expect(g.value()).toBe(0);
  });

  test("gauge inc()/dec() modify value", () => {
    const m = new MetricsCollector();
    const g = m.gauge("connections");
    g.inc();
    g.inc();
    g.dec();
    expect(g.value()).toBe(1);
    g.inc(5);
    g.dec(3);
    expect(g.value()).toBe(3);
  });

  // -- Histogram --

  test("histogram observe tracks count and sum", () => {
    const m = new MetricsCollector();
    const h = m.histogram("latency", undefined, [10, 50, 100]);
    h.observe(5);
    h.observe(25);
    h.observe(75);

    const snap = m.toJSON();
    const hist = snap.histograms[0];
    expect(hist.count).toBe(3);
    expect(hist.sum).toBe(105);
  });

  test("histogram buckets accumulate correctly", () => {
    const m = new MetricsCollector();
    const h = m.histogram("latency", undefined, [10, 50, 100]);
    h.observe(5); // <= 10, <= 50, <= 100
    h.observe(25); // <= 50, <= 100
    h.observe(75); // <= 100
    h.observe(200); // none (only +Inf)

    const snap = m.toJSON();
    const hist = snap.histograms[0];
    // le=10: 1, le=50: 2, le=100: 3
    expect(hist.buckets).toEqual([
      { le: 10, count: 1 },
      { le: 50, count: 2 },
      { le: 100, count: 3 },
    ]);
  });

  test("histogram startTimer observes elapsed ms", async () => {
    const m = new MetricsCollector();
    const h = m.histogram("latency", undefined, [100, 500]);
    const stop = h.startTimer();
    await Bun.sleep(10);
    const elapsed = stop();

    expect(elapsed).toBeGreaterThan(5);
    const snap = m.toJSON();
    expect(snap.histograms[0].count).toBe(1);
    expect(snap.histograms[0].sum).toBeGreaterThan(5);
  });

  // -- Type conflicts --

  test("reusing name with different type throws", () => {
    const m = new MetricsCollector();
    m.counter("metric_a");
    expect(() => m.gauge("metric_a")).toThrow("already registered as counter");
  });

  // -- Label deduplication --

  test("labels sorted for consistent keys regardless of insertion order", () => {
    const m = new MetricsCollector();
    const c1 = m.counter("x", { b: "2", a: "1" });
    c1.inc(7);
    const c2 = m.counter("x", { a: "1", b: "2" });
    expect(c2.value()).toBe(7);
  });

  // -- Prometheus text format --

  test("counter renders as prometheus text", () => {
    const m = new MetricsCollector();
    m.counter("http_requests", { method: "GET" }).inc(42);

    const text = m.toPrometheusText();
    expect(text).toContain("# TYPE http_requests counter");
    expect(text).toContain('http_requests{method="GET"} 42');
  });

  test("gauge renders as prometheus text", () => {
    const m = new MetricsCollector();
    m.gauge("active_sessions").set(3);

    const text = m.toPrometheusText();
    expect(text).toContain("# TYPE active_sessions gauge");
    expect(text).toContain("active_sessions 3");
  });

  test("histogram renders buckets, count, and sum", () => {
    const m = new MetricsCollector();
    const h = m.histogram("latency_ms", { server: "a" }, [10, 50]);
    h.observe(5);
    h.observe(30);

    const text = m.toPrometheusText();
    expect(text).toContain("# TYPE latency_ms histogram");
    expect(text).toContain('latency_ms_bucket{server="a",le="10"} 1');
    expect(text).toContain('latency_ms_bucket{server="a",le="50"} 2');
    expect(text).toContain('latency_ms_bucket{server="a",le="+Inf"} 2');
    expect(text).toContain('latency_ms_count{server="a"} 2');
    expect(text).toContain('latency_ms_sum{server="a"} 35');
  });

  test("dots in metric names are replaced with underscores", () => {
    const m = new MetricsCollector();
    m.counter("mcpd.ipc.requests").inc();

    const text = m.toPrometheusText();
    expect(text).toContain("mcpd_ipc_requests");
    expect(text).not.toContain("mcpd.ipc.requests");
  });

  test("no labels renders without braces", () => {
    const m = new MetricsCollector();
    m.counter("total").inc(1);

    const text = m.toPrometheusText();
    expect(text).toContain("total 1");
    expect(text).not.toContain("total{");
  });

  test("prometheus text ends with trailing newline", () => {
    const m = new MetricsCollector();
    m.counter("x").inc();

    const text = m.toPrometheusText();
    expect(text.endsWith("\n")).toBe(true);
  });

  test("empty collector produces empty string", () => {
    const m = new MetricsCollector();
    expect(m.toPrometheusText()).toBe("");
  });

  // -- JSON snapshot --

  test("toJSON returns structured snapshot", () => {
    const m = new MetricsCollector();
    m.counter("c", { a: "1" }).inc(5);
    m.gauge("g").set(42);
    m.histogram("h", undefined, [10]).observe(7);

    const snap = m.toJSON();
    expect(snap.collectedAt).toBeGreaterThan(0);
    expect(snap.counters).toEqual([{ name: "c", labels: { a: "1" }, value: 5 }]);
    expect(snap.gauges).toEqual([{ name: "g", labels: {}, value: 42 }]);
    expect(snap.histograms).toHaveLength(1);
    expect(snap.histograms[0].name).toBe("h");
    expect(snap.histograms[0].count).toBe(1);
    expect(snap.histograms[0].sum).toBe(7);
  });

  // -- Reset --

  test("reset clears all metrics and type registry", () => {
    const m = new MetricsCollector();
    m.counter("a").inc();
    m.gauge("b").set(1);
    m.reset();

    expect(m.toJSON().counters).toEqual([]);
    expect(m.toJSON().gauges).toEqual([]);
    // After reset, name can be reused with different type
    m.gauge("a").set(5);
    expect(m.gauge("a").value()).toBe(5);
  });
});
