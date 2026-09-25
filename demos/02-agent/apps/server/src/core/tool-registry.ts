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
