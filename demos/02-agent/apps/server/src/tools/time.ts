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
