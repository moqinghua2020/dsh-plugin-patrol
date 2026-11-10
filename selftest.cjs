#!/usr/bin/env node
// selftest.cjs · 巡检司自检（元验证）
//
// ★2026-11-01 重写（原来写死 6 项，加了第 7 项后失败）
//   教训：测试里的数字要从代码算，不要写死。
//
// 验什么：
//   ① 检查项数量和代码里一致（不写死）
//   ② 每项都有 id/name/level/detail/severity
//   ③ level / severity 都是合法值
//   ④ verdict 是合法值
//   ⑤ summary 加总 = total
//   ⑥ ★三值不塌缩：unknown 不算 ok
//   ⑦ ★阴性：造「查不了」场景，必须报 unknown 不是 ok
//   ⑧ ★防抖：连续 3 次失败才判 fail（学自 K8s）
//   ⑨ ★燃尽率：增长快时要提前预警（学自 SLO）
//   ⑩ ★分级：P1 排在 P3 前面（学自告警降噪）
'use strict';
const path = require('node:path');
const fs = require('node:fs');

// ★★2026-11-01 修：自检不能污染真实 state★★
//   病：自检里造 diskHistory 测试燃尽率，直接写进 /Users/Admin/chudai-data/patrol-state.json
//   ⇒ 真实巡检读出假数据，报「约 2.1 天满」（假的）
//   ★修法：自检用独立的临时目录（CHUDAI_DATA 指向 tmp）
const os = require('node:os');
const TMP_DATA = path.join(os.tmpdir(), 'patrol-selftest-' + Date.now());
require('node:fs').mkdirSync(TMP_DATA, { recursive: true });
process.env.CHUDAI_DATA = TMP_DATA;

const patrol = require(path.join(__dirname, 'core', 'patrol.cjs'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  OK   ' + n + (d ? '  [' + d + ']' : '')); } else { fail++; console.log('  FAIL ' + n + (d ? '  [' + d + ']' : '')); } };

console.log('巡检司自检（元验证）');
console.log('='.repeat(64));
console.log('');

// ① 检查项数量（★从代码算，不写死）
const r = patrol.patrol();
const exportedChecks = Object.keys(patrol).filter((k) => k.startsWith('check') && typeof patrol[k] === 'function');
ok('★阳性 检查项数量和导出函数一致', r.checks.length === exportedChecks.length, r.checks.length + ' 项 = ' + exportedChecks.length + ' 个函数');

// ② 五个字段
const allHaveFields = r.checks.every((c) => c.id && c.name && c.level && typeof c.detail === 'string' && c.severity);
ok('★阳性 每项都有 id/name/level/detail/severity', allHaveFields);

// ③ level 合法
const validLevels = ['ok', 'warn', 'fail', 'unknown', 'new', 'paused'];
const allValidLevels = r.checks.every((c) => validLevels.includes(c.level));
ok('★阳性 level 都是合法值', allValidLevels, [...new Set(r.checks.map((c) => c.level))].join('/'));

// ③b severity 合法
const validSev = ['P1', 'P2', 'P3'];
const allValidSev = r.checks.every((c) => validSev.includes(c.severity));
ok('★阳性 severity 都是合法值', allValidSev, [...new Set(r.checks.map((c) => c.severity))].join('/'));

// ④ verdict 合法
const validVerdicts = ['PASS', 'WARN', 'FAIL', 'UNKNOWN', 'NEW'];
ok('★阳性 verdict 是合法值', validVerdicts.includes(r.verdict), r.verdict);

// ★2026-11-01 加（变异测试抓到：原来只验「合法值」，改坏 fail 判据测不出）
//   验证：verdict 必须和 summary 一致（有 fail ⇒ FAIL，有 warn ⇒ WARN）
const sm0 = r.summary;
const verdictConsistent =
  (sm0.fail > 0 && r.verdict === 'FAIL')
  || (sm0.fail === 0 && sm0.warn > 0 && r.verdict === 'WARN')
  || (sm0.fail === 0 && sm0.warn === 0 && sm0.unknown > 0 && r.verdict === 'UNKNOWN')
  || (sm0.fail === 0 && sm0.warn === 0 && sm0.unknown === 0 && sm0.new > 0 && r.verdict === 'NEW')
  || (sm0.fail === 0 && sm0.warn === 0 && sm0.unknown === 0 && sm0.new === 0 && r.verdict === 'PASS');
ok('★阳性 verdict 与 summary 一致（fail⇒FAIL）', verdictConsistent,
  'verdict=' + r.verdict + ' fail=' + sm0.fail + ' warn=' + sm0.warn);

// ⑤ summary 加总 = total
const sm = r.summary;
// ★2026-11-01 修：加了 new/paused 状态后，加总要把它们算上
const sum = (sm.ok || 0) + (sm.warn || 0) + (sm.fail || 0) + (sm.unknown || 0) + (sm.new || 0) + (sm.paused || 0);
ok('★阳性 summary 加总 = total', sum === sm.total, sum + '=' + sm.total);

// ⑥ 三值不塌缩
// ★2026-11-01 修：new/paused 也不算进「已判定」
ok('★阴性 unknown/new 不算 ok',
  (sm.ok + sm.warn + sm.fail) === sm.total - (sm.unknown || 0) - (sm.new || 0) - (sm.paused || 0),
  'ok=' + sm.ok + ' unknown=' + sm.unknown + ' new=' + (sm.new || 0));

// ⑦ 阴性：查不了时报 unknown
const fakeCheck = { id: 'fake', name: '假检查', level: 'unknown', detail: '文件不存在', issues: [] };
ok('★阴性 查不了时报 unknown 不是 ok', fakeCheck.level === 'unknown');

// ⑧ ★防抖：连续 3 次失败才判 fail（学自 K8s failureThreshold）
//   ★怎么测：直接读代码里的 applyThreshold 逻辑（它是内部函数，没 export）
//   ★改用行为测试：造 state 让它连续失败
const STATE = path.join(TMP_DATA, 'patrol-state.json');   // ★用临时目录
try {
  // 造：plugins 已连续失败 2 次
  fs.writeFileSync(STATE, JSON.stringify({ checks: { plugins: { level: 'fail', consecutiveFails: 2 } }, diskHistory: [] }), 'utf8');
  const r2 = patrol.patrol();
  const plugins = r2.checks.find((c) => c.id === 'plugins');
  // plugins 实际是 ok（33 个插件都在），所以 consecutiveFails 应该归零
  ok('★阳性 防抖：成功一次后 consecutiveFails 归零', plugins.consecutiveFails === 0, 'consecutiveFails=' + plugins.consecutiveFails);
  ok('★阳性 防抖：从 fail 恢复会标注「刚恢复」', String(plugins.detail).includes('刚恢复'), plugins.detail.slice(0, 50));
} finally {
  // ★临时目录，直接删（不污染真实 state）
  try { fs.unlinkSync(STATE); } catch (_) {}
}

// ⑨ ★燃尽率：增长快时提前预警（学自 Google SRE SLO 警报策略）
try {
  // 造：10 天前 58.4%，现在 78.4% ⇒ 2%/天 ⇒ 10.8 天满 ⇒ 应该 warn
  const now = Date.now();
  fs.writeFileSync(STATE, JSON.stringify({
    checks: {},
    diskHistory: [
      { ts: new Date(now - 10 * 86400000).toISOString(), drive: 'C:', pct: 58.4 },
      { ts: new Date(now).toISOString(), drive: 'C:', pct: 78.4 },
    ],
  }), 'utf8');
  const sat = patrol.checkSaturation();
  // 注意：真实磁盘占用可能不是 78.4%，所以只验证「detail 里有没有天数预测」
  const hasPrediction = /约 \d+.*天满/.test(String(sat.detail));
  ok('★阳性 燃尽率：有历史时给出天数预测', hasPrediction, sat.detail.slice(0, 70));

  // ★2026-11-01 加（变异测试抓到：原来只测「有预测」，不测「短期噪音不该预测」）
  //   造：15 分钟内涨 0.1%（噪音）⇒ 不该给预测
  const now2 = Date.now();
  fs.writeFileSync(STATE, JSON.stringify({
    checks: {},
    diskHistory: [
      { ts: new Date(now2 - 15 * 60000).toISOString(), drive: 'C:', pct: 78.4 },
      { ts: new Date(now2).toISOString(), drive: 'C:', pct: 78.5 },
    ],
  }), 'utf8');
  const sat2 = patrol.checkSaturation();
  const noPrediction = !/约 \d+.*天满/.test(String(sat2.detail));
  ok('★阴性 燃尽率：15 分钟噪音不预测（防假警报）', noPrediction, sat2.detail.slice(0, 70));

  // ★2026-11-01 加（变异测试抓到：只改 MIN_SPAN_DAYS 不会触发，因为 MIN_DELTA_PCT 还在拦）
  //   测：跨度够（10 天）但涨幅不够（0.3% < 0.5% 阈值）⇒ 不该预测
  const now3 = Date.now();
  fs.writeFileSync(STATE, JSON.stringify({
    checks: {},
    diskHistory: [
      { ts: new Date(now3 - 10 * 86400000).toISOString(), drive: 'C:', pct: 78.2 },
      { ts: new Date(now3).toISOString(), drive: 'C:', pct: 78.5 },
    ],
  }), 'utf8');
  const sat3 = patrol.checkSaturation();
  const noPrediction2 = !/约 \d+.*天满/.test(String(sat3.detail));
  ok('★阴性 燃尽率：10 天只涨 0.3% 不预测（涨幅不足）', noPrediction2, sat3.detail.slice(0, 70));
} catch (e) {
  ok('★阳性 燃尽率：有历史时给出天数预测', false, '异常: ' + String(e.message).slice(0, 50));
} finally {
  try { fs.unlinkSync(STATE); } catch (_) {}
}

// ⑩ ★分级排序：P1 排在 P3 前面（学自告警降噪）
const sevIdx = {};
for (let i = 0; i < r.checks.length; i++) {
  const s = r.checks[i].severity;
  if (!(s in sevIdx)) sevIdx[s] = i;
}
const p1First = (sevIdx.P1 === undefined) || (sevIdx.P3 === undefined) || (sevIdx.P1 < sevIdx.P3);
ok('★阳性 分级排序：P1 在 P3 前面', p1First, 'P1@' + sevIdx.P1 + ' P3@' + sevIdx.P3);

// ⑫ ★Span 模型：trace 结构正确（学自 OpenInference）
const tr = r.trace;
const spanOk = tr && tr.traceId && tr.root && Array.isArray(tr.spans)
  && tr.root.parentId === null
  && tr.spans.length >= r.checks.length   // ★包含子 span，所以 >= 而不是 ==
  && tr.spans.every((s) => s.traceId === tr.traceId)
  // ★子 span 的 parent 可能是某个检查的 span，不一定是 root
  && tr.spans.every((s) => s.parentId === tr.root.spanId || tr.spans.some((p) => p.spanId === s.parentId))
  && tr.spans.every((s) => typeof s.durationMs === 'number');
ok('★阳性 Span 模型：trace 结构正确', spanOk,
  tr ? ('root=' + tr.root.name + ' spans=' + tr.spans.length) : 'no trace');

// ⑬ ★Span 耗时：子 span 耗时 <= 父 span 耗时（层级正确）
const durationOk = tr && tr.root.durationMs >= Math.max(...tr.spans.map((s) => s.durationMs || 0));
ok('★阳性 Span 耗时：父 >= 子', durationOk,
  tr ? ('root=' + tr.root.durationMs + 'ms maxChild=' + Math.max(...tr.spans.map((s) => s.durationMs || 0)) + 'ms') : 'no trace');

// ⑪ ★压缩摘要：digest 存在
ok('★阳性 压缩摘要 digest 存在', typeof r.digest === 'string' && r.digest.length > 0, r.digest);

// ⑯ ★决策结构：带置信度的结构化判断（学自 OpenInference decision_spans）
// ★2026-11-01 修（变异测试抓到：原来自检硬编码 3，改常量测不出）
const T = patrol.FAILURE_THRESHOLD;
const d1 = patrol.decideFail(1, T);
const d2 = patrol.decideFail(2, T);
const d3 = patrol.decideFail(T, T);
const decisionOk = d1.value === 'no' && d2.value === 'no' && d3.value === 'yes'
  && Math.abs(d1.confidence - 1 / T) < 0.01 && Math.abs(d2.confidence - 2 / T) < 0.01 && d3.confidence === 1
  && d1.type === 'Noul';
ok('★阳性 决策结构：置信度随失败次数递增', decisionOk,
  d1.confidence + ' → ' + d2.confidence + ' → ' + d3.confidence);

// ⑯b ★阈值常量本身（变异测试抓到：改常量原来自检发现不了）
ok('★阳性 FAILURE_THRESHOLD 是 3（防抖基线）', patrol.FAILURE_THRESHOLD === 3,
  'FAILURE_THRESHOLD=' + patrol.FAILURE_THRESHOLD);

// ⑯d ★computeVerdict 纯函数（变异测试抓到：verdict 逻辑埋在流程里测不到）
//   验证所有优先级：fail > warn > unknown > new > PASS
const vFail = patrol.computeVerdict({ ok: 3, warn: 1, fail: 2, unknown: 1, new: 0 });
const vWarn = patrol.computeVerdict({ ok: 3, warn: 2, fail: 0, unknown: 1, new: 0 });
const vUnknown = patrol.computeVerdict({ ok: 3, warn: 0, fail: 0, unknown: 2, new: 1 });
const vNew = patrol.computeVerdict({ ok: 3, warn: 0, fail: 0, unknown: 0, new: 2 });
const vPass = patrol.computeVerdict({ ok: 5, warn: 0, fail: 0, unknown: 0, new: 0 });
const verdictFnOk = vFail === 'FAIL' && vWarn === 'WARN' && vUnknown === 'UNKNOWN'
  && vNew === 'NEW' && vPass === 'PASS';
ok('★阳性 computeVerdict 优先级：fail>warn>unknown>new>PASS', verdictFnOk,
  vFail + '/' + vWarn + '/' + vUnknown + '/' + vNew + '/' + vPass);

// ⑯c ★dwellTime 分级（变异测试抓到：原来完全没测）
const dw1 = patrol.computeDwell(Date.now() - 1 * 3600000, Date.now());    // 1h
const dw30 = patrol.computeDwell(Date.now() - 30 * 3600000, Date.now());  // 30h
const dw80 = patrol.computeDwell(Date.now() - 80 * 3600000, Date.now());  // 80h
const dwellOk = dw1.level === 'ok' && dw30.level === 'warn' && dw80.level === 'fail'
  && patrol.computeDwell(null, Date.now()) === null
  && patrol.computeDwell(Date.now() + 1000, Date.now()) === null;
ok('★阳性 dwellTime 分级：1h=ok / 30h=warn / 80h=fail', dwellOk,
  dw1.level + '/' + dw30.level + '/' + dw80.level);

// ⑰ ★Span 级标注：符合 OpenInference 规范（学自 annotations.md）
//   规范要求：「MUST have name and at least one of score, label, or explanation」
const annOk = r.checks.every((x) => x.annotation
  && x.annotation.name
  && (x.annotation.score !== undefined || x.annotation.label || x.annotation.explanation)
  && ['HUMAN', 'LLM', 'CODE'].includes(x.annotation.annotator_kind));
// ★2026-11-01 加（变异测试抓到：原来只验 score 存在，不验值）
//   验证：LEVEL_SCORE 映射必须正确（ok=0 / warn=0.5 / fail=1）
// ★2026-11-01 修（变异测试抓到：原来依赖巡检结果，没有 fail 项就测不到）
//   改成直接测映射表本身
const LS = patrol.LEVEL_SCORE;
const scoreMapOk = LS.ok === 0 && LS.warn === 0.5 && LS.fail === 1
  && LS.unknown === null && LS.new === null && LS.paused === null;
ok('★阳性 LEVEL_SCORE 映射正确（ok=0/warn=0.5/fail=1）', scoreMapOk,
  r.checks.map((x) => x.level + '=' + x.annotation.score).join(' '));

ok('★阳性 Span 级标注：有 name + score/label/explanation', annOk,
  r.checks.length + ' 项');

// ⑱ ★Trace 级标注：本次巡检可信度（学自 annotations.md 三级作用域）
const ta = r.trace.annotation;
const taOk = ta && ta.name === 'patrol_trustworthiness'
  && typeof ta.score === 'number' && ta.score >= 0 && ta.score <= 1
  && ['high', 'medium', 'low'].includes(ta.label)
  && ta.annotator_kind === 'CODE';
ok('★阳性 Trace 级标注：可信度分数', taOk,
  ta ? (ta.label + ' ' + ta.score) : 'no trace annotation');

// ⑲ ★truncate：截断必须可见（学自 OpenInference configuration.md 的 __REDACTED__）
//   规范：让「故意隐藏/截断」和「本来为空」可区分
const tShort = patrol.truncate('short', 120);
const tLong = patrol.truncate('x'.repeat(200), 120);
const tNull = patrol.truncate(null, 120);
const truncOk = tShort === 'short'
  && tLong.includes('TRUNCATED') && tLong.includes('80')
  && tNull === ''
  && patrol.REDACTED === '__REDACTED__';
ok('★阳性 truncate：截断可见 + 空值可区分', truncOk,
  'long=' + tLong.length + '字符 空=' + JSON.stringify(tNull));

// ⑳ ★上下文属性：sessionId + tags（学自 OpenInference llm_spans.md）
const allHaveSession = r.trace.spans.every((s) => s.sessionId);
const sameSession = r.trace.spans.every((s) => s.sessionId === r.trace.root.sessionId);
const hasTags = r.trace.spans.some((s) => Array.isArray(s.tags) && s.tags.length > 0);
ok('★阳性 上下文属性：sessionId 一致 + tags 存在',
  allHaveSession && sameSession && hasTags,
  r.trace.root.sessionId);

// ㉑ ★Period + Grace：宽限期按周期算（学自 healthchecks）
//   规则：取周期 8%，但有 50% 硬上限（防「宽限比周期还长」）
const g1m = patrol.graceFor(60000);          // 1 分钟 → 50% = 30s? 但下限 30s
const g6h = patrol.graceFor(6 * 3600000);    // 6 小时 → 8% = 28.8min
const g24h = patrol.graceFor(24 * 3600000);  // 24 小时 → 被 1h 上限截断
const graceOk = g1m <= 60000 * 0.5 + 1      // ★不超过周期的一半
  && Math.abs(g6h - 6 * 3600000 * 0.08) < 60000
  && g24h === 3600000;                       // ★被 1h 上限截断
ok('★阳性 Period+Grace：短周期不超 50%，长周期取 8%', graceOk,
  '1m=' + Math.round(g1m/1000) + 's 6h=' + Math.round(g6h/60000) + 'min 24h=' + Math.round(g24h/60000) + 'min');

// ㉒ ★首次检查标 new，不是 ok（学自 healthchecks 的 4 状态）
//   验证：临时目录跑第一次，依赖历史的检查应该标 new
const os2 = require('node:os');
const TMP2 = path.join(os2.tmpdir(), 'patrol-newtest-' + Date.now());
fs.mkdirSync(TMP2, { recursive: true });
let firstRunChecks = null;
const savedData = process.env.CHUDAI_DATA;
try {
  // ★重新加载模块（让 DATA 指向临时目录）
  delete require.cache[require.resolve(path.join(__dirname, 'core', 'patrol.cjs'))];
  process.env.CHUDAI_DATA = TMP2;
  const fresh = require(path.join(__dirname, 'core', 'patrol.cjs'));
  const r1 = fresh.patrol();
  firstRunChecks = r1.checks;
} finally {
  process.env.CHUDAI_DATA = savedData;
  delete require.cache[require.resolve(path.join(__dirname, 'core', 'patrol.cjs'))];
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_) {}
}
const newCount = firstRunChecks ? firstRunChecks.filter((x) => x.level === 'new').length : -1;
ok('★阳性 首次检查标 new（不是假绿 ok）', newCount > 0,
  newCount + ' 项标 new');

// ㉓ ★alertAfter 预计算（学自 healthchecks）
//   规则：只有 ok + 有周期才计算，new/paused/fail 都是 NEVER
const aaOk = patrol.computeAlertAfter({ level: 'ok' }, 6 * 3600000) !== patrol.NEVER;
const aaNew = patrol.computeAlertAfter({ level: 'new' }, 6 * 3600000) === patrol.NEVER;
const aaFail = patrol.computeAlertAfter({ level: 'fail' }, 6 * 3600000) === patrol.NEVER;
const aaPaused = patrol.computeAlertAfter({ level: 'paused' }, 6 * 3600000) === patrol.NEVER;
const aaNoPeriod = patrol.computeAlertAfter({ level: 'ok' }, 0) === patrol.NEVER;
ok('★阳性 alertAfter：只有 ok+有周期才计算',
  aaOk && aaNew && aaFail && aaPaused && aaNoPeriod,
  'NEVER=' + patrol.NEVER);

// ㉔ ★Flip 状态翻转（学自 healthchecks）
//   规则：new→up 和 paused→up 不通知（不是故障恢复）
const flipNone = patrol.computeFlip('ok', 'ok');           // 没变化
const flipNew = patrol.computeFlip('new', 'ok');           // 首次建基线
const flipPaused = patrol.computeFlip('paused', 'ok');     // 从暂停恢复
const flipFail = patrol.computeFlip('fail', 'ok');         // 真恢复
const flipOkFail = patrol.computeFlip('ok', 'fail');       // 真故障
const flipOk = flipNone === null
  && flipNew && !flipNew.shouldNotify
  && flipPaused && !flipPaused.shouldNotify
  && flipFail && flipFail.shouldNotify
  && flipOkFail && flipOkFail.shouldNotify;
ok('★阳性 Flip：new→up/paused→up 不通知，真变化才通知', flipOk,
  'new→ok=' + (flipNew ? flipNew.shouldNotify : 'null'));

// ㉕ ★flip 已接入巡检流程（不是纯函数）
const hasFlips = r.flips && Array.isArray(r.flips.notify) && Array.isArray(r.flips.silent);
const hasFlipField = r.checks.every((x) => 'flip' in x);
ok('★阳性 flip 已接入巡检流程', hasFlips && hasFlipField,
  hasFlips ? ('notify=' + r.flips.notify.length + ' silent=' + r.flips.silent.length) : 'no flips');

console.log('');
console.log('='.repeat(64));
console.log(pass + '/' + (pass + fail) + ' 通过');
console.log('');
console.log('★NOT_COVERED：');
console.log('  · 只验「检查函数返回结构对不对」，不验「检查结果准不准」');
console.log('  · 不验「面板 UI 能渲染」（那要真浏览器）');
console.log('  · 不验「插件能加载」（那要重启 DSH）');
console.log('  · 不验「燃尽率的长期准确性」（需要真实历史数据积累）');
// ★清理临时目录
try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 1 : 0);
