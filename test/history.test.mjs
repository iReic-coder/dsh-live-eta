import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HistoryStore } from '../lib/history.js';

test('history persists, reloads and dedupes seeded rows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-live-eta-'));
  try {
    const store = new HistoryStore(dir, { limit: 10 });
    await store.load();
    await store.append({ ms: 600_000, category: 'feature', seedKey: 's1#0', trace: [] });
    await store.append({ ms: 700_000, category: 'feature', seedKey: 's1#0', trace: [] });
    await store.append({ ms: 900_000, category: 'debug', trace: [] });
    assert.equal(store.records.length, 2);

    const text = await readFile(path.join(dir, 'history.jsonl'), 'utf8');
    assert.equal(text.trim().split('\n').length, 2);

    const reloaded = new HistoryStore(dir, { limit: 10 });
    await reloaded.load();
    assert.equal(reloaded.records.length, 2);
    await reloaded.append({ ms: 800_000, seedKey: 's1#0' });
    assert.equal(reloaded.records.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearing drops rows and seed keys', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-live-eta-'));
  try {
    const store = new HistoryStore(dir, { limit: 10 });
    await store.load();
    await store.append({ ms: 100_000, seedKey: 'a#1' });
    await store.clear();
    assert.equal(store.records.length, 0);
    await store.append({ ms: 120_000, seedKey: 'a#1' });
    assert.equal(store.records.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});