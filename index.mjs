// ═══════════════════════════════════════════════════════════════════════════
// dsh-plugin-chudai-patrol · 巡检司宿主入口
//
// 【它是什么】
//   DSH 内部的看门狗。6 项健康巡检 + 面板 + 工具。
//
// 【与 daemon-guardian 的分工（重要）】
//   · core/memory-v2/daemon-guardian.mjs（独立进程）
//       —— 管「进程活着吗」，死了就拉起，7x24 不依赖 DSH
//   · 本插件（跟 DSH 生命周期走）
//       —— 管「DSH 内部健康吗」，只看不拉起，DSH 停了就停
//   ★不是替代关系，是互补：guardian 管进程，patrol 管功能
//
// 【诚实边界】
//   · 只看不改（要修走 heal / 青天闸）
//   · DSH 停了本插件也停 —— 所以它救不了 DSH 本身
//   · 检查本身可能误报，每项都标注判据
//
// 【2026-11-01 衡修 · 为什么改】
//   原版用的是 `ctx.tool({...})` 和 `ctx.router.post/get(...)`，这两个在 rc.5 都不存在
//   （rc.5 的正确姿势：ctx.tools.register(...) / ctx.webServer.register({kind:'prefix'})，
//    见 braincore 与 workbench 两个已上线插件）。原版还漏了 export const inject。
//   ⇒ 照 rc.5 契约重写这两处；core/patrol.cjs 加载失败时降级成"如实报错"，不让整个插件挂。
// ═══════════════════════════════════════════════════════════════════════════
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PLUGIN_ID = 'chudai-patrol';
const VERSION = '0.1.0';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ★core 缺失不能让插件挂：拿不到就直接报错字符串，路由和工具照常注册
let patrolCore = null;
let coreError = '';
try {
  patrolCore = require(path.join(__dirname, 'core', 'patrol.cjs'));
} catch (e) {
  coreError = String((e && e.message) || e).slice(0, 300);
}

function textBlocks(value) {
  return [{ type: 'text', text: JSON.stringify(value == null ? {} : value, null, 2) }];
}

function runPatrol(opts) {
  if (!patrolCore || typeof patrolCore.patrol !== 'function') {
    return { ok: false, error: 'core/patrol.cjs 未加载: ' + coreError };
  }
  try {
    return patrolCore.patrol(opts || {});
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

const PATROL_RUN_TOOL = {
  name: 'patrol_run',
  description: '巡检司 · 跑一次 DSH 内部健康巡检（6 项：插件加载/会话健康/记忆新鲜度/工具可用性/看门狗状态/daemon 状态）。★只看不改。',
  parameters: {
    type: 'object',
    properties: {
      skip: { type: 'array', items: { type: 'string' }, description: '跳过的检查 id（可选）' },
    },
  },
  async execute(args) {
    const r = runPatrol({ skip: (args && args.skip) || [] });
    return { content: textBlocks(r), isError: r && r.ok === false ? true : undefined };
  },
};

const PATROL_ONE_TOOL = {
  name: 'patrol_one',
  description: '巡检司 · 只跑某一项检查。id: plugins | sessions | memory | tools | guardian | daemon',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '检查 id' },
    },
    required: ['id'],
    },
  async execute(args) {
    const id = args && args.id;
    if (!patrolCore || typeof patrolCore.patrol !== 'function') {
      return { content: textBlocks({ error: 'core/patrol.cjs 未加载: ' + coreError }), isError: true };
    }
    const map = {
      plugins: patrolCore.checkPlugins,
      sessions: patrolCore.checkSessions,
      memory: patrolCore.checkMemory,
      tools: patrolCore.checkTools,
      guardian: patrolCore.checkGuardian,
      daemon: patrolCore.checkDaemon,
    };
    const fn = map[id];
    if (typeof fn !== 'function') {
      return { content: textBlocks({ error: '未知 id: ' + id, valid: Object.keys(map) }), isError: true };
    }
    try { return { content: textBlocks(fn()) }; }
    catch (e) { return { content: textBlocks({ error: String((e && e.message) || e).slice(0, 300) }), isError: true }; }
  },
};

export const name = PLUGIN_ID;
// ★2026-11-01 衡修：inject 只留 webServer（与 workbench 完全同构）。
//   原来写 ['webServer','tools']，实测 apply 能进但路由 404 —— 先对齐已验证样本。
//   tools 改成运行时探测，拿不到就不注册工具（路由不受影响）。
export const inject = ['webServer'];

export function apply(ctx) {
  const log = (ctx && ctx.logger) || console;
  const startedAt = Date.now();
  const webServer = ctx.webServer;

  // ── web 路由：/_dsh/chudai-patrol/{status,run} ──
  //   照 workbench 已验证模板：kind:'prefix' + 自己按 req.url 分发
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/_dsh/chudai-patrol',
    handler: async (req, res) => {
      const send = (code, body) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(body));
      };
      try {
        const url = String((req && req.url) || '');
        if (/\/run$/u.test(url)) {
          if ((req.method || 'GET') !== 'POST') { res.setHeader('allow', 'POST'); return send(405, { ok: false, error: 'method not allowed' }); }
          const body = (req && req.body) || {};
          return send(200, { ok: true, value: runPatrol({ skip: body.skip || [] }) });
        }
        if (/\/status$/u.test(url)) {
          return send(200, { ok: true, value: runPatrol({}) });
        }
        return send(200, {
          ok: true,
          name: 'chudai-patrol',
          version: VERSION,
          uptimeMs: Date.now() - startedAt,
          endpoints: ['/_dsh/chudai-patrol/status', '/_dsh/chudai-patrol/run'],
        });
      } catch (e) {
        return send(500, { ok: false, error: String((e && e.message) || e).slice(0, 300) });
      }
    },
  });

  ctx.effect(() => () => { try { dispose(); } catch (_) { /* 卸载失败不阻塞 */ } });

  // ── 工具 ──
  //   ★没声明 inject tools ⇒ 访问要用 try 包住（服务不存在时 cordis 会抛）
  let tools = null;
  try { tools = ctx.tools; } catch (_) { tools = null; }
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(PATROL_RUN_TOOL));
    ctx.effect(() => tools.register(PATROL_ONE_TOOL));
    (log.info || log.log)?.call?.(log, '[chudai-patrol] v' + VERSION + ' 已加载：2 工具 + 3 路由' + (coreError ? '（core 未加载：' + coreError + '）' : ''));
  } else {
    (log.warn || log.log)?.call?.(log, '[chudai-patrol] ctx.tools 不可用 ⇒ 工具未注册，路由仍在');
  }
}
