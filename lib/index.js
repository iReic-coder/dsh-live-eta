/**
 * dsh-live-eta — host half.
 *
 * Listens to the existing `session/event` feed and derives, per task (one
 * agent turn), a category prior plus a continuously corrected ETA with an
 * empirical probability. No model calls, no prompt context, no tools.
 *
 * Routes (loopback only):
 *   GET  /api/dsh-live-eta?session=<id>[&debug=1]  live state for one session
 *   GET  /api/dsh-live-eta                        tracked summary + perf
 *   POST /api/dsh-live-eta {"action":"clear"}     clear local history
 *   POST /api/dsh-live-eta {"action":"stats"}     refresh calibration report
 *   POST /api/dsh-live-eta {"action":"backtest"}  replay real sessions
 */

import os from 'node:os';
import path from 'node:path';
import {
  EtaTask,
  buildCalibration,
  calibrationOf,
  classify,
  priorFor,
  probabilityFor,
  statsFor,
  statsForAll,
} from './eta-core.js';
import { HistoryStore } from './history.js';

export const name = 'dsh-live-eta';
export const inject = ['sessions'];

const ROUTE = '/api/dsh-live-eta';

const DEFAULTS = {
  route: ROUTE,
  /** Wall clock (ms) without verifiable progress before "疑似停滞". */
  stallMs: 240_000,
  /** How long a finished task stays visible on the card. */
  doneTtlMs: 600_000,
  /** Local calibration file retention. */
  historyLimit: 1_000,
  /** Keep the short task label in the history file. */
  storeTaskText: true,
  /** Override the data directory (default `<DSH_HOME>/live-eta`). */
  dataDir: null,
  /** Sessions replayed by one backtest request. */
  backtestSessions: 120,
  /** Wall-clock budget for one backtest request. */
  backtestBudgetMs: 20_000,
};

function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const num = (v, fallback, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  return {
    route: typeof c.route === 'string' && c.route.startsWith('/') ? c.route : DEFAULTS.route,
    stallMs: num(c.stallMs, DEFAULTS.stallMs, 60_000, 3_600_000),
    doneTtlMs: num(c.doneTtlMs, DEFAULTS.doneTtlMs, 0, 86_400_000),
    historyLimit: num(c.historyLimit, DEFAULTS.historyLimit, 50, 20_000),
    storeTaskText: c.storeTaskText !== false,
    dataDir: typeof c.dataDir === 'string' && c.dataDir ? c.dataDir : path.join(home, 'live-eta'),
    backtestSessions: num(c.backtestSessions, DEFAULTS.backtestSessions, 1, 200),
    backtestBudgetMs: num(c.backtestBudgetMs, DEFAULTS.backtestBudgetMs, 1_000, 60_000),
  };
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The route exposes task labels, so it never answers beyond the local host. */
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Split a session log into per-turn event groups, ending at turn/end. */
function splitTurns(events) {
  const groups = [];
  let current = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.type === 'turn/start') {
      if (current) groups.push(current);
      current = [];
      const previous = events[i - 1];
      if (previous && previous.type === 'user/message') current.push(previous);
    }
    if (current) current.push(event);
  }
  if (current) groups.push(current);
  return groups.filter((group) => group.length > 1 && group[group.length - 1].type === 'turn/end');
}

/** Replay one turn through a fresh tracker, sampling the estimate every 15 s. */
function replayTurn(events, priorFactory, stallMs, workspace) {
  const first = events[0];
  const task = new EtaTask({
    sessionId: 'replay',
    startedAt: first.time,
    prior: priorFor(classify(''), null),
    priorFactory,
    workspace: workspace || null,
  });
  let lastSample = 0;
  for (const event of events) {
    task.observe(event);
    if (task.endedAt === null && (lastSample === 0 || event.time - lastSample >= 15_000)) {
      task.snapshot(event.time, stallMs);
      lastSample = event.time;
    }
  }
  if (task.endedAt === null || task.endKind !== 'completed') return null;
  return task.calibrationRecord(true, undefined);
}

class EtaEngine {
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.tasks = new Map();
    this.models = new Map();
    this.history = new HistoryStore(cfg.dataDir, { limit: cfg.historyLimit });
    this.ready = this.history.load().catch(() => undefined);
    this.perf = {
      events: 0,
      handlerMs: 0,
      failures: 0,
      bootstraps: 0,
      routes: 0,
      routeMs: 0,
      calibrations: 0,
      backtests: 0,
      lastError: null,
      lastFailureAt: 0,
    };
    this.calibrationCache = { at: 0, value: null };
  }

  // -- calibration ---------------------------------------------------------

  calibrationModel() {
    const now = Date.now();
    if (this.calibrationCache.value && now - this.calibrationCache.at < 30_000) {
      return this.calibrationCache.value;
    }
    const value = buildCalibration(this.history.records);
    this.calibrationCache = { at: now, value };
    return value;
  }

  calibration() {
    const model = this.calibrationModel();
    return {
      tasks: model.tasks,
      samples: model.samples,
      hw70: model.hw70,
      checkpoints: model.checkpoints,
      ...calibrationOf(this.history.records),
    };
  }

  priorFactory(classified, model, workspace) {
    // Thin categories borrow the pooled distribution: with a handful of real
    // tasks, category medians are noise and the pooled level is the better
    // prior. The static category base still leads the blend.
    let stats = statsFor(this.history.records, classified.category, model, workspace);
    if (stats.n === 0) {
      const pooled = statsForAll(this.history.records, model, workspace);
      if (pooled.n >= 3) stats = pooled;
    }
    const prior = priorFor(classified, stats);
    const calibration = this.calibrationModel();
    prior.hw70 = calibration.hw70;
    prior.intervalModel = calibration.intervalModel;
    return prior;
  }

  // -- task lifecycle ------------------------------------------------------

  startTask(session, startedAt) {
    const header = (session && session.header) || {};
    const model = this.models.get(session.id) || null;
    const task = new EtaTask({
      sessionId: session.id,
      startedAt,
      prior: { median: 10 * 60_000, n: 0, hw: 0.6, base: 10 * 60_000 },
      model,
      child: header.origin === 'subagent',
      workspace: header.cwd || null,
      priorFactory: (classified, currentModel) => this.priorFactory(classified, currentModel, header.cwd || null),
    });
    task.parentSession = header.parentSession || null;
    this.tasks.set(session.id, task);
    return task;
  }

  finishTask(task, session, record = true) {
    if (task.recorded) return;
    task.recorded = true;
    if (!record) return;
    const ok = task.endKind === 'completed';
    const label = this.cfg.storeTaskText ? task.label : undefined;
    const entry = task.calibrationRecord(ok, label);
    this.perf.calibrations += 1;
    this.calibrationCache = { at: 0, value: null };
    this.history.append(entry).catch((error) => {
      this.perf.lastError = String((error && error.message) || error);
    });
    void session;
  }

  handleEvent(session, event) {
    const t0 = process.hrtime.bigint();
    try {
      if (!session || typeof session.id !== 'string' || !event || typeof event.type !== 'string') return;
      this.perf.events += 1;
      const sid = session.id;

      if (event.type === 'request/header') {
        const model = event.data && event.data.header && event.data.header.config
          ? event.data.header.config.model
          : null;
        if (typeof model === 'string' && model) {
          this.models.set(sid, model);
          const tracked = this.tasks.get(sid);
          if (tracked) tracked.updateModel(model);
        }
        if (!this.tasks.has(sid)) return;
      }

      let task = this.tasks.get(sid);
      if ((event.type === 'turn/start' || event.type === 'user/message') && (!task || task.endedAt !== null)) {
        task = this.startTask(session, event.time || Date.now());
      }
      if (!task) return;

      task.observe(event);
      if (event.type === 'turn/end') this.finishTask(task, session);
    } catch (error) {
      this.perf.failures += 1;
      this.perf.lastError = String((error && error.message) || error);
      this.perf.lastFailureAt = Date.now();
      // Never let a display plugin disturb the agent loop.
    } finally {
      this.perf.handlerMs += Number(process.hrtime.bigint() - t0) / 1e6;
    }
  }

  // -- recovery ------------------------------------------------------------

  /**
   * Rebuild one task from a session log. Prefers the stable
   * `sessionQuery.readSession` read (live or persisted) and only falls back to
   * `Session.ownEvents()` when that service is absent.
   */
  async bootstrap(sessionId) {
    let header = null;
    let events = null;

    // A live session already holds its events in memory; reading them is
    // O(1) compared with the persisted-log replay. `snapshotEvents()` is the
    // stable accessor, `ownEvents()` only the fallback.
    const sessions = this.ctx.get('sessions');
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined;
    if (live) {
      header = live.header;
      try {
        if (typeof live.snapshotEvents === 'function') events = live.snapshotEvents();
        else if (typeof live.ownEvents === 'function') events = live.ownEvents();
      } catch {
        events = null;
      }
    }

    // Cold or unreadable live session: the documented live-or-persisted read.
    const query = this.ctx.get('sessionQuery');
    if (!events && query && typeof query.readSession === 'function') {
      try {
        const snapshot = await query.readSession(sessionId);
        if (snapshot && Array.isArray(snapshot.events)) {
          header = snapshot.session;
          events = snapshot.events;
        }
      } catch {
        // Fall through to the undefined-session result below.
      }
    }
    if (!Array.isArray(events) || events.length === 0) return null;

    let start = -1;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i] && events[i].type === 'turn/start') {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    let from = start;
    if (start > 0 && events[start - 1] && events[start - 1].type === 'user/message') from = start - 1;

    const first = events[from];
    const session = { id: sessionId, header: header || {} };
    const task = this.startTask(session, first.time || Date.now());
    task.recovered = true;
    for (let i = from; i < events.length; i += 1) {
      const event = events[i];
      if (event && event.type === 'request/header') {
        const model = event.data && event.data.header && event.data.header.config
          ? event.data.header.config.model
          : null;
        if (typeof model === 'string' && model) {
          this.models.set(sessionId, model);
          task.updateModel(model);
        }
      }
      task.observe(event);
    }
    if (task.endedAt !== null) this.finishTask(task, session, false);
    this.perf.bootstraps += 1;
    return task;
  }

  // -- backtest ------------------------------------------------------------

  /**
   * Replay real completed turns twice: cold (static priors only) and learned
   * (priors from earlier replayed turns). Both runs produce the same trace
   * format the live plugin persists, so the reported checkpoints are the same
   * numbers the UI would have shown.
   */
  async backtest(limit) {
    const query = this.ctx.get('sessionQuery');
    if (!query || typeof query.readSession !== 'function' || typeof query.listSessions !== 'function') {
      return { ok: false, error: 'sessionQuery unavailable' };
    }
    const startedAt = Date.now();
    const all = await query.listSessions();
    const chosen = all.slice(0, limit).reverse(); // oldest first: learned priors accumulate
    const cold = [];
    const learned = [];
    const coldPool = [];
    const learnedPool = [];
    const durations = [];
    let sessions = 0;
    let turns = 0;
    let skipped = 0;

    let currentWorkspace = null;
    const coldFactory = (classified) => priorFor(classified, null);
    const learnedFactory = (classified, model) => {
      let stats = statsFor(learnedPool, classified.category, model, currentWorkspace);
      if (stats.n === 0) {
        const pooled = statsForAll(learnedPool, model, currentWorkspace);
        if (pooled.n >= 3) stats = pooled;
      }
      const prior = priorFor(classified, stats);
      const cal = buildCalibration(learnedPool);
      prior.hw70 = cal.hw70;
      prior.intervalModel = cal.intervalModel;
      return prior;
    };

    for (const record of chosen) {
      if (Date.now() - startedAt > this.cfg.backtestBudgetMs) break;
      let snapshot;
      try {
        snapshot = await query.readSession(record.header.id);
      } catch {
        skipped += 1;
        continue;
      }
      if (!snapshot || !Array.isArray(snapshot.events)) {
        skipped += 1;
        continue;
      }
      sessions += 1;
      currentWorkspace = snapshot.session && snapshot.session.cwd ? snapshot.session.cwd : null;
      const groups = splitTurns(snapshot.events);
      for (let turnIndex = 0; turnIndex < groups.length; turnIndex += 1) {
        const group = groups[turnIndex];
        if (Date.now() - startedAt > this.cfg.backtestBudgetMs) break;
        const coldRecord = replayTurn(group, coldFactory, this.cfg.stallMs, currentWorkspace);
        const learnedRecord = replayTurn(group, learnedFactory, this.cfg.stallMs, currentWorkspace);
        if (!coldRecord || !learnedRecord) continue;
        learnedRecord.seedKey = `${record.header.id}#${turnIndex}`;
        turns += 1;
        durations.push(coldRecord.ms);
        cold.push(coldRecord);
        learned.push(learnedRecord);
        coldPool.push(coldRecord);
        learnedPool.push(learnedRecord);
      }
    }

    const summarize = (records) => {
      const cal = calibrationOf(records);
      return {
        tasks: cal.tasks,
        checkpoints: cal.checkpoints,
        coverage: cal.coverage,
        maeMs: cal.maeMs,
        mape: cal.mape,
        flutter: cal.flutter,
        hw70: cal.hw70,
        samples: cal.samples,
      };
    };

    this.perf.backtests += 1;
    // Seed the local calibration with real replayed turns (idempotent by
    // session#turn). These are genuine observations from the user's own logs,
    // not synthetic events, so the live probability becomes available without
    // waiting for new work.
    await this.ready;
    const pendingSeed = learned.filter((row) => !this.history.seedKeys.has(row.seedKey));
    for (const row of pendingSeed) {
      await this.history.append({ ...row, seeded: true });
    }
    if (pendingSeed.length > 0) this.calibrationCache = { at: 0, value: null };

    const sorted = durations.slice().sort((a, b) => a - b);
    const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
    return {
      ok: true,
      elapsedMs: Date.now() - startedAt,
      sessions,
      turns,
      skipped,
      seeded: pendingSeed.length,
      eligible: cold.length,
      duration: { n: sorted.length, p25: pick(0.25), p50: pick(0.5), p75: pick(0.75), p90: pick(0.9) },
      traces: cold.filter((r) => r.ms > 120_000).slice(0, 3).map((r) => ({
        ms: r.ms,
        category: r.category,
        trace: r.trace,
      })),
      from: chosen.length ? chosen[0].header.id : null,
      to: chosen.length ? chosen[chosen.length - 1].header.id : null,
      cold: summarize(cold),
      learned: summarize(learned),
    };
  }

  // -- reads ---------------------------------------------------------------

  evict(now) {
    if (this.tasks.size <= 80) return;
    const stale = [];
    for (const [id, task] of this.tasks) {
      if (task.endedAt !== null && now - task.endedAt > this.cfg.doneTtlMs) stale.push(id);
    }
    stale.sort((a, b) => (this.tasks.get(a).endedAt || 0) - (this.tasks.get(b).endedAt || 0));
    for (const id of stale) {
      if (this.tasks.size <= 60) break;
      this.tasks.delete(id);
    }
  }

  async state(sessionId, now) {
    let task = this.tasks.get(sessionId);
    if (!task) task = await this.bootstrap(sessionId);
    if (!task) return null;
    if (task.endedAt !== null && now - task.endedAt > this.cfg.doneTtlMs) return null;

    const snapshot = task.snapshot(now, this.cfg.stallMs);
    let children = 0;
    let childrenRunning = 0;
    for (const other of this.tasks.values()) {
      if (other.parentSession !== sessionId) continue;
      children += 1;
      if (other.endedAt === null) childrenRunning += 1;
    }
    snapshot.parallel = { children, running: childrenRunning };

    const estimate = snapshot.estimate || {};
    if (estimate.available !== false && estimate.medianMs > 0) {
      const elapsed = snapshot.elapsedMs;
      const elapsedFrac = elapsed / (elapsed + Math.max(60_000, estimate.medianMs));
      snapshot.probability = probabilityFor(
        this.calibrationModel(),
        estimate.lowMs,
        estimate.highMs,
        estimate.medianMs,
        elapsedFrac,
      );
    } else {
      snapshot.probability = { p: null, n: 0, source: 'none' };
    }
    return snapshot;
  }

  perfSnapshot() {
    const avgHandlerUs = this.perf.events ? (this.perf.handlerMs * 1000) / this.perf.events : 0;
    return {
      events: this.perf.events,
      avgHandlerUs: Math.round(avgHandlerUs * 10) / 10,
      handlerMs: Math.round(this.perf.handlerMs * 10) / 10,
      bootstraps: this.perf.bootstraps,
      routes: this.perf.routes,
      avgRouteMs: this.perf.routes ? Math.round((this.perf.routeMs / this.perf.routes) * 100) / 100 : 0,
      routeMsTotal: Math.round(this.perf.routeMs * 100) / 100,
      calibrations: this.perf.calibrations,
      backtests: this.perf.backtests,
      failures: this.perf.failures,
      lastError: this.perf.lastError,
      tracked: this.tasks.size,
    };
  }

  async summary(now) {
    const rows = [];
    for (const task of this.tasks.values()) {
      rows.push({
        sessionId: task.sessionId,
        label: task.label,
        status: task.derivedStatus(now, this.cfg.stallMs),
        child: task.child,
        elapsedMs: task.elapsed(now),
        startedAt: task.startedAt,
        endedAt: task.endedAt,
        category: task.classified.category,
        model: task.model,
        running: task.endedAt === null,
      });
    }
    rows.sort((a, b) => b.startedAt - a.startedAt);
    return {
      ok: true,
      now,
      route: this.cfg.route,
      tasks: rows,
      history: this.history.summary(),
      calibration: this.calibration(),
      perf: this.perfSnapshot(),
    };
  }

  async post(body) {
    const action = body && body.action;
    if (action === 'clear') {
      await this.history.clear();
      this.calibrationCache = { at: 0, value: null };
      return { ok: true, cleared: true, history: this.history.summary() };
    }
    if (action === 'stats') {
      this.calibrationCache = { at: 0, value: null };
      return { ok: true, calibration: this.calibration(), history: this.history.summary() };
    }
    if (action === 'backtest') {
      const limit = Number(body.limit);
      const n = Number.isFinite(limit) ? Math.min(this.cfg.backtestSessions, Math.max(1, Math.round(limit))) : this.cfg.backtestSessions;
      return this.backtest(n);
    }
    return { ok: false, error: 'unknown action; expected "clear", "stats" or "backtest"' };
  }

  async handleGet(req, res, now) {
    let parsed;
    try {
      parsed = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      send(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    const sessionId = parsed.searchParams.get('session');
    if (!sessionId) {
      send(res, 200, await this.summary(now));
      return;
    }
    const session = await this.state(sessionId, now);
    if (session && parsed.searchParams.get('debug') === '1') {
      const task = this.tasks.get(sessionId);
      if (task) {
        session.debug = {
          promptLength: task.promptLength,
          addedWorkMs: task.addedWorkMs,
          addedWorkAt: task.addedWorkAt,
          paceEma: task.paceEma,
          paceSamples: task.paceSamples,
          lastUnitAt: task.lastUnitAt,
          todoDone: task.todoDone,
          todoTotal: task.todoTotal,
          todoWeightDone: task.todoWeightDone,
          todoWeightTotal: task.todoWeightTotal,
          phaseStartedAt: task.phaseStartedAt,
          recentErrors: task.recentErrors.length,
          tracePoints: task.estimateHistory.length,
        };
      }
    }
    send(res, 200, {
      ok: true,
      now,
      session,
      calibration: this.calibration(),
      perf: this.perfSnapshot(),
    });
  }

  async handleAsync(req, res) {
    const t0 = process.hrtime.bigint();
    try {
      if (!isLoopback(req)) {
        send(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      await this.ready;
      const now = Date.now();
      if (req.method === 'GET' || req.method === 'HEAD') {
        await this.handleGet(req, res, now);
      } else if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          send(res, 400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        const result = await this.post(body);
        send(res, result.ok ? 200 : 400, result);
      } else {
        send(res, 405, { ok: false, error: 'method not allowed' });
      }
      this.evict(now);
    } catch (error) {
      send(res, 500, { ok: false, error: String((error && error.message) || error) });
    } finally {
      this.perf.routes += 1;
      this.perf.routeMs += Number(process.hrtime.bigint() - t0) / 1e6;
    }
  }
}

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig);
  const engine = new EtaEngine(ctx, cfg);

  ctx.on('session/event', (session, event) => {
    engine.handleEvent(session, event);
  });

  ctx.inject(['webServer'], (webCtx) => {
    const dispose = webCtx.webServer.register({
      kind: 'exact',
      path: cfg.route,
      handler: (req, res) => {
        void engine.handleAsync(req, res);
      },
    });
    webCtx.effect(() => dispose, 'live-eta: route');
  });
}