/**
 * dsh-live-eta — browser half.
 *
 * A compact chip in the composer tool row (aligned with the input box), plus a
 * floating detail panel portalled to <body> so the docked composer cannot clip
 * it. The chip only exists while a task is running or briefly after it ends;
 * otherwise the composer is untouched.
 *
 * Data comes from one localhost GET (6 s while running, 20 s otherwise). The
 * elapsed clock is local, so a stalled plugin degrades to a plain timer.
 */

window.__ModuleLoader__.load({
  id: 'dsh-live-eta',
  factory(require) {
    const React = require('react');
    const ReactDOM = require('react-dom');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = 'live-eta';
    const ROUTE = '/api/dsh-live-eta';
    const RUNNING_POLL_MS = 5000;
    const IDLE_POLL_MS = 1500;
    const DONE_POLL_MS = 15000;
    const PANEL_WIDTH = 372;

    const zh = {
      'status.running': '运行中',
      'status.waiting-tool': '等待工具',
      'status.waiting-user': '等待你的操作',
      'status.stalled': '疑似停滞',
      'status.done': '已完成',
      'status.cancelled': '已取消',
      'status.error': '出错',
      'status.incomplete': '未完全完成',
      'chip.left': '剩',
      'chip.unknown': '时间未知',
      'eta.done': '用时',
      'eta.finishAt': '预计完成',
      'phase.prefix': '阶段',
      'conf.high': '可信度较高',
      'conf.medium': '可信度中等',
      'conf.low': '可信度较低',
      'label.initial': '初始预测',
      'label.current': '当前预测',
      'label.phases': '阶段',
      'label.todos': '计划',
      'label.calibration': '历史校准',
      'stats.tools': '工具',
      'stats.errors': '错误',
      'stats.toolTime': '工具耗时',
      'stats.modelTime': '模型耗时',
      'todo.prefix': '待办',
      'parallel.prefix': '子任务',
      'cal.tasks': '已完成任务',
      'cal.coverage': '区间覆盖率',
      'cal.mae': '中位绝对误差',
      'cal.checkpoints': '25/50/75% 覆盖',
      'cal.none': '暂无历史数据，预测区间偏宽',
      'prob.label': '区间把握',
      'prob.value': '约 {p}%',
      'prob.hint': '历史 {n} 个预测点中，实际剩余时间落在此区间的比例',
      'prob.none': '样本不足，暂不给出概率',
      'progress.last': '上次有效进展',
      'progress.ago': '{m} 分钟前',
      'action.refresh': '刷新',
      'action.clear': '清空历史',
      'action.confirm': '确认清空',
      'action.cancel': '取消',
      'action.close': '关闭',
      'error.host': '预测服务不可用',
      'unit.min': '分',
      'unit.hour': '小时',
      'empty': '暂无运行中的任务',
      'title.hint': '点击查看耗时预测详情',
    };

    const en = {
      'status.running': 'Running',
      'status.waiting-tool': 'Waiting for tool',
      'status.waiting-user': 'Waiting for you',
      'status.stalled': 'Possibly stalled',
      'status.done': 'Done',
      'status.cancelled': 'Cancelled',
      'status.error': 'Failed',
      'status.incomplete': 'Incomplete',
      'chip.left': 'left',
      'chip.unknown': 'time unknown',
      'eta.done': 'Took',
      'eta.finishAt': 'ETA',
      'phase.prefix': 'Phase',
      'conf.high': 'High confidence',
      'conf.medium': 'Medium confidence',
      'conf.low': 'Low confidence',
      'label.initial': 'Initial estimate',
      'label.current': 'Current estimate',
      'label.phases': 'Phases',
      'label.todos': 'Plan',
      'label.calibration': 'Calibration',
      'stats.tools': 'Tools',
      'stats.errors': 'Errors',
      'stats.toolTime': 'Tool time',
      'stats.modelTime': 'Model time',
      'todo.prefix': 'Todos',
      'parallel.prefix': 'Subtasks',
      'cal.tasks': 'Completed tasks',
      'cal.coverage': 'Interval coverage',
      'cal.mae': 'Median abs. error',
      'cal.checkpoints': '25/50/75% coverage',
      'cal.none': 'No history yet; the interval stays wide',
      'prob.label': 'Interval confidence',
      'prob.value': '~{p}%',
      'prob.hint': 'Share of {n} historical prediction points whose actual remaining time fell in the interval',
      'prob.none': 'Not enough history to state a probability',
      'progress.last': 'Last real progress',
      'progress.ago': '{m} min ago',
      'action.refresh': 'Refresh',
      'action.clear': 'Clear history',
      'action.confirm': 'Confirm clear',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'error.host': 'Estimator unavailable',
      'unit.min': 'm',
      'unit.hour': 'h',
      'empty': 'No running task',
      'title.hint': 'Click for estimate details',
    };

    const CSS = [
      '.dle-chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 7px;margin:0 1px;',
      'border:none;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;max-width:230px;overflow:hidden;flex:none}',
      '.dle-chip:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));',
      'color:var(--dsw-alias-label-primary)}',
      '.dle-chip .dle-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary)}',
      '.dle-chip.is-ok .dle-dot{background:var(--dsw-alias-state-success-primary)}',
      '.dle-chip.is-warn .dle-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.dle-chip.is-bad .dle-dot{background:var(--dsw-alias-state-error-primary)}',
      '.dle-chip.is-idle .dle-dot{background:var(--dsw-alias-state-idle-primary)}',
      '.dle-chip .dle-e{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dle-chip .dle-eta{overflow:hidden;text-overflow:ellipsis}',
      '.dle-chip .dle-bang{color:var(--dsw-alias-state-warn-primary);font-weight:700}',
      '.dle-pop{position:fixed;z-index:80;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;',
      'padding:12px 14px;border-radius:12px;background:var(--dsw-alias-bg-overlay);',
      'border:1px solid var(--dsw-alias-border-l2);box-shadow:0 12px 32px rgba(0,0,0,.28);',
      'color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow:auto;',
      'font-variant-numeric:tabular-nums}',
      '.dle-head{display:flex;align-items:flex-start;gap:8px}',
      '.dle-title{flex:1 1 auto;min-width:0;font-size:13px;font-weight:600;line-height:19px;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
      '.dle-x{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;',
      'color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;line-height:1;padding:0}',
      '.dle-x:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));',
      'color:var(--dsw-alias-label-primary)}',
      '.dle-state{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary)}',
      '.dle-state .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}',
      '.dle-state .dot.is-ok{background:var(--dsw-alias-state-success-primary)}',
      '.dle-state .dot.is-warn{background:var(--dsw-alias-state-warn-primary)}',
      '.dle-state .dot.is-bad{background:var(--dsw-alias-state-error-primary)}',
      '.dle-state .dot.is-idle{background:var(--dsw-alias-state-idle-primary)}',
      '.dle-strong{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dle-etaRow{display:flex;align-items:baseline;gap:8px}',
      '.dle-etaRow .big{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.dle-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dle-sec{display:flex;flex-direction:column;gap:3px;padding-top:8px;',
      'border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dle-secTitle{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}',
      '.dle-ph{display:flex;align-items:center;gap:8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dle-ph.on{color:var(--dsw-alias-label-primary)}',
      '.dle-ph .mark{flex:none;width:12px;text-align:center}',
      '.dle-ph .name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dle-ph .d{flex:none}',
      '.dle-todo{display:flex;align-items:flex-start;gap:7px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dle-todo.active{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dle-todo.done .text{text-decoration:line-through;opacity:.65}',
      '.dle-todo .mark{flex:none;width:12px;text-align:center}',
      '.dle-todo .text{flex:1 1 auto;min-width:0;white-space:normal;word-break:break-word}',
      '.dle-todo-c{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}',
      '.dle-kv{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}',
      '.dle-kv b{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dle-warn{font-size:11px;line-height:17px;color:var(--dsw-alias-state-warn-primary)}',
      '.dle-foot{display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dle-btn{font:inherit;font-size:11px;line-height:22px;padding:0 9px;border-radius:6px;',
      'border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dle-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dle-btn.danger{color:var(--dsw-alias-state-error-primary)}',
      '.dle-spacer{flex:1 1 auto}',
    ].join('');

    // -- formatting ---------------------------------------------------------

    const pad2 = (n) => (n < 10 ? '0' + n : String(n));

    function fmtClock(ms) {
      const total = Math.max(0, Math.round(ms / 1000));
      const hh = Math.floor(total / 3600);
      const mm = Math.floor((total % 3600) / 60);
      const ss = total % 60;
      return hh > 0 ? hh + ':' + pad2(mm) + ':' + pad2(ss) : pad2(mm) + ':' + pad2(ss);
    }

    function fmtSpan(ms, t) {
      const m = Math.max(0, ms) / 60000;
      const min = t('unit.min');
      if (m < 1) return '<1' + min;
      if (m < 10) return Math.max(1, Math.round(m)) + min;
      if (m < 60) return Math.round(m / 5) * 5 + min;
      const hours = m / 60;
      return (hours < 10 ? hours.toFixed(1) : String(Math.round(hours))) + ' ' + t('unit.hour');
    }

    function fmtRange(low, high, t) {
      const lo = fmtSpan(low, t);
      const hi = fmtSpan(high, t);
      return lo === hi ? lo : lo + '–' + hi;
    }

    function fmtAt(epoch) {
      if (!Number.isFinite(epoch)) return '';
      const d = new Date(epoch);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    const ENDED = new Set(['done', 'cancelled', 'error', 'incomplete']);
    const DOT = { done: 'is-ok', cancelled: 'is-idle', error: 'is-bad', stalled: 'is-warn', incomplete: 'is-warn' };

    // -- popover anchor -----------------------------------------------------

    function useAnchor(open, anchorRef) {
      const [pos, setPos] = useState(null);
      useEffect(() => {
        if (!open) return undefined;
        const update = () => {
          const node = anchorRef.current;
          if (!node) return;
          const r = node.getBoundingClientRect();
          const width = Math.min(PANEL_WIDTH, window.innerWidth - 24);
          const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
          const room = Math.max(160, r.top - 16);
          setPos({
            left,
            bottom: Math.max(12, window.innerHeight - r.top + 8),
            width,
            maxHeight: Math.min(430, room),
          });
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => {
          window.removeEventListener('resize', update);
          window.removeEventListener('scroll', update, true);
        };
      }, [open, anchorRef]);
      return pos;
    }

    // -- chip + panel -------------------------------------------------------

    function LiveEta({ sessionId, t }) {
      const tr = typeof t === 'function' ? t : (k) => zh[k] || k;
      const [payload, setPayload] = useState(null);
      const [fetchedAt, setFetchedAt] = useState(0);
      const [open, setOpen] = useState(false);
      const [confirmClear, setConfirmClear] = useState(false);
      const [, forceTick] = useState(0);
      const statusRef = useRef('idle');
      const timerRef = useRef(null);
      const chipRef = useRef(null);
      const popRef = useRef(null);

      const load = useCallback(async () => {
        if (!sessionId) return;
        try {
          const res = await fetch(ROUTE + '?session=' + encodeURIComponent(sessionId), { cache: 'no-store' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const body = await res.json();
          setPayload(body);
          setFetchedAt(Date.now());
          statusRef.current = body && body.session ? body.session.status : 'idle';
        } catch (error) {
          statusRef.current = 'idle';
        }
      }, [sessionId]);

      useEffect(() => {
        if (!sessionId) return undefined;
        let disposed = false;
        const schedule = () => {
          if (disposed) return;
          const status = statusRef.current;
          const delay = status === 'idle' ? IDLE_POLL_MS : ENDED.has(status) ? DONE_POLL_MS : RUNNING_POLL_MS;
          timerRef.current = setTimeout(async () => {
            await load();
            schedule();
          }, delay);
        };
        void load().then(schedule);
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          disposed = true;
          if (timerRef.current) clearTimeout(timerRef.current);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, [sessionId, load]);

      const status = payload && payload.session ? payload.session.status : 'idle';
      const running = status !== 'idle' && !ENDED.has(status);

      useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(() => forceTick((x) => x + 1), 1000);
        return () => clearInterval(id);
      }, [running]);

      const pos = useAnchor(open, chipRef);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        const onDown = (event) => {
          const chip = chipRef.current;
          const pop = popRef.current;
          if (chip && chip.contains(event.target)) return;
          if (pop && pop.contains(event.target)) return;
          setOpen(false);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown, true);
        return () => {
          document.removeEventListener('keydown', onKey);
          document.removeEventListener('mousedown', onDown, true);
        };
      }, [open]);

      if (!sessionId) return null;
      const session = payload && payload.session;
      // A host that is down or a session with no task leaves the composer
      // exactly as it was: this plugin never draws an error state there.
      if (!session) return null;

      const drift = fetchedAt ? Math.max(0, Date.now() - fetchedAt) : 0;
      const elapsed = session.elapsedMs + (running ? drift : 0);
      const est = session.estimate || {};
      const ended = ENDED.has(status);
      const conf = est.confidence || 'low';
      const dotClass = DOT[status] || '';

      let shortEta;
      if (ended) shortEta = tr('eta.done') + ' ' + fmtClock(session.elapsedMs);
      else if (est.available === false) shortEta = tr('chip.unknown');
      else if (Number.isFinite(est.lowMs) && Number.isFinite(est.highMs)) {
        shortEta = tr('chip.left') + ' ' + fmtRange(est.lowMs, est.highMs, tr);
      } else shortEta = tr('chip.unknown');

      const chip = h('button', {
        type: 'button',
        ref: chipRef,
        className: 'dle-chip ' + dotClass,
        title: tr('title.hint'),
        'aria-expanded': open,
        onClick: () => { setOpen((v) => !v); if (!open) void load(); },
        onMouseDown: (event) => event.preventDefault(),
      },
        h('span', { className: 'dle-dot' }),
        h('span', { className: 'dle-e' }, fmtClock(elapsed)),
        h('span', { className: 'dle-eta' }, '· ' + shortEta),
        session.todo ? h('span', { className: 'dle-todo-c' }, '· ' + session.todo.done + '/' + session.todo.total) : null,
        session.anomalies && session.anomalies.length ? h('span', { className: 'dle-bang' }, '!') : null);

      if (!open) return chip;

      const initial = session.initial || {};
      const calibration = (payload && payload.calibration) || null;
      const prob = session.probability || {};
      const probText = prob.p != null
        ? tr('prob.value').replace('{p}', Math.round(prob.p * 100))
        : tr('prob.none');
      const last = session.lastProgress || {};
      const refNow = ended ? (session.endedAt || Date.now()) : Date.now();
      const agoMin = last.at ? Math.max(0, Math.round((refNow - last.at) / 60000)) : null;
      const checkpoints = calibration && calibration.checkpoints;
      const checkpointText = checkpoints && checkpoints[0.25] && checkpoints[0.25].n
        ? [0.25, 0.5, 0.75].map((f) => (checkpoints[f] && checkpoints[f].n
          ? Math.round((checkpoints[f].coverage || 0) * 100) + '%'
          : '—')).join(' / ')
        : null;
      const anomalies = Array.isArray(session.anomalies) ? session.anomalies : [];
      const phaseRows = (session.phases || []).map((p) => h('div', {
        key: p.key,
        className: 'dle-ph' + (p.active ? ' on' : ''),
      },
        h('span', { className: 'mark' }, p.active ? '●' : '·'),
        h('span', { className: 'name' }, p.label),
        h('span', { className: 'd' }, p.ms > 0 ? fmtClock(p.ms) : '')));
      const todoRows = (Array.isArray(session.todos) ? session.todos : []).map((item, i) => h('div', {
        key: String(i) + item.text,
        className: 'dle-todo' + (item.status === 'done' ? ' done' : item.status === 'active' ? ' active' : ''),
      },
        h('span', { className: 'mark' }, item.status === 'done' ? '✓' : item.status === 'active' ? '●' : '○'),
        h('span', { className: 'text' }, item.text)));

      const panel = h('div', {
        ref: popRef,
        className: 'dle-pop',
        role: 'dialog',
        style: pos ? { left: pos.left, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxHeight } : { left: -9999, bottom: 0, width: PANEL_WIDTH },
      },
        h('div', { className: 'dle-head' },
          h('div', { className: 'dle-title' }, session.label || tr('empty')),
          h('button', { type: 'button', className: 'dle-x', 'aria-label': tr('action.close'), onClick: () => setOpen(false) }, '×')),
        h('div', { className: 'dle-state' },
          h('span', { className: 'dot ' + dotClass }),
          h('span', { className: 'dle-strong' }, tr('status.' + status)),
          h('span', null, fmtClock(elapsed)),
          h('span', null, tr('conf.' + conf))),
        h('div', { className: 'dle-etaRow' },
          h('span', { className: 'big' }, ended
            ? tr('eta.done') + ' ' + fmtClock(session.elapsedMs)
            : est.available === false ? tr('chip.unknown') : tr('chip.left') + ' ' + fmtRange(est.lowMs, est.highMs, tr)),
          !ended && Number.isFinite(est.medianMs) && est.available !== false
            ? h('span', { className: 'dle-hint' }, tr('eta.finishAt') + ' ' + fmtAt(Date.now() + est.medianMs))
            : null),
        est.reason ? h('div', { className: 'dle-hint' }, est.reason) : null,
        h('div', { className: 'dle-kv' },
          h('span', { title: prob.p != null ? tr('prob.hint').replace('{n}', prob.n) : tr('prob.none') },
            tr('prob.label') + ' ', h('b', null, probText)),
          prob.p != null && prob.n ? h('span', null, 'n=' + prob.n) : null),
        last.at ? h('div', { className: 'dle-hint' },
          tr('progress.last') + ' ' + fmtAt(last.at)
          + (agoMin != null ? ' · ' + tr('progress.ago').replace('{m}', agoMin) : '')
          + (last.text ? ' · ' + last.text : '')) : null,
        h('div', { className: 'dle-kv' },
          h('span', null, tr('label.initial') + ' ', h('b', null, fmtRange(initial.lowMs || 0, initial.highMs || 0, tr))),
          h('span', null, tr('phase.prefix') + ' ', h('b', null, (session.phase.index + 1) + '/' + session.phase.total)),
          session.todo ? h('span', null, tr('todo.prefix') + ' ', h('b', null, session.todo.done + '/' + session.todo.total)) : null,
          session.parallel && session.parallel.children > 0
            ? h('span', null, tr('parallel.prefix') + ' ', h('b', null, session.parallel.running + '/' + session.parallel.children))
            : null),
        h('div', { className: 'dle-sec' }, phaseRows),
        todoRows.length ? h('div', { className: 'dle-sec' },
          h('div', { className: 'dle-secTitle' },
            tr('label.todos') + (session.todo ? ' · ' + session.todo.done + '/' + session.todo.total : '')),
          todoRows) : null,
        h('div', { className: 'dle-kv' },
          h('span', null, tr('stats.tools') + ' ', h('b', null, String(session.stats.toolCalls))),
          h('span', null, tr('stats.errors') + ' ', h('b', null, String(session.stats.errors))),
          h('span', null, tr('stats.toolTime') + ' ', h('b', null, fmtClock(session.stats.toolMs))),
          h('span', null, tr('stats.modelTime') + ' ', h('b', null, fmtClock(session.stats.modelMs)))),
        anomalies.length ? h('div', { className: 'dle-sec' },
          anomalies.slice(-3).map((a, i) => h('div', { key: String(a.at) + i, className: 'dle-warn' },
            '⚠ ' + fmtAt(a.at) + ' ' + a.text))) : null,
        h('div', { className: 'dle-sec' },
          h('div', { className: 'dle-secTitle' }, tr('label.calibration')),
          calibration && calibration.tasks > 0
            ? h('div', { className: 'dle-kv' },
              h('span', null, tr('cal.tasks') + ' ', h('b', null, String(calibration.tasks))),
              h('span', null, tr('cal.coverage') + ' ', h('b', null, Math.round((calibration.coverage || 0) * 100) + '%')),
              h('span', null, tr('cal.mae') + ' ', h('b', null, fmtSpan(calibration.maeMs || 0, tr))),
              checkpointText ? h('span', { title: '25% / 50% / 75%' }, tr('cal.checkpoints') + ' ', h('b', null, checkpointText)) : null)
            : h('div', { className: 'dle-hint' }, tr('cal.none'))),
        h('div', { className: 'dle-foot' },
          h('button', { type: 'button', className: 'dle-btn', onClick: () => { void load(); } }, tr('action.refresh')),
          h('span', { className: 'dle-spacer' }),
          confirmClear
            ? [
              h('button', {
                key: 'yes',
                type: 'button',
                className: 'dle-btn danger',
                onClick: async () => {
                  try {
                    await fetch(ROUTE, {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ action: 'clear' }),
                    });
                  } catch (error) {
                    // Clearing is best-effort; the panel still refreshes.
                  }
                  setConfirmClear(false);
                  await load();
                },
              }, tr('action.confirm')),
              h('button', {
                key: 'no',
                type: 'button',
                className: 'dle-btn',
                onClick: () => setConfirmClear(false),
              }, tr('action.cancel')),
            ]
            : h('button', {
              type: 'button',
              className: 'dle-btn',
              onClick: () => setConfirmClear(true),
            }, tr('action.clear'))));

      return h(React.Fragment, null, chip, ReactDOM.createPortal(panel, document.body));
    }

    function LiveEtaSeat(props) {
      return h(LiveEta, {
        sessionId: typeof props.sessionId === 'string' ? props.sessionId : undefined,
        t: props.t,
      });
    }

    // -- plugin -------------------------------------------------------------

    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-live-eta';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'live-eta: styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'live-eta: dictionaries');
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'live-eta',
        order: 100,
        locale: NS,
      }, LiveEtaSeat), 'live-eta: composer chip');
    }

    return { inject: ['slots', 'locale'], apply };
  },
});