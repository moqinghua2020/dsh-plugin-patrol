# 巡检司（dsh-plugin-chudai-patrol）

> DSH 内部的看门狗 · 6 项健康巡检 + 面板 + 2 工具

---

## 一句话

**daemon-guardian 管「进程活着吗」，巡检司管「DSH 内部健康吗」。**

---

## 为什么需要（和 guardian 的分工）

| | daemon-guardian | 巡检司（本插件）|
|---|---|---|
| 形态 | 独立进程 | DSH 插件 |
| 生命周期 | 7x24，不依赖 DSH | 跟 DSH 走 |
| 管什么 | **进程活着吗** | **DSH 内部健康吗** |
| 会拉起吗 | ✅ 死了就拉起 | ❌ 只看不拉起 |

**⇒ 互补，不是替代。**

**看门狗的盲区**：它只能看「进程在不在」，看不出「进程活着但功能坏了」。
例：DSH 活着、插件加载失败、记忆 3 天没更新、工具全挂 —— 看门狗都说 OK。

---

## 6 项巡检

| # | 检查 | 判据 |
|---|---|---|
| ① | **插件加载** | profile package.json 声明的插件是否都在 node_modules |
| ② | **会话健康** | sessions 目录有没有 0 字节的最近文件 |
| ③ | **记忆新鲜度** | RESUME.md 多久没更新（>24h fail，>4h warn）|
| ④ | **工具可用性** | check-all --brief 能不能过 |
| ⑤ | **看门狗状态** | guardian 进程活着吗 + 日志末行 |
| ⑥ | **daemon 状态** | 阴阳 daemon 活着吗 + state 多久没更新 |

---

## 两种用法

### 1. 模型工具

```
patrol_run         跑一次完整巡检（6 项）
patrol_one --id=X  只跑某一项（plugins|sessions|memory|tools|guardian|daemon）
```

### 2. 面板

**设置页 → 巡检司**

显示：
- 总裁决（PASS / WARN / FAIL / UNKNOWN）
- 6 项逐条状态（✅⚠️❌❔）+ 详情
- 刷新按钮

---

## 三值不塌缩

**4 种状态，不是 2 种：**

| 状态 | 含义 |
|---|---|
| ✅ ok | 检查了，没问题 |
| ⚠️ warn | 检查了，有隐患 |
| ❌ fail | 检查了，有问题 |
| **❔ unknown** | **查不了（不是通过！）** |

**⇒ unknown 绝不混进 ok。** 这是 R17「取不到前置 = skip，绝不判绿」的实践。

---

## 诚实边界（NOT_COVERED）

| 项 | 说明 |
|---|---|
| **只看不改** | 要修走 heal / 青天闸 |
| **DSH 停了本插件也停** | 所以它救不了 DSH 本身（那是 guardian 的事）|
| **检查可能误报** | 每项都标注判据，看 detail 自己判断 |
| **不验 UI** | 自检不验「面板能不能渲染」（那要真浏览器）|
| **不验加载** | 自检不验「插件能加载」（那要重启 DSH）|

---

## 自检

```bash
node selftest.cjs
```

**8/8 通过**（6 阳性 + 2 阴性）。

---

## 装/卸

**装**（已完成）：
1. `junction: ~/.dsh/profiles/desktop/node_modules/dsh-plugin-chudai-patrol → G:/chudai-repo/dsh-plugin-chudai-patrol`
2. profile package.json 加 `dsh-plugin-chudai-patrol: link:G:/chudai-repo/dsh-plugin-chudai-patrol`
3. `~/.dsh/cordis.patch.yml` 加 insert 块

**卸**：
- 临时停：`cordis.patch.yml` 里该条目加 `disabled: true`
- 彻底删：删 junction + 删 package.json 依赖 + 删 patch 条目

---

## 文件结构

```
dsh-plugin-chudai-patrol/
├── package.json          # dsh.host / dsh.client / dsh.bundle
├── index.mjs             # 宿主入口（2 工具 + 2 路由）
├── client.js             # 面板（设置页 section）
├── cordis.patch.yml      # 挂载声明
├── core/patrol.cjs       # 核心巡检逻辑（6 项）
├── selftest.cjs          # 自检（8/8）
└── README.md             # 本文件
```
