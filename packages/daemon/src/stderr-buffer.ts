/**
 * Per-server ring buffer for stderr lines.
 *
 * Keeps the most recent N lines in memory for fast retrieval
 * (e.g., IPC getLogs, status enrichment).
 */

export interface StderrLine {
  timestamp: number;
  line: string;
}

const DEFAULT_CAPACITY = 100;

export class StderrRingBuffer {
  private buffers = new Map<string, StderrLine[]>();
  private capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Append a line for the given server, returning the timestamped entry. */
  push(server: string, line: string): StderrLine {
    let buf = this.buffers.get(server);
    if (!buf) {
      buf = [];
      this.buffers.set(server, buf);
    }
    const entry: StderrLine = { timestamp: Date.now(), line };
    buf.push(entry);
    if (buf.length > this.capacity) {
      buf.splice(0, buf.length - this.capacity);
    }
    return entry;
  }

  /** Get lines for a server in chronological order. */
  getLines(server: string, limit?: number): StderrLine[] {
    const buf = this.buffers.get(server);
    if (!buf || buf.length === 0) return [];
    if (limit !== undefined && limit > 0) {
      return buf.slice(-limit);
    }
    return [...buf];
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
