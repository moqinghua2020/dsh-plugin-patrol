// ─────────────────────────────────────────────────────────────────────────────
// dsh-plugin-chudai-patrol · 客户端（设置页「巡检司」section）
//
// 布局：只挂 settings.section，不做右栏 tab（老板「不要占领聊天界面」）；
// 数据通道：host 暴露 /_dsh/chudai-patrol/status（GET），client same-origin fetch。
//   ★2026-11-01 修：原来写 /api/chudai-patrol ⇒ 面板 fetch 拿不到（/api 需认证，/_dsh 免认证）
//
// 渲染层铁律：宿主 React 18，组件 return h(...) 元素树，绝不 return 裸 DOM；
//   无 react 时走 DOM 降级。全 try-catch 不卡宿主。
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  if (typeof window === 'undefined') return;
  if (window.__chudaiPatrolClientLoaded) return;
  var loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') return;

  try {
    loader.load({
      id: 'dsh-plugin-chudai-patrol',
      factory: function (require) {
        try {
          var h = null, useState = null, useEffect = null;
          try {
            var React = require('react');
            h = React.createElement;
            useState = React.useState;
            useEffect = React.useEffect;
          } catch (_) { /* 无 react → DOM 降级 */ }

          var API = '/_dsh/chudai-patrol';

          function getJSON(p) {
            return fetch(API + p, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
          }

          var ICON = { ok: '✅', warn: '⚠️', fail: '❌', unknown: '❔' };
          var COLOR = { ok: '#22c55e', warn: '#f59e0b', fail: '#ef4444', unknown: '#6b7280' };

          function PatrolPanel() {
            var s1 = useState(null); var data = s1[0], setData = s1[1];
            var s2 = useState(false); var loading = s2[0], setLoading = s2[1];
            var s3 = useState(null); var err = s3[0], setErr = s3[1];

            function refresh() {
              setLoading(true); setErr(null);
              getJSON('/status')
                .then(function (j) { setData((j && j.value) ? j.value : j); })
                .catch(function (e) { setErr(String((e && e.message) || e).slice(0, 160)); })
                .then(function () { setLoading(false); });
            }

            useEffect(function () { refresh(); }, []);

            if (!h) {
              var el = document.createElement('div');
              el.style.cssText = 'font:12px system-ui,sans-serif;padding:12px 0;color:var(--dsw-alias-label-tertiary,#888)';
              el.textContent = '巡检司面板需要 React 环境';
              return el;
            }

            var children = [];
            children.push(h('div', { key: 'hdr', style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' } }, [
              h('span', { key: 't', style: { fontSize: '13px', fontWeight: 600 } }, '巡检司'),
              h('span', { key: 's', style: { fontSize: '11px', opacity: 0.6 } }, 'DSH 内部看门狗 · 6 项健康巡检'),
              h('button', {
                key: 'btn', onClick: refresh, disabled: loading,
                style: { marginLeft: 'auto', padding: '4px 12px', fontSize: '12px', cursor: 'pointer', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-secondary,#444)', background: 'transparent', color: 'inherit' },
              }, loading ? '检查中…' : '刷新'),
            ]));

            // ★★2026-11-01 加：诊断信息（让老板能看到到底卡在哪）★★
            children.push(h('div', { key: 'diag', style: { fontSize: '10px', color: '#888', padding: '2px 0' } },
              '诊断: API=' + API + ' | loading=' + loading + ' | data=' + (data ? '有' : '无') + ' | err=' + (err || '无')));

            if (err) {
              children.push(h('div', { key: 'err', style: { color: '#ef4444', fontSize: '12px', padding: '8px 0' } }, '连不上巡检接口：' + err));
            }

            if (data) {
              var sm = data.summary || {};
              var vc = COLOR[String(data.verdict || '').toLowerCase()] || '#6b7280';
              children.push(h('div', { key: 'sum', style: { display: 'flex', gap: '14px', fontSize: '12px', marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px solid var(--dsw-alias-border-secondary,#2a2a2a)' } }, [
                h('span', { key: 'v', style: { color: vc, fontWeight: 600 } }, data.verdict || '?'),
                h('span', { key: 'o' }, '✅ ' + (sm.ok || 0)),
                h('span', { key: 'w' }, '⚠️ ' + (sm.warn || 0)),
                h('span', { key: 'f' }, '❌ ' + (sm.fail || 0)),
                h('span', { key: 'u' }, '❔ ' + (sm.unknown || 0)),
              ]));

              // ★2026-11-01 加：压缩摘要（学自「告警降噪」）
              if (data.digest) {
                children.push(h('div', { key: 'digest', style: {
                  fontSize: '12px', padding: '6px 0 8px',
                  color: data.verdict === 'PASS' ? 'var(--dsw-alias-success,#3fb950)' : 'var(--dsw-alias-danger,#e05555)',
                } }, data.digest));
              }

              var rows = (data.checks || []).map(function (c) {
                return h('div', { key: c.id, style: { display: 'flex', gap: '8px', padding: '6px 0', fontSize: '12px', alignItems: 'flex-start' } }, [
                  h('span', { key: 'i', style: { width: '16px', flexShrink: 0 } }, ICON[c.level] || '?'),
                  // ★2026-11-01 加：severity 标签（P1/P2/P3）
                  h('span', { key: 'sev', style: {
                    width: '28px', flexShrink: 0, fontSize: '10px',
                    color: c.severity === 'P1' ? 'var(--dsw-alias-danger,#e05555)'
                         : c.severity === 'P2' ? 'var(--dsw-alias-warning,#d29922)'
                         : 'var(--dsw-alias-label-tertiary,#6f7885)',
                  } }, c.severity || ''),
                  h('span', { key: 'n', style: { width: '88px', flexShrink: 0, opacity: 0.75 } }, c.name),
                  h('span', { key: 'd', style: { flex: 1, opacity: 0.6 } }, c.detail),
                ].concat(c.runbook ? [
                  // ★2026-11-01 加：失败时显示「怎么修」（学自 Runbook 预置率）
                  h('div', { key: 'rb', style: { fontSize: '10px', color: 'var(--dsw-alias-label-tertiary,#6f7885)', paddingLeft: '52px', marginTop: '2px' } },
                    '→ ' + c.runbook),
                ] : []));
              });
              children.push(h('div', { key: 'rows' }, rows));

              if (data.note) {
                children.push(h('div', { key: 'note', style: { marginTop: '8px', fontSize: '11px', color: '#f59e0b' } }, data.note));
              }
              children.push(h('div', { key: 'ts', style: { marginTop: '10px', fontSize: '10px', opacity: 0.4 } }, '检查于 ' + (data.ts || '')));
            } else if (!loading) {
              children.push(h('div', { key: 'empty', style: { fontSize: '12px', opacity: 0.5 } }, '点「刷新」跑一次巡检'));
            }

            return h('div', { style: { padding: '4px 0' } }, children);
          }

          // ★2026-11-01 衡修：这里原来有两处会让壳崩
          //   ① require('@deepseek-ai/dsh-client').settings.section —— 这个模块在 rc.5 不存在
          //   ② factory 返回 { PatrolPanel: ... } 这种裸对象 —— 没有 apply
          //   ⇒ cordis 报 invalid plugin, expect function or object with an "apply" method,
          //      received object ⇒ web boot 挂 ⇒ 界面卡在 Loading plugins…（11:44 那次崩溃）
          //   ⇒ 改成 rc.5 的 slots 契约（照 skyeye 已验证写法）
          window.__chudaiPatrolClientLoaded = true;
          return {
            name: 'chudai-patrol-client',
            inject: ['slots'],
            apply: function (ctx) {
              window.__chudaiPatrolApply = (window.__chudaiPatrolApply || 0) + 1;
              // ★★2026-11-01 修（照 skyeye 已验证写法）★★
              //   病：直接用 ctx.slots，apply 执行时 slots 可能还没注入
              //   ★修法：ctx.inject(['slots'], cb) 异步等注入 + 兜底 ctx.slots
              try {
                ctx.inject(['slots'], function (native) {
                  var slots = native && native.slots;
                  try {
                    if (slots && typeof slots.inject === 'function') {
                      slots.inject('settings.section', function () {
                        slots.register({
                          name: 'settings.section',
                          id: 'chudai-patrol',
                          order: 93,
                          label: function () { return '巡检司'; },
                        }, PatrolPanel);
                      });
                    }
                  } catch (_) { /* 降级不卡宿主 */ }
                });
              } catch (_) {
                // ★兜底：直接拿 ctx.slots
                try {
                  var slotsF = ctx && ctx.slots;
                  if (slotsF && typeof slotsF.inject === 'function') {
                    slotsF.inject('settings.section', function () {
                      slotsF.register({
                        name: 'settings.section', id: 'chudai-patrol', order: 93,
                        label: function () { return '巡检司'; },
                      }, PatrolPanel);
                    });
                  }
                } catch (_) { /* 降级 */ }
              }
            },
          };
        } catch (e) {
          try { console.error('[chudai-patrol] client 加载失败:', e); } catch (_) {}
          // ★catch 里也必须返回合法插件对象（原来 return {} 一样会崩壳）
          return { name: 'chudai-patrol-client', inject: [], apply: function () {} };
        }
      },
    });
  } catch (e) {
    try { console.error('[chudai-patrol] loader.load 失败:', e); } catch (_) {}
  }
})();
