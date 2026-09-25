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

  const parsed = tokenize(expression);
  if (parsed === null || parsed.length === 0) {
    return { ok: false, reason: '表达式无法解析' };
  }

  // 上面已经把 null 排除掉了，但 TS 不会把这份收窄带进**被提升的函数声明**里：
  // parseExpr / parseTerm / parseFactor 是 function 声明，流分析对它们一律按
  // 声明类型 `Token[] | null` 看。这里做一次显式标注，让三个函数看到 `Token[]`。
  // 纯类型层的事 —— 擦除后的行为与之前完全一致。
  const tokens: Token[] = parsed;

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
