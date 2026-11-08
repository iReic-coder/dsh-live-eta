/**
 * dsh-live-eta / eta-core
 *
 * Pure estimation engine. No DSH imports, no I/O, no timers: every input is a
 * session event plus the current clock, so the whole model is unit-testable and
 * its cost per event is a handful of arithmetic operations.
 *
 * Model (deliberately explainable, not a black box):
 *   1. A task is one agent turn. Category + complexity come from the first
 *      user message (keyword rules), never from an extra LLM call.
 *   2. The prior is category base x complexity, blended with completed-task
 *      medians from the local history once that history exists.
 *   3. Progress comes from the agent's own todo list when it exists, otherwise
 *      from phase weights that advance on observed tool kinds.
 *   4. Remaining = blend(prior remaining, observed pace remaining), then
 *      corrected for the running tool, failures/retries and added work.
 *   5. A prior-based time floor keeps the ETA from collapsing to zero on a task
 *      that is simply slower than its estimate.
 */

const MIN = 60_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// -- normal distribution helpers (for the survival model) -------------------

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Acklam's inverse normal CDF; accurate to ~1e-9 over (0,1). */
function normalInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Conditional median of the remaining time under a log-normal prior on the
 * total duration, given that the task has already run `elapsed`. Early on this
 * is close to `median - elapsed`; as the task outlives its prior it shrinks
 * faster, which is the honest update when nothing else is observable.
 */
export function survivalRemaining(median, sigma, elapsed) {
  if (!(median > 0)) return 0;
  if (elapsed <= 1_000) return Math.max(0, median - elapsed);
  const s = clamp(sigma || 0.5, 0.3, 1.4);
  const mu = Math.log(median);
  const survival = 1 - normalCdf((Math.log(Math.max(elapsed, 1)) - mu) / s);
  if (survival <= 0.02) return Math.max(30_000, median * 0.08);
  const quantile = Math.exp(mu + s * normalInv(1 - 0.5 * survival));
  return Math.max(0, quantile - elapsed);
}

/** The four display phases, in work order. */
export const PHASES = [
  { key: 'explore', label: '检查与准备', weight: 0.2 },
  { key: 'modify', label: '修改与实现', weight: 0.42 },
  { key: 'run', label: '运行与验证', weight: 0.28 },
  { key: 'deliver', label: '收尾与交付', weight: 0.1 },
];

const PHASE_INDEX = { explore: 0, plan: 0, modify: 1, delegate: 1, run: 2, deliver: 3 };

/** Task categories with their base medians and keyword sets. */
export const CATEGORY_DEFS = {
  research: {
    label: '分析研究',
    baseMs: 18 * MIN,
    kw: [
      ['仿真', 2], ['实验', 2], ['论文', 2], ['文献', 2], ['建模', 2], ['模型', 2],
      ['信道', 2], ['推导', 2], ['算法', 2], ['科研', 2], ['数值', 2], ['matlab', 2],
      ['simulink', 2], ['分析', 1], ['研究', 1], ['评估', 1],
    ],
  },
  debug: {
    label: '问题修复',
    baseMs: 9 * MIN,
    kw: [
      ['修复', 2], ['报错', 2], ['错误', 2], ['失败', 2], ['异常', 2], ['崩溃', 2],
      ['不工作', 2], ['无法', 2], ['调试', 2], ['排查', 2], ['bug', 2],
      ['fix', 2], ['debug', 2], ['error', 2], ['failure', 2], ['broken', 2],
      ['crash', 2], ['issue', 2], ['回归', 1], ['复现', 1], ['定位问题', 1],
    ],
  },
  feature: {
    label: '功能开发',
    baseMs: 12 * MIN,
    kw: [
      ['实现', 2], ['开发', 2], ['新增', 2], ['添加', 2], ['重构', 2], ['插件', 2],
      ['封装', 2], ['编写', 2], ['写一个', 2], ['支持', 2], ['接入', 2],
      ['修改', 1], ['调整', 1], ['改进', 1], ['优化', 1], ['更新', 1], ['改', 1],
      ['build', 2], ['implement', 2], ['feature', 2], ['refactor', 2], ['plugin', 2],
    ],
  },
  ops: {
    label: '运行与部署',
    baseMs: 8 * MIN,
    kw: [
      ['运行', 2], ['测试', 2], ['编译', 2], ['构建', 2], ['部署', 2], ['安装', 2],
      ['启动', 2], ['打包', 2], ['迁移', 2],
      ['run', 2], ['test', 2], ['deploy', 2], ['install', 2], ['compile', 2],
    ],
  },
  doc: {
    label: '文档整理',
    baseMs: 7 * MIN,
    kw: [
      ['文档', 2], ['说明', 2], ['报告', 2], ['总结', 2], ['注释', 2], ['readme', 2],
      ['排版', 2], ['撰写', 2],
      ['document', 2], ['report', 2], ['summary', 2], ['write-up', 2],
    ],
  },
  data: {
    label: '数据处理',
    baseMs: 10 * MIN,
    kw: [
      ['表格', 2], ['数据清洗', 2], ['清洗数据', 2], ['批量', 2], ['转换', 2], ['导出', 2],
      ['csv', 2], ['excel', 2], ['xlsx', 2], ['jsonl', 2],
      ['table', 2], ['spreadsheet', 2], ['convert', 2], ['batch', 2], ['dataset', 2],
    ],
  },
  general: { label: '通用任务', baseMs: 10 * MIN, kw: [] },
};

/** Tool kind -> phase. Unknown tools leave the phase unchanged. */
const TOOL_PHASE = {
  read: 'explore', glob: 'explore', grep: 'explore', read_image: 'explore', skill: 'explore',
  web_search: 'explore', web_fetch: 'explore', list_agents: 'explore', job_list: 'explore',
  cordis_inspect_list: 'explore', cordis_inspect_query: 'explore', cordis_inspect_self: 'explore',
  session_search: 'explore', session_event_read: 'explore', session_event_search: 'explore',
  session_event_trace: 'explore', session_trace: 'explore', list_subagent_models: 'explore',
  todo_write: 'plan', create_goal: 'plan', update_goal: 'plan', get_goal: 'plan',
  exit_plan_mode: 'plan',
  edit: 'modify', write: 'modify', apply_patch: 'modify', cordis_define: 'modify',
  bash: 'run', pwsh: 'run', cordis_run: 'run', job_output: 'run', job_kill: 'run',
  terminal_open: 'run', terminal_read: 'run', terminal_signal: 'run', terminal_close: 'run',
  evaluate_matlab_code: 'run', run_matlab_file: 'run', run_matlab_test_file: 'run',
  check_matlab_code: 'run', detect_matlab_toolboxes: 'run', process_start: 'run',
  process_stop: 'run', process_logs: 'run', process_ping: 'run', process_wait_ready: 'run',
  workflow: 'delegate', subagent: 'delegate', subagent_fork: 'delegate',
  send_message: 'delegate', spawn_teammate: 'delegate', wait_agent: 'delegate',
  interrupt_agent: 'delegate', team_task_create: 'delegate',
  present: 'deliver',
  ask_user_question: 'wait',
};

/** Rough per-tool wall-clock expectations (ms), used only for corrections. */
const TOOL_TYPICAL = {
  read: 3_000, glob: 2_000, grep: 4_000, edit: 5_000, write: 5_000,
  apply_patch: 6_000, todo_write: 1_500, bash: 40_000, pwsh: 40_000,
  evaluate_matlab_code: 90_000, run_matlab_file: 90_000, run_matlab_test_file: 120_000,
  web_search: 15_000, web_fetch: 15_000, subagent: 300_000, workflow: 300_000,
  job_output: 3_000, present: 1_500, skill: 2_000,
};

const TOOL_TYPICAL_DEFAULT = 20_000;

/** A run-type tool only counts as verification when it looks like one. */
function looksLikeVerification(name, args) {
  if (/^(evaluate_matlab_code|run_matlab_file|run_matlab_test_file|check_matlab_code)$/.test(name)) return true;
  return /(^|[^a-z])(test|pytest|unittest|jest|vitest|ctest|build|compile|make|cmake|npm run|pnpm|yarn run|matlab|simulink|mex)([^a-z]|$)/i.test(args || '');
}

/** Longest plausible single task used to reject corrupt history rows. */
const HISTORY_MAX_MS = 6 * 60 * 60_000;
const HISTORY_MIN_MS = 5_000;

/** Default share of total time per phase when history is thin. */
const DEFAULT_PHASE_SHARES = { explore: 0.2, modify: 0.42, run: 0.28, deliver: 0.1 };

/** Effort weight of one todo item, from its own wording. */
export function todoWeight(text) {
  const s = String(text || '');
  if (/修复|bug|调试|fix|debug|排查/i.test(s)) return 1.2;
  if (/测试|验证|回归|编译|构建|运行|仿真|验收|benchmark|test|verify|build|simulat/i.test(s)) return 1.5;
  if (/文档|说明|报告|readme|注释|总结|document|report|changelog/i.test(s)) return 0.8;
  return 1;
}

/** Smallest calibration sample that may lift a probability to the UI. */
const MIN_PROBABILITY_SAMPLES = 8;

/**
 * Tasks shorter than this are not what the ETA is for, and their relative
 * errors would dominate every statistic. They stay in the raw history but do
 * not shape the priors or the interval calibration.
 */
const CALIBRATION_MIN_MS = 60_000;

/** Keep the empirical ratio from producing absurd bounds. */
const R_MIN = 0.1;
const R_MAX = 8;

/** Host-side user messages that are notices, not task instructions. */
function looksLikeNotice(text) {
  const s = String(text || '').trim();
  return /^(time sampled|elapsed since|browser time zone|current runtime context|current working directory|current deepseek harness|approval prompts are disabled|instructions from:|the user changed|user changed the approval|runtime notice|系统提示|运行时通知|用户已(将|把)审批)/i.test(s);
}

/**
 * Remove harness-injected user content (skill catalogs and other
 * <system-reminder> blocks) and the approval-policy banner, so the label and
 * the category describe the human's request rather than runtime plumbing.
 */
function normalizePrompt(text) {
  let s = String(text || '');
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ');
  s = s.replace(/^\s*(time sampled[^\n]*|elapsed since[^\n]*|browser time zone[^\n]*|current runtime context[^\n]*|the user changed[^\n]*|用户已(将|把)审批[^\n]*)\n+/i, '');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function messageText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  const blocks = message.content;
  if (!Array.isArray(blocks)) return '';
  let out = '';
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      out += (out ? '\n' : '') + block.text;
    }
  }
  return out;
}

/** One-line label, never the full prompt. */
export function shortLabel(text, max = 80) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max - 1) + '…';
}

/** Keyword category + complexity multiplier for one task description. */
export function classify(text) {
  const s = String(text || '').toLowerCase();
  const scores = {};
  for (const [key, def] of Object.entries(CATEGORY_DEFS)) {
    if (key === 'general') continue;
    let score = 0;
    for (const [word, weight] of def.kw) {
      if (s.includes(word)) score += weight;
    }
    scores[key] = score;
  }
  // A hard failure word states intent ("fix this"), but only when it is
  // paired with a fix verb near the start: long specs mention errors as
  // material to handle, not as the request.
  const head = s.slice(0, s.length > 500 ? 120 : 240);
  if (/(修复|解决|排查|调试|定位|处理|fix|resolve|debug).{0,40}(报错|错误|失败|异常|崩溃|bug|crash|failure|error)/i.test(head) && scores.debug > 0) {
    scores.debug += 3;
  }
  let best = 'general';
  let bestScore = 0;
  for (const [key, score] of Object.entries(scores)) {
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  let complexity = 1;
  const len = s.length;
  if (len > 200) complexity += 0.15;
  if (len > 600) complexity += 0.15;
  if (len > 1500) complexity += 0.1;
  if (/多文件|多个文件|所有文件|整个项目|全量|重构|批量修改/.test(s)) complexity += 0.2;
  if (/测试|验证|编译|仿真|运行|回归/.test(s)) complexity += 0.15;
  if (/子\s*agent|subagent|并行|workflow|团队/.test(s)) complexity += 0.2;
  if ((s.match(/@[^\s@]+/g) || []).length >= 3) complexity += 0.15;
  if (/简单|快速|小改|一句话|只需|仅/.test(s)) complexity -= 0.2;
  return {
    category: best,
    categoryLabel: CATEGORY_DEFS[best].label,
    complexity: Math.round(clamp(complexity, 0.6, 2.2) * 100) / 100,
    baseMs: Math.round(CATEGORY_DEFS[best].baseMs * clamp(complexity, 0.6, 2.2)),
    weak: bestScore === 0,
  };
}

// ---------------------------------------------------------------------------
// Prior
// ---------------------------------------------------------------------------

/**
 * Blend the static category prior with local history.
 * `stats` is `{ n, median, p25, p75 }` for this category (or null).
 */
export function priorFor(classified, stats) {
  const base = classified.baseMs;
  const shares = (stats && stats.phaseShares && stats.phaseShares.shares) || DEFAULT_PHASE_SHARES;
  const sigma = stats && stats.n > 0 && stats.p25 > 0 && stats.p75 > 0
    ? clamp((Math.log(stats.p75) - Math.log(stats.p25)) / 1.349, 0.3, 1.0)
    : 0.5;
  if (!stats || stats.n === 0) {
    return { median: base, n: 0, hw: 0.6, base, phaseShares: shares, hw70: null, sigma };
  }
  const w = Math.min(0.75, stats.n / (stats.n + 4));
  const median = base * (1 - w) + stats.median * w;
  const spread = stats.p75 > 0 && stats.p25 > 0 ? (stats.p75 - stats.p25) / Math.max(stats.median, 1) : 0.5;
  const hw = clamp(0.9 / Math.sqrt(stats.n + 1) + spread / 2 / Math.sqrt(stats.n), 0.14, 0.65);
  return { median, n: stats.n, hw, base, phaseShares: shares, hw70: null, sigma };
}

/** Pooled statistics across every category, for a thin per-category sample. */
export function statsForAll(records, model) {
  const all = usable(records);
  const byModel = model ? all.filter((r) => r.model === model) : [];
  const pool = byModel.length >= 3 ? byModel : all;
  if (pool.length === 0) return { n: 0, median: 0, p25: 0, p75: 0, phaseShares: null };
  const sorted = pool.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    phaseShares: phaseSharesOf(pool),
  };
}

// ---------------------------------------------------------------------------
// One task
// ---------------------------------------------------------------------------

export class EtaTask {
  /**
   * @param {object} options
   * @param {string} options.sessionId
   * @param {number} options.startedAt
   * @param {object} options.prior      from priorFor()
   * @param {object} [options.classified]
   * @param {string|null} [options.model]
   * @param {boolean} [options.child]   true for a subagent session
   */
  constructor({ sessionId, startedAt, prior, classified, model = null, child = false, priorFactory = null }) {
    this.sessionId = sessionId;
    this.startedAt = startedAt;
    this.prior = prior;
    this.classified = classified || classify('');
    this.model = model;
    this.child = child;
    this.priorFactory = priorFactory;
    this.parentSession = null;

    this.endedAt = null;
    this.endKind = null;
    this.statusText = null;

    this.label = '';
    this.sawPrompt = false;
    this.promptLength = 0;
    this.promptAt = 0;
    this.turn = 0;
    this.step = 0;

    this.phaseIndex = 0;
    this.phaseStartedAt = startedAt;
    this.sawEdit = false;
    // Display phase = the kind of work happening now; it may move back when
    // the agent edits again after a test run. `phaseIndex` above stays
    // monotonic and only feeds the internal progress prior.
    this.activePhaseKey = 'explore';
    this.lastPhaseAt = startedAt;
    this.phaseMs = { explore: 0, modify: 0, run: 0, deliver: 0 };
    this.phases = PHASES.map((p, i) => ({
      key: p.key,
      label: p.label,
      status: i === 0 ? 'active' : 'pending',
      startedAt: i === 0 ? startedAt : null,
      endedAt: null,
      actualMs: 0,
    }));

    this.tools = new Map(); // callId -> { name, startedAt }
    this.activeTool = null;
    this.toolEma = new Map();

    this.todoTotal = 0;
    this.todoDone = 0;
    this.todoWeightTotal = 0;
    this.todoWeightDone = 0;
    this.lastUnitAt = startedAt;
    this.paceEma = null;
    this.paceSamples = 0;

    this.lastEventAt = startedAt;
    this.lastProgressAt = startedAt;
    this.lastProgressText = '任务开始';
    this.recentErrors = [];
    this.retryCounts = new Map();
    this.retryPenalties = 0;

    this.stats = { toolCalls: 0, errors: 0, toolMs: 0, modelMs: 0, steps: 0 };
    this.anomalies = [];
    this.estimateHistory = [];
    this.addedWorkMs = 0;
    this.addedWorkAt = 0;

    this.lastMedian = null;
    this.lastLow = null;
    this.lastHigh = null;
    this.lastEstimateAt = 0;
    this.updates = 0;
    this.bigUpdates = 0;
    this.lastReason = '';
    this.recovered = false;
    this.recorded = false;
  }

  // -- observation ---------------------------------------------------------

  observe(event) {
    const t = Number(event && event.time);
    if (!Number.isFinite(t)) return;
    this.lastEventAt = Math.max(this.lastEventAt, t);
    const data = (event && event.data) || {};
    switch (event.type) {
      case 'turn/start':
        this.turn = data.turn ?? this.turn;
        break;
      case 'user/message': {
        const text = normalizePrompt(messageText(data));
        if (!text) break;
        // Runtime noise (clock stamps, policy banners, the skills catalog) is
        // not a task and not new work.
        if (looksLikeNotice(text)) break;
        if (!this.sawPrompt) {
          this.adoptPrompt(text, t);
        } else {
          // A longer, substantive message early in the task usually means the
          // first message was runtime noise: adopt it as the task description
          // instead of charging the task extra time for steering.
          const early = t - this.startedAt < 90_000;
          const longer = text.length > Math.max(24, this.promptLength * 1.4);
          if (early && (longer || this.promptWasNotice)) {
            this.adoptPrompt(text, t);
          } else if (t > this.startedAt + 2_000) {
            this.addedWorkMs += clamp(this.prior.median * 0.15, MIN, 5 * MIN);
            this.addedWorkAt = t;
            this.addAnomaly(t, 'steering', '任务中途追加了要求，已上调预计剩余时间');
          }
        }
        break;
      }
      case 'step/start':
        this.step = data.step ?? this.step;
        this.stats.steps += 1;
        break;
      case 'assistant/message': {
        // Time since the previous observable activity approximates this model
        // call's wall time; it is a statistic, never an estimate input.
        const since = Math.max(this.phaseStartedAt, this.lastToolEndAt || this.startedAt);
        this.stats.modelMs += Math.min(Math.max(0, t - since), 20 * MIN);
        this.attributePhase(t);
        this.touchProgress(t, `模型完成第 ${data.step ?? this.step} 步`);
        break;
      }
      case 'tool/call':
        this.onToolCall(t, data);
        break;
      case 'tool/result':
        this.onToolResult(t, data);
        break;
      case 'turn/end':
        this.finish(t, data.reason);
        break;
      default:
        break;
    }
  }

  adoptPrompt(text, at) {
    this.sawPrompt = true;
    this.promptLength = text.length;
    this.promptAt = at;
    this.promptWasNotice = looksLikeNotice(text);
    this.label = shortLabel(text);
    this.classified = classify(text);
    if (typeof this.priorFactory === 'function') {
      this.prior = this.priorFactory(this.classified, this.model);
    }
  }

  /** The model can change mid-session (user switches model). */
  updateModel(model) {
    if (!model || model === this.model) return;
    this.model = model;
    if (this.sawPrompt && typeof this.priorFactory === 'function') {
      this.prior = this.priorFactory(this.classified, this.model);
    }
  }

  touchProgress(at, text) {
    this.lastProgressAt = Math.max(this.lastProgressAt, at);
    if (text) this.lastProgressText = text;
  }

  addAnomaly(at, kind, text) {
    const last = this.anomalies[this.anomalies.length - 1];
    if (last && last.kind === kind && at - last.at < 120_000) return;
    this.anomalies.push({ at, kind, text });
    if (this.anomalies.length > 8) this.anomalies.shift();
  }

  onToolCall(t, data) {
    this.attributePhase(t);
    const name = String(data.name || 'tool');
    const args = typeof data.arguments === 'string' ? data.arguments : '';
    const callId = String(data.callId || `${name}:${t}`);
    const resolved = this.resolvePhase(name, args);
    this.tools.set(callId, { name, startedAt: t, stage: resolved.stage });
    if (this.tools.size > 200) {
      const oldest = this.tools.keys().next().value;
      this.tools.delete(oldest);
    }
    this.activeTool = { callId, name, startedAt: t };
    this.stats.toolCalls += 1;

    // Todo list is the most reliable progress signal when the agent keeps one.
    if (name === 'todo_write' && args) {
      try {
        const parsed = JSON.parse(args);
        const todos = Array.isArray(parsed && parsed.todos) ? parsed.todos : null;
        if (todos && todos.length >= 2) {
          const done = todos.filter((x) => x && (x.status === 'completed' || x.status === 'done'));
          let totalW = 0;
          let doneW = 0;
          for (const item of todos) {
            const weight = todoWeight(item && (item.content || item.text || ''));
            totalW += weight;
            if (item && (item.status === 'completed' || item.status === 'done')) doneW += weight;
          }
          const previousDone = this.todoWeightDone;
          this.todoTotal = todos.length;
          this.todoDone = done.length;
          this.todoWeightTotal = totalW;
          this.todoWeightDone = doneW;
          if (doneW > previousDone) {
            const deltaUnits = doneW - previousDone;
            const delta = t - this.lastUnitAt;
            if (delta > 1_000) {
              const perUnit = delta / deltaUnits;
              this.paceEma = this.paceEma === null ? perUnit : 0.65 * this.paceEma + 0.35 * perUnit;
              this.paceSamples += 1;
            }
            this.lastUnitAt = t;
          }
          this.touchProgress(t, `待办 ${done.length}/${todos.length}`);
        }
      } catch {
        // Non-JSON arguments: ignore, the phase hint below still applies.
      }
    }

    // Retry detection: the same tool with the same arguments, again.
    const digest = `${name}|${args.slice(0, 240)}`;
    const n = (this.retryCounts.get(digest) || 0) + 1;
    this.retryCounts.set(digest, n);
    if (n >= 3 && n % 2 === 1) {
      this.retryPenalties += 1;
      (this.retryTimes || (this.retryTimes = [])).push(t);
      this.addAnomaly(t, 'retry', `同一操作已重复 ${n} 次：${name}`);
    }

    if (resolved.raw === 'wait') this.waitingUserSince = t;
    if (resolved.display) this.setActivePhase(resolved.display);
    if (resolved.raw === 'modify') this.sawEdit = true;
    this.touchProgress(t, `调用 ${name}`);
  }

  /**
   * Map one tool call to a display phase and a plan stage.
   * - display: what the agent is doing right now (may move backwards).
   * - stage: monotonic progress credit, granted only when the call succeeds.
   * A shell command counts as verification only when it looks like a
   * test/build/simulation; otherwise it is inspection work.
   */
  resolvePhase(name, args) {
    const phase = TOOL_PHASE[name];
    if (phase === undefined) return { raw: undefined, display: null, stage: null };
    if (phase === 'wait') return { raw: phase, display: null, stage: null };
    if (phase === 'plan') return { raw: phase, display: 'explore', stage: null };
    if (phase === 'deliver') return { raw: phase, display: 'deliver', stage: 3 };
    if (phase === 'delegate') return { raw: phase, display: 'modify', stage: 1 };
    if (phase === 'run') {
      const verification = looksLikeVerification(name, args) || this.classified.category === 'ops';
      if (verification) return { raw: phase, display: 'run', stage: 2 };
      return { raw: phase, display: this.phaseIndex >= 1 ? 'modify' : 'explore', stage: null };
    }
    return { raw: phase, display: phase, stage: PHASE_INDEX[phase] };
  }

  /** Attribute elapsed time to the phase that was active until `at`. */
  attributePhase(at) {
    const delta = Math.max(0, at - this.lastPhaseAt);
    if (delta > 0) this.phaseMs[this.activePhaseKey] = (this.phaseMs[this.activePhaseKey] || 0) + delta;
    this.lastPhaseAt = Math.max(this.lastPhaseAt, at);
  }

  setActivePhase(key) {
    if (!key || key === this.activePhaseKey) return;
    if (!(key in this.phaseMs)) return;
    this.activePhaseKey = key;
  }

  advanceToStage(idx, at) {
    if (idx === null || idx === undefined || idx <= this.phaseIndex) return;
    const maxStep = this.classified.category === 'ops' ? 2 : 1;
    const target = idx === 3 ? 3 : Math.min(idx, this.phaseIndex + maxStep);
    this.advancePhase(target, at);
  }

  onToolResult(t, data) {
    const callId = data.callId ? String(data.callId) : this.activeTool ? this.activeTool.callId : null;
    const known = callId ? this.tools.get(callId) : this.activeTool;
    const name = (known && known.name) || this.activeTool?.name || String(data.name || 'tool');
    const startedAt = known && Number.isFinite(known.startedAt) ? known.startedAt : t;
    const duration = clamp(t - startedAt, 0, 60 * MIN);
    this.stats.toolMs += duration;
    this.lastToolEndAt = t;

    const ema = this.toolEma.get(name);
    this.toolEma.set(name, ema === undefined ? duration : 0.7 * ema + 0.3 * duration);

    const failed = Boolean(data.error) || Boolean(data.message && data.message.isError);
    this.attributePhase(t);
    if (failed) {
      this.stats.errors += 1;
      this.recentErrors.push(t);
      if (this.recentErrors.length > 20) this.recentErrors.shift();
      this.addAnomaly(t, 'error', `工具调用失败：${name}，已追加返工时间`);
      this.touchProgress(t, `${name} 失败`);
    } else {
      // Progress credit only after a successful call.
      if (known && known.stage !== null && known.stage !== undefined) this.advanceToStage(known.stage, t);
      this.touchProgress(t, `${name} 完成（${(duration / 1000).toFixed(1)}s）`);
    }

    if (callId) this.tools.delete(callId);
    this.activeTool = null;
    if (this.waitingUserSince) this.waitingUserSince = null;
  }

  advancePhase(idx, at) {
    const now = Math.max(at, this.phaseStartedAt);
    for (let i = this.phaseIndex; i < idx; i += 1) {
      const p = this.phases[i];
      p.status = 'done';
      p.endedAt = now;
      p.actualMs = Math.max(0, now - (p.startedAt ?? this.startedAt));
    }
    this.phaseIndex = idx;
    this.phases[idx].status = 'active';
    this.phases[idx].startedAt = now;
    this.phaseStartedAt = now;
    this.touchProgress(now, PHASES[idx].label);
  }

  finish(at, reason) {
    if (this.endedAt !== null) return;
    this.attributePhase(at);
    this.endedAt = at;
    const kind = reason && reason.kind ? reason.kind : 'completed';
    this.endKind = kind;
    this.statusText = kind;
    const p = this.phases[this.phaseIndex];
    if (p && p.status === 'active') {
      p.status = 'done';
      p.endedAt = at;
      p.actualMs = Math.max(0, at - (p.startedAt ?? this.startedAt));
    }
    for (const phase of this.phases) {
      if (phase.status === 'pending') phase.status = 'skipped';
    }
  }

  // -- estimation ----------------------------------------------------------

  elapsed(now) {
    return Math.max(0, (this.endedAt ?? now) - this.startedAt);
  }

  derivedStatus(now, stallMs) {
    if (this.endedAt !== null) {
      if (this.endKind === 'completed') return 'done';
      if (this.endKind === 'error') return 'error';
      if (this.endKind === 'aborted' || this.endKind === 'interrupted') return 'cancelled';
      return 'incomplete';
    }
    if (this.activeTool) {
      if (this.activeTool.name === 'ask_user_question') return 'waiting-user';
      return 'waiting-tool';
    }
    if (this.waitingUserSince) return 'waiting-user';
    if (now - this.lastProgressAt > stallMs) return 'stalled';
    return 'running';
  }

  progress(now) {
    if (this.todoTotal >= 2 && this.todoWeightTotal > 0) {
      const frac = clamp(this.todoWeightDone / this.todoWeightTotal, 0, 1);
      return clamp(0.08 + 0.82 * frac, 0.03, 0.93);
    }
    // Phase transitions are coarse: a single early test run must not read as
    // "half the task is done". Cap phase-derived progress by elapsed time.
    const ratio = this.elapsed(now) / Math.max(this.prior.median, MIN);
    const phase = PHASES[this.phaseIndex] || PHASES[0];
    let before = 0;
    for (let i = 0; i < this.phaseIndex; i += 1) before += PHASES[i].weight;
    const expectedPhase = Math.max(this.prior.median * phase.weight, 30_000);
    const into = clamp((now - this.phaseStartedAt) / expectedPhase, 0, 1);
    const phaseP = before + phase.weight * 0.4 * into;
    const cap = 0.2 + 0.8 * Math.min(1, ratio);
    const floor = clamp(0.3 * ratio, 0, 0.28);
    return clamp(Math.max(Math.min(phaseP, cap), floor), 0.02, 0.93);
  }

  /**
   * Remaining time from the plan stages, scaled by the historical share of
   * each phase for this category. Overspending in a phase does not inflate
   * the rest, but the current phase always retains a small tail.
   */
  phaseRemaining(now) {
    const total = this.prior.median;
    const shares = this.prior.phaseShares || DEFAULT_PHASE_SHARES;
    let remaining = 0;
    for (let i = this.phaseIndex; i < PHASES.length; i += 1) {
      const expected = total * (shares[PHASES[i].key] ?? DEFAULT_PHASE_SHARES[PHASES[i].key]);
      if (i === this.phaseIndex) {
        const spent = Math.max(0, now - this.phaseStartedAt);
        remaining += Math.max(expected * 0.15, expected - spent);
      } else {
        remaining += expected;
      }
    }
    return remaining;
  }

  recentErrorPenalty(now) {
    this.recentErrors = this.recentErrors.filter((t) => now - t < 3 * MIN);
    return Math.min(2.5 * MIN, this.recentErrors.length * 60_000);
  }

  retryPenalty(now) {
    this.retryTimes = (this.retryTimes || []).filter((t) => now - t < 6 * MIN);
    return Math.min(2 * MIN, this.retryTimes.length * 60_000);
  }

  toolRemaining(now) {
    if (!this.activeTool || this.activeTool.name === 'ask_user_question') return 0;
    const name = this.activeTool.name;
    const typical = this.toolEma.get(name) ?? TOOL_TYPICAL[name] ?? TOOL_TYPICAL_DEFAULT;
    const elapsed = Math.max(0, now - this.activeTool.startedAt);
    return clamp(typical - elapsed, 0, Math.max(typical, 60_000));
  }

  addedWorkRemaining(now) {
    if (!this.addedWorkAt) return 0;
    const age = Math.max(0, now - this.addedWorkAt);
    if (age > 20 * MIN) return 0;
    // Added work is being worked off while the clock runs: fade it instead of
    // keeping a fixed surcharge for the rest of the task.
    return this.addedWorkMs * (1 - age / (20 * MIN));
  }

  /**
   * Recompute the current estimate.
   * @returns {{available:boolean, medianMs:number, lowMs:number, highMs:number,
   *            confidence:'high'|'medium'|'low', reason:string, progress:number,
   *            pace:number|null, hw:number}}
   */
  computeEstimate(now, status, force = false) {
    const elapsed = this.elapsed(now);
    if (this.endedAt !== null) {
      return {
        available: true,
        medianMs: 0,
        lowMs: 0,
        highMs: 0,
        confidence: 'high',
        reason: '任务已结束',
        progress: 1,
        pace: this.paceEma,
        hw: 0,
      };
    }

    const p = this.progress(now);
    const priorRemaining = Math.max(0, this.prior.median - elapsed);
    // The phase plan is capped by the prior's own remaining time: a task that
    // has already spent its whole prior must not still claim 80% of the plan
    // is ahead of it.
    const phaseRemaining = Math.min(
      this.phaseRemaining(now),
      Math.max(priorRemaining * 1.5, 30_000),
    );
    const hasTodos = this.todoTotal >= 2 && this.todoWeightTotal > 0;
    let remaining;
    if (hasTodos) {
      // Weighted work left at the observed pace; the phase plan keeps the shape.
      const perUnit = this.paceEma ?? this.prior.median / this.todoWeightTotal;
      const todoRemaining = perUnit * Math.max(0.2, this.todoWeightTotal - this.todoWeightDone);
      remaining = 0.7 * todoRemaining + 0.3 * phaseRemaining;
    } else {
      // No todo list: the log-normal survival prior is the monotone signal,
      // tempered by the plain prior's remaining time so a cold start is not
      // paralyzed by the model's tail.
      const survival = survivalRemaining(this.prior.median, this.prior.sigma, elapsed);
      remaining = 0.5 * survival + 0.3 * priorRemaining + 0.2 * phaseRemaining;
    }
    remaining += this.toolRemaining(now);
    remaining += this.recentErrorPenalty(now);
    remaining += this.retryPenalty(now);
    remaining += this.addedWorkRemaining(now);

    // An overrunning task keeps a visible tail instead of collapsing to zero.
    if (elapsed > this.prior.median) {
      remaining = Math.max(remaining, Math.min(6 * MIN, 0.15 * elapsed));
    }
    remaining = Math.max(remaining, 30_000);

    let reason = this.reasonFor(now, status, p);

    // Empirical bucket model: correct the point estimate BEFORE smoothing (so
    // the correction is not re-applied on every update) and reuse its adjusted
    // quantiles for the band.
    const intervalModel = this.prior.intervalModel;
    let bounds = null;
    let correction = 1;
    if (intervalModel) {
      const elapsedFrac = elapsed / (elapsed + Math.max(60_000, remaining));
      const bucket = elapsedFrac < 0.34 ? 'early' : elapsedFrac < 0.67 ? 'mid' : 'late';
      const candidate = intervalModel[bucket];
      bounds = candidate && candidate.n >= MIN_PROBABILITY_SAMPLES ? candidate : intervalModel.all;
      if (bounds && Number.isFinite(bounds.med)) correction = bounds.med;
    }

    let median = clamp(remaining * correction, 30_000, 6 * 60 * 60_000);

    // Small corrections are smoothed; material changes jump immediately.
    if (this.lastMedian !== null) {
      const ratio = Math.abs(median - this.lastMedian) / Math.max(this.lastMedian, MIN);
      if (ratio <= 0.3 && !force) {
        median = 0.6 * this.lastMedian + 0.4 * median;
        if (!reason) reason = this.lastReason;
      } else if (ratio > 0.3) {
        this.bigUpdates += 1;
      }
    }
    if (!reason) reason = '初始预测';

    const uncertainty = 1 + 0.1 * Math.min(3, this.anomalies.filter((a) => now - a.at < 15 * MIN).length);
    let hw = this.prior.hw * uncertainty;
    if (this.paceSamples < 2) hw *= 1.1;
    hw = clamp(hw, 0.16, 0.55);
    // Empirical 70% band from past prediction residuals: the interval should
    // actually contain the truth about 70% of the time, not just look wide.
    const calibrated = this.prior.hw70;
    if (Number.isFinite(calibrated)) hw = clamp(0.5 * hw + 0.5 * calibrated, 0.15, 0.9);

    let low;
    let high;
    if (bounds && bounds.lo > 0 && bounds.hi > bounds.lo) {
      low = Math.max(15_000, median * bounds.lo);
      high = Math.max(low + 30_000, median * bounds.hi);
      hw = clamp((high / median - low / median) / 2, 0.12, 9);
    } else {
      low = Math.max(20_000, median * (1 - hw));
      high = Math.max(low + 30_000, median * (1 + hw));
    }

    let confidence = 'low';
    if (this.prior.n >= 5 && hw <= 0.3 && this.anomalies.length === 0) confidence = 'high';
    else if (this.prior.n >= 2 || hw <= 0.42) confidence = 'medium';

    const weak = this.classified.weak && this.prior.n === 0 && this.label.length < 16;
    if (weak && p < 0.15) {
      return {
        available: false,
        medianMs: median,
        lowMs: low,
        highMs: high,
        confidence: 'low',
        reason: '任务描述信息不足，暂时无法可靠估算',
        progress: p,
        pace: this.paceEma,
        hw,
      };
    }

    if (this.lastEstimateAt === 0 || now - this.lastEstimateAt >= 15_000 || force) {
      this.estimateHistory.push({
        at: now,
        elapsedMs: Math.round(elapsed),
        lowMs: Math.round(low),
        highMs: Math.round(high),
        medianMs: Math.round(median),
        reason,
      });
      if (this.estimateHistory.length > 40) this.estimateHistory.shift();
      this.lastEstimateAt = now;
      this.updates += 1;
    }
    this.lastMedian = median;
    this.lastLow = low;
    this.lastHigh = high;
    this.lastReason = reason;

    return {
      available: true,
      medianMs: median,
      lowMs: low,
      highMs: high,
      confidence,
      reason,
      progress: p,
      pace: this.paceEma,
      hw,
    };
  }

  reasonFor(now, status, p) {
    if (status === 'stalled') return '长时间没有可验证的进展';
    if (status === 'waiting-tool') {
      const name = this.activeTool?.name;
      const typical = (name && (this.toolEma.get(name) ?? TOOL_TYPICAL[name])) || 60_000;
      if (this.activeTool && now - this.activeTool.startedAt > typical * 1.5) {
        return '工具执行时间超出预期，剩余时间随之变化';
      }
    }
    const recentError = this.recentErrors[this.recentErrors.length - 1];
    if (recentError && now - recentError < 45_000) return '发现新的失败，已追加返工时间';
    if (this.addedWorkAt && now - this.addedWorkAt < 10 * MIN) return '任务增加了新的工作量';
    if (this.prior.n === 0) return '暂无同类历史，按任务类型与复杂度估算';
    if (p > 0.2) return '根据已完成进度与实际速度校准';
    return '参考同类任务历史耗时';
  }

  // -- snapshot ------------------------------------------------------------

  snapshot(now, stallMs) {
    const status = this.derivedStatus(now, stallMs);
    const estimate = this.computeEstimate(now, status);
    const activeKey = this.activePhaseKey;
    const displayIndex = PHASE_INDEX[activeKey] ?? 0;
    const displayDef = PHASES[displayIndex] || PHASES[0];
    return {
      id: this.sessionId,
      sessionId: this.sessionId,
      label: this.label,
      status,
      endKind: this.endKind,
      child: this.child,
      model: this.model,
      category: this.classified.category,
      categoryLabel: this.classified.categoryLabel,
      complexity: this.classified.complexity,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      elapsedMs: this.elapsed(now),
      phase: {
        index: displayIndex,
        key: activeKey,
        label: displayDef.label,
        total: PHASES.length,
      },
      phases: PHASES.map((def) => ({
        key: def.key,
        label: def.label,
        ms: Math.round((this.phaseMs[def.key] || 0) + (def.key === activeKey ? Math.max(0, now - this.lastPhaseAt) : 0)),
        active: def.key === activeKey,
      })),
      todo: this.todoTotal >= 2 ? { done: this.todoDone, total: this.todoTotal } : null,
      currentTool: this.activeTool
        ? { name: this.activeTool.name, elapsedMs: Math.max(0, now - this.activeTool.startedAt) }
        : null,
      lastProgress: { at: this.lastProgressAt, text: this.lastProgressText },
      estimate: {
        available: estimate.available,
        lowMs: Math.round(estimate.lowMs),
        highMs: Math.round(estimate.highMs),
        medianMs: Math.round(estimate.medianMs),
        confidence: estimate.confidence,
        reason: estimate.reason,
        updatedAt: now,
      },
      initial: {
        lowMs: Math.round(this.prior.median * (1 - this.prior.hw)),
        highMs: Math.round(this.prior.median * (1 + this.prior.hw)),
        medianMs: Math.round(this.prior.median),
        confidence: this.prior.n === 0 ? 'low' : 'medium',
        n: this.prior.n,
      },
      anomalies: this.anomalies.slice(-4).map((a) => ({ at: a.at, kind: a.kind, text: a.text })),
      stats: {
        toolCalls: this.stats.toolCalls,
        errors: this.stats.errors,
        toolMs: this.stats.toolMs,
        modelMs: this.stats.modelMs,
        steps: this.stats.steps,
      },
      updates: this.updates,
      bigUpdates: this.bigUpdates,
      recovered: this.recovered,
      history: this.estimateHistory.slice(-6),
    };
  }

  /** Compact record for the local history file (no prompt text by default). */
  calibrationRecord(ok, label) {
    return {
      v: 1,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      ms: this.elapsed(this.endedAt ?? this.startedAt),
      category: this.classified.category,
      complexity: this.classified.complexity,
      model: this.model,
      ok,
      endKind: this.endKind,
      initialMedianMs: Math.round(this.initialMedian()),
      initialLowMs: Math.round(this.initialLow()),
      initialHighMs: Math.round(this.initialHigh()),
      finalMedianMs: Math.round(this.lastMedian ?? 0),
      updates: this.updates,
      bigUpdates: this.bigUpdates,
      errors: this.stats.errors,
      retries: this.retryPenalties,
      toolCalls: this.stats.toolCalls,
      phaseMs: Object.fromEntries(PHASES.map((p) => [p.key, Math.round(this.phaseMs[p.key] || 0)])),
      trace: this.estimateHistory.map((p) => [p.elapsedMs, p.medianMs, p.lowMs, p.highMs]),
      label: label || undefined,
    };
  }

  initialMedian() {
    return this.prior.median;
  }
  initialLow() {
    return this.prior.median * (1 - this.prior.hw);
  }
  initialHigh() {
    return this.prior.median * (1 + this.prior.hw);
  }
}

// ---------------------------------------------------------------------------
// History-derived statistics
// ---------------------------------------------------------------------------

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function usable(records) {
  return records.filter((r) => Number.isFinite(r.ms) && r.ms >= CALIBRATION_MIN_MS && r.ms <= HISTORY_MAX_MS);
}

/** Empirical interval and bias correction for one group of residual ratios. */
function ratioBounds(points) {
  if (points.length < MIN_PROBABILITY_SAMPLES) return null;
  const rs = points.map((p) => p.r).sort((a, b) => a - b);
  const med = clamp(quantile(rs, 0.5), 0.2, 2.5);
  const adjusted = rs.map((r) => r / med).sort((a, b) => a - b);
  return {
    med,
    lo: clamp(quantile(adjusted, 0.15), R_MIN, R_MAX),
    hi: clamp(quantile(adjusted, 0.85), R_MIN, R_MAX),
    n: rs.length,
  };
}

/** Median/IQR per category, optionally narrowed by model when that model has samples. */
export function statsFor(records, category, model) {
  const all = usable(records).filter((r) => r.category === category);
  const byModel = model ? all.filter((r) => r.model === model) : [];
  const pool = byModel.length >= 2 ? byModel : all;
  if (pool.length === 0) return { n: 0, median: 0, p25: 0, p75: 0, phaseShares: null };
  const sorted = pool.map((r) => r.ms).sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    phaseShares: phaseSharesOf(pool),
  };
}

/** Median share of wall time spent in each phase, when records carry it. */
export function phaseSharesOf(records) {
  const keys = PHASES.map((p) => p.key);
  const columns = Object.fromEntries(keys.map((k) => [k, []]));
  let used = 0;
  for (const record of records) {
    const pm = record && record.phaseMs;
    if (!pm || typeof pm !== 'object') continue;
    let total = 0;
    for (const k of keys) total += Number(pm[k]) || 0;
    if (total < 10_000) continue;
    used += 1;
    for (const k of keys) columns[k].push((Number(pm[k]) || 0) / total);
  }
  if (used < 3) return null;
  const shares = {};
  for (const k of keys) shares[k] = quantile(columns[k].sort((a, b) => a - b), 0.5);
  const sum = keys.reduce((acc, k) => acc + shares[k], 0) || 1;
  for (const k of keys) shares[k] = shares[k] / sum;
  return { shares, n: used };
}

/** One record's estimate trace as [elapsedMs, medianMs, lowMs, highMs]. */
export function tracePoints(record) {
  if (!record || !Array.isArray(record.trace)) return [];
  return record.trace.filter((p) => Array.isArray(p) && p.length >= 4 && p[1] > 0 && p[0] >= 0);
}

/**
 * Empirical calibration over real completed tasks.
 *
 * `r` is the ratio actual-remaining / predicted-median at one update. The 70th
 * percentile of |r-1| is the interval half-width that would have covered the
 * truth in 70% of past updates, so the live interval can be calibrated instead
 * of merely widened.
 */
export function buildCalibration(records) {
  const rows = usable(records);
  const points = [];
  for (const row of rows) {
    for (const [elapsed, median, low, high] of tracePoints(row)) {
      const actual = row.ms - elapsed;
      if (actual < 0) continue;
      points.push({
        // Same progress axis the live estimator uses to pick a bucket.
        f: elapsed / (elapsed + median),
        r: actual / median,
        covered: actual >= low && actual <= high,
        err: Math.abs(median - actual),
      });
    }
  }
  const deviations = points.map((p) => Math.abs(p.r - 1)).sort((a, b) => a - b);
  const hw70 = deviations.length >= MIN_PROBABILITY_SAMPLES ? quantile(deviations, 0.7) : null;
  // Asymmetric empirical bounds per progress bucket. Using the 15th/85th
  // percentile of the observed ratio yields an interval that, on past data,
  // contains the truth about 70% of the time -- the number the UI reports.
  const intervalModel = {
    all: ratioBounds(points),
    early: ratioBounds(points.filter((p) => p.f < 0.34)),
    mid: ratioBounds(points.filter((p) => p.f >= 0.34 && p.f < 0.67)),
    late: ratioBounds(points.filter((p) => p.f >= 0.67)),
  };

  const checkpoints = {};
  for (const target of [0.25, 0.5, 0.75]) {
    let n = 0;
    let covered = 0;
    let absErr = 0;
    let rel = 0;
    for (const row of rows) {
      let best = null;
      for (const point of tracePoints(row)) {
        if (point[0] <= target * row.ms) best = point;
      }
      if (!best) continue;
      const actual = row.ms - best[0];
      if (actual <= 0) continue;
      n += 1;
      if (actual >= best[2] && actual <= best[3]) covered += 1;
      absErr += Math.abs(best[1] - actual);
      rel += Math.abs(best[1] - actual) / actual;
    }
    checkpoints[target] = n > 0
      ? { n, coverage: covered / n, maeMs: Math.round(absErr / n), mape: rel / n }
      : { n: 0, coverage: null, maeMs: null, mape: null };
  }
  return { tasks: rows.length, samples: points.length, points, hw70, checkpoints, intervalModel };
}

/**
 * Probability that the actual remaining time falls inside [low, high], using
 * historical ratios at a comparable progress point. `null` when the sample is
 * too small to claim a number.
 */
export function probabilityFor(model, low, high, median, elapsedFrac) {
  if (!model || !Array.isArray(model.points) || !(median > 0)) return { p: null, n: 0, source: 'none' };
  const bucket = elapsedFrac < 0.34 ? 'early' : elapsedFrac < 0.67 ? 'mid' : 'late';
  const bucketPoints = model.points.filter((point) => {
    const b = point.f < 0.34 ? 'early' : point.f < 0.67 ? 'mid' : 'late';
    return b === bucket;
  });
  const useBucket = bucketPoints.length >= MIN_PROBABILITY_SAMPLES;
  const pool = useBucket ? bucketPoints : model.points;
  if (pool.length < MIN_PROBABILITY_SAMPLES) return { p: null, n: pool.length, source: 'insufficient' };
  const bounds = model.intervalModel
    ? (useBucket ? model.intervalModel[bucket] : model.intervalModel.all)
    : null;
  const correction = bounds && Number.isFinite(bounds.med) ? bounds.med : 1;
  const lo = low / median;
  const hi = high / median;
  let inside = 0;
  for (const point of pool) {
    const adjusted = point.r / correction;
    if (adjusted >= lo && adjusted <= hi) inside += 1;
  }
  return { p: (inside + 1) / (pool.length + 2), n: pool.length, source: useBucket ? 'bucket' : 'all' };
}

/** Calibration report shown in the panel and used by the docs. */
export function calibrationOf(records) {
  const model = buildCalibration(records);
  const rows = model.tasks > 0 ? usable(records) : [];
  if (rows.length === 0) {
    return {
      tasks: 0, coverage: null, maeMs: null, mape: null, flutter: null, avgUpdates: null,
      checkpoints: model.checkpoints, samples: 0, hw70: null,
    };
  }
  let covered = 0;
  let absErr = 0;
  let mape = 0;
  let flutter = 0;
  let updates = 0;
  for (const r of rows) {
    if (Number.isFinite(r.initialLowMs) && Number.isFinite(r.initialHighMs) && r.ms >= r.initialLowMs && r.ms <= r.initialHighMs) {
      covered += 1;
    }
    absErr += Math.abs(r.ms - (r.initialMedianMs || 0));
    mape += Math.abs(r.ms - (r.initialMedianMs || 0)) / r.ms;
    flutter += r.bigUpdates || 0;
    updates += r.updates || 0;
  }
  return {
    tasks: rows.length,
    coverage: covered / rows.length,
    maeMs: Math.round(absErr / rows.length),
    mape: mape / rows.length,
    flutter: flutter / rows.length,
    avgUpdates: updates / rows.length,
    checkpoints: model.checkpoints,
    samples: model.samples,
    hw70: model.hw70,
  };
}