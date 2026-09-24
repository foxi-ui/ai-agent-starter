// REPL（Read-Eval-Print Loop）：读一行 → 调模型 → 打印回答 → 循环。
//
// 这是 cli 层，也是唯一负责「和用户打交道」的地方：
// 读标准输入、写标准输出都发生在这里。
// 它只依赖 LLMClient 接口，不知道背后是 DeepSeek。

import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import { parseCommand, executeCommand } from '@/core/commands.ts';
import { createStreamRenderer, renderCommandResult, renderUnknownCommand } from '@/cli/render.ts';
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
  /** 往哪里写模型回答与命令结果（真实运行时是 process.stdout） */
  output: NodeJS.WritableStream;
  /**
   * 往哪里写错误与诊断信息（真实运行时是 process.stderr）。
   *
   * 与 output 分开是刻意的：stdout 只承载模型回答与命令结果，
   * 这样 `pnpm start > answers.txt` 得到的文件里只有回答、命令结果与提示符，
   * 不会混进报错；管道里也能按流分别过滤。
   * 声明为必填字段，是为了让「忘记分流」在编译期就暴露。
   */
  errorOutput: NodeJS.WritableStream;
  /** 提示符，例如 'You: ' */
  prompt: string;
  /** 会话的初始模型，通常来自 resolveConfig 的 config.model */
  model: string;
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
  const session = new Session(options.model);
  const rl = createInterface({ input: options.input, output: options.output });

  // 诊断信息的专用通道。写到 stderr
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
      // 每次读取尝试前各写一次。注意：EOF 前那次也会写出，所以输出以 `You: ` 结尾
      // —— 这是 D15 的「已知边界」，不是 bug
      writePrompt();

      const { value: line, done } = await lines.next();
      if (done) break;

      const question = line.trim();
      // 空行直接跳过，不进入上下文，避免污染对话历史
      if (question === '') continue;

      // 命令必须在 append 之前处理，所以它永远不会进入对话上下文。
      // 否则 `/clear` 会作为一条 user 消息留在刚被它清空的历史里，
      // `/history` 会让模型看到「用户查了历史」。
      const parsed = parseCommand(question);

      if (parsed.kind === 'unknown') {
        // 未知命令不发请求，走 stderr（它是错误，不是用户要的输出）
        renderUnknownCommand(parsed.input, { errorOutput: options.errorOutput });
        continue;
      }

      if (parsed.kind === 'known') {
        const result = executeCommand(parsed.name, parsed.argument, session);
        // 命令结果走 stdout：用户主动索要的输出
        renderCommandResult(result, { output: options.output });
        continue;
      }

      session.append('user', question);

      // 每轮新建渲染器：「[思考中…] 只出现一次」因此是天然的
      const renderer = createStreamRenderer({
        output: options.output,
        errorOutput: options.errorOutput,
      });

      // 本轮正文。渲染器只呈现，累积是这里的职责 ——
      // 因为只有攒出完整文本才能写进 Session 当上下文。
      let text = '';

      try {
        // 把「system + 目前为止的全部历史」发过去，模型据此理解上下文；
        // 当前模型随请求走，所以中途切换模型能立即生效
        const stream = client.chatStream(session.toMessages(SYSTEM_PROMPT), {
          model: session.model,
        });

        for await (const event of stream) {
          renderer.onEvent(event);
          if (event.type === 'text-delta') text += event.text;
        }

        // 只在成功之后才记录 AI 的回答。
        // 失败时若也追加，历史里就会出现一条「伪造的回答」，
        // 下一轮模型会把它当成自己说过的话，产生自我矛盾。
        //
        // 注意：流中途失败时屏幕上会留下半截回答，但它**不会**进入上下文。
        // 「屏幕上看到的」与「模型记得的」是两回事。
        session.append('assistant', text);
      } catch (error) {
        // 最小错误处理：打印错误后继续循环。
        // 不崩溃，也不污染上下文——失败的轮次不留 assistant 消息。
        // 走 stderr：stdout 只留给模型回答与命令结果，重定向时不被诊断信息污染。
        //
        // 先收尾再报错（D-18）：finish() 补的那一个换行属于 stdout，
        // 若等到 finally 才补，真实终端上一行的报错会粘在半截回答后面。
        // 这里提前调一次，finally 里那次靠 finish() 的幂等守卫变成空操作；
        // 两个流各自的字节内容不变（wrotePrefix 为真才补换行）。
        renderer.finish();
        writeError(`[error] ${(error as Error).message}`);
      } finally {
        // 无论正常还是异常结束都收尾：保证正文后有且只有一个换行，
        // 否则下一次提示符会接在半句话后面
        renderer.finish();
      }
    }
  } finally {
    // 提前退出（比如上面抛错）时把迭代器还回去，否则 readline 的接口会一直开着。
    // 正常走完 EOF 时它已经关闭，这里再调一次是无害的。
    await lines.return?.();
  }
}
