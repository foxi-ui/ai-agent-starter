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
