// ═══════════════════════════════════════════════════════════════════════════
// core/patrol.js · 巡检司核心（6 项健康巡检）
//
// 【它是什么】
//   DSH 内部的看门狗。和 core/memory-v2/daemon-guardian 分工：
//     · daemon-guardian（独立进程）：管「进程活着吗」，死了就拉起
//     · patrol（本模块）：管「DSH 内部健康吗」，只看不拉起
//
// 【为什么需要】
//   看门狗只能看「进程在不在」，看不出「进程活着但功能坏了」。
//   例：DSH 活着、插件加载失败、记忆 3 天没更新、工具全挂 —— 看门狗都说 OK。
//
// 【6 项巡检】
//   ① 插件加载 —— package.json 声明的插件是否都在 node_modules
//   ② 会话健康 —— sessions 目录有没有异常文件
//   ③ 记忆新鲜度 —— RESUME.md 多久没更新
//   ④ 工具可用性 —— check-all --brief 能不能过
//   ⑤ 看门狗状态 —— guardian 进程活着吗 + 最近拉起几次
//   ⑥ daemon 状态 —— 阴阳 daemon 活着吗
//
// 【诚实边界】
//   · 只看不改（要修走 heal / 青天闸）
//   · 不替代 daemon-guardian（它管拉起，我管检查）
//   · 检查本身可能误报（每项都标注判据）
// ═══════════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = process.env.CHUDAI_REPO || '/Users/Admin/Projects/chudai-setup/01-repo';
const DATA = process.env.CHUDAI_DATA || '/Users/Admin/chudai-data';
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');

// ── ① 插件加载 ──
function checkPlugins() {
  const out = { id: 'plugins', name: '插件加载', level: 'ok', detail: '', issues: [] };
  try {
    const pkgPath = path.join(DSH_HOME, 'profiles', 'desktop', 'package.json');
    if (!fs.existsSync(pkgPath)) {
      out.level = 'unknown'; out.detail = 'profile package.json 不存在: ' + pkgPath; return out;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).filter((d) => d.startsWith('dsh-plugin-') || d.startsWith('dsh-'));
    const nm = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules');
    const missing = deps.filter((d) => !fs.existsSync(path.join(nm, d)));
    out.detail = deps.length + ' 个插件声明，' + missing.length + ' 个缺失';
    if (missing.length) { out.level = 'fail'; out.issues = missing; }
  } catch (e) { out.level = 'unknown'; out.detail = truncate(e.message, 120); }
  return out;
}

// ── ② 会话健康 ──
function checkSessions() {
  const out = { id: 'sessions', name: '会话健康', level: 'ok', detail: '', issues: [] };
  try {
    const dir = path.join(DSH_HOME, 'sessions');
    if (!fs.existsSync(dir)) { out.level = 'unknown'; out.detail = 'sessions 目录不存在'; return out; }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') || f.endsWith('.zst'));
    let bad = 0;
    const now = Date.now();
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      // ★只查「最近 1 小时内修改但大小为 0」的（可能写坏了）
      if (st.size === 0 && (now - st.mtimeMs) < 3600000) { bad++; out.issues.push(f + '（0 字节，最近修改）'); }
    }
    out.detail = files.length + ' 个会话文件，' + bad + ' 个可疑';
    if (bad > 0) out.level = 'warn';
  } catch (e) { out.level = 'unknown'; out.detail = String(e.message).slice(0, 120); }
  return out;
}

// ── ③ 记忆新鲜度 ──
function checkMemory() {
  const out = { id: 'memory', name: '记忆新鲜度', level: 'ok', detail: '', issues: [] };
  try {
    const resume = path.join(DATA, 'memory', 'RESUME.md');
    if (!fs.existsSync(resume)) { out.level = 'fail'; out.detail = 'RESUME.md 不存在'; return out; }
    const st = fs.statSync(resume);
    const ageH = (Date.now() - st.mtimeMs) / 3600000;
    out.detail = 'RESUME ' + ageH.toFixed(1) + ' 小时前更新';
    if (ageH > 24) { out.level = 'fail'; out.detail += '（超 24 小时）'; }
    else if (ageH > 4) { out.level = 'warn'; out.detail += '（超 4 小时）'; }
  } catch (e) { out.level = 'unknown'; out.detail = String(e.message).slice(0, 120); }
  return out;
}

// ── ④ 工具可用性 ──
function checkTools() {
  const out = { id: 'tools', name: '工具可用性', level: 'ok', detail: '', issues: [] };
  // ★span 声明在 try 外（finally 要访问）
  const spHist = subSpan('读历史账本', 'RETRIEVER');
  const spRun = subSpan('真跑 check-all', 'TOOL');
  try {
    // ★★2026-11-01 优化（巡检司 99.7% 时间花在这）★★
    //   病：每次巡检都跑完整 check-all（17-22 秒），占巡检司总耗时 99.7%
    //   ★修法：优先读 check-all 自己的历史账本（.harness/check-trend.jsonl）
    //     · 最近 N 分钟内跑过 ⇒ 直接复用结果（0ms）
    //     · 太旧或没有 ⇒ 才真跑一次
    //
    //   【为什么可以复用】
    //     check-all 每次跑都会追加到 check-trend.jsonl（229 条历史可查）
    //     这是它自己维护的账本，不是我造的缓存 ⇒ 不引入「缓存与真实不一致」的风险
    //
    //   【诚实边界】
    //     · 复用时 detail 会标「复用 X 分钟前的结果」，不假装刚跑过
    //     · 超过 MAX_AGE_MIN 就真跑（默认 30 分钟）
    const MAX_AGE_MIN = 30;
    const TREND = path.join(REPO, '.harness', 'check-trend.jsonl');
    // ★2026-11-01 修：重置 startTime（span 在 try 外创建，但计时应该从现在开始）
    spHist.span.startTime = Date.now();
    if (fs.existsSync(TREND)) {
      try {
        const raw = fs.readFileSync(TREND, 'utf8');
        const ls = raw.split('\n').filter((l) => l.trim());
        // ★从后往前找最新的 quick 记录
        for (let i = ls.length - 1; i >= 0 && i >= ls.length - 20; i--) {
          let rec;
          try { rec = JSON.parse(ls[i]); } catch (_) { continue; }
          if (!rec || rec.level !== 'quick' || !rec.ts) continue;
          const ageMin = (Date.now() - new Date(rec.ts).getTime()) / 60000;
          if (ageMin > MAX_AGE_MIN) break;   // 太旧，不找了
          const total = (rec.pass || 0) + (rec.fail || 0) + (rec.unknown || 0);
          const fails = Array.isArray(rec.failures) ? rec.failures : [];
          const unks = Array.isArray(rec.unknowns) ? rec.unknowns : [];
          if ((rec.fail || 0) > 0) {
            out.level = 'fail';
            out.detail = (rec.pass || 0) + '/' + total + ' 通过，' + rec.fail + ' 失败' + (fails.length ? '（' + fails.slice(0, 3).join(', ') + '）' : '') + ' | 复用 ' + ageMin.toFixed(0) + ' 分钟前的结果';
            out.issues = fails.slice(0, 5);
            return out;
          }
          if ((rec.unknown || 0) > 0) {
            out.level = 'warn';
            out.detail = (rec.pass || 0) + '/' + total + ' 通过，' + rec.unknown + ' 未知' + (unks.length ? '（' + unks.slice(0, 3).join(', ') + '）' : '') + ' | 复用 ' + ageMin.toFixed(0) + ' 分钟前的结果';
            return out;
          }
          // ★全通过 ⇒ 直接 ok
          out.detail = (rec.pass || 0) + '/' + total + ' 通过（' + rec.totalMs + 'ms）| 复用 ' + ageMin.toFixed(0) + ' 分钟前的结果';
          return out;
        }
      } catch (_) { /* 历史读不了 ⇒ 走真跑 */ }
    }
    // ★2026-11-01 修：读历史结束立刻 end（不要等 finally，否则计时=整个函数）
    spHist.end('OK');

    // ── 历史太旧或没有 ⇒ 真跑一次 ──
    // ★重置 startTime（同上）
    spRun.span.startTime = Date.now();
    const ca = path.join(REPO, 'tools', 'check-all.cjs');
    if (!fs.existsSync(ca)) { out.level = 'unknown'; out.detail = 'check-all.cjs 不存在'; return out; }
    // ★'node' 优先（check-all L987-996 实测：process.execPath 在 DSH 里是 Harness.exe，会静默假绿）
    const NODE_CANDIDATES = ['node', process.env.CHUDAI_NODE, '/Users/Admin/chudai-data\\tools\\node-v24.22.2\\node.exe', 'C:\\Program Files\\nodejs\\node.exe'].filter(Boolean);
    let nodeBin = null;
    for (const cand of NODE_CANDIDATES) {
      try { if (cand === 'node' || fs.existsSync(cand)) { nodeBin = cand; break; } } catch (_) {}
    }
    if (!nodeBin) { out.level = 'unknown'; out.detail = '找不到 node 可执行文件'; return out; }

    const r = execFileSync(nodeBin, [ca, 'quick', '--brief'], {
      cwd: REPO, encoding: 'utf8', timeout: 180000, stdio: 'pipe',
    });
    spRun.end('OK');   // ★真跑结束立刻 end
    const m = String(r).match(/一句话：(.+)/);
    out.detail = (m ? m[1].trim() : String(r).trim().slice(0, 80)) + ' | 刚跑的';
    const fail = out.detail.match(/(\d+)\s*个失败/);
    if (fail && parseInt(fail[1], 10) > 0) out.level = 'fail';
  } catch (e) {
    const stdout = String((e && e.stdout) || '');
    const m = stdout.match(/一句话：(.+)/);
    if (m) { out.detail = m[1].trim() + ' | 刚跑的'; if (/失败/.test(m[1])) out.level = 'fail'; }
    else { out.level = 'unknown'; out.detail = String((e && e.message) || e).slice(0, 120); }
  } finally {
    // ★★2026-11-01 修：用 finally 保证 span 一定结束★★
    //   病：checkTools 有 5 个 return 点（复用/真跑/异常），手动加 end 会漏
    //   实测漏了 3 个 ⇒ 子 span 状态是 UNSET
    //   ★修法：finally 统一收尾（end 已做幂等，多次调用无害）
    try { spHist.end('OK'); } catch (_) {}
    try { spRun.end('OK'); } catch (_) {}
  }
  return out;
}

// ── ⑤ 看门狗状态 ──
function checkGuardian() {
  const out = { id: 'guardian', name: '看门狗状态', level: 'ok', detail: '', issues: [] };
  try {
    const log = path.join(DATA, 'memory-v2', 'guardian.log');
    const state = path.join(DATA, 'memory-v2', 'yinyang-state.json');
    let pid = null;
    if (fs.existsSync(state)) {
      try { const s = JSON.parse(fs.readFileSync(state, 'utf8')); pid = s.pid || s.daemon_pid || null; } catch (_) {}
    }
    let lastLine = '';
    if (fs.existsSync(log)) {
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
      lastLine = lines[lines.length - 1] || '';
    }
    out.detail = 'daemon pid=' + (pid || '?') + ' | 日志末行: ' + lastLine.slice(0, 60);
    if (!pid) out.level = 'warn';
  } catch (e) { out.level = 'unknown'; out.detail = String(e.message).slice(0, 120); }
  return out;
}

// ── ⑥ daemon 状态 ──
function checkDaemon() {
  const out = { id: 'daemon', name: 'daemon 状态', level: 'ok', detail: '', issues: [] };
  try {
    const state = path.join(DATA, 'memory-v2', 'yinyang-state.json');
    if (!fs.existsSync(state)) { out.level = 'unknown'; out.detail = 'state 文件不存在'; return out; }
    const s = JSON.parse(fs.readFileSync(state, 'utf8'));
    const pid = s.pid || s.daemon_pid;

    // ★★2026-11-01 修（误报：把「周期静默期」当成「卡住」）★★
    //   病：原来用 state 文件 mtime 判断「超 30 分钟未更新」⇒ WARN
    //     但 daemon 周期是 6 小时，state 只在「跑完一轮」时写
    //     ⇒ 6 小时里 5 小时不动是正常的，却被判 warn
    //   实测：lastRunAt=12:02(北京)，现在 13:05，间隔 1.05h < 周期 6h ⇒ 正常等待
    //   ★修法：用「距上次跑的时间 vs 周期」判断，超周期 + 宽限期才算异常
    const intervalMs = s.intervalMs || 0;
    const lastRunAt = s.lastRunAt ? new Date(s.lastRunAt).getTime() : 0;
    const now = Date.now();
    const sinceLastH = lastRunAt ? (now - lastRunAt) / 3600000 : null;
    const intervalH = intervalMs / 3600000;

    if (!lastRunAt || !intervalMs) {
      out.level = 'unknown';
      out.detail = 'pid=' + (pid || '?') + ' | 缺 lastRunAt 或 intervalMs，判断不了';
      return out;
    }

    // ★★2026-11-01 改造：宽限期按 Period 算，不再硬编码 30 分钟★★
    //   学自 healthchecks：报警阈值 = 上次 + Period + Grace
    //   Grace 按 Period 的 8% 算（限制在 1min-1h）
    const graceMs = graceFor(intervalMs);
    const graceMin = Math.round(graceMs / 60000);
    const overdueMs = (now - lastRunAt) - intervalMs;
    const overdueMin = Math.round(overdueMs / 60000);
    out.detail = 'pid=' + (pid || '?') + ' | 周期 ' + intervalH + 'h | 距上次跑 ' + sinceLastH.toFixed(1) + 'h';

    if (overdueMin > graceMin) {
      out.level = 'warn';
      out.detail += ' | ★超期 ' + overdueMin + ' 分钟未跑（宽限 ' + graceMin + ' 分钟）';
    } else if (overdueMin > 0) {
      out.detail += ' | 刚到期待跑（超 ' + overdueMin + '/' + graceMin + ' 分钟，在宽限期内）';
    } else {
      out.detail += ' | 下次 ' + new Date(lastRunAt + intervalMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    }
  } catch (e) { out.level = 'unknown'; out.detail = String(e.message).slice(0, 120); }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★2026-11-01 加（学自 K8s 健康检查 · failureThreshold）★★
//
// 【为什么加】
//   原来：一次检查失败就报 fail。
//   问题：网络抖动 / 瞬时 GC / 磁盘 IO 峰值 ⇒ 单次误报 ⇒ 假警报 ⇒ 噪音 ⇒ 被无视。
//   K8s 的做法：连续失败 N 次才判失败（failureThreshold，默认 3）。
//
// 【做法】
//   把每次检查结果落盘（state 文件），下次检查时：
//     · 连续 fail >= failureThreshold  ⇒ 才报 fail
//     · 从 fail 恢复 1 次              ⇒ 报 ok（但标注「刚恢复」）
//     · 首次 fail（还没到阈值）        ⇒ 报 warn + 标注「待确认 N/M」
//
// 【边界】
//   · 只对 fail 做防抖，unknown/warn 不防抖（它们本身就是弱信号）
//   · state 文件坏了 ⇒ 当首次检查（全部从零算）
// ═══════════════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(DATA, 'patrol-state.json');
const FAILURE_THRESHOLD = 3;

// ★★2026-11-01 加（学自 healthchecks 的 Period + Grace Time）★★
//
// 【原文】
//   「Each check has configurable Period and Grace Time parameters.
//    Period is the expected time between pings.
//    Grace Time specifies how long to wait before sending out alerts
//    when a job is running late.」
//
// 【Period vs Grace】
//   Period = 预期周期（如 6 小时）
//   Grace  = 宽限期（如 30 分钟）
//   ⇒ 报警阈值 = 上次 + Period + Grace
//
// 【为什么要分开】
//   原来我把 30 分钟硬编码在判据里，没说明依据。
//   分开后：
//     · Period 来自被监控任务自己的声明（intervalMs）
//     · Grace 是「调度抖动允许多久」——这是监控方的假设
//
// 【Grace 怎么定】
//   经验法则：Grace ≈ Period 的 5-10%
//     Period 1min  → Grace 1-2min
//     Period 1h    → Grace 5-10min
//     Period 6h    → Grace 30min   ← 我的 daemon
//     Period 24h   → Grace 1h
//   ★我的 daemon：6h × 8.3% = 30min ⇒ 在合理区间
const DEFAULT_GRACE_MS = 30 * 60000;   // 30 分钟（Period 6h 的 8.3%）

// ★★2026-11-01 加（学自 healthchecks 的 STATUSES）★★
//
// 【原文】
//   STATUSES = (("up","Up"), ("down","Down"), ("new","New"), ("paused","Paused"))
//   REASONS  = (("","Unknown"), ("timeout","Timeout"), ("fail","Fail signal"))
//
// 【为什么 4 种状态，不是 2 种】
//   new    = 刚创建，还没收到过 ping ⇒ 不是 up（假绿）也不是 down（假红）
//   paused = 主动暂停（维护窗口）⇒ 不是 down（会天天报警）
//
// 【为什么区分 reason】
//   timeout = 该跑没跑（调度器问题）
//   fail    = 跑了但失败（任务本身的问题）
//   ⇒ 同样是「坏了」，修法完全不同。
//
// 【我的对应】
//   · 首次巡检（无历史）⇒ new（还没建立基线）
//   · 插件主动禁用     ⇒ paused（不是故障）
//   · check-all 超时   ⇒ reason=timeout
//   · check-all 报错   ⇒ reason=fail
const VALID_LEVELS = ['ok', 'warn', 'fail', 'unknown', 'new', 'paused'];

// ★★2026-11-01 加（变异测试抓到：verdict 逻辑埋在流程里，测不到）★★
//
// 【问题】verdict 计算写在 patrol() 里：
//   const verdict = fail > 0 ? 'FAIL' : (warn > 0 ? 'WARN' : ...)
//   ⇒ 要测它必须先造出 fail/warn/unknown 场景 ⇒ 很难
//   ⇒ 变异测试发现「改成 false ? 'FAIL'」自检不红（因为当前是 WARN 场景）
//
// 【修法】抽成纯函数，直接传 summary 就能测
//   优先级：fail > warn > unknown > new > PASS
//   ★unknown 和 new 都不算 PASS（三值不塌缩）
/**
 * 计算整体 verdict（纯函数，便于测试）
 * @param {object} summary { ok, warn, fail, unknown, new, paused }
 * @returns {string} PASS / WARN / FAIL / UNKNOWN / NEW
 */
function computeVerdict(summary) {
  const s = summary || {};
  const fail = s.fail || 0, warn = s.warn || 0, unknown = s.unknown || 0, newC = s.new || 0;
  if (fail > 0) return 'FAIL';
  if (warn > 0) return 'WARN';
  if (unknown > 0) return 'UNKNOWN';
  if (newC > 0) return 'NEW';
  return 'PASS';
}

// ★★2026-11-01 加（学自 healthchecks 的 dwellTime）★★
//
// 【原文】
//   statsd.timing('hc.sendalerts.dwellTime', send_start - flip.created)
//   statsd.timing('hc.sendalerts.sendTime', now() - send_start)
//
// 【两个指标的区别】
//   dwellTime = 从「事件发生」到「开始处理」的延迟
//   sendTime  = 实际发送耗时
//
// 【为什么 dwellTime 重要】
//   它衡量「队列健康度」：
//     · dwellTime 稳定 ⇒ 处理得过来
//     · dwellTime 一直涨 ⇒ 积压了
//
// 【我的对应场景】
//   巡检发现问题（fail）→ 我什么时候处理？
//   dwellTime = 现在 - 首次发现时间
//   ⇒ 如果一项 fail 了 3 天还没修，dwellTime = 72 小时（该报警了）
/**
 * 计算 dwellTime（问题停留时长）
 * @param {number} firstSeenAt 首次发现时间戳
 * @param {number} now 当前时间戳
 * @returns {object|null} { ms, hours, level }
 */
function computeDwell(firstSeenAt, now) {
  if (!firstSeenAt || !now) return null;
  const ms = now - firstSeenAt;
  if (ms < 0) return null;
  const hours = Math.round(ms / 3600000 * 10) / 10;
  let level = 'ok';
  if (hours >= 72) level = 'fail';
  else if (hours >= 24) level = 'warn';
  return { ms, hours, level };
}


// ★★2026-11-01 加（学自 healthchecks 的 alert_after 预计算）★★
//
// 【原文】
//   alert_after = models.DateTimeField(null=True, blank=True, editable=False)
//   # Index for the alert_after field. Exclude rows with status=down.
//
//   def going_down_after(self):
//       grace_start = self.get_grace_start()
//       if grace_start is not None:
//           return grace_start + self.grace
//       return None
//
// 【核心思想】
//   不是「每次判断要不要报警」，而是「预先算出什么时候该报警」。
//   ⇒ 可索引、查询快、可预测、不重复报警。
//
// 【NEVER 哨兵值】
//   原文注释：「NEVER is a constant sentinel value (year 3000).
//              Using None instead would make the min() logic clunky.」
//   ⇒ 用具体值代替 None，避免比较逻辑混乱。
const NEVER = 4102444800000;   // 2100-01-01，足够远（对应 healthchecks 的 year 3000）

// ★★2026-11-01 加（学自 healthchecks 的 Flip 状态翻转）★★
//
// 【原文】
//   class Flip(models.Model):
//       old_status = models.CharField(...)
//       new_status = models.CharField(...)
//       reason     = models.CharField(...)
//
// 【核心思想】
//   记录的是「状态变化」本身，不是「当前状态」。
//   ⇒ 只在变化时通知，状态不变不重复骚扰。
//
// 【★关键规则】new→up 和 paused→up 不通知！
//   理由：这不是「故障恢复」，只是「首次建立基线」或「从暂停恢复」。
//   | 翻转         | 含义         | 该通知吗 |
//   | new → up     | 首次建立基线  | 否      |
//   | paused → up  | 从暂停恢复    | 否      |
//   | down → up    | 真故障恢复了  | 是      |
/**
 * 计算状态翻转（学自 healthchecks 的 Flip）
 * @param {string} oldLevel 上次状态
 * @param {string} newLevel 本次状态
 * @returns {object|null} 翻转记录，null = 没变化
 */
function computeFlip(oldLevel, newLevel) {
  if (oldLevel === newLevel) return null;   // 没变化 ⇒ 不通知
  const flip = {
    oldStatus: oldLevel,
    newStatus: newLevel,
    shouldNotify: true,
    reason: '',
  };
  // ★规则：new→up 和 paused→up 不通知（不是故障恢复）
  if (newLevel === 'ok' && (oldLevel === 'new' || oldLevel === 'paused')) {
    flip.shouldNotify = false;
    flip.reason = oldLevel === 'new' ? '首次建立基线（不是故障恢复）' : '从暂停恢复（不是故障恢复）';
  }
  return flip;
}


/**
 * ★预计算「什么时候该报警」（学自 healthchecks 的 alert_after）
 * @param {object} check 检查结果
 * @param {number} periodMs 周期（如果有）
 * @param {number} graceMs 宽限期
 * @returns {number} 该报警的时间戳（NEVER = 永不）
 */
function computeAlertAfter(check, periodMs, graceMs) {
  // ★状态机驱动：只有 ok 状态才计算下次报警时间
  //   理由（学自 healthchecks）：
  //     new/paused/down ⇒ 不报警（已经报过或不需报）
  //     ok + 有周期      ⇒ 上次 + 周期 + 宽限
  //     ok + 无周期      ⇒ NEVER（不主动报）
  if (!check) return NEVER;
  if (check.level === 'new' || check.level === 'paused') return NEVER;
  if (check.level === 'fail') return NEVER;   // ★已 fail ⇒ 不重复报
  if (!periodMs || periodMs <= 0) return NEVER;
  const now = Date.now();
  const grace = graceMs || graceFor(periodMs);
  // ★下次该检查的时间 = 现在 + 周期 + 宽限
  return now + periodMs + grace;
}
const VALID_REASONS = ['timeout', 'fail', 'unknown'];

/** 判断是不是首次检查（没有历史状态） */
function isFirstRun(prevState) {
  return !prevState || Object.keys(prevState).length === 0;
}

/** 按 Period 算 Grace（学自 healthchecks 的 5-10% 经验法则） */
//
// ★★2026-11-01 修（实测发现下限有 bug）★★
//   病：原来下限写死 1 分钟 ⇒ Period 1 分钟时 Grace 也是 1 分钟 = 100%
//       ⇒ 等于「永远不报警」（宽限期比周期还长）
//   实测：
//     Period 1min  → Grace 1min  → 100%  ❌ 太宽
//     Period 5min  → Grace 1min  → 20%   ⚠ 偏宽
//     Period 1h    → Grace 5min  → 8%    ✅
//     Period 6h    → Grace 29min → 8%    ✅
//   ★修法：Grace 上下限都按 Period 的比例算
//     下限 = Period × 20%（不能超过周期的 1/5，否则宽限比周期还长）
//     上限 = 1 小时（再长就没意义了，说明周期本身有问题）
function graceFor(periodMs) {
  if (!periodMs || periodMs <= 0) return DEFAULT_GRACE_MS;
  // ★★2026-11-01 简化（第一版和第一修都太复杂，都错了）★★
  //
  //   第一版：Math.min(Math.max(pct, 60000), 3600000)
  //     问题：Period 1min 时 Grace=1min=100% ⇒ 等于永不报警
  //   第一修：加了 floor = 20%
  //     问题：1h 周期给 12min（20%），比 8% 宽了 ⇒ 又偏了
  //
  //   ★最终：直接取 8%，只做 [1min, 1h] 的硬边界
  //     Period 1min  → 8% = 4.8s  → 被下限拉到 1min（100%？）
  //     ⇒ 不行，1min 周期本来就没法算合理的 Grace
  //
  //   ★真正的解法：Period 太短时，Grace 就取 Period 的一半（50%）
  //     Period 1min  → Grace 30s  （50%）
  //     Period 5min  → Grace 1min （20%，因为 8%=24s < 1min 下限）
  //     Period 1h    → Grace 5min （8%）
  //     Period 6h    → Grace 29min（8%）
  //     Period 24h   → Grace 60min（4.2%，因为 8%=115min > 1h 上限）
  const pct = periodMs * 0.08;
  const hardMin = 30000;                   // 绝对下限 30 秒
  const hardMax = 3600000;                 // 绝对上限 1 小时
  let grace = Math.max(pct, hardMin);
  // ★但不能超过周期的一半（否则宽限比周期还长，等于不报警）
  grace = Math.min(grace, periodMs * 0.5);
  grace = Math.min(grace, hardMax);
  return Math.round(grace);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★2026-11-01 加（学自「告警降噪」：分级 + Runbook）★★
//
// 【为什么加分级】
//   原来只有 level（ok/warn/fail），但 level 说的是「多严重」，
//   不是「要不要现在处理」。
//   原文：「告警发出来，只是起到通知作用，接收者无需动作，
//        那这个告警策略是否合理就很值得深究。」
//
//   分级意义：
//     P1 = 立刻处理（核心功能坏了）
//     P2 = 当天处理（影响长期）
//     P3 = 本周处理（资源类，不急）
//
// 【为什么加 Runbook】
//   原文：「告警规则里建议配置 Runbook（预案 SOP）。
//         Runbook 预置率可作为关键指标，预置率太低一定有问题。」
//   我的巡检司原来只说「XX 失败了」，没说「怎么办」⇒ 等于把问题丢给人。
//
// 【诚实边界】
//   · severity 是我按「影响面」拍的，不是实测数据
//   · runbook 是简短的「去哪看」，不是完整 SOP
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ★★2026-11-01 加（学自 OpenInference / OpenTelemetry 的 Trace/Span 模型）★★
//
// 【为什么要 Span】
//   我原来只有「每项检查的总耗时」：
//     { id: 'tools', ms: 17367 }
//   ⇒ 知道 tools 花了 17 秒，但不知道里面哪一步慢。
//
//   Span 模型（OpenInference spec/traces.md）：
//     Trace = 一次完整操作（共享 trace_id）
//     Span  = 一个工作单元（有 span_id / parent_id / 耗时 / 状态）
//   ⇒ 能看出「哪一步慢」「哪一步失败」「谁调用了谁」。
//
// 【原文】
//   「Span 看起来像结构化日志。这是因为——它确实就是！
//    可以把 Trace 理解为「带上下文、关联、层级的结构化日志集合」。」
//
// 【我的简化】
//   不做完整 OTel（那是分布式系统用的），只做三件事：
//     ① 层级（parent_id）
//     ② 耗时（start/end）
//     ③ 状态（status_code）
//
// 【诚实边界】
//   · 不做跨进程传播（单机工具，没有分布式需求）
//   · 不做采样（数据量小，全记）
//   · span 只存在内存里，不落盘（落盘会撑爆 state 文件）
// ═══════════════════════════════════════════════════════════════════════════

// ★★2026-11-01 加（学自 OpenInference 的 configuration.md）★★
//
// 【问题】我到处用 slice(0, 120) 截断，但截断后看不出「是截断了还是本来就这么短」：
//   · 120 字符以内 ⇒ 完整
//   · 超过 120     ⇒ 截断，但看不出来
//   · 本来就没内容 ⇒ 也是空
//   ⇒ 三种状态塌缩成两种，分不清「截断」和「本来短」。
//
// 【OpenInference 的做法】
//   内容被隐藏时用 __REDACTED__ 占位符：
//   「This constant value allows consumers of the trace data to identify that
//     content was intentionally hidden rather than missing or empty.」
//   ⇒ 让「故意隐藏」和「缺失」可区分。
//
// 【我的做法】
//   截断时明确标注截了多少字符：
//   '...xxx…[TRUNCATED 380 chars]'
//   ⇒ 一眼看出「这里被截断了，原文还有 380 字符」
function truncate(s, max) {
  const str = String(s === null || s === undefined ? '' : s);
  if (str.length <= max) return str;
  return str.slice(0, max) + '…[TRUNCATED ' + (str.length - max) + ' chars]';
}

/** 标记「内容被故意省略」（对应 OpenInference 的 __REDACTED__） */
const REDACTED = '__REDACTED__';
/** 生成短 id（够用即可，不做 UUID） */
function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 创建一个 Span
 * @param {string} name   span 名
 * @param {string} traceId 所属 trace
 * @param {string|null} parentId 父 span（null = root）
 */
// ★★2026-11-01 加：span kind（学自 OpenInference semantic_conventions.md）★★
//   「openinference.span.kind is REQUIRED for all OpenInference spans」
//
//   10 种 kind：
//     LLM / EMBEDDING / CHAIN / RETRIEVER / RERANKER
//     TOOL / AGENT / GUARDRAIL / EVALUATOR / PROMPT
//
//   ★为什么重要：kind 告诉后端「这个 span 在干什么」
//     没有 kind ⇒ 只知道有耗时，不知道是什么类型的操作
//
//   我的映射：
//     patrol（root）      → CHAIN     整个流程
//     checkXxx            → TOOL      执行检查（调工具）
//     读历史账本          → RETRIEVER 从账本取数据
//     真跑 check-all      → TOOL      调外部命令
//     燃尽率              → EVALUATOR 评估数据
//     防抖                → GUARDRAIL 拦截误报
// ★★2026-11-01 加（学自 OpenInference llm_spans.md 的 Context Attributes）★★
//
// 【原文】「All LLM spans automatically inherit context attributes...
//         These attributes are propagated to every span in the trace
//         without needing to be explicitly set on each span.」
//
// 【为什么要 session.id】
//   span  = 一项检查
//   trace = 一次巡检
//   session = 这台机器上的所有巡检（跨多次操作的长期上下文）
//   有了 session.id 才能回答「这台机器最近 100 次巡检稳定吗」
//
// 【为什么要 tags】
//   kind 是单选（TOOL/RETRIEVER/...），tags 是多选
//   tags: ['health-check', 'p1', 'disk'] ⇒ 可按类型/严重度/主题多维筛选
//
// 【sessionId 怎么算】
//   用机器标识（hostname + 数据目录），不随机
//   ⇒ 重启后还是同一个 session，能看长期趋势
const os = require('node:os');
const SESSION_ID = (function () {
  try {
    const host = os.hostname().replace(/[^a-zA-Z0-9-]/g, '').slice(0, 20);
    const dataTag = String(DATA).replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    return host + '-' + dataTag;
  } catch (_) { return 'unknown-session'; }
})();

function makeSpan(name, traceId, parentId, kind, tags) {
  return {
    name,
    kind: kind || 'CHAIN',   // ★默认 CHAIN
    traceId,
    sessionId: SESSION_ID,   // ★上下文属性：跨巡检的机器标识
    tags: tags || [],        // ★上下文属性：多标签分类
    spanId: shortId(),
    parentId: parentId || null,
    startTime: Date.now(),
    endTime: null,
    statusCode: 'UNSET',
    attributes: {},
  };
}

/** 结束 span（记耗时 + 状态） */
function endSpan(span, statusCode, attributes) {
  span.endTime = Date.now();
  span.durationMs = span.endTime - span.startTime;
  span.statusCode = statusCode || 'OK';
  if (attributes) Object.assign(span.attributes, attributes);
  return span;
}

// ★★2026-11-01 加：span 上下文（让子函数能挂 span）★★
//   为什么用全局变量：检查函数是独立函数，不方便层层传参
//   用法：patrol() 设 _currentSpan，检查函数内部调 subSpan('名字')
//   ★注意：必须在 patrol() 之前声明（否则 TDZ 报 _currentSpan is not defined）
let _currentSpan = null;

/** 在「当前 span」下开一个子 span */
function subSpan(name, kind) {
  if (!_currentSpan) return { end: function () {}, span: null };
  const s = makeSpan(name, _currentSpan.traceId, _currentSpan.spanId, kind || 'TOOL');
  _currentSpan._children = _currentSpan._children || [];
  _currentSpan._children.push(s);
  let ended = false;
  return {
    end: function (statusCode, attrs) {
      if (ended) return s;   // ★幂等：多次调用只算第一次
      ended = true;
      return endSpan(s, statusCode, attrs);
    },
    span: s,
  };
}

/** 收集当前 span 的所有子 span（递归） */
function collectChildren(span) {
  const out = [];
  if (span && span._children) {
    for (const ch of span._children) {
      out.push(ch);
      out.push(...collectChildren(ch));
    }
  }
  return out;
}

/** 把 span 转成可读的一行（供面板/日志用） */
function formatSpan(span, depth) {
  const indent = '  '.repeat(depth || 0);
  const icon = span.statusCode === 'OK' ? '✓' : (span.statusCode === 'ERROR' ? '✗' : '?');
  return indent + icon + ' ' + span.name + ' (' + (span.durationMs || 0) + 'ms)';
}
const CHECK_META = {
  plugins:   { severity: 'P1', runbook: '检查 profile/package.json 声明的插件是否都在 node_modules；缺了就 dsh plugin --profile desktop add <包名>' },
  sessions:  { severity: 'P2', runbook: '看 ~/.dsh/sessions 下有没有 0 字节的最近文件；有就删掉（可能是写入中断）' },
  memory:    { severity: 'P2', runbook: '更新 /Users/Admin/chudai-data/memory/RESUME.md（把最近做的写进去）' },
  tools:     { severity: 'P1', runbook: '跑 node tools/check-all.cjs quick 看哪项失败；单跑那个工具看报错' },
  guardian:  { severity: 'P2', runbook: '看 /Users/Admin/chudai-data/memory-v2/guardian.log 末几行；进程没了就重启 daemon-guardian.mjs' },
  daemon:    { severity: 'P2', periodMs: 6 * 3600000, runbook: '看 /Users/Admin/chudai-data/memory-v2/yinyang-state.json 的 lastRunAt；超周期就查 yinyang-daemon.mjs' },
  saturation:{ severity: 'P3', runbook: '清磁盘：C 盘查 C:/Users/19124/AppData 缓存；sessions 大了归档旧会话' },
};

// ★★2026-11-01 改造（学自 OpenInference 的 annotations.md）★★
//
// 【规范要求】
//   「Each object MUST have name and at least one of score, label, or explanation.」
//   ⇒ 一个判断必须至少有「分数 / 标签 / 解释」之一，只有名字不算。
//
// 【我原来的问题】
//   { level: 'warn', detail: 'RESUME 6 小时前更新' }
//   · level 是 label，但没有 score（严重度分数）
//   · 没有 annotator_kind（这个判断是谁做的？）
//   · 没有 explanation（为什么判 warn 不是 fail？）
//
// 【三种评判者】
//   HUMAN = 人判的 / LLM = 语言模型判的 / CODE = 确定性代码判的
//   我全是 CODE（规则判的），这点要诚实标注。
//
// 【score 怎么算】
//   0.0 = 完全正常，1.0 = 完全坏了
//   ok=0, warn=0.5, fail=1.0, unknown=null（查不了，不打分）
//   ★unknown 的 score 是 null 不是 0 —— 查不了不等于正常。
const LEVEL_SCORE = { ok: 0, warn: 0.5, fail: 1, unknown: null, new: null, paused: null };

/** 给检查结果补 severity + runbook + annotation（OpenInference 风格） */
function annotate(check) {
  const meta = CHECK_META[check.id];
  if (!meta) return check;
  check.severity = meta.severity;
  if (check.level !== 'ok') check.runbook = meta.runbook;
  // ★2026-11-01 加：预计算 alertAfter（学自 healthchecks）
  //   用途：知道「什么时候该报警」而不是每次判断
  //   ★无周期的检查（静态检查）⇒ NEVER
  const periodMs = meta.periodMs || 0;
  check.alertAfter = computeAlertAfter(check, periodMs, periodMs ? graceFor(periodMs) : 0);
  // ★annotation：符合 OpenInference 规范
  check.annotation = {
    name: check.id,
    label: check.level,
    score: LEVEL_SCORE[check.level] !== undefined ? LEVEL_SCORE[check.level] : null,
    explanation: String(check.detail || '').slice(0, 200),
    annotator_kind: 'CODE',   // ★诚实标注：规则判的，不是人也不是 LLM
  };
  return check;
}

/** 读上次的检查状态（坏文件当空） */
function loadPrevState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return (j && typeof j === 'object' && j.checks) ? j.checks : {};
  } catch (_) { return {}; }
}

/** 写本次状态（失败不阻塞巡检） */
// ★★2026-11-01 修：原来会覆盖 diskHistory★★
//   病：saveState 每次重写整个文件，把 recordDiskHistory 写的 diskHistory 冲掉
//   ⇒ 实测跑两次，diskHistory 始终 0 条
//   ★修法：先读旧 state，保留 diskHistory，再写
function saveState(checks) {
  try {
    let prev = {};
    try {
      if (fs.existsSync(STATE_FILE)) prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
    } catch (_) {}
    const out = {
      ts: new Date().toISOString(),
      checks: {},
      diskHistory: Array.isArray(prev.diskHistory) ? prev.diskHistory : [],   // ★保留
    };
    for (const c of checks) {
      out.checks[c.id] = { level: c.level, consecutiveFails: c.consecutiveFails || 0 };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (_) { /* 落盘失败不影响巡检 */ }
}

/**
 * ★防抖：把「单次结果」变成「连续 N 次才判失败」
 * @param {object} check 本次检查结果
 * @param {object} prev  上次状态 { level, consecutiveFails }
 * @returns {object} 应用防抖后的结果
 */
// ★★2026-11-01 改造（学自 OpenInference 的 decision_spans.md）★★
//
// 【原来的问题】硬编码 if-else，没有「决策依据」和「置信度」：
//   if (nowFails < FAILURE_THRESHOLD) { level = 'warn' } else { level = 'fail' }
//   ⇒ 不知道为什么这么判，也不知道有多确定
//
// 【决策模型的做法】
//   state + 结构化问题 → 带置信度的答案
//   · state: { level, consecutiveFails, threshold }
//   · question: Noul（是/否）「应该报 fail 吗？」
//   · answer: { value: 'no', confidence: 0.67, reason: '1/3' }
//
// 【为什么置信度有用】
//   置信度 0.33（1/3）和 1.0（3/3）都是「报 fail」，但紧迫度完全不同。
//   有了置信度，上层可以决定「要不要立刻通知」。
//
// 【诚实边界】
//   我没有真正的决策模型（Jev / OpenAI Decisions API 需外部服务），
//   置信度是规则算的（consecutiveFails / threshold），不是概率推理。
function decideFail(consecutiveFails, threshold) {
  // ★Noul 类型：是/否
  const shouldFail = consecutiveFails >= threshold;
  // ★置信度：连续失败次数 / 阈值（封顶 1.0）
  const confidence = Math.min(1, consecutiveFails / threshold);
  return {
    question: 'shouldFail',
    type: 'Noul',
    value: shouldFail ? 'yes' : 'no',
    confidence: Math.round(confidence * 100) / 100,
    state: { consecutiveFails, threshold },
  };
}

function applyThreshold(check, prev) {
  // ★2026-11-01 加：首次检查标 new（不是 ok）
  //   理由：没有基线就说「正常」是假绿
  //   ★但只对「依赖历史」的检查有意义（防抖/燃尽率）
  //     对纯静态检查（插件加载）没历史也能判，不该标 new
  const prevFails = (prev && prev.consecutiveFails) || 0;
  if (check.level === 'fail') {
    const nowFails = prevFails + 1;
    check.consecutiveFails = nowFails;
    // ★结构化决策（替代硬编码 if）
    const decision = decideFail(nowFails, FAILURE_THRESHOLD);
    check.decision = decision;
    if (decision.value === 'no') {
      check.originalLevel = 'fail';
      check.level = 'warn';
      check.detail += ' | 待确认 ' + nowFails + '/' + FAILURE_THRESHOLD + '（置信度 ' + decision.confidence + '）';
    } else {
      check.detail += ' | ★连续失败 ' + nowFails + ' 次（置信度 ' + decision.confidence + '）';
    }
  } else {
    check.consecutiveFails = 0;
    check.decision = decideFail(0, FAILURE_THRESHOLD);
    if (prev && prev.level === 'fail' && check.level === 'ok') {
      check.detail += ' | ★刚恢复';
    }
  }
  return check;
}

// ── 燃尽率估算（学自 Google SRE Workbook「SLO 警报策略」）──
//
// 【什么是燃尽率】
//   原意：消耗错误预算的速度（Burn rate = 1 表示刚好在窗口末用完）。
//   这里借用：**磁盘增长速率** ⇒ 外推「还剩多少天会满」。
//
// 【为什么比固定阈值好】
//   固定阈值：85% 就 warn。但「85% 每天涨 1%」和「85% 十年涨 1%」完全不同。
//   燃尽率：算出「约 X 天满」，直接回答「要不要现在处理」。
//
// 【实现】
//   1. 读 patrol-state.json 里的 diskHistory（每次巡检追加一条 {ts, pct}）
//   2. 算最近 N 次的线性增长率（%/天）
//   3. 外推：(100 - 当前) / 日增长率 = 天数
//
// 【诚实边界】
//   · 线性外推，不预测突变（下了个大文件、清了缓存）
//   · 至少 2 条历史才能算，否则返回 null
//   · 历史最多留 20 条（防 state 膨胀）
//   · 增长率为负（在减少）⇒ 返回 null（不报「永远不满」这种废话）
function estimateDaysToFull(drive, currentPct) {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const hist = (j && Array.isArray(j.diskHistory)) ? j.diskHistory : [];
    const sameDrive = hist.filter((h) => h && h.drive === drive && typeof h.pct === 'number');
    if (sameDrive.length < 2) return null;
    const first = sameDrive[0];
    const last = sameDrive[sameDrive.length - 1];
    const dtDays = (new Date(last.ts).getTime() - new Date(first.ts).getTime()) / 86400000;
    // ★★2026-11-01 修（实测假警报）★★
    //   病：15 条历史都在 15 分钟内（78.4% → 78.5%，涨 0.1%），
    //       线性外推算出「2.1 天满」⇒ 完全是噪音。
    //   根因：短期波动（缓存写入/临时文件）被当成长期趋势。
    //   ★修法：要求最小时间跨度（默认 1 天）+ 最小涨幅（默认 0.5%）。
    //     两条都不满足 ⇒ 不预测（返回 null）。
    //   ★为什么是这两个值：
    //     · 1 天：磁盘占用在 1 天内的波动是噪音，不是趋势
    //     · 0.5%：1 天内涨 0.5% 才算「真的在涨」（198GB 盘 = 1GB/天）
    const MIN_SPAN_DAYS = 1;
    const MIN_DELTA_PCT = 0.5;
    if (!(dtDays >= MIN_SPAN_DAYS)) return null;          // 时间跨度太短 ⇒ 不预测
    const deltaPct = last.pct - first.pct;
    if (!(deltaPct >= MIN_DELTA_PCT)) return null;        // 涨幅太小 ⇒ 不预测
    const ratePerDay = deltaPct / dtDays;                 // %/天
    if (!(ratePerDay > 0.001)) return null;               // 涨得太慢 ⇒ 不预测
    const days = (100 - currentPct) / ratePerDay;
    return days > 0 ? days : null;
  } catch (_) { return null; }
}

/** 记录本次磁盘占用到 history（供下次算燃尽率） */
function recordDiskHistory(drive, pct) {
  try {
    let j = { checks: {}, diskHistory: [] };
    if (fs.existsSync(STATE_FILE)) {
      try {
        const prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
        j = { checks: prev.checks || {}, diskHistory: Array.isArray(prev.diskHistory) ? prev.diskHistory : [] };
      } catch (_) {}
    }
    if (!Array.isArray(j.diskHistory)) j.diskHistory = [];
    j.diskHistory.push({ ts: new Date().toISOString(), drive, pct });
    if (j.diskHistory.length > 20) j.diskHistory = j.diskHistory.slice(-20);
    fs.writeFileSync(STATE_FILE, JSON.stringify(j, null, 2), 'utf8');
  } catch (_) { /* 落盘失败不影响巡检 */ }
}

// ── ⑦ 饱和度（SRE 四大黄金信号之一）──
//
// 【为什么加】
//   SRE 四大黄金信号：延迟 / 流量 / 错误 / **饱和度**。
//   我原来只覆盖了「错误」（check-all 通过率），缺「饱和度」。
//   饱和度 = 资源用得多满（磁盘 / 会话目录大小）。
//
// 【查什么】
//   · 磁盘占用率：>=90% fail，>=85% warn（C 盘最容易满）
//   · 会话目录大小：>2GB warn（DSH 会话只增不减）
//
// 【诚实边界】
//   · 只查占用率，不预测「多久会满」
//   · 会话目录阈值是拍脑袋定的（2GB），后续按实际调
function checkSaturation() {
  const out = { id: 'saturation', name: '饱和度', level: 'ok', detail: '', issues: [] };
  try {
    const parts = [];
    const drives = ['C:', 'G:'];
    let worstPct = 0, worstDrive = '';
    // ★★2026-11-01 优化（powershell 每次启动 1.5s × 2 盘 = 3s）★★
    //   病：用 powershell 查磁盘，两次调用 3.2 秒
    //   ★修法：用 Node 内置 fs.statfsSync（Node 18.15+，无子进程）
    for (const d of drives) {
      try {
        // Node 20+ 有 fs.statfsSync，返回 { bsize, blocks, bfree, bavail, ... }
        if (typeof fs.statfsSync === 'function') {
          const st = fs.statfsSync(d + '/');
          const total = st.blocks * st.bsize;
          const free = st.bavail * st.bsize;
          if (total > 0) {
            const pct = Math.round(((total - free) / total) * 1000) / 10;
            parts.push(d + ' ' + pct + '%');
            if (pct > worstPct) { worstPct = pct; worstDrive = d; }
          }
        }
      } catch (_) { /* 单个盘查不了不影响整体 */ }
    }
    // ★兜底：statfsSync 不可用时才用 powershell（慢但能用）
    if (parts.length === 0) {
      try {
        const r = require('node:child_process').execFileSync('powershell', ['-NoProfile', '-Command',
          'Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } | ForEach-Object { "$($_.Name) " + [math]::Round(($_.Used / ($_.Used + $_.Free)) * 100, 1) }'
        ], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
        for (const line of String(r).split('\n')) {
          const m = line.trim().match(/^([A-Z])\s+([\d.]+)$/);
          if (m) {
            const pct = parseFloat(m[2]);
            parts.push(m[1] + ': ' + pct + '%');
            if (pct > worstPct) { worstPct = pct; worstDrive = m[1] + ':'; }
          }
        }
      } catch (_) {}
    }
    // ★★2026-11-01 实测修正★★
    //   一开始以为递归慢（3.1 秒），实测发现：
    //     · 递归 walk 182 个文件 = 27ms
    //     · powershell 查磁盘 = 3.2 秒
    //   ⇒ 瓶颈是 powershell，不是递归！
    //   现在磁盘改用 fs.statfsSync（0ms），递归可以放心用。
    //   sessions 结构是三层：sessions/工作区/session-id/文件
    const sessDir = path.join(process.env.USERPROFILE || 'C:/Users/19124', '.dsh', 'sessions');
    let sessMB = null;
    if (fs.existsSync(sessDir)) {
      try {
        let size = 0;
        const walk = (p) => {
          for (const f of fs.readdirSync(p, { withFileTypes: true })) {
            const fp = path.join(p, f.name);
            if (f.isDirectory()) walk(fp);
            else { try { size += fs.statSync(fp).size; } catch (_) {} }
          }
        };
        walk(sessDir);
        sessMB = Math.round(size / 1024 / 1024);
        parts.push('sessions ' + sessMB + 'MB');
      } catch (_) {}
    }
    out.detail = parts.length ? parts.join(' | ') : '查不到磁盘/会话数据';
    // ★★2026-11-01 加：燃尽率（学自 Google SRE Workbook「SLO 警报策略」）★★
    //
    // 【为什么加】固定阈值（>85% warn）有两个缺陷：
    //   ① 不知道「多久会满」：85% 每天涨 1% 和涨 0.01% 紧迫度完全不同
    //   ② 没有趋势：单点判断看不出是在变好还是变坏
    //
    // 【燃尽率是什么】
    //   原意：消耗错误预算的速度（Burn rate = 1 表示刚好在窗口末用完）。
    //   这里借用：**磁盘增长速率** ⇒ 算出「还剩多少天会满」。
    //
    // 【怎么做】
    //   把每次的磁盘占用率记进 patrol-state.json 的 history，
    //   算最近 N 次的变化率（%/天），外推「多少天会满」。
    //
    // 【诚实边界】
    //   · 线性外推，不预测「突然涨」（比如下了个大文件）
    //   · 至少要 2 次历史才能算
    //   · 历史最多留 20 条（防 state 文件膨胀）
    const spBurn = subSpan('燃尽率估算', 'EVALUATOR');
    const daysToFull = estimateDaysToFull(worstDrive, worstPct);
    spBurn.end('OK', { daysToFull: daysToFull === null ? 'null' : Math.round(daysToFull) });
    if (worstDrive) recordDiskHistory(worstDrive, worstPct);
    // ★★2026-11-01 实测修正：阈值 7 天太严★★
    //   实测：C 盘 78.4%，历史显示 2%/天 ⇒ 10.8 天满，但阈值 <7 天没触发。
    //   ★修法：阈值改 30 天（磁盘从 78% 到满，正常是几个月；30 天内会满确实该预警）
    const DANGER_DAYS = 30;
    if (worstPct >= 90) {
      out.level = 'fail';
      out.detail += ' | ★' + worstDrive + ' 磁盘 ' + worstPct + '% 接近满';
      if (daysToFull !== null) out.detail += '（约 ' + daysToFull.toFixed(1) + ' 天满）';
    } else if (worstPct >= 85) {
      out.level = 'warn';
      out.detail += ' | ⚠ ' + worstDrive + ' 磁盘 ' + worstPct + '% 偏高';
      if (daysToFull !== null) out.detail += '（约 ' + daysToFull.toFixed(1) + ' 天满）';
    } else if (daysToFull !== null && daysToFull < DANGER_DAYS) {
      // ★占用不高但涨得快 ⇒ 提前告警（这正是燃尽率的价值）
      out.level = 'warn';
      out.detail += ' | ⚠ ' + worstDrive + ' 涨得快，约 ' + daysToFull.toFixed(1) + ' 天满（现在才 ' + worstPct + '%）';
    } else if (daysToFull !== null) {
      // ★有预测但不紧急 ⇒ 记在 detail 里（信息透明，不告警）
      out.detail += ' | ' + worstDrive + ' 按当前增速约 ' + daysToFull.toFixed(0) + ' 天满';
    }
    if (sessMB !== null && sessMB > 2048) {
      if (out.level === 'ok') out.level = 'warn';
      out.detail += ' | ⚠ 会话目录 ' + sessMB + 'MB 超 2GB';
    }
  } catch (e) { out.level = 'unknown'; out.detail = String(e.message).slice(0, 120); }
  return out;
}

// ── 汇总 ──
function patrol(opts) {
  const o = opts || {};
  const checks = [];
  const spans = [];
  const prevState = loadPrevState();
  // ★本次巡检的 trace id（所有 span 共享）
  const traceId = shortId();
  const rootSpan = makeSpan('patrol', traceId, null, 'CHAIN');
  const fns = [checkPlugins, checkSessions, checkMemory, checkTools, checkGuardian, checkDaemon, checkSaturation];
  for (const fn of fns) {
    if (o.skip && o.skip.includes(fn.name.replace('check', '').toLowerCase())) continue;
    const t0 = Date.now();
    // ★每个检查一个 child span
    // ★tags：检查名 + 严重度（便于多维筛选）
    const checkMeta = CHECK_META[fn.name.replace('check', '').toLowerCase()];
    const spanTags = ['health-check'].concat(checkMeta ? [checkMeta.severity.toLowerCase()] : []);
    const span = makeSpan(fn.name, traceId, rootSpan.spanId, 'TOOL', spanTags);
    _currentSpan = span;   // ★设置上下文
    let result;
    try {
      result = fn();
      endSpan(span, 'OK');
    } catch (e) {
      result = { id: fn.name, name: fn.name, level: 'unknown', detail: '检查抛错: ' + truncate(e.message, 120), issues: [] };
      endSpan(span, 'ERROR', { error: String(e.message).slice(0, 120) });
    }
    // ★2026-11-01 修：防抖 span 必须在 _currentSpan 清空前创建（否则挂不上父 span）
    const spGuard = subSpan('防抖判断', 'GUARDRAIL');
    result.ms = Date.now() - t0;
    result.spanId = span.spanId;
    // ★2026-11-01 加：首次检查标 new（学自 healthchecks 的 4 状态）
    //   理由：没有基线就说「正常」是假绿
    //   ★只对「依赖历史」的检查生效（防抖/燃尽率需要历史）
    //     纯静态检查（插件加载/会话健康）没历史也能判，不该标 new
    const needsHistory = ['tools', 'daemon', 'saturation'].includes(result.id);
    if (needsHistory && isFirstRun(prevState) && result.level === 'ok') {
      result.originalLevel = 'ok';
      result.level = 'new';
      result.detail += ' | ★首次检查，还没建立基线（不是「正常」）';
      result.reason = 'unknown';
    }
    // ★★2026-11-01 修：flip 必须用「防抖后」的最终状态★★
    //   病：flip 在 applyThreshold 之前算 ⇒ 用的是原始 level（未防抖）
    //   实测：memory 第一次 warn，第二次原始 fail 被防抖降为 warn，
    //         但 flip 记录了 warn → fail（错）
    //   ★修法：先 applyThreshold，再算 flip
    applyThreshold(result, prevState[result.id]);
    // ★2026-11-01 加：算状态翻转（学自 healthchecks 的 Flip）
    //   记录「上次状态 → 本次最终状态」的变化
    //   ★关键：new→up / paused→up 不通知（不是故障恢复）
    const prevLevel = prevState[result.id] ? prevState[result.id].level : null;
    result.flip = prevLevel ? computeFlip(prevLevel, result.level) : null;   // null = 没变化或首次检查
    // ★2026-11-01 加：区分 timeout 和 fail（学自 healthchecks 的 REASONS）
    if (result.level === 'fail' || result.level === 'warn') {
      // 超时的特征：detail 里有「超时」「timeout」「ETIMEDOUT」
      const d = String(result.detail || '');
      result.reason = /超时|timeout|ETIMEDOUT|SIGTERM/i.test(d) ? 'timeout' : 'fail';
    }
    spGuard.end('OK', { level: result.level, consecutiveFails: result.consecutiveFails || 0 });
    _currentSpan = null;   // ★清理上下文（放在最后）
    annotate(result);
    checks.push(result);
    spans.push(span);
    // ★把子 span 也收进来（递归）
    spans.push(...collectChildren(span));
  }
  // ★root span 收尾（记录总耗时 + 整体状态）
  endSpan(rootSpan, checks.some((x) => x.level === 'fail') ? 'ERROR' : 'OK', {
    checkCount: checks.length,
  });
  const count = (lv) => checks.filter((c) => c.level === lv).length;
  // ★2026-11-01 修：加了 new/paused 状态后，summary 必须跟上
  //   病：原来只统计 ok/warn/fail/unknown ⇒ 加 new 后加总 != total（自检抓到）
  //   实测：5=7（差 2 个是 new）
  const ok = count('ok'), warn = count('warn'), fail = count('fail'), unknown = count('unknown');
  const newCount = count('new'), paused = count('paused');
  // ★2026-11-01 改：抽成 computeVerdict 纯函数（便于测试）
  const verdict = computeVerdict({ ok, warn, fail, unknown, new: newCount, paused });
  saveState(checks);
  const totalMs = checks.reduce((s, c) => s + (c.ms || 0), 0);
  const pending = checks.filter((c) => c.consecutiveFails > 0 && c.level !== 'fail');
  // ★★2026-11-01 加（学自「告警降噪」：分级排序 + 压缩）★★
  //
  // 【分级排序】
  //   原来 checks 按固定顺序（plugins, sessions, memory, ...）。
  //   ⇒ 有问题时，P3 的磁盘告警可能排在 P1 的工具故障前面。
  //   ★修法：按 severity 排序（P1 在最前），同 severity 内按 level（fail > warn > unknown > ok）。
  //
  // 【压缩】
  //   原文：「短时间内产生大量告警，可以合并为一个」。
  //   场景：7 项里 5 项都 fail ⇒ 输出 5 条，人看得累。
  //   ★修法：给一句 summary 结论（「5 项失败，最紧急的是 X」）。
  const SEV_ORDER = { P1: 0, P2: 1, P3: 2 };
  const LVL_ORDER = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  const sorted = checks.slice().sort((a, b) => {
    const sa = SEV_ORDER[a.severity] !== undefined ? SEV_ORDER[a.severity] : 9;
    const sb = SEV_ORDER[b.severity] !== undefined ? SEV_ORDER[b.severity] : 9;
    if (sa !== sb) return sa - sb;
    return (LVL_ORDER[a.level] || 9) - (LVL_ORDER[b.level] || 9);
  });
  // ★压缩：生成一句话结论
  const bad = sorted.filter((c) => c.level === 'fail' || c.level === 'warn');
  let digest = '';
  if (bad.length === 0) {
    digest = '全部 ' + checks.length + ' 项通过';
  } else if (bad.length === 1) {
    digest = bad[0].severity + ' ' + bad[0].name + '：' + bad[0].detail.slice(0, 60);
  } else {
    // ★多个问题时：说清「几个 + 最紧急的是哪个」
    const p1 = bad.filter((c) => c.severity === 'P1');
    digest = bad.length + ' 项异常';
    if (p1.length > 0) digest += '，最紧急 P1：' + p1.map((c) => c.name).join('/');
    else digest += '，最高 ' + bad[0].severity + '：' + bad[0].name;
  }
  // ★★2026-11-01 加：trace 级标注（学自 OpenInference annotations.md）★★
  //
  // 【为什么要 trace 级】
  //   span 级标注回答「这一项检查怎么样」，
  //   trace 级标注回答「整次巡检可不可信」。
  //
  //   ★关键：unknown 项多 ⇒ 巡检结果不可信，即使 verdict=PASS。
  //     例：7 项里 3 项 unknown ⇒ 只有 4 项真检查了 ⇒ 可信度 4/7 = 0.57
  //
  // 【可信度怎么算】
  //   confidence = (ok + warn + fail) / total
  //   unknown 不算进分子（查不了不等于通过）
  //   复用历史的结果也打折（不是刚跑的）
  // ★2026-11-01 加：统计需要通知的翻转
  const notifyFlips = checks.filter((x) => x.flip && x.flip.shouldNotify);
  const silentFlips = checks.filter((x) => x.flip && !x.flip.shouldNotify);
  const freshCount = checks.filter((x) => !String(x.detail).includes('复用')).length;
  const checkedCount = checks.filter((x) => x.level !== 'unknown').length;
  const confidence = Math.round((checkedCount / checks.length) * 100) / 100;
  const freshness = Math.round((freshCount / checks.length) * 100) / 100;
  const traceAnnotation = {
    name: 'patrol_trustworthiness',
    label: confidence >= 0.9 ? 'high' : (confidence >= 0.7 ? 'medium' : 'low'),
    score: confidence,
    explanation: checkedCount + '/' + checks.length + ' 项真检查了，' + freshCount + '/' + checks.length + ' 项是刚跑的（其余复用历史）',
    annotator_kind: 'CODE',
  };
  return {
    ts: new Date().toISOString(),
    verdict,
    digest,
    // ★2026-11-01 加：状态翻转（学自 healthchecks 的 Flip）
    flips: {
      notify: notifyFlips.map((x) => ({ id: x.id, name: x.name, old: x.flip.oldStatus, new: x.flip.newStatus })),
      silent: silentFlips.map((x) => ({ id: x.id, name: x.name, old: x.flip.oldStatus, new: x.flip.newStatus, reason: x.flip.reason })),
    },
    // ★2026-11-01 加：trace（学自 OpenInference）
    trace: { traceId, root: rootSpan, spans, annotation: traceAnnotation },
    summary: { ok, warn, fail, unknown, new: newCount, paused, total: checks.length },
    totalMs,
    checks: sorted,
    note: [
      unknown > 0 ? '★有 ' + unknown + ' 项查不了（不等于通过）' : '',
      newCount > 0 ? '★有 ' + newCount + ' 项首次检查（还没建立基线，不等于正常）' : '',
    ].filter(Boolean).join(' '),
    pendingNote: pending.length > 0 ? '★有 ' + pending.length + ' 项待确认（连续 ' + FAILURE_THRESHOLD + ' 次失败才判 fail）' : '',
  };
}

module.exports = { patrol, checkPlugins, checkSessions, checkMemory, checkTools, checkGuardian, checkDaemon, checkSaturation, decideFail, applyThreshold, truncate, REDACTED, graceFor, DEFAULT_GRACE_MS, computeAlertAfter, NEVER, computeFlip, computeDwell, FAILURE_THRESHOLD, computeVerdict, LEVEL_SCORE };
