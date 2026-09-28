// 上下文预算：把「这一次要发给模型的消息」裁到预算之内。
//
// **纯函数、零 IO**。裁剪是**策略**而不是会话状态，所以它不住在 `Session` 里
// （让预算渗进 Session 会把一个可单测的纯函数变成一个隐藏行为），
// 而是由 `cli/repl.ts` 在组装完之后调一次。
//
// 最要紧的一条边界：**裁剪结果只用于本次请求，不回写 Session、不影响落盘**。
// `Session.messages` 与磁盘上的 JSONL 永远是完整历史 ——
// 这是「发给模型的内容」与「会话记得的内容」的区别，
// 和 D7 的「屏幕上看到的 ≠ 模型记得的」是同一类边界。

import type { Message } from '@/core/types.ts';

/**
 * 估算用的「字符 / token」比。
 *
 * **刻意取 1.5，而不是归档蓝图 §7 写的 4。** 蓝图那句话说「中文约 1.5 字符/token，
 * 英文约 4，取 4 作保守上界」—— 但方向是反的：`chars / 4` 对英文准，对**中文是低估**
 * （3 个汉字约合 2 token，而 chars/4 只给 0.75）。低估意味着「以为还没超预算、
 * 实际已经超了」，正好是不保守的那一侧。保守的做法是取**更小的除数**。
 *
 * 代价：英文材料会被高估约 2.7 倍。这是**有意**偏向安全的一侧 ——
 * 宁可早裁一轮，也不要发出一个必然被 API 拒掉的超长请求。
 */
const CHARS_PER_TOKEN = 1.5;

/**
 * 估算一段文本的 token 数（**保守上界**）。
 *
 * 已知的不精确处，写在这里免得将来被当成 bug：
 *
 * - 除数取 1.5 的理由见 `CHARS_PER_TOKEN`
 * - `String.length` 是 **UTF-16 码元**数：BMP 内的汉字算 1，emoji 等代理对算 2
 * - 估算**只用于预算决策**；真实用量以 API 返回的 `usage.prompt_tokens` 为准
 *
 * **不引入 tiktoken 之类的精确 tokenizer**：那会破坏「核心层零运行时依赖」
 * 这条跨阶段硬约束，还要为不同模型各带一份词表。在这个用途上误差完全够用。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** `fitToBudget` 的结果 */
export interface FittedContext {
  /** 实际要发给模型的消息数组 */
  messages: Message[];
  /** 被丢掉的消息**条数**（不是组数）；未裁剪时为 0 */
  dropped: number;
  /** 被丢掉的那些消息的估算 token 数；未裁剪时为 0 */
  droppedTokens: number;
  /**
   * 保留下来的消息的估算 token 数。
   *
   * 供 M4b 的校准用：它要和 API 返回的真实 `prompt_tokens` 比，而后者
   * 描述的是「这一次实际发出去的东西」—— 所以这里也必须是**裁剪后**的估算。
   */
  keptTokens: number;
}

/** 一轮在 `messages` 里的下标区间 `[start, end)` */
interface TurnGroup {
  start: number;
  end: number;
}

/**
 * 把 `messages` 切成「轮」。
 *
 * **按 user 消息切，不能按 role 交替推**：成功的轮次是 `user, assistant`，
 * 而**失败的轮次只留 user 不留 assistant**（D7），历史里于是会出现两个 user 相邻。
 * 按交替推会在那里切错，把一次失败的提问和下一次的提问绑成一组丢掉。
 *
 * index 0 是 system，**不参与分组**（它永不参与裁剪）。
 * 开头若有不以 user 起始的残余（比如文件第一行就是 assistant），它单独成一组，
 * 因此会最先被丢掉。
 */
function groupTurns(messages: Message[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  if (messages.length <= 1) return groups;

  let start = 1;
  for (let i = 2; i < messages.length; i += 1) {
    if (messages[i].role === 'user') {
      groups.push({ start, end: i });
      start = i;
    }
  }
  groups.push({ start, end: messages.length });
  return groups;
}

/**
 * 把 `[system, ...历史, 当前 user]` 裁到预算之内。
 *
 * 两条不可违反的规则：
 *
 * - **system 永不裁** —— 它是每次请求的稳定前缀，丢了等于换了个人设
 * - **最后一组永不裁** —— 那是当前这一问。连问题都丢掉，模型只会答非所问，
 *   比报错难查得多
 *
 * 裁剪单位是「轮」，**绝不拆半条消息**：留下一条没有问题的答案，
 * 比少一轮更糟。
 *
 * 返回值里的 `messages` 在未裁剪时**就是入参那个数组本身**（不做拷贝）——
 * 它只是被读一次就直送 `JSON.stringify`，全链路没有改动方。
 *
 * @param messages 已组装好的完整数组，index 0 是 system，最后一条是当前 user 消息
 * @param budget 软预算（token）。`<= 0` 时不需要特例：正常裁剪会一路丢到
 *   「只剩最后一组」为止，函数对任何输入都有定义
 */
export function fitToBudget(messages: Message[], budget: number): FittedContext {
  const tokens = messages.map((message) => estimateTokens(message.content));
  const total = tokens.reduce((sum, n) => sum + n, 0);

  // 快路径：没超预算就原样返回。调用方靠 dropped === 0 判断「要不要警告」，
  // 所以这条路径必须一个字节都不动。
  if (total <= budget) return { messages, dropped: 0, droppedTokens: 0, keptTokens: total };

  const groups = groupTurns(messages);

  // 从最老的一组开始丢，但**最后一组永不丢**（`cut < groups.length - 1`）。
  // 单条消息自己就超预算时，这个循环会自然停下并把超长的那条原样发出去 ——
  // 让 API 报错，比静默丢掉用户的问题好得多。
  let remaining = total;
  let dropped = 0;
  let droppedTokens = 0;
  let cut = 0;

  while (cut < groups.length - 1 && remaining > budget) {
    const group = groups[cut];
    for (let i = group.start; i < group.end; i += 1) {
      dropped += 1;
      droppedTokens += tokens[i];
      remaining -= tokens[i];
    }
    cut += 1;
  }

  // 一组都没丢掉：要么本来就只剩一轮（没有什么可裁），要么超预算的是最后一组
  if (dropped === 0) return { messages, dropped: 0, droppedTokens: 0, keptTokens: total };

  // 丢掉的必然是 index 1 起、连续的一段 —— 分组从 index 1 开始且首尾相接
  return {
    messages: [messages[0], ...messages.slice(1 + dropped)],
    dropped,
    droppedTokens,
    keptTokens: total - droppedTokens,
  };
}
