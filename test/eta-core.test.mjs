import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EtaTask,
  buildCalibration,
  calibrationOf,
  classify,
  priorFor,
  probabilityFor,
  statsFor,
  survivalRemaining,
  todoWeight,
} from '../lib/eta-core.js';

const T0 = 1_700_000_000_000;
let seq = 0;

const ev = (type, time, data = {}) => ({ type, seq: (seq += 1), time, data });
const user = (time, text) => ev('user/message', time, { content: [{ type: 'text', text }] });
const toolCall = (time, callId, name, args = '{}') => ev('tool/call', time, { callId, name, arguments: args });
const toolResult = (time, callId, isError = false, name = 'tool') => ev('tool/result', time, {
  callId,
  message: { role: 'tool', isError },
  error: isError ? { name: 'Error', code: 'E' } : undefined,
  name,
});

function makeTask(text = '修复登录接口报错', extra = {}) {
  const classified = classify(text);
  const prior = priorFor(classified, null);
  return new EtaTask({ sessionId: 's', startedAt: T0, prior, classified, ...extra });
}

test('classify picks a category with a complexity multiplier', () => {
  assert.equal(classify('修复 MATLAB 信道模型的报错').category, 'debug');
  assert.equal(classify('修改 MATLAB 信道模型并完成仿真验证').category, 'research');
  assert.equal(classify('写一份实验报告并整理排版').category, 'doc');
  assert.equal(classify('把 csv 批量转换成表格').category, 'data');
  assert.equal(classify('看看这个').category, 'general');
  assert.ok(classify('所有文件全部重构，并跑完整测试和回归').complexity > 1.2);
  assert.ok(classify('快速小改一下').complexity < 1);
});

test('estimate has a usable ordered interval and a low-confidence start', () => {
  const task = makeTask();
  task.observe(user(T0, '修复登录接口报错'));
  task.observe(ev('turn/start', T0 + 50, { turn: 1 }));
  task.observe(toolCall(T0 + 1_000, 'c1', 'read', '{"file_path":"a.ts"}'));
  const snap = task.snapshot(T0 + 4_000, 240_000);
  assert.equal(snap.status, 'waiting-tool');
  assert.ok(snap.estimate.lowMs < snap.estimate.medianMs);
  assert.ok(snap.estimate.medianMs < snap.estimate.highMs);
  assert.ok(snap.initial.lowMs > 0);
  assert.equal(snap.estimate.confidence, 'low');
  assert.equal(snap.category, 'debug');
});

test('todo progress shrinks the ETA instead of counting tool calls', () => {
  const task = makeTask('实现登录流程并补测试');
  task.observe(user(T0, '实现登录流程并补测试'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const todos = (done) => JSON.stringify({
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: done >= 2 ? 'completed' : 'pending' },
      { content: 'c', status: done >= 3 ? 'completed' : 'pending' },
      { content: 'd', status: 'pending' },
    ],
  });
  task.observe(toolCall(T0 + 20_000, 't1', 'todo_write', todos(1)));
  task.observe(toolResult(T0 + 21_000, 't1'));
  const early = task.snapshot(T0 + 30_000, 240_000);

  task.observe(toolCall(T0 + 60_000, 't2', 'todo_write', todos(2)));
  task.observe(toolResult(T0 + 61_000, 't2'));
  const mid = task.snapshot(T0 + 90_000, 240_000);

  task.observe(toolCall(T0 + 120_000, 't3', 'todo_write', todos(3)));
  task.observe(toolResult(T0 + 121_000, 't3'));
  const late = task.snapshot(T0 + 150_000, 240_000);

  assert.ok(mid.estimate.medianMs < early.estimate.medianMs);
  assert.ok(late.estimate.medianMs < mid.estimate.medianMs);
  assert.deepEqual(late.todo, { done: 3, total: 4 });
  assert.ok(late.estimate.medianMs > 0, 'ETA must never collapse to zero while running');
});

test('a failed tool call adds rework time and records an anomaly', () => {
  const task = makeTask('修复编译失败');
  task.observe(user(T0, '修复编译失败'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 5_000, 'c1', 'bash', '{"command":"npm test"}'));
  task.observe(toolResult(T0 + 40_000, 'c1', false, 'bash'));
  const before = task.snapshot(T0 + 45_000, 240_000);

  task.observe(toolCall(T0 + 50_000, 'c2', 'bash', '{"command":"npm test"}'));
  task.observe(toolResult(T0 + 95_000, 'c2', true, 'bash'));
  const after = task.snapshot(T0 + 100_000, 240_000);

  assert.ok(after.stats.errors >= 1);
  assert.ok(after.anomalies.some((a) => a.kind === 'error'));
  assert.ok(after.estimate.medianMs > before.estimate.medianMs);
  assert.match(after.estimate.reason, /失败/);
});

test('a long-running tool is "waiting", never "stalled"', () => {
  const task = makeTask('跑一遍 MATLAB 仿真');
  task.observe(user(T0, '跑一遍 MATLAB 仿真'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 2_000, 'c1', 'run_matlab_file', '{"script_path":"a.m"}'));
  const snap = task.snapshot(T0 + 300_000, 240_000);
  assert.equal(snap.status, 'waiting-tool');
  assert.equal(snap.currentTool.name, 'run_matlab_file');
});

test('silence without a running tool becomes a stall signal', () => {
  const task = makeTask('分析这个问题');
  task.observe(user(T0, '分析这个问题'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const early = task.snapshot(T0 + 60_000, 240_000);
  const late = task.snapshot(T0 + 400_000, 240_000);
  assert.equal(early.status, 'running');
  assert.equal(late.status, 'stalled');
  assert.match(late.estimate.reason, /进展/);
});

test('steering mid-task raises the estimate and records why', () => {
  const task = makeTask('整理数据');
  task.observe(user(T0, '整理数据'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 2_000, 'c1', 'read', '{}'));
  task.observe(toolResult(T0 + 4_000, 'c1'));
  const before = task.snapshot(T0 + 5_000, 240_000);
  task.observe(user(T0 + 60_000, '顺便把图表也画出来'));
  const after = task.snapshot(T0 + 61_000, 240_000);
  assert.ok(after.anomalies.some((a) => a.kind === 'steering'));
  assert.ok(after.estimate.medianMs > before.estimate.medianMs);
});

test('a vague prompt reports "cannot estimate" instead of a fake number', () => {
  const task = makeTask('看看这个');
  task.observe(user(T0, '看看这个'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const snap = task.snapshot(T0 + 2_000, 240_000);
  assert.equal(snap.estimate.available, false);
  assert.match(snap.estimate.reason, /信息不足/);
});

test('a host notice before the real prompt is not charged as steering', () => {
  const text = 'The user changed the approval policy from ask to never';
  const task = new EtaTask({
    sessionId: 's',
    startedAt: T0,
    prior: priorFor(classify(text), null),
    classified: classify(text),
    priorFactory: (classified) => priorFor(classified, null),
  });
  task.observe(user(T0, text));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(user(T0 + 20, '开发一个插件：实现实时耗时预测，包含历史校准和界面'));
  const snap = task.snapshot(T0 + 30_000, 240_000);
  assert.equal(snap.category, 'feature');
  assert.equal(snap.anomalies.length, 0);
  assert.match(snap.label, /开发一个插件/);
});

test('a long specification is classified by its request, not by error words inside it', () => {
  const spec = '开发任务：实现一个进度插件，包含界面和历史校准。需要覆盖失败、异常、取消等场景。';
  assert.equal(classify(spec).category, 'feature');
});

test('harness reminders are ignored when choosing the task label', () => {
  const task = makeTask('');
  task.observe(user(T0, '<system-reminder> A skill is a reusable set of instructions: matlab-debug-code, error handling </system-reminder>'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(user(T0 + 20, '开发一个实时耗时预测插件，包含界面和历史校准'));
  const snap = task.snapshot(T0 + 30_000, 240_000);
  assert.equal(snap.label, '开发一个实时耗时预测插件，包含界面和历史校准');
  assert.equal(snap.category, 'feature');
});

test('runtime clock messages are neither a task nor steering', () => {
  const task = makeTask('');
  task.observe(user(T0, 'Time sampled while preparing turn 1, step 1'));
  assert.equal(task.sawPrompt, false);
  task.observe(user(T0 + 1, '写一个脚本'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(user(T0 + 30_000, 'Elapsed since the preceding model-visible message: unavailable.'));
  const snap = task.snapshot(T0 + 31_000, 240_000);
  assert.equal(snap.label, '写一个脚本');
  assert.equal(snap.anomalies.length, 0);
});

test('phases advance on evidence, not on every shell command', () => {
  const task = makeTask('修复构建失败');
  task.observe(user(T0, '修复构建失败'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 1_000, 'c1', 'pwsh', '{"command":"git status"}'));
  task.observe(toolResult(T0 + 2_000, 'c1'));
  assert.equal(task.snapshot(T0 + 3_000, 240_000).phase.index, 0, 'inspection stays in explore');

  task.observe(toolCall(T0 + 10_000, 'c2', 'edit', '{}'));
  task.observe(toolResult(T0 + 11_000, 'c2'));
  assert.equal(task.snapshot(T0 + 12_000, 240_000).phase.index, 1);

  task.observe(toolCall(T0 + 20_000, 'c3', 'pwsh', '{"command":"npm test"}'));
  task.observe(toolResult(T0 + 60_000, 'c3'));
  assert.equal(task.snapshot(T0 + 61_000, 240_000).phase.index, 2);
  assert.equal(task.snapshot(T0 + 61_000, 240_000).phase.label, '运行与验证');
});

test('present marks the remaining phases complete', () => {
  const task = makeTask('整理一份说明');
  task.observe(user(T0, '整理一份说明'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 5_000, 'c1', 'present', '{}'));
  task.observe(toolResult(T0 + 6_000, 'c1'));
  const snap = task.snapshot(T0 + 7_000, 240_000);
  assert.equal(snap.phase.index, 3);
});

test('todo effort weights follow the item wording', () => {
  assert.equal(todoWeight('实现登录页'), 1);
  assert.equal(todoWeight('运行完整测试并回归'), 1.5);
  assert.equal(todoWeight('补充 README 文档'), 0.8);
  assert.equal(todoWeight('修复编译报错'), 1.2);
});

test('pending verification work costs more than pending documentation', () => {
  const make = (pendingText) => {
    const task = makeTask('实现导出功能');
    task.observe(user(T0, '实现导出功能'));
    task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
    const todos = JSON.stringify({
      todos: [
        { content: '实现导出函数', status: 'completed' },
        { content: pendingText, status: 'pending' },
      ],
    });
    task.observe(toolCall(T0 + 60_000, 't1', 'todo_write', todos));
    task.observe(toolResult(T0 + 61_000, 't1'));
    return task.snapshot(T0 + 120_000, 240_000).estimate.medianMs;
  };
  const withTest = make('运行完整测试并回归');
  const withDocs = make('补充 README 文档');
  assert.ok(withTest > withDocs);
});

test('calibration turns real traces into checkpoints and a 70% band', () => {
  const records = [];
  for (let i = 0; i < 12; i += 1) {
    const ms = 600_000;
    const jitter = ((i % 5) - 2) * 0.08;
    const at = (elapsed) => {
      const actual = ms - elapsed;
      const median = Math.round(actual * (1 + jitter));
      return [elapsed, median, Math.round(median * 0.7), Math.round(median * 1.4)];
    };
    records.push({
      ms,
      category: 'feature',
      trace: [at(0), at(150_000), at(300_000), at(450_000)],
    });
  }
  const model = buildCalibration(records);
  assert.equal(model.samples, 48);
  assert.ok(model.hw70 > 0 && model.hw70 < 1);
  assert.equal(model.checkpoints[0.25].n, 12);
  assert.ok(model.checkpoints[0.25].coverage >= 0.9);
  assert.ok(model.checkpoints[0.5].maeMs >= 0);

  const p = probabilityFor(model, 300_000, 700_000, 480_000, 0.2);
  assert.ok(p.p > 0.5 && p.p <= 1);
  assert.ok(p.n >= 8);
});

test('probability stays unavailable until the sample is large enough', () => {
  const thin = buildCalibration([
    { ms: 600_000, trace: [[0, 600_000, 400_000, 900_000]] },
  ]);
  const p = probabilityFor(thin, 400_000, 900_000, 600_000, 0.1);
  assert.equal(p.p, null);
  assert.equal(p.source, 'insufficient');
});

test('survival remaining is monotone and never negative', () => {
  const a = survivalRemaining(600_000, 0.5, 0);
  const b = survivalRemaining(600_000, 0.5, 300_000);
  const c = survivalRemaining(600_000, 0.5, 540_000);
  const d = survivalRemaining(600_000, 0.5, 900_000);
  assert.ok(a > b && b > c && c > d);
  assert.ok(d >= 0);
  assert.ok(a <= 600_000);
});

test('a biased history shrinks the point estimate through the bucket model', () => {
  // Historical predictions were twice the truth: correction should be ~0.5.
  const records = [];
  for (let i = 0; i < 10; i += 1) {
    records.push({
      ms: 600_000,
      category: 'feature',
      trace: [[0, 1_200_000, 900_000, 1_500_000]],
    });
  }
  const model = buildCalibration(records);
  assert.ok(model.intervalModel.all.med < 0.6);
  const task = new EtaTask({
    sessionId: 's',
    startedAt: T0,
    prior: { ...priorFor(classify('实现导出功能'), null), intervalModel: model.intervalModel },
    classified: classify('实现导出功能'),
  });
  task.observe(user(T0, '实现导出功能'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const snap = task.snapshot(T0 + 5_000, 240_000);
  assert.ok(snap.estimate.medianMs < 600_000);
  assert.ok(snap.estimate.lowMs <= snap.estimate.medianMs);
  assert.ok(snap.estimate.highMs >= snap.estimate.medianMs);
});

test('a workspace with enough samples gets its own prior', () => {
  const rows = [
    { ms: 10 * 60_000, category: 'feature', cwd: 'A' },
    { ms: 11 * 60_000, category: 'feature', cwd: 'A' },
    { ms: 9 * 60_000, category: 'feature', cwd: 'A' },
    { ms: 60 * 60_000, category: 'feature', cwd: 'B' },
    { ms: 62 * 60_000, category: 'feature', cwd: 'B' },
    { ms: 58 * 60_000, category: 'feature', cwd: 'B' },
  ];
  const inA = statsFor(rows, 'feature', null, 'A');
  assert.equal(inA.scope, 'workspace');
  assert.ok(inA.median < 15 * 60_000);
  const noWorkspace = statsFor(rows, 'feature', null, 'C');
  assert.equal(noWorkspace.scope, 'category');
});

test('older tasks count less than recent ones', () => {
  const now = Date.UTC(2026, 10, 8);
  const rows = [
    { ms: 60 * 60_000, category: 'feature', endedAt: now - 365 * 24 * 60 * 60_000 },
    { ms: 10 * 60_000, category: 'feature', endedAt: now },
  ];
  const stats = statsFor(rows, 'feature', null, null, now);
  assert.ok(stats.median < 20 * 60_000);
});

test('the first plan seeds the pace from learned time per plan unit', () => {
  const prior = { ...priorFor(classify('实现导出功能'), null), unitMs: 120_000 };
  const task = new EtaTask({ sessionId: 's', startedAt: T0, prior, classified: classify('实现导出功能') });
  task.observe(user(T0, '实现导出功能'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const todos = JSON.stringify({
    todos: [
      { content: '实现导出函数', status: 'pending' },
      { content: '补一条测试', status: 'pending' },
    ],
  });
  task.observe(toolCall(T0 + 20_000, 't1', 'todo_write', todos));
  task.observe(toolResult(T0 + 21_000, 't1'));
  const snap = task.snapshot(T0 + 30_000, 240_000);
  // 2 weight units x 2 min = 4 min, not the static 10-12 min prior.
  assert.ok(snap.estimate.medianMs < 8 * 60_000);
});

test('turn end settles the task and produces a calibration record', () => {
  const task = makeTask('改一个配置');
  task.observe(user(T0, '改一个配置'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(toolCall(T0 + 1_000, 'c1', 'edit', '{}'));
  task.observe(toolResult(T0 + 3_000, 'c1'));
  task.observe(ev('turn/end', T0 + 120_000, { turn: 1, reason: { kind: 'completed' } }));
  const snap = task.snapshot(T0 + 130_000, 240_000);
  assert.equal(snap.status, 'done');
  assert.equal(snap.elapsedMs, 120_000);
  assert.equal(snap.estimate.medianMs, 0);

  const record = task.calibrationRecord(true, 'label');
  assert.equal(record.ms, 120_000);
  assert.equal(record.ok, true);
  assert.equal(record.category, 'feature');
  assert.ok(record.initialMedianMs > 0);
  assert.equal(record.label, 'label');
});

test('cancelled turns are not counted as success', () => {
  const task = makeTask('跑一个长任务');
  task.observe(user(T0, '跑一个长任务'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  task.observe(ev('turn/end', T0 + 30_000, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));
  assert.equal(task.snapshot(T0 + 31_000, 240_000).status, 'cancelled');
  assert.equal(task.calibrationRecord(false).ok, false);
});

test('history statistics use per-category medians and ignore outliers', () => {
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push({ ms: 600_000 + i * 60_000, category: 'feature', model: 'm1' });
  }
  rows.push({ ms: 60 * 60_000, category: 'feature', model: 'm1' }); // > 6h noise? still under limit
  rows.push({ ms: 1_000, category: 'feature', model: 'm1' }); // too short
  const stats = statsFor(rows, 'feature', 'm1');
  assert.equal(stats.n, 6);
  assert.ok(stats.median >= 600_000);
  assert.ok(stats.p25 <= stats.median && stats.median <= stats.p75);
  assert.equal(statsFor(rows, 'debug', null).n, 0);
});

test('prior blends with history as samples accumulate', () => {
  const classified = classify('实现一个新的导出功能');
  const bare = priorFor(classified, null);
  const learned = priorFor(classified, { n: 10, median: 40 * 60_000, p25: 30 * 60_000, p75: 50 * 60_000 });
  assert.ok(learned.median > bare.median);
  assert.ok(learned.hw < bare.hw);
});

test('calibration report computes coverage and error metrics', () => {
  const rows = [
    { ms: 600_000, initialLowMs: 400_000, initialHighMs: 900_000, initialMedianMs: 650_000, updates: 4, bigUpdates: 1 },
    { ms: 1_200_000, initialLowMs: 400_000, initialHighMs: 900_000, initialMedianMs: 650_000, updates: 6, bigUpdates: 2 },
  ];
  const cal = calibrationOf(rows);
  assert.equal(cal.tasks, 2);
  assert.equal(cal.coverage, 0.5);
  assert.ok(cal.maeMs > 0);
  assert.equal(cal.flutter, 1.5);
});

test('a cold start estimates a short turn, not the category median', () => {
  const task = makeTask('修复登录接口报错');
  task.observe(user(T0, '修复登录接口报错'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const snap = task.snapshot(T0 + 3_000, 240_000);
  // The category prior for `debug` is nine minutes; the chip must not promise
  // that before the task has shown it is a long one.
  assert.ok(snap.estimate.medianMs <= 60_000, `median ${snap.estimate.medianMs}`);
  assert.ok(snap.initial.medianMs <= 60_000, `initial ${snap.initial.medianMs}`);
  assert.ok(snap.estimate.highMs / snap.estimate.lowMs <= 2.45);
});

test('a task that outlives the short-turn window grows into the category prior', () => {
  const task = makeTask('实现导出功能');
  task.observe(user(T0, '实现导出功能'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const early = task.snapshot(T0 + 10_000, 240_000);
  const late = task.snapshot(T0 + 200_000, 240_000);
  assert.ok(late.estimate.medianMs > early.estimate.medianMs * 3, 'long task must not stay on the short scale');
});

test('the interval narrows as the task progresses', () => {
  const span = (snap) => snap.estimate.highMs / snap.estimate.lowMs;
  const task = makeTask('实现登录流程并补测试');
  task.observe(user(T0, '实现登录流程并补测试'));
  task.observe(ev('turn/start', T0 + 10, { turn: 1 }));
  const todos = (done) => JSON.stringify({
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: done >= 2 ? 'completed' : 'pending' },
      { content: 'c', status: done >= 3 ? 'completed' : 'pending' },
      { content: 'd', status: 'pending' },
    ],
  });
  task.observe(toolCall(T0 + 20_000, 't1', 'todo_write', todos(1)));
  task.observe(toolResult(T0 + 21_000, 't1'));
  const early = task.snapshot(T0 + 30_000, 240_000);
  task.observe(toolCall(T0 + 120_000, 't2', 'todo_write', todos(3)));
  task.observe(toolResult(T0 + 121_000, 't2'));
  const late = task.snapshot(T0 + 150_000, 240_000);
  assert.ok(span(early) <= 2.45);
  assert.ok(span(late) <= 1.7, `late span ${span(late)}`);
  assert.ok(span(late) <= span(early));
});

test('calibration exposes the short-turn median for the cold start', () => {
  const records = [];
  for (let i = 0; i < 10; i += 1) records.push({ ms: 12_000, trace: [] });
  for (let i = 0; i < 5; i += 1) records.push({ ms: 900_000, trace: [] });
  const model = buildCalibration(records);
  assert.equal(model.tasks, 5, 'only long tasks feed the bias model');
  assert.ok(model.quickMs > 10_000 && model.quickMs < 20_000, `quickMs ${model.quickMs}`);
});