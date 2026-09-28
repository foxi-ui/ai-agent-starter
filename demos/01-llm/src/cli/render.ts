// 把 llm 层吐出的 StreamEvent 变成终端上的输出。
//
// 这是 cli 层：只有这里才允许写 stdout / stderr。
// 渲染器**只呈现、不累积正文** —— 正文由 repl 自己攒（它需要那份完整文本
// 才能写进 Session）。各管一件事。
//
// 输出分流（见 DECISIONS D13 / D-M2-10）：
//   stdout —— 用户主动要看的：模型回答 + 命令结果
//   stderr —— 用户没主动要的：思考指示、截断警告、错误、未知命令提示

import type { StreamEvent } from '@/core/types.ts';
import { COMMAND_NAMES, type CommandResult } from '@/core/commands.ts';
import { periodAt, costOf, isOutsideHolidayTable, HOLIDAY_TABLE_YEAR } from '@/core/usage.ts';

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
 * 需求形状是 `You: 问` / `AI: 答` 交替（见 spec §2 与 README）。
 * 流式下它必须在**第一段正文之前**写出，所以由渲染器持有 ——
 * 这正是「渲染器负责一轮长什么样」的职责。
 */
const ANSWER_PREFIX = 'AI: ';

/**
 * 展开思考时，写在思考全文之前的前缀（stderr）。
 *
 * 同样**只在真有内容时**才写，所以服务端没吐 reasoning 时不会留下一个孤零零的前缀。
 */
const REASONING_PREFIX = '[思考] ';

export function createStreamRenderer(options: {
  output: NodeJS.WritableStream;
  errorOutput: NodeJS.WritableStream;
  /**
   * 展开思考全文（`--show-reasoning`）。为 false 时维持 D22 的一行 `[思考中…]` 指示。
   *
   * 无论哪种模式，思考都走 **stderr** —— stdout 的契约是「只有模型回答与命令结果」，
   * `pnpm start > answers.txt` 必须拿到一份干净的答案文件（见 D-M4a-6）。
   */
  showReasoning: boolean;
}): StreamRenderer {
  // 每轮一个新的渲染器，所以这些标志天然是「本轮」的，不需要跨轮重置
  let thinkingNotified = false;
  let wroteReasoningPrefix = false;
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
        if (options.showReasoning) {
          // 展开全文。前缀只写一次，正文紧随其后（不换行），
          // 由 finish() 统一补末尾那个换行 —— 与 stdout 的正文同一个形状。
          if (!wroteReasoningPrefix) {
            wroteReasoningPrefix = true;
            options.errorOutput.write(REASONING_PREFIX);
          }
          options.errorOutput.write(event.text);
          return;
        }

        // 默认模式：思考可能持续十几秒。这期间若一片死寂，流式解决的「等待没反馈」
        // 就只解决了一半 —— 所以给一行指示，但**不打印思考内容本身**
        // （它通常比答案长得多，会淹没答案）。
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

      if (event.type === 'usage') {
        // **必须显式写出来，不能靠 fallthrough。**
        //
        // 这个 if 链的最后一个分支是隐式的 done（「走到这里的一定是 done」），
        // 加了 usage 变体之后那句话不再成立 —— 不拦它的话每个末 chunk 都会
        // 掉进 done 分支，多写一个 `AI: ` 前缀，且 finish_reason 的截断判断
        // 会读到 undefined。这个错误编译不报、只在输出形状上现形。
        //
        // 用量由 /usage 按需展示，不往 stdout 里插（D-M4b-7）。
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
      // 展开的思考在 stderr 上是一条独立的行，也和正文一样需要收尾 ——
      // 否则下一次的 [思考] 或报错会粘在思考的最后一句后面
      if (wroteReasoningPrefix) options.errorOutput.write('\n');
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
 * 从会话 id 里切出 `MM-DD HH:MM` 供展示。
 *
 * 直接切片而不是解析 meta 里的 createdAt：id 里的时间**本来就是本地时间**
 * （见 core/journal.ts 的 makeSessionId），切片零换算、且在哪台机器上都一样。
 * 走 createdAt 则要 new Date(iso) 再取本机时区，同一份文件换个 TZ 就显示成
 * 另一个时间 —— 列表是拿来比对的，那样很别扭。
 *
 * id 的格式已由 isValidSessionId 保证，所以这里的切片不会越界。
 */
function formatSessionTime(id: string): string {
  // YYYYMMDD-HHMMSS-xxxx
  // 0123456789...
  return `${id.slice(4, 6)}-${id.slice(6, 8)} ${id.slice(9, 11)}:${id.slice(11, 13)}`;
}

/**
 * 一个字符在终端里占几列。
 *
 * 汉字、全角标点在等宽终端里占 **2 列**，而 `String.length` 把它们算作 1 ——
 * 所以用 `padEnd` 对齐中文表头一定会错位。
 *
 * ⚠️ **这不是一个通用的 Unicode 宽度实现**，只覆盖本项目表头用到的那几个词
 * （模型 / 时段 / 输入 / 命中缓存 / 输出 / 思考 / 费用）。别拿它去处理 emoji、
 * 组合字形或其它东亚文字。
 */
const WIDE_CHAR = /[　-〿぀-ヿ㐀-䶿一-鿿＀-｠￠-￦]/;

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1;
  return width;
}

/** 按**显示宽度**右侧补空格 */
function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 千分位。
 *
 * **不用 `toLocaleString`** —— 它依赖 ICU 构建，同一份输入在不同 Node
 * 构建上可能得到不同结果，测试会跟着飘。这个三行实现结果恒定。
 */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 金额 → `¥0.00405`；无价目 → `—`（不是 ¥0.00000） */
function formatAmount(cny: number | null): string {
  return cny === null ? '—' : `¥${cny.toFixed(5)}`;
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

    case 'sessions': {
      if (result.sessions.length === 0) {
        write('(还没有历史会话)');
        return;
      }
      for (const session of result.sessions) {
        // 当前会话行首打 *，其余行首补一个空格，这样两列对齐
        const marker = session.id === result.currentId ? '*' : ' ';
        write(
          `${marker} ${session.id}  ${formatSessionTime(session.id)}  ${session.messageCount} 条`,
        );
      }
      return;
    }

    case 'usage': {
      write(`本会话用量（${result.entries.length} 轮）`);

      if (result.entries.length === 0) {
        write('本会话还没有用量记录。');
        write('范围：本会话的全部记录，含 --resume 恢复的历史。');
        return;
      }

      // 逐行算好，再统一算列宽 —— 表头与合计行都要参与，否则中文表头、
      // 以及比数据列更宽的「合计」两个字，都会把那一行挤得对不齐
      const rows: string[][] = [];
      // 分档轮次顺便在这里数出来：「时段拆分」那行要报每档几轮，
      // 而 `cost()` 只给金额合计，没有分档计数
      let peakRounds = 0;
      let offPeakRounds = 0;

      result.entries.forEach((entry, index) => {
        const period = periodAt(new Date(entry.at));
        const amount = costOf(entry.usage, entry.model, period);
        if (amount !== null) {
          if (period === 'peak') peakRounds += 1;
          else offPeakRounds += 1;
        }
        rows.push([
          String(index + 1),
          entry.model,
          period === 'peak' ? '高峰' : '空闲',
          group(entry.usage.promptTokens),
          group(entry.usage.cachedTokens),
          group(entry.usage.completionTokens),
          group(entry.usage.reasoningTokens),
          formatAmount(amount),
        ]);
      });

      const headers = ['#', '模型', '时段', '输入', '命中缓存', '输出', '思考', '费用'];

      // 合计行：前两列留空（不填模型与时段 —— 它们是「每条」的属性）
      const totalAmount =
        result.cost.pricedRounds === 0 && result.cost.unpricedModels.length > 0
          ? null
          : result.cost.cny;
      const totalRow = [
        '合计', '', '',
        group(result.total.promptTokens),
        group(result.total.cachedTokens),
        group(result.total.completionTokens),
        group(result.total.reasoningTokens),
        formatAmount(totalAmount),
      ];

      const widths = headers.map((header, i) =>
        Math.max(
          displayWidth(header),
          displayWidth(totalRow[i]),
          ...rows.map((r) => displayWidth(r[i])),
        ),
      );
      // **不做 trimEnd**：末列补齐的空格一旦削掉，各行的显示宽度就会不等 ——
      // 表头末列是「费用」（宽度 4），数据行末列是「¥0.00405」（宽度 8），
      // 削掉补齐部分之后两者差 4 列。整表对齐的代价只是行尾多几个看不见的空格。
      //
      // 缩进也**必须每行都有**（含表头与分隔线）：表头不加缩进的话，
      // 它会比数据行整体左移 2 列，`#` 与行号对不上。
      const renderRow = (cells: string[]): string =>
        `  ${cells.map((cell, i) => padDisplay(cell, widths[i])).join('  ')}`;

      write(renderRow(headers));
      for (const row of rows) write(renderRow(row));
      write(`  ${'─'.repeat(widths.reduce((a, b) => a + b + 2, -2))}`);
      write(renderRow(totalRow));
      write('');

      // 未定价模型：单独一行，且**不与合计混在一起**
      if (result.cost.unpricedModels.length > 0) {
        const count = result.entries.length - result.cost.pricedRounds;
        write(
          `注意：${count} 轮使用未定价模型（${result.cost.unpricedModels.join(', ')}），未计入合计。`,
        );
      }

      // 估算校准：只有拿到过真实用量才有意义
      if (result.total.promptTokens > 0) {
        const estimated = result.entries.reduce((sum, e) => sum + e.estimatedPromptTokens, 0);
        const actual = result.total.promptTokens;
        const delta = ((estimated - actual) / actual) * 100;
        const direction = estimated > actual ? '估算偏保守' : estimated < actual ? '估算偏激进' : '与真实一致';
        write(
          `上下文估算：合计估算 ${group(estimated)} / 真实 ${group(actual)}（${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%，${direction}）`,
        );
      }

      // 峰谷拆分：只在两档都出现过时才有信息量。轮次数按 spec §9 一并报出 ——
      // 只有金额的话，用户无法判断「空闲那部分便宜」是因为单价低还是因为轮次少
      if (result.cost.pricedRounds >= 2 && result.cost.peakCny > 0 && result.cost.offPeakCny > 0) {
        write(
          `时段拆分：高峰 ${peakRounds} 轮 ${formatAmount(result.cost.peakCny)} / 空闲 ${offPeakRounds} 轮 ${formatAmount(result.cost.offPeakCny)}`,
        );
      }

      // 表过期是**必须可见**的：静默用一张过期表会让 2027 年春节
      // 被当成普通工作日按高峰计价（D-M4b-14）
      if (result.entries.some((e) => isOutsideHolidayTable(new Date(e.at)))) {
        // 措辞不写「${YEAR + 1} 年及以后」—— 触发条件是「年份 ≠ 表年份」，
        // 早于表年份的记录（手改的旧时间戳）也会走到这里，那句话对它是错的
        write(
          `注意：节假日表只覆盖 ${HOLIDAY_TABLE_YEAR} 年，其它年份的记录未按法定节假日扣除。`,
        );
      }

      // 口径与范围这两行**始终**输出（D-M4b-8）：金额与真实账单之间隔着
      // 估算器的误差、中断的轮次、节假日表的覆盖范围三件事，
      // 不写出来用户就会把 ¥0.01328 当成账单
      write(
        `口径：按 docs/deepseek-api-facts.md 的价目表分高峰/空闲两档估算（含 ${HOLIDAY_TABLE_YEAR} 年法定节假日表）；`
          + '未计入中断的轮次，未经账单核对。',
      );
      write('范围：本会话的全部记录，含 --resume 恢复的历史。');
      return;
    }

    default: {
      // 穷尽性守卫：给 CommandResult 再加一个变体却忘了在这里处理时，
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
