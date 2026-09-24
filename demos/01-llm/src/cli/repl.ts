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
  /** 往哪里写模型回答（真实运行时是 process.stdout） */
  output: NodeJS.WritableStream;
  /**
   * 往哪里写错误与诊断信息（真实运行时是 process.stderr）。
   *
   * 与 output 分开是刻意的：stdout 只承载模型回答，
   * 这样 `pnpm start > answers.txt` 得到的文件是干净的回答，
   * 不会混进报错；管道里也能按流分别过滤。
   * 声明为必填字段，是为了让「忘记分流」在编译期就暴露。
   */
  errorOutput: NodeJS.WritableStream;
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

  // 诊断信息的专用通道。与 write 对称，但写到 stderr
  const writeError = (text: string) => {
    options.errorOutput.write(text + '\n');
  };

  // 提示符**刻意不补换行**：它要和用户输入处在同一行（终端会回显输入），
  // 补了换行就会把问题顶到下一行，与文档里的 `You: 什么是...` 不符
  const writePrompt = () => {
    options.output.write(options.prompt);
  };

  // 为什么手写异步迭代而不用 `for await`：
  // 提示符必须在**读取下一行之前**写（那才是用户该看到它、准备打字的时刻），
  // 而 `for await` 把「读取」藏在语法里，拿不到这个时机。
  // 串行语义不变 —— 上一轮的 await 全部结束后才拉下一行，与 D9 的选择一致。
  const lines = rl[Symbol.asyncIterator]();

  try {
    while (true) {
      // 写在读取之前而不是本轮处理之后：EOF 时就不会多出一个孤零零的提示符
      writePrompt();

      const { value: line, done } = await lines.next();
      if (done) break;

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
        // `AI: ` 前缀与正文一起写出，且整轮只出现一次。
        // 它只在成功路径上写 —— 失败时 stdout 不会留下一个空的 `AI: `。
        write(`AI: ${result.content}`);
      } catch (error) {
        // 最小错误处理：打印错误后继续循环。
        // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
        // 走 stderr：stdout 只留给模型回答，重定向时不被诊断信息污染。
        writeError(`[error] ${(error as Error).message}`);
      }
    }
  } finally {
    // 提前退出（比如上面抛错）时把迭代器还回去，否则 readline 的接口会一直开着。
    // 正常走完 EOF 时它已经关闭，这里再调一次是无害的。
    await lines.return?.();
  }
}
