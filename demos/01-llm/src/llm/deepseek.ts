// DeepSeek 的具体实现：把「消息数组」变成一次 HTTP 请求。
//
// 属于 llm 层（最底层），只依赖 core 的类型。
// 这一层**不打印任何东西**——打印是 cli 层的职责。
// 保持安静，才能在测试里被反复调用而不产生多余输出。

import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type {
  ChatOptions,
  Message,
  ChatResult,
  FinishReason,
  StreamEvent,
  TokenUsage,
} from '@/core/types.ts';
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
 * 把 `ChatOptions.thinking` 翻译成请求体里的字段。
 *
 * **只在关闭时**才产生字段：不传或为 `true` 时返回空对象，请求体里连 `thinking`
 * 这个键都不出现 —— 服务端默认就是开启（见 `docs/deepseek-api-facts.md`），
 * 显式声明默认值只会多出一个可能与服务端漂移的分支。
 *
 * `chat()` 与非流式/流式两条路径共用它，避免两处各写一遍（否则两个方法的行为
 * 会悄悄不一致 —— 这正是 D-M4a-11 要防的）。
 */
function thinkingField(options?: ChatOptions): { thinking?: { type: 'disabled' } } {
  return options?.thinking === false ? { thinking: { type: 'disabled' } } : {};
}

/** 数字字段的防御式读取：不是有限数就取 0 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 「可能是数字」的读取：可用就返回数字，否则 `undefined`。
 *
 * 与 `num` 的区别是**区分「没拿到」与「拿到了 0」**。回落链必须用它，
 * 否则 `null` 或字符串会被 `num` 变成 0 并**短路**掉后面的候选字段：
 * 上游若用 `null` 表示「本项不适用」（JSON API 的常见形态），链子就停在那里 ——
 * 「未命中」被算成 0（金额偏低），或者「命中」被算成 0 而全部输入按最贵档计
 * （金额偏高最多 50 倍）。两种情况屏幕上都没有任何异样。
 */
function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * 把 API 的 usage 对象归一化成 TokenUsage。
 *
 * **永不抛错**：任何字段缺失、类型不对、整个对象不存在，都退回 0 ——
 * 统计拿不到不该毁掉一轮对话。
 *
 * 字段名取**防御式策略**：官方未文档化 `prompt_tokens_details` 的确切形状
 * （见 `docs/deepseek-api-facts.md` 末尾「官方未给出错误响应体的字段名，
 * 解析须防御式处理」），所以两个候选名都试：
 *
 * - 命中：`prompt_cache_hit_tokens` → `cached_tokens` → 0
 * - 未命中：`prompt_cache_miss_tokens` → `promptTokens - 命中` → 0
 * - 总数：`total_tokens` → `promptTokens + completionTokens`
 *
 * 未命中那一档要取 `Math.max(0, …)`：上游若给出「命中数 > 输入总数」，
 * 相减会得到负数，而负金额比金额偏差难查得多。
 */
function toTokenUsage(raw: unknown): TokenUsage {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;

  const promptTokens = num(source.prompt_tokens);
  const completionTokens = num(source.completion_tokens);

  const promptDetails = (
    typeof source.prompt_tokens_details === 'object' && source.prompt_tokens_details !== null
      ? source.prompt_tokens_details
      : {}
  ) as Record<string, unknown>;

  // 命中数：**四个候选名依次回落**。前两个在嵌套的 details 里（当前官方形状），
  // 后两个在顶层（历史文档 / 其它 OpenAI 兼容服务的形状）。只认嵌套那一种的话，
  // 上游换个位置就会让命中恒为 0、输入全部按最贵档计 —— 最多偏高 50 倍，
  // 而屏幕上唯一的变化是「命中缓存」那一列从某个数字变成 0，看不出是对是错。
  const cachedTokens =
    optNum(promptDetails.prompt_cache_hit_tokens) ??
    optNum(promptDetails.cached_tokens) ??
    optNum(source.prompt_cache_hit_tokens) ??
    optNum(source.cached_tokens) ??
    0;

  const cacheMissTokens =
    optNum(promptDetails.prompt_cache_miss_tokens) ??
    optNum(source.prompt_cache_miss_tokens) ??
    // 都没给才相减推出。取 Math.max(0, …)：命中数大于输入总数时相减得负数，
    // 而负金额比金额偏差难查得多
    Math.max(0, promptTokens - cachedTokens);

  const completionDetails = (
    typeof source.completion_tokens_details === 'object' &&
    source.completion_tokens_details !== null
      ? source.completion_tokens_details
      : {}
  ) as Record<string, unknown>;

  return {
    promptTokens,
    completionTokens,
    totalTokens: optNum(source.total_tokens) ?? promptTokens + completionTokens,
    cachedTokens,
    cacheMissTokens,
    reasoningTokens: num(completionDetails.reasoning_tokens),
  };
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
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          ...thinkingField(options),
        }),
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
        usage?: unknown;
      };
      // 逐层可选链 + 兜底空串：任何一层缺失都返回 ''，而不是抛错。
      // 否则一个空回答就能让整个 REPL 崩掉。
      //
      // 另外：这里刻意不读 reasoning_content（模型的思考过程）——这是**非流式路径**的取舍。
      // 流式路径（chatStream）会把同一个字段归一化成 reasoning-delta，由渲染器在 stderr
      // 写一行 `[思考中…]` 指示；两条路径都不打印思考正文、也都不把它放进后续上下文。
      // 见 DECISIONS D22。
      const content = data.choices[0]?.message?.content ?? '';
      // 「没拿到」与「真的是 0」是两回事：API 没给 usage 时保持 undefined，
      // 由调用方决定怎么显示（见 core/types.ts 的 ChatResult）
      const usage = data.usage == null ? undefined : toTokenUsage(data.usage);
      return { content, usage };
    },

    async *chatStream(
      messages: Message[],
      options?: ChatOptions,
    ): AsyncIterable<StreamEvent> {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        // 只发三个必填字段（+ 可选的 thinking）。**仍然不发 stream_options** ——
        // 官方文档没有要求流式必须带它（依赖方向相反：单独传 stream_options 才 400），
        // 且官方口径是不传它时 usage 也出现在最后一个 chunk 上，
        // 所以 M4b 有了消费者之后也没有理由加（这一条由 Task 12 的冒烟实测确认）。
        body: JSON.stringify({
          model: options?.model ?? config.model,
          messages,
          stream: true,
          ...thinkingField(options),
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

      /**
       * 把一条 SSE 事件归一化成 0..n 个 `StreamEvent`。
       *
       * 抽成内部生成器，是为了让**主循环与收尾分支共用同一段归一化** ——
       * 两处各写一份的话，收尾那份迟早漏掉某个变体（它已经漏过一次 usage）。
       */
      function* normalize(event: { data: string }): Generator<StreamEvent> {
        // [DONE] 是 OpenAI 的约定，不是 SSE 协议的一部分，
        // 所以由这一层（而不是 sse.ts）来解释它
        if (event.data === '[DONE]') {
          if (!doneEmitted) {
            doneEmitted = true;
            yield { type: 'done', reason: 'stop' };
          }
          return;
        }

        let payload: {
          choices?: Array<{
            delta?: { content?: string | null; reasoning_content?: string | null };
            finish_reason?: string | null;
          }>;
          usage?: unknown;
        };
        try {
          payload = JSON.parse(event.data);
        } catch {
          // 单条坏 chunk 不该让整个回答作废：跳过，继续读后面的
          return;
        }

        const choice = payload.choices?.[0];
        const delta = choice?.delta;

        // 同一个 chunk 可能同时带内容和 finish_reason，所以逐个字段判定，
        // 不是 switch 整个 chunk。顺序也要紧：正文 → **usage** → done。
        //
        // usage 必须在 done 之前：done 是终止信号，消费者见到它可能 break，
        // 之后 yield 的就永远拿不到了。真实响应里两者在同一个末 chunk 上，
        // 所以这个顺序不是理论问题（D-M4b-2）。
        if (delta?.reasoning_content) {
          yield { type: 'reasoning-delta', text: delta.reasoning_content };
        }
        if (delta?.content) {
          yield { type: 'text-delta', text: delta.content };
        }
        // `!= null` 而不是 `!== undefined`：上游用 `usage: null` 表示
        // 「本 chunk 没有用量」是常见形态，写成 `!== undefined` 会让 null
        // 被归一化成**全 0**，于是这一轮以 ¥0.00000 记进账本 ——
        // 一个看起来完整、实际少了钱的数字（D54 花力气避免的正是这个形状）
        if (payload.usage != null) {
          yield { type: 'usage', usage: toTokenUsage(payload.usage) };
        }
        if (choice?.finish_reason && !doneEmitted) {
          doneEmitted = true;
          // 宽松处理：服务端新增取值时原样传出，不做白名单校验
          yield { type: 'done', reason: choice.finish_reason as FinishReason };
        }
      }

      try {
        while (true) {
          const result = await readWithIdleTimeout(reader, idleTimeoutMs);

          if (result.done) break;

          const text = decoder.decode(result.value, { stream: true });
          // 残余必须回灌给下一轮：一条事件被 TCP 切成两次 read 时，
          // 前一半只有靠 buffer 带过去才能和后半拼成完整事件
          const { events, rest } = parseSse(text, buffer);
          buffer = rest;

          for (const event of events) yield* normalize(event);
        }

        // 冲掉 decoder 内部可能残留的字节。**这一步不是可有可无的**：
        // 最后一块若正好把一个多字节字符切成两半，`decode(chunk, {stream:true})`
        // 会把那半个字符扣在内部，于是它所在的那条事件在循环里永远等不到补齐、
        // 留在 buffer 里 —— 只有这里的 decode() 能把它冲出来。
        const tail = decoder.decode();
        if (tail !== '') {
          const { events } = parseSse(tail, buffer);
          // 这里**同样要跑完整的归一化**，不能只认 `[DONE]`。
          // 曾经的写法是「收尾阶段的事件都不带正文，只处理 done 就够了」——
          // 那句对正文成立，对 **usage** 不成立：一条被切碎的末 chunk 里
          // usage 会被静默丢掉，紧接着下面补一个 done。结果这一轮屏幕正常、
          // assistant 消息也正常落盘，**只有账本少一轮**（偏低且无任何迹象），
          // 而 D-M4b-2 承诺的是「收到 done ⇒ 统计已经到手」。
          for (const event of events) yield* normalize(event);
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
