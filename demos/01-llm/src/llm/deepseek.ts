// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印是 cli 层的职责。
// 保持安静，才能在测试里被反复调用而不产生多余输出。

import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { Message, ChatResult } from '@/core/types.ts';

/**
 * 造一个调用 DeepSeek 非流式接口的客户端。
 *
 * 「非流式」= 一次请求拿完整回答，不做 SSE 逐字返回
 * （流式属于后续增量）。
 *
 * @param config 包含 apiKey / baseUrl / model
 */
export function createDeepSeekClient(config: LLMClientConfig): LLMClient {
  // 在闭包里只算一次，避免每次请求都重复拼接字符串
  const url = `${config.baseUrl}/chat/completions`;

  return {
    async chat(messages: Message[]): Promise<ChatResult> {
      // 用 Node 内置的 fetch，无需任何第三方 HTTP 库
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // 鉴权：Bearer + API key。key 只来自环境变量，不落代码
          authorization: `Bearer ${config.apiKey}`,
        },
        // 请求体只传本次用到的两个字段；
        // stream / temperature 等都跟随服务端默认值，不额外发送
        body: JSON.stringify({ model: config.model, messages }),
      });

      // 非 2xx（如 401 密钥错误、429 限流）统一当作失败抛出，
      // 交给调用方决定怎么显示。这一层不做自动重试。
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          // DeepSeek 的错误体是 JSON（形如 { error: { message } }），
          // 优先取出里面给人看的那句话；取不到就退回原始文本
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        throw new Error(
          `DeepSeek API error ${response.status}: ${detail}`,
        );
      }

      // 响应形状大致是：
      // { choices: [ { message: { content, reasoning_content } } ] }
      // 这里故意只声明我们真正要用的字段
      const data = (await response.json()) as {
        choices: Array<{ message?: { content?: string } }>;
      };
      // 逐层可选链 + 兜底空串：任何一层缺失都返回 ''，而不是抛错。
      // 否则一个空回答就能让整个 REPL 崩掉。
      //
      // 另外：这里刻意不读 reasoning_content（模型的思考过程），
      // 它既不打印、也不会进入后续上下文。
      const content = data.choices[0]?.message?.content ?? '';
      return { content };
    },
  };
}
