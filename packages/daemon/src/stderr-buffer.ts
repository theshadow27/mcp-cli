/**
 * Per-server circular ring buffer for stderr lines.
 *
 * Keeps the most recent N lines in memory for fast retrieval
 * (e.g., IPC getLogs, status enrichment).
 *
 * Uses a fixed-size circular buffer instead of array splice
 * for O(1) push operations.
 */

export interface StderrLine {
  timestamp: number;
  line: string;
}

const DEFAULT_CAPACITY = 100;

export class StderrRingBuffer {
  private buffers = new Map<string, CircularBuffer>();
  private capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Append a line for the given server, returning the timestamped entry. */
  push(server: string, line: string): StderrLine {
    let buf = this.buffers.get(server);
    if (!buf) {
      buf = new CircularBuffer(this.capacity);
      this.buffers.set(server, buf);
    }
    const entry: StderrLine = { timestamp: Date.now(), line };
    buf.push(entry);
    return entry;
  }

  /** Get lines for a server in chronological order. */
  getLines(server: string, limit?: number): StderrLine[] {
    const buf = this.buffers.get(server);
    if (!buf) return [];
    return buf.toArray(limit);
  }

  /** Clear buffer for a specific server, or all servers. */
  clear(server?: string): void {
    if (server) {
      this.buffers.delete(server);
    } else {
      this.buffers.clear();
    }
  }
}

/** Fixed-size circular buffer with O(1) push. */
class CircularBuffer {
  private items: (StderrLine | undefined)[];
  private head = 0; // index of oldest item
  private count = 0;
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.items = new Array(capacity);
  }

  push(entry: StderrLine): void {
    if (this.count < this.capacity) {
      // Buffer not full yet — append
      this.items[(this.head + this.count) % this.capacity] = entry;
      this.count++;
    } else {
      // Buffer full — overwrite oldest
      this.items[this.head] = entry;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Return entries in chronological order, optionally limited to last N. */
  toArray(limit?: number): StderrLine[] {
    if (this.count === 0) return [];

    const n = limit !== undefined && limit > 0 ? Math.min(limit, this.count) : this.count;
    const start = (this.head + this.count - n) % this.capacity;
    const result: StderrLine[] = new Array(n);

    for (let i = 0; i < n; i++) {
      result[i] = this.items[(start + i) % this.capacity] as StderrLine;
    }
    return result;
  }
}
