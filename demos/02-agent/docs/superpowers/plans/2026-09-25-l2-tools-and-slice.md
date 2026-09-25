# L2 · 工具层与垂直切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**这是渐进步骤的第 2 步（共 6 步）。** 顺序与判据见 [`README.md`](./README.md)。
**前置：L1 已完成**（`Message` / `Session` / `LLMClient` 已就位）。

**Goal:** 建立**工具层** —— `core/tool-registry.ts` 声明接口，`tools/` 给出实现与三个具体工具；然后用一个**垂直切片**，在**完全不接模型**的前提下，手工把一次工具调用整条走通。

**这一步学到什么：**

1. **工具的「声明」与「实现」是两个东西。** 声明是发给模型看的说明书（`Tool`），实现是程序真跑的代码（`ToolDefinition.run`）。把它们放进同一个对象里是刻意的 —— 声明写错一个参数名，模型就会传错参数，而这两半分居两地时最容易写歪的正是它们的一致性。
2. **模型给的参数完全不可信。** `run(args)` 收到的 `args` 形状是模型编的，可能传字符串、传 `null`、干脆不传。**校验是每个工具自己的责任**，校验不过要返回 `{ok:false}` 而不是抛异常。
3. **模型从不执行任何函数。** 这是本步最重要的一句。垂直切片会把「解析参数 → 派发 → 执行 → 拼回消息」全部手工做一遍，让你看清：模型只输出了一段文字，干活的全是我们的程序。

**Architecture:** `tools → core` 单向依赖 —— 工具层**一个字都不碰 LLM 层**。这个依赖方向是「本步能排在接模型之前」的全部依据（见 `README.md` 的说明）。接口在 `core/`、实现在 `tools/`，与 `LLMClient` 是同一个套路，于是 `core` 不必 import 任何具体工具，测试也能塞一个假注册表进去。

**Tech Stack:** Node 22、`node --test`；三个工具都不碰网络、不碰文件系统，可离线单测。

**Spec:** `../specs/2026-09-25-ai-chat-agent-web-design.md` 的 §6（工具层）；D10（weather 用确定性 mock）、D11（calculator 不用 `eval`）

## Global Constraints

以下约束对**每一个** Task 都生效，六份计划里都完整重复一遍。

- **Node ≥ 22**（本项目在 v22.23.2 验证），依赖原生类型擦除直接运行 `.ts`，服务端**不引入构建步骤**
- **不用需要「代码变换」的 TS 特性**（参数属性 / `enum` / `namespace` / 实验性装饰器）。
  判断标准：删掉所有类型标注后仍是合法 JS 的，才能用
- **只当类型用的导入必须写 `import type`**，否则擦除阶段无法识别，运行时抛
  「does not provide an export named …」而 `tsc --noEmit` 放行
- **`core/` / `llm/` / `tools/` / `presentation/` 零第三方依赖**，只用 `node:` 内置模块与全局 `fetch`
- **`http/` 层允许运行时依赖且必须登记**：当前唯一一条是 `express`（配套 `@types/express`）
- **依赖方向单向**：`http → presentation → core`、`http → core`、`http → llm`、`http → tools`、
  `core → llm`（仅 `import type`）、`tools → core`。
  **`core` 不 import `tools`**；**`presentation` 不 import `http`**
- `core/` / `llm/` / `tools/` / `presentation/` **不 import express**、不碰 `req` / `res`、
  **不写** `process.stdout` / `process.stderr`；**只有 `src/main.ts` 碰 `process`**
- **`core/types.ts` 里不许出现为了界面存在的字段**（判断标准：删掉它，浏览器上的东西会少一块吗？）
- 源码用 `@/` 指向 `src/`，且**必须配 `--import ./loader.mjs`**；`start` / `dev` / `test` 三个脚本都要带
- ESM（`"type": "module"`）；包管理器 pnpm
- **密钥只经环境变量**：`.env` 是占位符模板（入库），`.env.local` 存真实值（已 gitignore）
- **测试不依赖真实网络**；真实 API 冒烟手动单独跑，不进 `pnpm test`
- **不在 `test/` 下放非 `*.test.ts` 的文件**（裸 `node --test` 会匹配到它，静默撑大用例数）
- **每次提交前**：`pnpm run typecheck` 与 `pnpm test` 都必须绿。

  **⚠️ 例外：本步（L2，即 Task 3–4）期间它们仍然是红的。** 原因：`src/llm/deepseek.ts`
  是从 01-llm 原样复制过来的，它 `import { parseSse } from '@/llm/sse.ts'` 是**值导入**，
  而 `sse.ts` 按设计不复制 —— 它要到 **L3** 才被重写。所以本步：
  - **各 Task 自己的单文件测试是绿的**（`node --import ./loader.mjs --test test/<name>.test.ts`）
  - **全量 `pnpm test` 与 `pnpm run typecheck` 是红的**，红的是 deepseek 那一条链

  **本步不要去修它** —— 提前修等于把 L3 的工作做掉。**L3 一结束就该全绿。**

## Review Focus

以下几类输入/条件，spec 隐含要求它们正确、但任何单条任务的测试都不会自动覆盖。
**本步相关的两条：**

1. **工具声明与实现的一致性** —— 声明里的参数名与 `run` 里实际读的字段名必须一致。
   不一致的后果是模型永远传错参数，而报错在模型那侧（它只会反复重试），
   程序这侧一条错都不报。测试落点：Task 3 的各工具用例 + Task 4 Step 1 的 ①。
2. **参数形状不可信** —— 模型可能传 `null`、字符串、缺字段。期望行为：一律 `{ok:false}` + 错误文本，
   **不抛异常**（抛了也不致命，L4 会兜底，但那会让「兜底」发生在两处）。
   测试落点：Task 3 Step 2 的 `args 不是对象也不抛错`。

---

### Task 3: ToolRegistry 与三个工具

实现 spec §6 的全部内容：`core/` 里的**接口** + `tools/` 里的**实现与三个具体工具**。

**Files:**
- Create: `demos/02-agent/apps/server/src/core/tool-registry.ts`
- Create: `demos/02-agent/apps/server/src/tools/{weather,time,calculator,registry}.ts`
- Test: `demos/02-agent/apps/server/test/tools-{weather,time,calculator,registry}.test.ts`

**Interfaces:**
- Consumes: L1 的 `Tool` / `ToolResult`
- Produces: `ToolDefinition`（`declaration` + `run(args)`）；`ToolRegistry`（`list()` / `execute(name, args)`）；
  `createToolRegistry()`；`weatherTool` / `timeTool` / `calculatorTool`

- [ ] **Step 1: 写 `src/core/tool-registry.ts`**

```ts
// 工具注册表的**接口**。与 LLMClient 是同一个套路：
// 接口在 core、实现在 tools、调用方只认接口。
//
// 这样 core 层不需要 import 任何具体工具，测试也能塞一个假注册表进来。
// 将来接入 MCP 时，只给 tools/registry.ts 的实现加一个 mount()，
// 这个接口不用动，core 与 llm 更不用动。

import type { Tool, ToolResult } from '@/core/types.ts';

/**
 * 一个工具：**声明**（发给模型看）+ **实现**（真要执行时跑的代码）。
 *
 * 两者放一起是刻意的：声明说错一个参数名，模型就会传错参数，
 * 而这两半分隔两地时最容易写歪的就是它们的一致性。
 */
export interface ToolDefinition {
  declaration: Tool;
  /**
   * 执行工具。`args` 是**模型给的、解析过的**参数，形状不可信 ——
   * 参数校验是每个工具自己的责任（校验不过返回 `{ok:false}`，不要抛）。
   *
   * 真抛了也不致命：调用方（core/agent.ts）会兜底成 `{ok:false}` 回喂模型。
   */
  run(args: unknown): ToolResult | Promise<ToolResult>;
}

/** 工具注册表：core 只认这个接口 */
export interface ToolRegistry {
  /** 序列化成请求体里的 `tools` 字段 */
  list(): Tool[];
  /** 按名派发。名字不存在时返回 `{ok:false}`，不抛错 */
  execute(name: string, args: unknown): Promise<ToolResult>;
}
```

- [ ] **Step 2: 写失败测试（weather）**

`test/tools-weather.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { weatherTool } from '@/tools/weather.ts';

test('Beijing 命中内置表', async () => {
  const result = await weatherTool.run({ city: 'Beijing' });
  assert.deepStrictEqual(result, {
    ok: true,
    value: { city: 'Beijing', temperature: '25°C', condition: 'Sunny' },
  });
});

test('城市名大小写与首尾空白不影响命中', async () => {
  const result = await weatherTool.run({ city: '  beijing  ' });
  assert.strictEqual(result.ok, true);
});

test('未收录的城市返回兜底值并注明是模拟数据', async () => {
  const result = await weatherTool.run({ city: 'Mars' });
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { note?: string };
  assert.ok(typeof value.note === 'string' && value.note.includes('模拟数据'));
});

test('缺 city 参数返回 {ok:false} 而不是抛错', async () => {
  assert.strictEqual((await weatherTool.run({})).ok, false);
});

test('city 不是字符串返回 {ok:false}', async () => {
  assert.strictEqual((await weatherTool.run({ city: 42 })).ok, false);
});

test('args 不是对象也不抛错', async () => {
  assert.strictEqual((await weatherTool.run(null)).ok, false);
  assert.strictEqual((await weatherTool.run('Beijing')).ok, false);
});

test('声明里的 name 与 registry 注册名一致，required 标了 city', () => {
  assert.strictEqual(weatherTool.declaration.name, 'weather');
  assert.deepStrictEqual(weatherTool.declaration.parameters.required, ['city']);
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: FAIL —— `Cannot find module '@/tools/weather.ts'`

- [ ] **Step 4: 写 `src/tools/weather.ts`**

```ts
// 查天气 —— **确定性 mock**，不联网、不需要 key。
//
// 本阶段的学习目标是 tool calling 这条链路本身（模型怎么开调用单、
// 程序怎么执行、结果怎么回喂），不是「怎么调第三方天气 API」。
// 用一个内置小表把网络这个变量消掉，失败原因才能收敛到链路自己身上（spec D10）。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

/** 内置的「天气数据库」。键是小写城市名 */
const WEATHER_TABLE: Record<string, { temperature: string; condition: string }> = {
  beijing: { temperature: '25°C', condition: 'Sunny' },
  shanghai: { temperature: '28°C', condition: 'Cloudy' },
  shenzhen: { temperature: '31°C', condition: 'Thunderstorm' },
  hangzhou: { temperature: '27°C', condition: 'Light Rain' },
  chengdu: { temperature: '23°C', condition: 'Overcast' },
};

/** 未收录城市的兜底值 */
const FALLBACK = { temperature: '22°C', condition: 'Partly Cloudy' };

const declaration: Tool = {
  name: 'weather',
  description: '查询某个城市今天的天气。需要知道某地天气时使用。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名，例如 Beijing、Shanghai' },
    },
    required: ['city'],
  },
};

export const weatherTool: ToolDefinition = {
  declaration,

  run(args: unknown): ToolResult {
    // 参数形状不可信 —— 模型可能传字符串、传 null、干脆不传。
    // 校验不过就返回错误文本，它会作为 tool 消息回喂给模型，让它自己改。
    if (typeof args !== 'object' || args === null) {
      return { ok: false, error: '参数必须是对象，且包含 city 字段' };
    }
    const city = (args as { city?: unknown }).city;
    if (typeof city !== 'string' || city.trim() === '') {
      return { ok: false, error: '缺少 city 参数，或 city 不是非空字符串' };
    }

    const trimmed = city.trim();
    const hit = WEATHER_TABLE[trimmed.toLowerCase()];

    if (!hit) {
      // 兜底也要**明说是模拟数据** —— 否则模型会把编出来的天气当事实转述给用户
      return {
        ok: true,
        value: { city: trimmed, ...FALLBACK, note: '模拟数据：该城市不在内置表中' },
      };
    }

    return { ok: true, value: { city: trimmed, ...hit } };
  },
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/tools-weather.test.ts`
Expected: 全绿（7 条）

- [ ] **Step 6: 写 `src/tools/time.ts` 与它的测试**

`test/tools-time.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { timeTool } from '@/tools/time.ts';

test('返回可解析的 ISO 时间字符串', async () => {
  const result = await timeTool.run({});
  assert.strictEqual(result.ok, true);
  if (!result.ok) return;
  const value = result.value as { now?: unknown };
  assert.strictEqual(typeof value.now, 'string');
  assert.ok(!Number.isNaN(Date.parse(value.now as string)));
});

test('忽略任何多余参数', async () => {
  assert.strictEqual((await timeTool.run({ unexpected: 'ignored' })).ok, true);
});

test('声明没有 required 参数', () => {
  assert.strictEqual(timeTool.declaration.name, 'get_time');
  assert.strictEqual(timeTool.declaration.parameters.required, undefined);
});
```

`src/tools/time.ts`：

```ts
// 取当前时间。无参数，因此没有参数校验可做 ——
// 它存在的意义是演示「零参数工具」在 schema 里长什么样。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

const declaration: Tool = {
  name: 'get_time',
  description: '获取当前的日期与时间。需要知道「现在」时使用。',
  parameters: {
    type: 'object',
    properties: {},
  },
};

export const timeTool: ToolDefinition = {
  declaration,

  run(): ToolResult {
    // 这个工具**不纯**（每次调用结果都不同），测试只能断言格式，不能断言具体值
    return { ok: true, value: { now: new Date().toISOString() } };
  },
};
```

- [ ] **Step 7: 写失败测试（calculator）**

`test/tools-calculator.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { calculatorTool } from '@/tools/calculator.ts';

async function calculate(expression: string) {
  return calculatorTool.run({ expression });
}

function valueOf(result: Awaited<ReturnType<typeof calculate>>): number {
  assert.strictEqual(result.ok, true);
  return result.ok ? (result.value as { result: number }).result : NaN;
}

test('四则运算与优先级', async () => {
  assert.deepStrictEqual(await calculate('1 + 2 * 3'), {
    ok: true,
    value: { expression: '1 + 2 * 3', result: 7 },
  });
});

test('括号改变优先级', async () => {
  assert.strictEqual(valueOf(await calculate('(1 + 2) * 3')), 9);
});

test('小数与一元负号', async () => {
  assert.strictEqual(valueOf(await calculate('1.5 * 2')), 3);
  assert.strictEqual(valueOf(await calculate('-4 + 1')), -3);
});

test('除零返回 {ok:false}，且错误文本包含表达式原文', async () => {
  const result = await calculate('1 / 0');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 / 0'));
});

test('字母被白名单拦下', async () => {
  assert.strictEqual((await calculate('alert(1)')).ok, false);
});

test('分号、反引号与属性访问被白名单拦下', async () => {
  for (const expression of ['1; process.exit(1)', '`1`', '1 .toString()']) {
    assert.strictEqual((await calculate(expression)).ok, false, `应被拒绝：${expression}`);
  }
});

test('括号不配对返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('(1 + 2')).ok, false);
});

test('尾部有多余内容返回 {ok:false}', async () => {
  assert.strictEqual((await calculate('1 2')).ok, false);
});

test('缺 expression 参数返回 {ok:false}', async () => {
  assert.strictEqual((await calculatorTool.run({})).ok, false);
});

test('错误文本里带着表达式原文（模型据此才能改）', async () => {
  const result = await calculate('1 + ');
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('1 + '));
});
```

- [ ] **Step 8: 写 `src/tools/calculator.ts`**

```ts
// 四则运算计算器。
//
// **不用 eval / new Function。** 模型给的表达式是外部输入，
// 直接喂给 eval 等于把一个任意代码执行的口子开在最不该开的地方（spec D11）。
// 这里改成：白名单正则拦一道 → 手写词法 → 递归下降求值。
//
// 这道防线本身也是教学内容：工具的参数是「不可信输入」，
// 哪怕它看起来只是一个算式。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

/**
 * 白名单：只允许数字、四个运算符、括号、小数点与空白。
 *
 * 它是**第一道**防线，作用是快速拒绝明显危险的东西（字母、分号、反引号）。
 * 它不是唯一防线 —— 真正保证求值安全的是下面的递归下降求值器：
 * 它只会做加减乘除，即使白名单被绕过也执行不了别的东西。
 */
const ALLOWED = /^[0-9+\-*/(). \t]+$/;

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' | '(' | ')' };

/** 词法分析。遇到白名单内的意外字符返回 null */
function tokenize(expression: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;

    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }

    if (char === '+' || char === '-' || char === '*' || char === '/' || char === '(' || char === ')') {
      tokens.push({ kind: 'op', value: char });
      index += 1;
      continue;
    }

    // 数字：连续取 [0-9.]，交给 Number() 判断是否合法
    // （`1.2.3` 这种会被 Number 拒掉，所以这里不用自己写校验）
    if ((char >= '0' && char <= '9') || char === '.') {
      let literal = '';
      while (index < expression.length && /[0-9.]/.test(expression[index]!)) {
        literal += expression[index];
        index += 1;
      }
      const value = Number(literal);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: 'num', value });
      continue;
    }

    return null;
  }

  return tokens;
}

/** 求值结果：成功给数值，失败给原因 */
type EvalResult = { ok: true; value: number } | { ok: false; reason: string };

/**
 * 递归下降求值。文法：
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := factor (('*' | '/') factor)*
 *   factor := number | '(' expr ')' | '-' factor
 */
function evaluate(expression: string): EvalResult {
  if (!ALLOWED.test(expression)) {
    return { ok: false, reason: '表达式含不支持的字符（只允许数字、+ - * / ( ) 和空格）' };
  }

  const tokens = tokenize(expression);
  if (tokens === null || tokens.length === 0) {
    return { ok: false, reason: '表达式无法解析' };
  }

  let pos = 0;
  // 失败原因单独存：递归的每个分支都返回 number | null，
  // 用一个外部变量记住「具体为什么失败」，比到处传错误对象干净
  let reason = '表达式语法错误';

  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;

    while (true) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      pos += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = token.value === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;

    while (true) {
      const token = tokens[pos];
      if (token?.kind !== 'op' || (token.value !== '*' && token.value !== '/')) break;
      pos += 1;
      const right = parseFactor();
      if (right === null) return null;
      if (token.value === '/') {
        if (right === 0) {
          reason = '除数不能为 0';
          return null;
        }
        left /= right;
      } else {
        left *= right;
      }
    }
    return left;
  }

  function parseFactor(): number | null {
    const token = tokens[pos];

    if (token === undefined) {
      reason = '表达式意外结束';
      return null;
    }

    if (token.kind === 'num') {
      pos += 1;
      return token.value;
    }

    if (token.value === '-') {
      pos += 1;
      const inner = parseFactor();
      return inner === null ? null : -inner;
    }

    if (token.value === '(') {
      pos += 1;
      const inner = parseExpr();
      if (inner === null) return null;
      const close = tokens[pos];
      if (close?.kind !== 'op' || close.value !== ')') {
        reason = '括号不配对';
        return null;
      }
      pos += 1;
      return inner;
    }

    reason = `意外的符号：${token.value}`;
    return null;
  }

  const value = parseExpr();

  if (value === null) return { ok: false, reason };
  // 多余的 token 说明整串没被消费完，例如 `1 2`
  if (pos !== tokens.length) return { ok: false, reason: '表达式尾部有多余内容' };
  if (!Number.isFinite(value)) return { ok: false, reason: '计算结果不是有限数' };

  return { ok: true, value };
}

const declaration: Tool = {
  name: 'calculator',
  description: '计算一个四则运算表达式。只支持 + - * / 与括号，例如 (1 + 2) * 3。',
  parameters: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: '要计算的表达式，例如 1 + 2 * 3' },
    },
    required: ['expression'],
  },
};

export const calculatorTool: ToolDefinition = {
  declaration,

  run(args: unknown): ToolResult {
    if (typeof args !== 'object' || args === null) {
      return { ok: false, error: '参数必须是对象，且包含 expression 字段' };
    }
    const expression = (args as { expression?: unknown }).expression;
    if (typeof expression !== 'string' || expression.trim() === '') {
      return { ok: false, error: '缺少 expression 参数，或它不是非空字符串' };
    }

    const original = expression.trim();
    const result = evaluate(original);

    if (!result.ok) {
      // **错误文本必须带上表达式原文** —— 它是模型唯一的纠错线索。
      // 只说「表达式非法」的话，模型不知道该改哪里，只能反复重试同一个式子。
      return { ok: false, error: `无法计算「${original}」：${result.reason}` };
    }

    return { ok: true, value: { expression: original, result: result.value } };
  },
};
```

- [ ] **Step 9: 跑测试**

Run:
```bash
cd demos/02-agent/apps/server
node --import ./loader.mjs --test test/tools-time.test.ts
node --import ./loader.mjs --test test/tools-calculator.test.ts
```
Expected: 两个文件全绿（time 3 条、calculator 10 条）

- [ ] **Step 10: 写失败测试（registry）**

`test/tools-registry.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';

test('list() 返回三份工具声明', () => {
  const names = createToolRegistry()
    .list()
    .map((tool) => tool.name)
    .sort();
  assert.deepStrictEqual(names, ['calculator', 'get_time', 'weather']);
});

test('每份声明都有非空 description 与 object 类型的 parameters', () => {
  for (const tool of createToolRegistry().list()) {
    assert.ok(tool.description.length > 0, `${tool.name} 缺 description`);
    assert.strictEqual(tool.parameters.type, 'object');
  }
});

test('按名派发到对应工具', async () => {
  const result = await createToolRegistry().execute('weather', { city: 'Beijing' });
  assert.strictEqual(result.ok, true);
});

test('未知名返回 {ok:false} 而不是抛错', async () => {
  const result = await createToolRegistry().execute('no_such_tool', {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('no_such_tool'));
});

test('list() 每次返回新数组，外部改不动注册表', () => {
  const registry = createToolRegistry();
  registry.list().push({
    name: 'injected',
    description: 'x',
    parameters: { type: 'object', properties: {} },
  });
  assert.strictEqual(registry.list().length, 3);
});
```

- [ ] **Step 11: 写 `src/tools/registry.ts`**

```ts
// 工具注册表的实现。接口声明在 core/tool-registry.ts。
//
// 将来接入 MCP 时，在这个文件里加一个 mount()，把远端工具也塞进同一个 Map ——
// 接口不变、core 与 llm 不动。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition, ToolRegistry } from '@/core/tool-registry.ts';
import { weatherTool } from '@/tools/weather.ts';
import { timeTool } from '@/tools/time.ts';
import { calculatorTool } from '@/tools/calculator.ts';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  for (const definition of [weatherTool, timeTool, calculatorTool]) {
    tools.set(definition.declaration.name, definition);
  }

  return {
    list(): Tool[] {
      // 返回新数组：调用方 push 一下就能改到注册表，那不是我们希望的可变面
      return [...tools.values()].map((definition) => definition.declaration);
    },

    async execute(name: string, args: unknown): Promise<ToolResult> {
      const definition = tools.get(name);
      if (!definition) {
        // 名字不存在是**正常结果**而不是异常：模型可能编出一个不存在的工具名，
        // 错误文本回喂给它，它下一轮就会改用正确的名字
        return { ok: false, error: `未知工具：${name}` };
      }

      // 这里**不** try/catch —— 工具自己抛出的异常由 core/agent.ts 统一兜底，
      // 「兜底」只在一处发生，行为才不会随调用方而变
      return await definition.run(args);
    },
  };
}
```

- [ ] **Step 12: 跑全部工具测试**

Run:
```bash
cd demos/02-agent/apps/server
node --import ./loader.mjs --test test/tools-registry.test.ts
node --import ./loader.mjs --test test/tools-weather.test.ts
node --import ./loader.mjs --test test/tools-time.test.ts
node --import ./loader.mjs --test test/tools-calculator.test.ts
```
Expected: 四个文件全绿（registry 5 条 + weather 7 条 + time 3 条 + calculator 10 条 = 25 条）

**不要在这里跑 `pnpm run typecheck` 或 `pnpm test`** —— 它们是红的（deepseek 那条链，
见本文件 Global Constraints 的例外）。**L3 会把它修掉。**

- [ ] **Step 13: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/src/core/tool-registry.ts demos/02-agent/apps/server/src/tools \
        demos/02-agent/apps/server/test/tools-*.test.ts
git commit -m "feat(server): 新增 ToolRegistry 接口与 weather / get_time / calculator 三个工具"
```

---

### Task 4: 垂直切片 —— 不接模型，手工走一次工具调用

**这是 L2 存在的主要理由，也是「为什么工具层排在 LLM 层前面」的答案。**

L3 之后，「开调用单」由模型完成，很容易让人以为工具调用是「模型做了什么」。不是。
这个 Task 把模型的输出**手工写死**，让链路只剩程序这一半，一次看全六步：

```text
① 声明    registry.list() → 模型看到的说明书
② 开单    ToolCall{ id, function:{ name, arguments: "..." } }   ← 模型唯一的产出
③ 解析    JSON.parse(arguments) → 真正的参数
④ 派发    registry.execute(name, args) → { ok, value | error }
⑤ 序列化  JSON.stringify(value) → tool 消息的 content
⑥ 拼回    [ assistant{tool_calls}, tool{tool_call_id} ]
```

**它同时是真实的测试覆盖**：别的测试都用**假的**注册表（`agent.test.ts` 里的 `fakeRegistry`），
只有这一条把**真的** `createToolRegistry()` 串进去。`test/` 在本仓库约定「与被测模块一一对应」，
这份文件是**刻意的例外** —— 它测的不是某个模块，而是**模块之间的接缝**。

**Files:**
- Create: `demos/02-agent/apps/server/test/tool-call-walkthrough.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `createToolRegistry()`；L1 的 `Message` / `ToolCall`
- Produces: 无（只验证；这条链路的行为在 L4 会被 `core/agent.ts` 复用）

- [ ] **Step 1: 写 `test/tool-call-walkthrough.test.ts`**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';
import type { Message, ToolCall } from '@/core/types.ts';

/**
 * 垂直切片：**不接模型**，手工把一次工具调用走完。
 *
 * 这九条用例连起来读，就是 L4 那个循环体的一次迭代 ——
 * 先把一次迭代手工做对，再去写循环。
 *
 * 为什么不含「参数不是合法 JSON」那条：解析是**循环的职责**（见 L4 的
 * core/agent.ts），注册表拿到的永远是「已经解析好的参数」。这里不越位。
 */

const registry = createToolRegistry();

test('① 声明：模型看到的工具只是一份说明书，没有任何实现', () => {
  const weather = registry.list().find((tool) => tool.name === 'weather');
  assert.ok(weather);
  // description 是给模型看的 —— 它决定模型「知不知道什么时候该用这个工具」
  assert.ok(weather.description.length > 0);
  // parameters 是给模型看的参数规格 —— 它决定模型传什么名字的参
  assert.deepStrictEqual(weather.parameters.required, ['city']);
});

test('② 开单：模型的全部产出就是这张结构化的调用单', () => {
  // 关键在于：模型**没有执行任何东西**，它只是输出了这段文字结构。
  // 函数名与参数都是字符串，去执行的是我们。
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  // arguments 是 **JSON 字符串**而不是对象 —— 模型逐字生成文本，中途可能截断，
  // 所以它天然可能是非法 JSON（那一条由 L4 的循环负责兜底）
  assert.strictEqual(typeof toolCall.function.arguments, 'string');
});

test('③ 解析：把参数字符串 parse 成真正的参数', () => {
  const argumentsText = '{"city":"Beijing"}';
  const args = JSON.parse(argumentsText) as unknown;
  assert.deepStrictEqual(args, { city: 'Beijing' });
});

test('④ 派发：注册表按名字找工具，参数交给工具自己校验', async () => {
  const result = await registry.execute('weather', { city: 'Beijing' });
  assert.deepStrictEqual(result, {
    ok: true,
    value: { city: 'Beijing', temperature: '25°C', condition: 'Sunny' },
  });
});

test('⑤ 序列化：成功结果 stringify 之后才能放进 tool 消息', () => {
  // tool 消息的 content 必须是**字符串**，而上游 API 只认这一种形状
  const content = JSON.stringify({ city: 'Beijing', temperature: '25°C', condition: 'Sunny' });
  assert.strictEqual(content, '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}');
});

test('⑥ 拼回：两条消息，tool 那条靠 tool_call_id 认领调用单', () => {
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
    },
  ];

  // 少了 tool_call_id 这个字段，上游不知道这条结果在回应哪张单，直接 400。
  // 这就是 Message 必须是可辨识联合、而不能是扁平 interface 的原因（L1）。
  assert.strictEqual(messages[1]?.role === 'tool' ? messages[1].tool_call_id : null, 'call_1');
});

test('⑦ 失败路径：参数缺失时工具报错，而不是程序崩掉', async () => {
  const result = await registry.execute('weather', {});
  assert.strictEqual(result.ok, false);
  // 错误文本要能**指导模型改** —— 它只会照着自己看得懂的话改
  assert.ok(!result.ok && result.error.includes('city'));
});

test('⑧ 未知名工具：模型编出一个不存在的工具名，也是 {ok:false} 而不是抛错', async () => {
  const result = await registry.execute('get_weather', {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('get_weather'));
});

test('⑨ 连起来：这一串动作就是 L4 那个循环体的一次迭代', async () => {
  // 手工写死的「模型这一轮的产出」
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  // ② 解析参数
  const args = JSON.parse(toolCall.function.arguments) as unknown;
  // ③ 派发执行
  const result = await registry.execute(toolCall.function.name, args);
  // ④ 结果转成 tool 消息的 content
  const content = result.ok ? JSON.stringify(result.value) : result.error;
  // ⑤ 拼成两条要回喂给模型的消息
  const added: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: toolCall.id, content },
  ];

  assert.deepStrictEqual(added, [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
    },
  ]);
});
```

- [ ] **Step 2: 运行确认通过**

Run: `cd demos/02-agent/apps/server && node --import ./loader.mjs --test test/tool-call-walkthrough.test.ts`
Expected: 全绿（9 条）

**若 ⑦⑧ 挂了**：多半是 `execute` 里对未知名工具 throw 了而不是返回 `{ok:false}`。
契约在 Task 3 Step 1 的接口注释里：**名字不存在时返回 `{ok:false}`，不抛错**。

- [ ] **Step 3: 提交**

```bash
cd /Users/mawq/workspaces/ai-agent-starter
git add demos/02-agent/apps/server/test/tool-call-walkthrough.test.ts
git commit -m "test(server): 新增垂直切片，不接模型手工走通一次工具调用"
```

---

## L2 的验证：你这一步看见了什么

1. **跑工具层的四个测试文件 + 切片**（命令见 Task 3 Step 12 与 Task 4 Step 2）。
   Expected: 25 + 9 = **34 条全绿**。

2. **亲眼看见「模型不执行任何函数」** —— 重读 Task 4 的 ② 那条用例。
   整份文件里没有任何一处调用模型，而工具调用照样走通了。这就是证据。

3. **亲手试一次声明与实现不一致的后果**（可选，但很值）：
   把 `src/tools/weather.ts` 声明里的 `city` 改成 `cityName`（`properties` 与 `required` 两处都改），
   再跑 `test/tool-call-walkthrough.test.ts` 的 ④。
   Expected: ④ 仍然绿 —— 因为参数是你手工写的 `{city:'Beijing'}`，程序这边不会报任何错。
   **但这正是问题所在**：真接上模型后，模型会照着 `cityName` 传参，
   而 `run` 里读的是 `city`，于是永远 `{ok:false}`，模型只会反复重试。看完改回来。

4. **接受那条已知的红**：`pnpm test` 与 `pnpm run typecheck` 此刻仍然是红的
   （`src/llm/deepseek.ts` 那条链）。**下一份文档（L3）就是来修它的。**

**下一步** → [`l3-llm-client.md`](./2026-09-25-l3-llm-client.md)：把「这张单子从哪来」
从你手写换成模型给的，同时把那条一直红着的 `deepseek.ts` 重写掉。
