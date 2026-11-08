/**
 * dsh-live-eta / history
 *
 * Local calibration store: one JSONL line per completed task under
 * `<dshHome>/live-eta/history.jsonl`. Only counters and durations are stored;
 * the prompt text is reduced to a short label and can be disabled entirely.
 *
 * All writes go through one promise chain so concurrent sessions cannot
 * interleave partial lines. A failed write is reported to the caller, never
 * thrown into the agent loop.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = 'history.jsonl';

export class HistoryStore {
  /**
   * @param {string} dir  absolute directory for this plugin's data
   * @param {{limit?: number}} [options]
   */
  constructor(dir, options = {}) {
    this.dir = dir;
    this.limit = Math.max(50, Math.min(20_000, options.limit ?? 1_000));
    this.records = [];
    this.loaded = false;
    this.writeChain = Promise.resolve();
    this.lastError = null;
    this.file = path.join(dir, FILE);
    this.seedKeys = new Set();
  }

  async load() {
    if (this.loaded) return this.records;
    this.loaded = true;
    try {
      const text = await readFile(this.file, 'utf8');
      const rows = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (row && typeof row === 'object' && Number.isFinite(row.ms)) {
            rows.push(row);
            if (typeof row.seedKey === 'string') this.seedKeys.add(row.seedKey);
          }
        } catch {
          // A torn final line from a crash is expected; skip it.
        }
      }
      this.records = rows.slice(-this.limit);
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.lastError = String(error.message || error);
      this.records = [];
    }
    return this.records;
  }

  /** Append one record; resolves after the durable write. Seeded rows dedupe. */
  async append(record) {
    await this.load();
    if (record && typeof record.seedKey === 'string') {
      if (this.seedKeys.has(record.seedKey)) return this.writeChain;
      this.seedKeys.add(record.seedKey);
    }
    this.records.push(record);
    if (this.records.length > this.limit) this.records = this.records.slice(-this.limit);
    const line = JSON.stringify(record) + '\n';
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(this.file, line, 'utf8');
        if (this.records.length >= this.limit) await this.compact();
      })
      .catch((error) => {
        this.lastError = String((error && error.message) || error);
      });
    return this.writeChain;
  }

  /** Rewrite the file with the retained tail, via an atomic rename. */
  async compact() {
    const body = this.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, this.file);
  }

  async clear() {
    this.records = [];
    this.seedKeys.clear();
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await writeFile(this.file, '', 'utf8');
      })
      .catch((error) => {
        this.lastError = String((error && error.message) || error);
        throw error;
      });
    return this.writeChain;
  }

  summary() {
    return {
      dir: this.dir,
      records: this.records.length,
      limit: this.limit,
      lastError: this.lastError,
    };
  }
}