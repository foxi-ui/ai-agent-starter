// 把 llm 层吐出的 StreamEvent 变成终端上的输出。
//
// 这是 cli 层：只有这里才允许写 stdout / stderr。
// 渲染器**只呈现、不累积正文** —— 正文由 repl 自己攒（它需要那份完整文本
// 才能写进 Session）。各管一件事。
//
// 输出分流（见 DECISIONS D13 / D-M2-10）：
//   stdout —— 用户主动要看的：模型回答
//   stderr —— 用户没主动要的：思考指示、截断警告、错误

import type { StreamEvent } from '@/core/types.ts';
import { COMMAND_NAMES, type CommandResult } from '@/core/commands.ts';

/** 一轮回答的渲染器；每轮新建一个，用完即弃 */
export interface StreamRenderer {
  /** 处理一个流式事件 */
  onEvent(event: StreamEvent): void;
  /**
   * 收尾：保证本轮正文后有**且只有一个**换行。
   *
   * 必须在 `finally` 里调用 —— 流中途报错时若不补，
   * 下一次 `You: ` 提示符会接在半句话后面。
   */
  finish(): void;
}

/**
 * 一轮回答在 stdout 上的前缀。
 *
 * 需求形状是 `You: 问` / `AI: 答` 交替（见 `docs/00-index.md`、spec §2、README）。
 * 流式下它必须在**第一段正文之前**写出，所以由渲染器持有 ——
 * 这正是「渲染器负责一轮长什么样」的职责。
 */
const ANSWER_PREFIX = 'AI: ';

export function createStreamRenderer(options: {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
}): StreamRenderer {
  // 每轮一个新的渲染器，所以这些标志天然是「本轮」的，不需要跨轮重置
  let thinkingNotified = false;
  let wrotePrefix = false;
  let finished = false;

  // 前缀必须恰好写出一次，且在正文之前
  const writePrefixOnce = (): void => {
    if (wrotePrefix) return;
    wrotePrefix = true;
    options.output.write(ANSWER_PREFIX);
  };

  return {
    onEvent(event: StreamEvent): void {
      if (event.type === 'reasoning-delta') {
        // 思考可能持续十几秒。这期间若一片死寂，流式解决的「等待没反馈」
        // 就只解决了一半 —— 所以给一行指示，但**不打印思考内容本身**
        // （它通常比答案长得多，会淹没答案；展开全文是 M4 的 --show-reasoning）。
        if (!thinkingNotified) {
          thinkingNotified = true;
          options.errorOutput.write('[思考中…]\n');
        }
        return;
      }

      if (event.type === 'text-delta') {
        writePrefixOnce();
        // 不补换行：正文是连续流动的，换行只由 finish() 统一负责
        options.output.write(event.text);
        return;
      }

      // done
      // 整轮一个字都没来时也要补上前缀 —— 非流式路径对空回答同样会写出
      // `AI: `（`write(\`AI: ${content}\`)` 里 content 是空串），
      // 两条路径的形状必须一致，否则同一件事在流式/非流式下长得不一样。
      writePrefixOnce();
      if (event.reason === 'length') {
        options.errorOutput.write('[警告] 回答被截断（finish_reason=length）\n');
      }
    },

    finish(): void {
      // 幂等：无论调用几次，只补一个换行
      if (finished) return;
      finished = true;
      // 前缀都没写过说明本轮完全没产出（比如一上来就抛错），
      // 此时当前行是空的，补换行只会多一个空行
      if (wrotePrefix) options.output.write('\n');
    },
  };
}

/** `/history` 里每条消息最多显示多少字符 */
const HISTORY_PREVIEW_CHARS = 200;

/**
 * 截断过长的历史消息。
 *
 * 计数单位是 **UTF-16 码元**（`text.length`），所以第 200 个码元处若正好落在
 * 代理对（emoji 等辅助平面字符）中间，会把它切成两个孤立码元。这是**有意接受**
 * 的取舍：改成按码点截同样会切开 ZWJ 组合字形（如 👨‍👩‍👧），要彻底安全得上
 * `Intl.Segmenter` —— 对一条终端预览而言，成本远高于收益。
 */
function truncate(text: string): string {
  if (text.length <= HISTORY_PREVIEW_CHARS) return text;
  return `${text.slice(0, HISTORY_PREVIEW_CHARS)}…`;
}

/**
 * 渲染命令的执行结果。
 *
 * 走 **stdout**：这是用户主动索要的输出，`pnpm start > answers.txt` 里
 * 应该能看到它（与错误、思考指示这些「用户没主动要的」区分开）。
 */
export function renderCommandResult(
  result: CommandResult,
  options: { output: NodeJS.WritableStream },
): void {
  const write = (text: string): void => {
    options.output.write(text + '\n');
  };

  switch (result.kind) {
    case 'cleared':
      write(`已清空 ${result.removed} 条消息。`);
      return;

    case 'model-current':
      write(`当前模型：${result.model}`);
      return;

    case 'model-changed':
      write(`已切换模型：${result.model}`);
      return;

    case 'history': {
      if (result.messages.length === 0) {
        write('(当前会话没有消息)');
        return;
      }
      result.messages.forEach((message, index) => {
        write(`${index + 1}. [${message.role}] ${truncate(message.content)}`);
      });
      return;
    }

    default: {
      // 穷尽性守卫：给 CommandResult 加第 5 个变体却忘了在这里处理时，
      // 这行会编译报错，而不是让用户敲了新命令只看到空屏。
      const _exhaustive: never = result;
      void _exhaustive;
    }
  }
}

/**
 * 渲染未知命令的提示。
 *
 * 走 **stderr**：这是错误，不是用户要的输出。
 */
export function renderUnknownCommand(
  input: string,
  options: { errorOutput: NodeJS.WritableStream },
): void {
  // 可用列表由 COMMAND_NAMES 拼出来，**不硬编码**——
  // 硬编码的话，以后新增命令时这行提示不会跟着更新
  const available = COMMAND_NAMES.map((name) => `/${name}`).join(' ');
  options.errorOutput.write(`未知命令：${input}。可用：${available}\n`);
}
