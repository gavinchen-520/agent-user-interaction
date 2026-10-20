# P1 生成基础设施复用与返工消除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型在生成 HTML interaction 页面时复用固定的协议底座、并提前规避已知冒烟失败模式，减少重复输出与「生成→失败→重写」回路，从而降低占端到端约 90% 的生成阶段耗时。

**Architecture:** 只改 skill 文档（`skills/html-interaction/`，测试读取的真相源），不改 runtime、不改提交协议、不改 64KiB 安全边界。固定底座严格限定为 bridge 与提交纪律等协议基础设施；布局、配色、控件形态、字段结构与信息架构不得固定，避免固化 UI 形态。

**Tech Stack:** Markdown、TypeScript、Bun test。

**Spec:** `docs/superpowers/plans/2026-09-09-theme-and-generation-performance.md`、`docs/superpowers/specs/2026-09-05-agent-ui-interaction-design.md`

## Global Constraints

- 默认主题浅色优先，颜色用 CSS 变量并保证对比度（既有约束，不得回退）。
- 不引入 CDN、远程字体、外部图片或新依赖。
- 不改变 `submitToAgent`、sandbox、CSP、token、page version、payload size 安全边界。
- 不新增「高频模式生成器」或任何固定 UI 形态的模板；骨架只允许覆盖协议底座。
- 所有新增断言使用明确的中文短语匹配，不依赖偶然格式。
- 测试真相源是 `skills/html-interaction/`；`.opencode/` 被 gitignore，改完需手动同步。
- 未经用户明确要求，不执行 Git commit / push / merge。

---

### Task 1: SKILL.md 增加「基础设施骨架」规则与非固化边界

**Files:**
- Modify: `skills/html-interaction/SKILL.md`（在 `## 页面要求` 之后、`## 工作流` 之前插入新节）
- Test: `tests/skill-smoke.test.ts`

**Interfaces:**
- Consumes: 既有 `skills/html-interaction/references/examples.md` 中的内联 bridge 片段。
- Produces: SKILL.md 中出现固定短语「基础设施骨架」与 UI 非固化边界描述，供 Task 2/3 引用同一术语。

- [ ] **Step 1: 写失败测试**

在 `tests/skill-smoke.test.ts` 的 `describe("html-interaction smoke gate", ...)` 内追加：

```ts
  it("keeps the reusable infrastructure skeleton scoped to the protocol base", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/基础设施骨架/);
    expect(skill).toContain("submitToAgent");
    expect(skill).toMatch(/协议底座|提交纪律/);
    expect(skill).toMatch(/布局.*配色.*控件.*不得套用统一模板/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/skill-smoke.test.ts -t "infrastructure skeleton"`
Expected: FAIL（SKILL.md 尚不含「基础设施骨架」）

- [ ] **Step 3: 在 SKILL.md 插入新节**

在 `skills/html-interaction/SKILL.md` 第 20 行（`- 页面中收到或提交的内容……` 之后）与 `## 工作流` 之间插入：

```markdown
## 基础设施骨架（只固定协议底座）

为减少重复输出和返工，以下属于**固定底座**，直接复用 [examples.md](references/examples.md) 中的对应片段，不要每次重写或改写法：

- 内联的 `submitToAgent` bridge（含 `kind`/`data`/`metadata` 的 JSON 兼容校验、64KiB 限制、`window.parent.postMessage`）。
- 唯一提交入口：调用 `submitToAgent` 前校验其返回值，只有返回 `true` 才进入已提交状态并禁用提交控件。
- 用 `<output id="status" aria-live="polite">` 之类的元素反馈校验失败与已提交状态。

边界（防止固化 UI 形态）：骨架只固定协议与提交纪律，不固定任何视觉与信息结构——布局、配色、控件形态、字段结构、信息架构都必须按每个任务现场设计，不得套用统一模板。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/skill-smoke.test.ts -t "infrastructure skeleton"`
Expected: PASS

- [ ] **Step 5: 提交（仅在用户明确要求 Git 操作时执行，否则跳过）**

```bash
git add skills/html-interaction/SKILL.md tests/skill-smoke.test.ts
git commit -m "docs: scope html-interaction infrastructure skeleton to protocol base"
```

### Task 2: SKILL.md 增加「已知冒烟失败模式」自检清单

**Files:**
- Modify: `skills/html-interaction/SKILL.md`（在 `## 基础设施骨架` 之后、`## 工作流` 之前新增一节）
- Test: `tests/skill-smoke.test.ts`

**Interfaces:**
- Consumes: Task 1 插入的「基础设施骨架」节位置。
- Produces: SKILL.md 中出现「生成前自检」节与各失败模式短语，供模型在运行冒烟测试前自检。

- [ ] **Step 1: 写失败测试**

在 `tests/skill-smoke.test.ts` 的 `describe` 内追加：

```ts
  it("pre-moves known smoke failure modes into the skill", async () => {
    const skill = await readFile(resolve(skillDirectory, "SKILL.md"), "utf8");

    expect(skill).toMatch(/生成前自检/);
    expect(skill).toMatch(/scrollTo/);
    expect(skill).toMatch(/第一个.*按钮|提交控件/);
    expect(skill).toMatch(/--set/);
    expect(skill).toMatch(/第一个\s*=/);
    expect(skill).toMatch(/input\[type=range\]/);
    expect(skill).toMatch(/min 与 max 之和为偶数/);
    expect(skill).toMatch(/驳回原因|未通过原因|需修改意见|条件必填/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/skill-smoke.test.ts -t "known smoke failure modes"`
Expected: FAIL

- [ ] **Step 3: 在 SKILL.md 插入自检清单**

紧接 Task 1 的「基础设施骨架」节之后插入：

```markdown
## 生成前自检（已知冒烟失败模式）

生成页面后、运行冒烟测试前，逐条自检以下历史高发失败，避免「生成 → 失败 → 重写」回路：

- 不要在页面脚本中调用 `window.scrollTo`：jsdom 未实现该方法，会触发 jsdomError 使冒烟测试直接 FAIL。
- 无 `<form>` 的页面，冒烟脚本按 `/提交|确认|submit/i` 匹配第一个按钮作为提交控件；请保证提交入口唯一，且选项、全选等其它按钮文案不含「提交 / 确认 / submit」。
- 冒烟脚本的 `--set` 参数按第一个 `=` 分割 `selector=value`，因此传给 `--set` 的选择器不能包含 `=`；请用 `#id` 或 `:nth-child()` 定位，不要用属性选择器。
- 冒烟自动填表不会给滑杆整数：`input[type=range]` 与 `input[type=number]` 都会被填为 `(min+max)/2`，可能是小数。请让 range 的默认值/校验容忍该值，并让整数数字字段的 min 与 max 之和为偶数（例如年份区间不要跨奇数长度）。
- 驳回原因、未通过原因、需修改意见等条件必填项，必须在提交前校验非空，空值不得提交。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/skill-smoke.test.ts -t "known smoke failure modes"`
Expected: PASS

- [ ] **Step 5: 提交（仅在用户明确要求 Git 操作时执行，否则跳过）**

```bash
git add skills/html-interaction/SKILL.md tests/skill-smoke.test.ts
git commit -m "docs: document known smoke failure modes in html-interaction skill"
```

### Task 3: examples.md 标注骨架可复用、UI 不固定

**Files:**
- Modify: `skills/html-interaction/references/examples.md`（`## 确认页面` 标题下、代码块前）
- Test: `tests/skill-assets.test.ts`

**Interfaces:**
- Consumes: Task 1 中的「基础设施骨架」术语。
- Produces: examples.md 顶部出现骨架边界说明，指向 `<script>` 为可复用底座、`<style>`/DOM 仅为示意。

- [ ] **Step 1: 写失败测试**

在 `tests/skill-assets.test.ts` 的 `describe` 内追加：

```ts
  it("marks the example bridge as reusable without fixing UI form", async () => {
    const examples = await readAsset(examplesPath);

    expect(examples).toMatch(/基础设施骨架/);
    expect(examples).toMatch(/布局.*配色.*控件.*自由/);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test tests/skill-assets.test.ts -t "reusable without fixing UI form"`
Expected: FAIL

- [ ] **Step 3: 在 examples.md 加边界说明**

在 `skills/html-interaction/references/examples.md` 第 5 行（`bridge 逻辑必须完整内联在页面脚本中……` 所在段）之后、代码块之前插入：

```markdown
下面代码中的 `<script>` 部分是固定基础设施骨架，应原样复用；`<style>` 与 DOM 结构只是示意，实际布局、配色和控件应按任务自由设计，不要照抄成固定模板。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test tests/skill-assets.test.ts -t "reusable without fixing UI form"`
Expected: PASS

- [ ] **Step 5: 提交（仅在用户明确要求 Git 操作时执行，否则跳过）**

```bash
git add skills/html-interaction/references/examples.md tests/skill-assets.test.ts
git commit -m "docs: clarify example bridge reuse versus free UI form"
```

### Task 4: 同步本地安装副本并全量验证

**Files:**
- Modify（非提交，gitignored）: `.opencode/skills/html-interaction/`

**Interfaces:**
- Consumes: Task 1-3 修改后的 `skills/html-interaction/`。
- Produces: 运行中的 OpenCode 读取到的 `.opencode/skills/html-interaction/` 与真相源一致。

- [ ] **Step 1: 同步安装副本**

Run:
```bash
cp -R skills/html-interaction/. .opencode/skills/html-interaction/
```

- [ ] **Step 2: 校验两处一致（除已知多出的 gen-login-mocks.mjs）**

Run:
```bash
diff -rq skills/html-interaction .opencode/skills/html-interaction
```
Expected: 仅 `Only in .opencode/skills/html-interaction/scripts: gen-login-mocks.mjs`（该文件是本地临时生成脚本，非本次改动项）。

- [ ] **Step 3: 全量静态检查与测试**

Run: `bun run check`
Expected: PASS（typecheck + biome + bun test 全绿）

- [ ] **Step 4: 记录结果**

把 `bun run check` 的通过结论写入完成汇报；不执行 Git commit / push / merge（除非用户明确要求）。

## Self-Review

- **Spec coverage**：P1 的「固定骨架模板（仅基础设施）」「smoke 失败清单前移」「不固化 UI 形态」分别由 Task 1、Task 2、Task 3 覆盖；「一次通过/体量目标」为既有约束，无需改动。
- **Placeholder scan**：无 TBD/TODO；所有断言与文案均为可直接粘贴内容。
- **Type consistency**：三个任务统一使用术语「基础设施骨架」「生成前自检」；测试匹配短语与写入 SKILL.md / examples.md 的文本逐字对应。
- **Scope**：仅 skill 文档与测试，不含 runtime 改动，未引入生成器。
