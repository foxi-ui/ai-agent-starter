// Agent 循环：把「调模型 → 执行工具 → 回喂 → 再调模型」这件事写成有界的循环。
//
// 两个函数，两种粒度：
//   runAgentTurn   —— 纯函数，只吃 messages、不改 Session，便于离线断言
//   runSessionTurn —— 薄薄一层编排，把一轮对话与 Session 的读写绑在一起
//
// **它只产出事实，不产出展示。** 本轮调了哪些工具、传了什么参、成没成功，
// 全都可以从 `added` 推导（见 presentation/transcript.ts）——
// 在这里额外返回一份「给人看的 steps」会让 agent 层的输出形状被界面需求塑形，
// 也会引入 `ms` 这类无法断言的字段。见 spec D4。

import type { ChatResult, Message, ToolResult } from '@/core/types.ts';
import type { LLMClient } from '@/llm/client.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { Session } from '@/core/session.ts';

/** 默认的最大步数。对应 guides「Agent 为什么会无限循环」—— 循环必须有界（spec D9） */
const DEFAULT_MAX_STEPS = 6;

/** 跑满步数时追加的提示语 */
const MAX_STEPS_NOTICE = '（已达最大步数，停止）';

/** 一轮对话的产出 —— 只有事实 */
export interface AgentTurn {
  /** 最终回答 */
  final: ChatResult;
  /** 本轮新追加的消息（assistant{tool_calls} + tool 结果 + 最终 assistant） */
  added: Message[];
  /** 循环是怎么结束的：拿到答案，还是跑满了步数 */
  stopReason: 'answered' | 'max-steps';
}

export interface AgentOptions {
  maxSteps?: number;
  /** 本次请求使用的模型；不传则由 client 用它构造时的默认值 */
  model?: string;
}

/** 解析模型给的参数串 */
function parseArguments(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // 把原文带回错误里 —— 模型据此才知道自己写歪在哪
    return { ok: false, error: `参数不是合法 JSON：${text}` };
  }
}

/** 工具结果 → 回喂给模型的那条 tool 消息的 content */
function toToolContent(result: ToolResult): string {
  if (!result.ok) return result.error;
  const json = JSON.stringify(result.value);
  // JSON.stringify(undefined) 返回 undefined 而不是字符串，
  // 而 tool 消息的 content 必须是非空字符串，否则下一轮请求 400
  return json === undefined ? 'null' : json;
}

/**
 * 跑一轮带工具的对话。
 *
 * **纯函数**：不修改传入的 `messages`，也不碰 `Session` ——
 * 要不要把 `added` 写进会话由调用方决定（见 runSessionTurn）。
 * 这样这个循环能在没有会话、没有网络的前提下被测透。
 */
export async function runAgentTurn(
  client: LLMClient,
  registry: ToolRegistry,
  messages: Message[],
  options: AgentOptions = {},
): Promise<AgentTurn> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  // 复制外层数组再往里面推，调用方的数组不受影响
  const working: Message[] = [...messages];
  const added: Message[] = [];
  const tools = registry.list();

  for (let step = 1; step <= maxSteps; step += 1) {
    const result = await client.chat(working, {
      tools,
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    // 判据是 **tool_calls 是否非空**，不是 finish_reason（spec D7）。
    // 有些 OpenAI 兼容实现会在 finish_reason: 'stop' 的同时返回 tool_calls ——
    // 若看 finish_reason，就会漏调工具、把 content: null 当成最终答案
    // 回给用户（前端会显示一个空气泡），而且不报任何错。
    const toolCalls = result.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const message: Message = { role: 'assistant', content: result.content };
      working.push(message);
      added.push(message);
      return { final: result, added, stopReason: 'answered' };
    }

    // 先把「模型要调工具」这件事记进数组：下一步请求必须带上它，
    // 否则后面那条 tool 消息没有任何东西可以挂在上面，API 会直接 400
    const assistantMessage: Message = {
      role: 'assistant',
      content: result.content,
      tool_calls: toolCalls,
    };
    working.push(assistantMessage);
    added.push(assistantMessage);

    // 一轮里可能有多个调用，按序逐个执行、每个各回一条 tool 消息
    for (const call of toolCalls) {
      const parsed = parseArguments(call.function.arguments);

      let outcome: ToolResult;
      if (!parsed.ok) {
        // 参数非法**不执行工具**，直接把解析错误当成工具结果回喂 ——
        // 让模型看到自己写歪的 JSON，自行改一版
        outcome = { ok: false, error: parsed.error };
      } else {
        try {
          outcome = await registry.execute(call.function.name, parsed.value);
        } catch (error) {
          // 工具抛异常也**不崩**：兜底成错误文本（spec D8）。
          // 这是「兜底」发生的唯一一处。
          outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      const toolMessage: Message = {
        role: 'tool',
        tool_call_id: call.id,
        content: toToolContent(outcome),
      };
      working.push(toolMessage);
      added.push(toolMessage);
    }
  }

  // 跑满步数仍未收敛。追加一条**带正文的** assistant 再返回 ——
  // 不能留一条只有 tool_calls 的消息在末尾，那样的历史对 API 是非法的（spec D9）。
  const notice: Message = { role: 'assistant', content: MAX_STEPS_NOTICE };
  working.push(notice);
  added.push(notice);

  return {
    final: { content: MAX_STEPS_NOTICE, finish_reason: 'length' },
    added,
    stopReason: 'max-steps',
  };
}

/**
 * 在某个会话上跑一轮：写 user、跑循环、成功后再把结果写回会话。
 *
 * **这三行的顺序是语义，不是风格**（spec §8）：
 *
 * 1. `append('user', …)` 必须在 `toMessages()` **之前** —— 反过来的话，
 *    用户这句话根本没被发出去，而循环照样跑、照样有回答，只是答的是上一轮的问题。
 * 2. `appendAll(added)` 必须在**成功之后** —— 否则失败轮次会留下一条
 *    **伪造的 assistant 回答**（对齐 01-llm 的 D7，也是 spec §13 的「提交原子性」）。
 *
 * 为什么单独一层而不是让 HTTP 路由写这三行：路由的职责是状态码与 JSON 形状，
 * 不是对话时序。把顺序敏感的语句内联进 async handler，是把 agent 语义
 * 与 HTTP 语义搅在一起 —— 写反了不会报错，只会静默丢消息或留下伪造的回答。
 */
export async function runSessionTurn(
  session: Session,
  client: LLMClient,
  registry: ToolRegistry,
  question: string,
  options: { systemPrompt: string; maxSteps?: number },
): Promise<AgentTurn> {
  session.append('user', question);

  const turn = await runAgentTurn(client, registry, session.toMessages(options.systemPrompt), {
    model: session.model,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
  });

  session.appendAll(turn.added);
  return turn;
}
