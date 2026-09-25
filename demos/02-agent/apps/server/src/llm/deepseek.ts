// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印不属于它，它保持安静才能在测试里被反复调用。
//
// 本文件是从 01-llm 复制过来的那个版本**重写**的结果：
// 复制版 import 了没被复制过来的 `@/llm/sse.ts`，在本步之前一直是红的。
// 这次改动删掉了全部流式代码（chatStream / 空闲超时 / SSE 解析，见 spec D5）：
// 本项目不做流式，而下个里程碑做「流式 + 工具」时，分片 tool_calls 的拼接
// 本来就要另写一套，留着只是重写前的负担。
//
// 仍然成立的取舍：**不读** `reasoning_content`（见下方 chat() 内的注释）。

import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { ChatOptions, Message, ChatResult, FinishReason, Tool, ToolCall } from '@/core/types.ts';

/**
 * 内部扁平的工具声明 → 线上的包装层级。
 *
 * 这两层形状是**故意不一样**的：
 *   - 线上的 `tools` 数组元素是 `{ type: 'function', function: { … } }`（OpenAI 约定）
 *   - 而 `core/types.ts` 里的 `Tool` 是扁平的 `{ name, description, parameters }`
 *
 * 内部保持扁平，是因为调用方（tools/registry.ts）只关心「这个工具叫什么、要什么参数」，
 * 外面那层 `type: 'function'` 目前只有一种取值、纯粹是协议规定的封装。
 * 把包装收敛在这一个函数里，将来协议变了只改这里。
 *
 * **已核实（2026-09-26，对照 DeepSeek API Reference 的 Create Chat Completion 页）**：
 * 线上层级确为 `{ type: 'function', function: { name, description, parameters } }`。
 * （另有 beta 的 `strict` 字段，我们不发。）响应侧是 `message.tool_calls`，元素含
 * `id` / `type` / `function.name` / `function.arguments`，且 `arguments` 是 JSON **字符串**；
 * 回喂用 `role: 'tool'` + `tool_call_id`。
 *
 * **不要图省事直接把 options.tools 发出去** —— 上游会 400 说结构不对，
 * 而报错信息里不会提到「少包了一层」。
 */
function toWireTools(tools: Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * 把响应里的 `tool_calls` 归一化成 `ToolCall[]`。
 *
 * 策略是**丢弃非法项、保留合法项**：模型给出的东西尽量用上，
 * 丢一条总比整轮不调工具强。
 *
 * 为什么必须校验：`id` 缺失会变成 `tool_call_id: undefined`，
 * `JSON.stringify` 时键被丢掉，下一轮请求直接 400，
 * 而那个报错信息完全不指向真正的原因。
 */
function normalizeToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];

  const calls: ToolCall[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const call = item as Record<string, unknown>;
    const fn = call.function;
    if (typeof call.id !== 'string') continue;
    if (typeof fn !== 'object' || fn === null) continue;
    const fnRecord = fn as Record<string, unknown>;
    if (typeof fnRecord.name !== 'string' || typeof fnRecord.arguments !== 'string') continue;

    calls.push({
      id: call.id,
      // type 归一化为 'function'：官方目前只有这一种，
      // 原样透出未知取值只会让下游多一层无意义的判断
      type: 'function',
      function: { name: fnRecord.name, arguments: fnRecord.arguments },
    });
  }
  return calls;
}

/**
 * 造一个调用 DeepSeek 接口的客户端。
 *
 * 它**无状态**（只持有 url 与 headers 两个闭包常量），所以一个实例
 * 可以被多个会话共享；「当前模型」随请求传（见 core/types.ts 的 ChatOptions）。
 */
export function createDeepSeekClient(config: LLMClientConfig): LLMClient {
  const url = `${config.baseUrl}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    // 鉴权：Bearer + API key。key 只来自环境变量，不落代码
    authorization: `Bearer ${config.apiKey}`,
  };

  return {
    async chat(messages: Message[], options?: ChatOptions): Promise<ChatResult> {
      // 用 Node 内置的 fetch，无需任何第三方 HTTP 库
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 有工具才带 tools 字段。**空数组按「不带」处理** ——
        // 部分 OpenAI 兼容实现会对 `tools: []` 直接 400，
        // 而「传了一个空列表」与「这次不传工具」在语义上本来就是一回事。
        //
        // 其余字段（temperature / thinking 等）跟随服务端默认值，不额外发送。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          ...(options?.tools && options.tools.length > 0
            ? { tools: toWireTools(options.tools) }
            : {}),
        }),
      });

      // 非 2xx（如 401 密钥错误、429 限流）统一当作失败抛出，
      // 交给调用方决定怎么显示。这一层不做自动重试（见 spec D20）。
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          // DeepSeek 的错误体是 JSON（形如 { error: { message } }），
          // 优先取出里面给人看的那句话；取不到就退回原始文本。
          // 官方未给出错误响应体的字段名，所以必须防御式处理。
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        // 抛裸 Error，消息里带状态码 —— HTTP 层靠这个前缀区分「上游返回了错误」
        // 与「连不上上游」（见 L5 的 http/errors.ts）
        throw new Error(`DeepSeek API error ${response.status}: ${detail}`);
      }

      // 响应形状大致是：
      // { choices: [ { message: { content, reasoning_content, tool_calls }, finish_reason } ] }
      const data = (await response.json()) as {
        choices: Array<{
          message?: { content?: string | null; tool_calls?: unknown };
          finish_reason?: string | null;
        }>;
      };
      const choice = data.choices[0];

      // 工具调用轮次里模型可能一个字都不说，content 缺省或为 null 都是正常的。
      // 这里把「没有正文」如实表示成 null，而不是兜底成 '' ——
      // 空串会让调用方分不清「模型说了空话」和「模型没说话只开了调用单」。
      //
      // 另外：刻意**不读** reasoning_content（模型的思考过程）。它通常比答案长得多，
      // 带进后续上下文既浪费 token 又可能干扰推理（对齐 01-llm 的 D6 / D22）。
      const content = choice?.message?.content ?? null;
      const toolCalls = normalizeToolCalls(choice?.message?.tool_calls);

      // finish_reason 缺失时按 stop；宽松处理，服务端新增取值时原样传出，不做白名单校验
      const finish_reason = (choice?.finish_reason ?? 'stop') as FinishReason;

      return {
        content,
        finish_reason,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    },
  };
}
