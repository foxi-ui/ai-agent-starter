// REPL（Read-Eval-Print Loop）：读一行 → 调模型 → 打印回答 → 循环。
//
// 这是 cli 层，也是唯一负责「和用户打交道」的地方：
// 读标准输入、写标准输出都发生在这里。
// 它只依赖 LLMClient 接口，不知道背后是 DeepSeek。

import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import type { LLMClient } from '@/llm/client.ts';

/**
 * 系统提示：每轮请求都放在最前，用来固定助手的身份和回答风格。
 * 抽成常量是为了只有一处可改。
 */
export const SYSTEM_PROMPT = '你是 CLI AI 助手，简洁直接地回答问题。';

/** 运行 REPL 需要的输入输出通道与提示符 */
export interface ReplOptions {
  /** 从哪里读用户输入（真实运行时是 process.stdin） */
  input: NodeJS.ReadableStream;
  /** 往哪里写回答（真实运行时是 process.stdout） */
  output: NodeJS.WritableStream;
  /** 提示符，例如 'You: ' */
  prompt: string;
}

/**
 * 启动对话循环，直到输入流关闭才返回。
 *
 * @param client 已构造好的 LLM 客户端。测试时传入假的实现即可，
 *               这样整个 REPL 的行为都能离线验证
 * @param options 输入输出通道与提示符
 */
export async function runRepl(
  client: LLMClient,
  options: ReplOptions,
): Promise<void> {
  // 一整段对话的消息记录，循环期间一直被复用
  const session = new Session();
  const rl = createInterface({ input: options.input, output: options.output });

  // 统一在这里补换行，省得每个调用点都自己写 '\n'
  const write = (text: string) => {
    options.output.write(text + '\n');
  };

  write(options.prompt);

  // for await 逐行处理：每行的异步工作 await 完成后才进入下一行，
  // 循环在输入流关闭（rl 触发 close）时自然结束，避免异步竞态。
  //
  // 为什么不用 rl.on('line', ...)？因为事件回调里没法自然地 await。
  // 若在回调中并发发起请求，快速连续输入会让多个请求同时在途，
  // 回答顺序就和提问顺序对不上了，上下文随即错乱。
  for await (const line of rl) {
    const question = line.trim();
    // 空行直接跳过，不进入上下文，避免污染对话历史
    if (question === '') continue;

    session.append('user', question);
    try {
      // 把「system + 目前为止的全部历史」发过去，模型据此理解上下文
      const result = await client.chat(session.toMessages(SYSTEM_PROMPT));
      // 只在成功之后才记录 AI 的回答。
      // 失败时若也追加，历史里就会出现一条「伪造的回答」，
      // 下一轮模型会把它当成自己说过的话，产生自我矛盾。
      session.append('assistant', result.content);
      write(result.content);
    } catch (error) {
      // 最小错误处理：打印错误后继续循环。
      // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
      write(`[error] ${(error as Error).message}`);
    }
  }
}
