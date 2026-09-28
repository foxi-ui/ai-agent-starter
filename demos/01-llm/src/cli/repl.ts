// REPL（Read-Eval-Print Loop）：读一行 → 调模型 → 打印回答 → 循环。
//
// 这是 cli 层，也是唯一负责「和用户打交道」的地方：
// 读标准输入、写标准输出都发生在这里。
// 它只依赖 LLMClient 接口，不知道背后是 DeepSeek。

import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import { fitToBudget } from '@/core/context.ts';
import { parseCommand, executeCommand } from '@/core/commands.ts';
import { createStreamRenderer, renderCommandResult, renderUnknownCommand } from '@/cli/render.ts';
import { UsageLedger, type UsageEntry } from '@/core/usage.ts';
import type { ChatOptions, Message, TokenUsage } from '@/core/types.ts';
import type { SessionStore } from '@/core/journal.ts';
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
  /** 本次会话的 id，落盘时用它定位文件 */
  sessionId: string;
  /** 恢复出来的历史消息；新会话传空数组 */
  history: Message[];
  /**
   * 从 JSONL 回放出的账本记录；新会话传空数组。
   *
   * 与 `history` 同一个处置：账本是**会话文件级**的累计，
   * 所以 --resume 时接着算，而不是从零开始（D-M4b-3）。
   */
  usageEntries: UsageEntry[];
  /** 会话存储。落盘失败时的降级策略见下面的 onChange */
  store: SessionStore;
  /**
   * 展开思考全文到 stderr，来自 `--show-reasoning`。
   *
   * 与下面两个一样声明为**必填**：它们都是从命令行一路传下来的开关，
   * 漏传一个就会静默退回默认行为，而用户明明敲了那个参数 ——
   * 让它在编译期暴露，比让用户对着没生效的开关猜要好。
   */
  showReasoning: boolean;
  /** 关闭 thinking，来自 `--no-thinking` */
  noThinking: boolean;
  /** 上下文软预算（token），来自 `--max-context` */
  maxContext: number;
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
  const rl = createInterface({ input: options.input, output: options.output });

  // 诊断信息的专用通道。写到 stderr
  const writeError = (text: string) => {
    options.errorOutput.write(text + '\n');
  };

  // 落盘失败的降级：**只警告一次**。
  // 每轮都刷同一句会把屏幕占满，反而看不见别的；
  // 但绝不能静默 —— 那会让人以为存下来了，比直接报错更糟。
  let warnedWriteFailure = false;
  const reportWriteFailure = (error: unknown): void => {
    if (warnedWriteFailure) return;
    warnedWriteFailure = true;
    writeError(
      `[警告] 会话写入失败，本次对话将不再记录到磁盘：${(error as Error).message}`,
    );
  };

  // 整段对话的消息记录，循环期间一直被复用。
  //
  // onChange 就是「落盘」这件事的全部入口：Session 改完状态就喊一声，
  // 这里把这行追加进文件。之所以不让 repl 在每个变更点手动写，
  // 是因为 /clear 与 /model <name> 是 executeCommand **内部**改的状态，
  // 这里看不见它们 —— 靠记得写的写法迟早漏。
  const session = new Session(options.model, {
    history: options.history,
    onChange: (change) => {
      try {
        options.store.append(options.sessionId, change);
      } catch (error) {
        // 磁盘满、只读目录之类的问题不该打断正在进行的对话：
        // 内存照常往前走，只是磁盘落后了。
        reportWriteFailure(error);
      }
    },
  });

  // 账本只覆盖本会话文件 —— 起点是回放出来的历史记录。
  // 它**不**参与 Session 的 onChange 广播（D-M4b-16）：账本不是会话消息，
  // 落盘由下面那段显式调用完成。
  const ledger = new UsageLedger(options.usageEntries);

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
        const result = executeCommand(parsed.name, parsed.argument, session, {
          store: options.store,
          currentSessionId: options.sessionId,
          ledger,
        });
        // 命令结果走 stdout：用户主动索要的输出
        renderCommandResult(result, { output: options.output });
        continue;
      }

      session.append('user', question);

      // 每轮新建渲染器：「[思考中…] 只出现一次」因此是天然的
      const renderer = createStreamRenderer({
        output: options.output,
        errorOutput: options.errorOutput,
        showReasoning: options.showReasoning,
      });

      // 本轮正文与用量。渲染器只呈现，累积是这里的职责 ——
      // 因为只有攒出完整文本才能写进 Session 当上下文。
      let text = '';
      let usage: TokenUsage | null = null;

      try {
        // 组装 → **裁剪** → 请求。
        //
        // 裁剪只作用于这一次请求：Session 与磁盘上的 JSONL 仍是完整历史，
        // 所以下一轮会拿完整历史重新裁一遍。这是刻意的 ——
        // 「发给模型的内容」与「会话记得的内容」是两回事（D-M4a-5），
        // 回写就会多出一条静默删改历史的路径。这一处的 `session.append` 不受影响。
        const fitted = fitToBudget(session.toMessages(SYSTEM_PROMPT), options.maxContext);
        if (fitted.dropped > 0) {
          // 一行警告，不是每轮都报：静默的话用户只会觉得「模型怎么把前面忘了」
          writeError(
            `[上下文] 已裁剪 ${fitted.dropped} 条最早的消息（约 ${fitted.droppedTokens} token）`,
          );
        }

        // 把「system + 裁过的历史」发过去，模型据此理解上下文；
        // 当前模型随请求走，所以中途切换模型能立即生效。
        // thinking 只在关闭时才放进 options（不传即为服务端默认的开启）。
        const chatOptions: ChatOptions = { model: session.model };
        if (options.noThinking) chatOptions.thinking = false;

        const stream = client.chatStream(fitted.messages, chatOptions);

        for await (const event of stream) {
          renderer.onEvent(event);
          if (event.type === 'text-delta') text += event.text;
          else if (event.type === 'usage') usage = event.usage;
        }

        // 只在成功之后才记录 AI 的回答。
        // 失败时若也追加，历史里就会出现一条「伪造的回答」，
        // 下一轮模型会把它当成自己说过的话，产生自我矛盾。
        //
        // 注意：流中途失败时屏幕上会留下半截回答，但它**不会**进入上下文。
        // 「屏幕上看到的」与「模型记得的」是两回事。
        session.append('assistant', text);

        // **只在成功路径记账**：中断的轮次（超时、连接断）走 catch 分支，
        // 那时 API 侧可能已经为已生成的部分计费，但我们拿不到那个 usage ——
        // 记一笔残缺的会让账本看起来完整、实则错。宁可偏低且可解释。
        if (usage) {
          const entry: UsageEntry = {
            // 时刻在这里定格：金额按它分峰谷，事后再算就晚了（D-M4b-13）
            at: new Date().toISOString(),
            model: session.model,
            usage,
            // 裁剪**之后**的估算 —— 它要和真实的 prompt_tokens 对得上，
            // 而后者描述的是「这一次实际发出去的东西」
            estimatedPromptTokens: fitted.keptTokens,
          };
          ledger.record(entry);
          try {
            // 与 Session 那条落盘路径共用 reportWriteFailure：
            // 「写盘失败只警告一次」这条降级自动覆盖 usage 记录
            options.store.append(options.sessionId, { type: 'usage', entry });
          } catch (error) {
            reportWriteFailure(error);
          }
        }
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
