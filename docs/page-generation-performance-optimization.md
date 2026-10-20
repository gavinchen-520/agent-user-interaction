# agent-user-interaction 页面生成性能分析与优化方案

> 状态：**Superseded（历史分析）**。本文分析的插件耗时日志埋点已在后续清理中从代码移除，结论保留作历史参考；P1/P2/P3 的页面瘦身与骨架页优化仍然有效。
>
> 目标读者：后续接手优化的开发者。

## 1. 背景与问题

用户体感：从发出提示词到交互页面可用，等待时间偏长（实测约 25–34 秒）。

现有插件日志（`.opencode/agent-user-interaction.log`）中的 `generateHtml` 阶段**不能代表真实生成耗时**：它只测量「assistant 消息创建 → `create_html_session` 工具开始执行」这一小段（最后一步模型调用的等待），既不含模型逐字输出 HTML 的时间，也不含多步骤推理与工具往返。

本文件基于 opencode 会话数据库重新做了端到端归因，并给出优化方向与分阶段计划。

## 2. 测量方法与口径

### 2.1 真实端到端耗时

opencode 的会话消息与 part 明细存放在 SQLite 库 `~/.local/share/opencode/opencode.db`（表 `message`、`part`，`part.data` 为 JSON，含 `time.start/end`）。

- **端到端耗时** = 用户消息 `message.time_created` → `create_html_session` 工具 part 开始执行。
- **写 HTML** = `write` 工具的 part 执行时长（模型把整段 HTML 作为工具参数流式输出）。
- **模型推理** = 该轮内所有 `reasoning` part 的 `time.end - time.start` 之和。
- **其他工具** = `bash`（含冒烟测试）/`read`/`glob`/`grep` 等执行时长之和。
- **未计部分** = 端到端 − 上述工具 − 推理，即模型首 token 等待与步间延迟。

### 2.2 插件日志口径（仅作参考）

日志每次 `create_html_session` 写 5 条记录：

| phase | 含义 | 实测均值 | 范围 |
|---|---|---|---|
| `generateHtml` | assistant 消息创建 → 工具开始执行（最后一步） | 1872.7 ms | 825–4881 ms |
| `createSession` | 插件内部创建会话 | 1.6 ms | 0.58–4.06 ms |
| `openBrowser` | 拉起浏览器 | 55.9 ms | 48.3–65.3 ms |
| `pageReady` | 等待 iframe 就绪回传 | 122.9 ms | 89.1–163.6 ms |
| `total` | 工具内部总耗时（不含 `generateHtml`） | 180.8 ms | 143.5–231.4 ms |

结论：插件与浏览器侧合计约 180 ms，**在总耗时中占比可忽略**；`generateHtml` 也不能代表生成耗时。

## 3. 实测数据（最近 3 个页面）

| 任务 | 端到端 | 写 HTML | 模型推理 | 冒烟/读文件 | 插件+浏览器 | 页面字节 |
|---|---|---|---|---|---|---|
| 闲置服务器处置确认 | 34.1 s | 13.3 s | 10.2 s | 1.5 s | 0.5 s | 18368 |
| 慢查询处置确认 | 25.1 s | 10.8 s | 7.7 s | 0.9 s | 0.5 s | 16157 |
| 差旅报销审批 | 26.8 s | 14.0 s | 5.9 s | 0.7 s | 0.5 s | 19303 |
| **均值** | **28.7 s** | **12.7 s (44%)** | **8.0 s (28%)** | ~1.0 s (4%) | ~0.5 s (2%) | ~17900 |

另有约 **24%** 为「步间模型延迟」（每步首 token 等待、工具结果回灌后的处理），未计入推理。

## 4. 耗时归因结论

真实耗时由模型侧三座大山主导：

1. **模型逐字输出 HTML（44%）** —— 每次约 12.7 s，与页面字节数近似线性。
2. **模型推理/规划（28%）** —— 每次约 8 s，用于理解任务、设计布局、规划控件。
3. **步间模型延迟（24%）** —— 每次约 6.9 s，来自 7–8 个模型步骤各自的首 token 等待。

插件、浏览器、冒烟测试、文件读写合计 < 6%。

> 说明：以上为单会话 3 个样本的归因，结论方向可信；具体百分比存在样本波动。

## 5. 优化方向

### 5.1 方向 A：减少模型必须输出的 HTML 体积（对应 44%，收益最大）

现状：每个页面都从零重写约 1.6 KiB 的 submit-bridge、4–6 KiB 的定制 CSS，再写业务结构；15–19 KiB 中相当比例是每次都重复的样板。

| 编号 | 措施 | 说明 | 预计收益 |
|---|---|---|---|
| A1 | **模板注入** | 插件提供 `template.html`（bridge + 设计变量 + 常用组件），模型只输出「业务 body + 页面脚本」，创建时由插件拼装 | 输出量约减半 |
| A2 | **共享样式表** | 约定紧凑工具类 CSS 放入模板/技能，禁止每页自造 CSS | 省 2–4 KiB |
| A3 | **数据驱动渲染** | 列表用 JS 从紧凑数据数组渲染，而非重复 DOM 节点 | 稳定小幅收益 |

预计：页面输出 18 KiB → 11 KiB 左右，写 HTML 从 12.7 s 降到约 8 s。

### 5.2 方向 B：减少模型步骤数与往返（对应 24% 步间延迟 + 部分推理）

现状每次生成约 7–8 个模型步骤：加载 skill → 读 protocol → 读 bridge → 读 examples → `bash` 探测 → 再读 → `write` 写 HTML → `bash` 冒烟测试 → `create_html_session`。

| 编号 | 措施 | 说明 | 预计收益 |
|---|---|---|---|
| B1 | **冒烟校验内联进 `create_html_session`** | 由插件在创建时校验 HTML 合法性并返回结构化错误，省掉一次独立 `bash` 步骤和整轮模型往返 | 省 1–2 s |
| B2 | **精简技能文档** | bridge 直接内联进 SKILL.md 或模板，避免反复读取 `examples.md`/`bridge.js` | 省 0.5–1 s |
| B3 | **内联传 HTML** | 用 `create_html_session({ html })` 代替 `write 文件 → htmlFile`，页面 <64 KiB 时可行，省一次 Write 往返和一个模型步骤 | 省 1–2 s |

预计合计再省约 2–4 s。B1 与 B3 需一起设计（冒烟测试原依赖文件）。

### 5.3 方向 C：体感优化（总时长不变，但观感质变）

| 编号 | 措施 | 说明 | 代价 |
|---|---|---|---|
| C1 | **骨架页先行** | 收到任务先 `create_html_session` 打开带「正在生成…」的骨架（<1 s 可见），完成后再 `update_html_session` 填真内容；依赖 wrapper 实时刷新（已实现） | 多一次 update，实际总时长略增 |
| C2 | **分阶段渲染** | 页面先渲染标题与结构，数据后填 | 页面逻辑变复杂 |

C1 可将首屏可见从约 29 s 降到 <2 s，是**性价比最高的体感杠杆**。是否接受取决于更在意「总时长」还是「首屏可见」。

### 5.4 方向 D：模型与缓存层

| 编号 | 措施 | 说明 |
|---|---|---|
| D1 | 换更快模型 / 调整输出限速 | 对比同量级更快模型 |
| D2 | 提升提示缓存命中 | 保持技能与模板内容稳定，确保 cache read 命中 |
| D3 | 拆分模型 | 大模型规划、小模型填模板，压缩推理那 28% |

## 6. 分阶段实施计划

| 阶段 | 动作 | 预期收益 | 风险 |
|---|---|---|---|
| P0 | 先加 `TTFP` 埋点（见第 7 节） | 无（建立度量基线） | 低 |
| P1 ✅ | A1 收窄为「插件注入 bridge + 可选令牌」（见 6.3）；A2/A3 经字节实测否决 | 实际约 −10%（≈1–1.5 s） | 中：改技能契约与注入机制 |
| P2 ✅ | B1 冒烟校验内联 + B3 内联传 HTML | 实际再 −5%~15%（约 2–4 s） | 中：改插件工具与技能流程 |
| P3 | C1 骨架页先行 | 首屏 <2 s（体感质变） | 低：仅增加一次 update |
| P4 | D 模型/缓存调优 | 视情况 | 低 |

推荐顺序：**P0 → P3（低风险、体感立竿见影）→ P1（收益最大）→ P2 → P4**。

> 收益百分比为基于本次测量的**估算**，须以 P0 埋点后的 A/B 复测数据为准。

### 6.1 P3 实施记录（已完成）

P3 的隐藏前置是「`update_html_session` 后浏览器能自动刷新」；原架构不支持（只改内存/磁盘内容，wrapper 的 iframe `src` 固定，README/用例/e2e 原本都依赖手动刷新）。本次已补齐该前置并落地 P3：

- **实时刷新（前置能力）**：服务端新增 `GET /session/:id/version` 返回 `{ pageVersion, pageId }`；wrapper 每 700 ms 轮询该端点，发现 `pageVersion` 递增时同步更新 `config.pageVersion/pageId`、重置提交位并重载 iframe（`?v=<version>` 破缓存）。版本不同步会导致新页面提交被 `STALE_PAGE` 拒绝，因此三者必须一起更新。
- **骨架资产**：新增 `skills/agent-user-interaction/assets/skeleton.html`（固定展示资源，无提交入口）。
- **技能工作流**：`SKILL.md` 步骤 1 先 `create_html_session` 打开骨架，步骤 4 用 `update_html_session` 替换为真实页面；骨架为固定资源，**豁免冒烟测试**。
- **文档同步**：`README.md` 步骤 5、`docs/manual-test-cases.md` 用例 3 的「手动刷新」描述改为自动刷新，并新增用例 17。
- **测试**：`tests/browser/wrapper.test.ts` 增补轮询断言，`tests/runtime/server.test.ts` 增补 version 端点用例，`tests/e2e/agent-user-interaction.spec.ts` 改为验证自动刷新（移除手动 `page.reload()`）。

遗留：`firstPaint` 真实指标仍需 P0 埋点后才能验收。

### 6.2 P2 实施记录（已完成）

P2 = B1（冒烟校验内联）+ B3（内联传 HTML）。核心是不再让模型单独 `write` 工作文件再跑 `bash` 冒烟，改由插件在 create/update 时同步静态校验。

- **两级大小通道**：内联 `html` ≤ 64 KiB（快通道，默认）；`htmlFile` ≤ `storage.maxPageFileBytes`（默认从 10 MiB 收紧到 **3 MiB**）。内联超限抛结构化错误 `HTML_TOO_LARGE_FOR_INLINE`（含实际字节、内联上限、文件上限与处置建议），指引回退 `htmlFile`。
- **常量解耦**：`defaultMaxInlineHtmlBytes`（64 KiB，页面大小）/ `defaultMaxPayloadBytes`（64 KiB，提交回传）/ `defaultMaxPageFileBytes`（3 MiB，文件页面）三者独立，不再共用一个常量。
- **静态门禁单一源**：新增 `opencode-v1-aui/src/runtime/htmlValidation.ts`（`collectHtmlIssues`），在 `create_html_session`/`update_html_session` 中对内联与文件内容统一校验，命中 `type=submit`、`requestSubmit()`、本地存储、弹窗、`window.open`、网络请求等返回 `INVALID_HTML`（附 `[CODE]` 与 `action`）。
- **技能工作流**：主链路改为「骨架页 → `update_html_session({ html })` 内联提交」；`scripts/smoke-test.mjs` 退回 CI/开发自测（移除其重复静态规则，避免与插件漂移）。
- **测试**：新增 `tests/runtime/htmlValidation.test.ts`；`tests/tools/htmlSession*.test.ts` 覆盖内联超限、静态门禁、`htmlFile` 承载 >64 KiB；`tests/config.test.ts` 默认值改为 3 MiB；`tests/skill-smoke.test.ts` 改为校验「插件内联校验 + >64 KiB 回退」契约。

遗留：P2 的端到端收益（模型步骤数 7–8 → 5–6）仍需 P0 埋点后 A/B 复测验收。

### 6.3 P1 实施记录（已完成，瘦身版）

评审时用 `.opencode/html-sessions/` 真实页面做了字节构成实测（见下表），发现原计划的 A2/A3 收益被高估、且会收紧模型自由度，因此按"只注入不变量"原则瘦身实施。

| 页面 | 总字节 | CSS | 业务脚本 | bridge | body 结构 |
|---|---|---|---|---|---|
| expense-approval | 17573 | 5292 | 8306 | 1744 | 1977 |
| code-review-diff | 17925 | 4933 | 10494 | 1552 | 696 |

结论：真正每次都重复的样板只有 bridge（约 1.7 KiB，约 10%）；大头是任务专属业务脚本（约 50%）与专属 CSS，**A2"禁止自造 CSS"、A3"强制数据驱动渲染"收益低且伤开放性，已放弃**。

实际落地：
- **新增 `opencode-v1-aui/src/runtime/pageRuntime.ts`**：bridge 唯一真源（`submitBridgeSource`）+ 惰性可选令牌（`tokenStyleSource`，仅 `:root` 变量，无 reset/布局）+ `injectPageRuntime`。
- **触发条件**：仅当页面引用 `submitToAgent` 且未自带桥接实现时注入；骨架页等非交互页完全不改。
- **注入位置**：`<head>` 起始处，保证 bridge 先于任何模型脚本；缺失 head/html 时逐级回退。
- **字节口径**：`bytes` 仍统计模型原始输出（注入前），作为输出量优化指标；注入后的完整文档才交给 runtime（内存/磁盘模式一致）。
- **单一真源**：删除 `skills/agent-user-interaction/assets/submit-bridge.js`（含 `.opencode` 副本），桥接行为测试改为直接执行插件导出的 `submitBridgeSource`。
- **技能契约**：`SKILL.md`/`examples.md` 改为"页面只调用 `submitToAgent`，bridge 由插件自动注入"，并列出可选令牌；保持"不固定 UI 形态"边界。
- **测试**：新增 `tests/runtime/pageRuntime.test.ts`；`tests/tools/htmlSession.test.ts` 增补注入与字节口径用例；`skill-assets.test.ts`/`skill-smoke.test.ts` 同步契约。

预期收益（推断）：模型输出约降 10%（≈1–1.5 s），远低于原计划估算；A2/A3 的更大收益被否定。真实收益需 P0 埋点后 A/B 复测。

## 7. 度量与验收

### 7.1 新增 TTFP 埋点（建议）

当前日志漏测约 96% 的真实耗时。建议在 `index.ts` 记录 assistant 消息起点的同一处，额外记录**最近一条 user 消息的 `time.created`**，并在 `pageReady` 时输出：

```text
phase = "firstPaint"
durationMs = pageReadyAt - userMessageCreatedAt
```

这样每项优化都可用同一指标做前后对比，避免只看插件内部阶段造成误判。

### 7.2 复现端到端归因

复用本次分析方法，从 `~/.local/share/opencode/opencode.db` 读取 `message`/`part`，按「用户消息 → create_html_session」窗口统计各 part 时长与推理时长。验收标准：

- P1 后：写 HTML 平均时长下降 ≥25%，页面字节下降 ≥25%。
- P2 后：模型步骤数从 7–8 降到 5–6，端到端再降 ≥5%。
- P3 后：`firstPaint` < 2 s。

### 7.3 测试约束

按 `scenario-test-prompts.md` 约定：性能测试必须让模型**真正重新生成全新页面**，不得复用旧 session 页面，否则耗时数据失真。

## 8. 待决策项

1. ~~优先级：先做 P1（省真实耗时）还是 P3（省体感）？~~ 已定：P3 与 P1 均已实施。
2. ~~是否接受改技能契约（模型只写业务片段、插件注入模板）？~~ 已定：采用**瘦身版**——只注入 bridge 与可选令牌，不注入模板、不强制渲染方式（见 6.3）。
3. **待办**：是否先落地 TTFP 埋点（P0），使后续优化都有数据支撑？A2/A3 是否彻底关闭需 P0 复测后再确认。

## 9. 附：涉及文件

| 文件 | 作用 |
|---|---|
| `.opencode/agent-user-interaction.log` | 插件耗时日志（JSONL） |
| `opencode-v1-aui/src/tools/htmlSession.ts` | 工具入口，各 phase 埋点位置 + 运行时注入接线 |
| `opencode-v1-aui/src/runtime/pageRuntime.ts` | bridge 唯一真源 + 可选令牌 + `injectPageRuntime` |
| `opencode-v1-aui/src/observation.ts` | assistant 消息起点提取 |
| `opencode-v1-aui/src/index.ts` | 会话起点记录（TTFP 埋点建议加在此处） |
| `opencode-v1-aui/src/logging.ts` | TimingPhase 类型定义 |
| `skills/agent-user-interaction/SKILL.md` | 页面生成工作流（须同步 `.opencode` 运行副本） |
