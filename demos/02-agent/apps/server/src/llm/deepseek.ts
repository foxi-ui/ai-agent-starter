// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印是 cli 层的职责。
// 保持安静，才能在测试里被反复调用而不产生多余输出。

import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { ChatOptions, Message, ChatResult, FinishReason, StreamEvent } from '@/core/types.ts';
import { parseSse } from '@/llm/sse.ts';

/**
 * 流式空闲超时：两个 chunk 之间的最大间隔。
 *
 * 为什么流式必须有它：非流式卡住是「整个请求没响应」，用户明确知道在等；
 * 流式已经打印了半句话然后停住，用户无法区分「模型在想」和「连接死了」。
 *
 * 它覆盖的是「**响应头之后的**首字节」——计时器在拿到 `response.body` 之后才建立，
 * `await fetch(...)` 之上没有本项目的时限（见 `DECISIONS.md` D21；真正的首字节超时归 M6）。
 *
 * 为什么不用单一总时长包住整个流：长回答会被误杀（见 DECISIONS.md D21）。
 */
const STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * 等下一个 chunk，超过 `timeoutMs` 没有数据就抛错。
 *
 * 单独抽出来是因为「超时」必须作用在**每一次读取**上，
 * 而不是整个流的总时长。
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`流空闲超时（${timeoutMs / 1000}s 无数据），已中断`));
    }, timeoutMs);

    reader.read().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 造一个调用 DeepSeek 接口的客户端（非流式 `chat` + 流式 `chatStream`）。
 *
 * @param config 包含 apiKey / baseUrl / model
 * @param idleTimeoutMs 流式读取时两个 chunk 之间的最大间隔；默认 30s。
 *   做成参数是为了让测试能注入极短超时，不必真的等 30 秒。
 */
export function createDeepSeekClient(
  config: LLMClientConfig,
  idleTimeoutMs: number = STREAM_IDLE_TIMEOUT_MS,
): LLMClient {
  // 在闭包里只算一次，避免每次请求都重复拼接字符串
  const url = `${config.baseUrl}/chat/completions`;
  // 两个方法共用同一份请求头，提到这里避免两处各写一遍（鉴权行为只此一处）
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
        // 请求体只传本次用到的两个字段；
        // stream / temperature 等都跟随服务端默认值，不额外发送
        //
        // 本次请求的模型优先；没传才回落到构造时的默认值。
        // 这样「当前模型」可以随会话切换，而 client 本身保持无状态。
        body: JSON.stringify({ model: options?.model ?? config.model, messages }),
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
      // 另外：这里刻意不读 reasoning_content（模型的思考过程）——这是**非流式路径**的取舍。
      // 流式路径（chatStream）会把同一个字段归一化成 reasoning-delta，由渲染器在 stderr
      // 写一行 `[思考中…]` 指示；两条路径都不打印思考正文、也都不把它放进后续上下文。
      // 见 DECISIONS D22。
      const content = data.choices[0]?.message?.content ?? '';
      return { content };
    },

    async *chatStream(
      messages: Message[],
      options?: ChatOptions,
    ): AsyncIterable<StreamEvent> {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 只发三个字段。不发 stream_options —— 官方文档没有要求流式必须带它
        // （依赖方向相反：单独传 stream_options 才 400），
        // 而 M2 也不消费 usage，发了没有收益。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          stream: true,
        }),
      });

      // 非 2xx 必须在产出任何事件**之前**抛出，处理方式与 chat() 一致
      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        throw new Error(`DeepSeek API error ${response.status}: ${detail}`);
      }

      if (!response.body) {
        throw new Error('响应没有 body，无法流式读取');
      }

      const reader = response.body.getReader();
      // stream: true 让 TextDecoder 把跨块的多字节序列暂存在内部。
      // 不这么做的话，一个中文被 TCP 切在字符中间就会解出乱码。
      const decoder = new TextDecoder();
      let buffer = '';
      let doneEmitted = false;

      try {
        while (true) {
          const result = await readWithIdleTimeout(reader, idleTimeoutMs);

          if (result.done) break;

          const text = decoder.decode(result.value, { stream: true });
          // 残余必须回灌给下一轮：一条事件被 TCP 切成两次 read 时，
          // 前一半只有靠 buffer 带过去才能和后半拼成完整事件
          const { events, rest } = parseSse(text, buffer);
          buffer = rest;

          for (const event of events) {
            // [DONE] 是 OpenAI 的约定，不是 SSE 协议的一部分，
            // 所以由这一层（而不是 sse.ts）来解释它
            if (event.data === '[DONE]') {
              if (!doneEmitted) {
                doneEmitted = true;
                yield { type: 'done', reason: 'stop' };
              }
              continue;
            }

            let payload: {
              choices?: Array<{
                delta?: { content?: string | null; reasoning_content?: string | null };
                finish_reason?: string | null;
              }>;
            };
            try {
              payload = JSON.parse(event.data);
            } catch {
              // 单条坏 chunk 不该让整个回答作废：跳过，继续读后面的
              continue;
            }

            const choice = payload.choices?.[0];
            const delta = choice?.delta;

            // 同一个 chunk 可能同时带内容和 finish_reason，所以逐个字段判定，
            // 不是 switch 整个 chunk。顺序也要紧：先正文后 done。
            if (delta?.reasoning_content) {
              yield { type: 'reasoning-delta', text: delta.reasoning_content };
            }
            if (delta?.content) {
              yield { type: 'text-delta', text: delta.content };
            }
            if (choice?.finish_reason && !doneEmitted) {
              doneEmitted = true;
              // 宽松处理：服务端新增取值时原样传出，不做白名单校验
              yield { type: 'done', reason: choice.finish_reason as FinishReason };
            }
          }
        }

        // 冲掉 decoder 内部可能残留的字节（正常不会剩）
        const tail = decoder.decode();
        if (tail !== '') {
          const { events } = parseSse(tail, buffer);
          for (const event of events) {
            // 收尾阶段只剩极少数情况会有事件，且都不带正文；
            // 这里只处理 done，避免重复实现上面的归一化逻辑
            if (event.data === '[DONE]' && !doneEmitted) {
              doneEmitted = true;
              yield { type: 'done', reason: 'stop' };
            }
          }
        }

        // 服务端没给 finish_reason 也没给 [DONE] 就关流了：
        // 不报错，补一个 stop，让调用方总能收到 done
        if (!doneEmitted) {
          yield { type: 'done', reason: 'stop' };
        }
      } finally {
        // 清理必须在 finally 里做，因为有三条路都会走到这里：
        // 正常读完、超时/读失败抛出、以及**调用方提前退出消费**
        // （`for await` 里 break —— Task 6 中途停止打印就会走这条）。
        //
        // 只 releaseLock() 是不够的：它只是归还读锁，底层流仍然活着，
        // 真实 fetch 下 undici 的连接会悬着直到 GC 才被回收。
        // 对已经读完/已关闭的流调 cancel() 无害（立即 resolve），
        // 所以正常路径不受影响。
        //
        // 顺序不能反：releaseLock() 之后再调 cancel() 会抛
        // 「reader has been released」。
        await reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // 故意吞掉：清理动作失败不能盖住真正要抛出的那个错误
        }
      }
    },
  };
}
