// 会话日志：记录格式、解析、回放，以及会话存储的接口。
//
// **纯逻辑** —— 这里不 import node:fs、不写 stdout/stderr。
// 真正读写文件的实现由 cli/store.ts 提供（实现下面这个 SessionStore 接口），
// 这样 core 层仍然可以在没有文件系统的前提下被推理和测试。
//
// 与 LLMClient 是同一个套路：接口在里层、实现在外层、调用方只认接口。

import type { Message, Role } from '@/core/types.ts';
import type { UsageEntry } from '@/core/usage.ts';

/**
 * 会话状态的一次变更。
 *
 * `Session` 在三个变更点广播它，它同时也是日志里**除 meta 外的全部内容**。
 * 单独定义成一个联合（而不是直接复用 SessionRecord）是为了让 Session 的
 * 广播签名只覆盖「变更」，不含只在建文件时写一次的 meta。
 *
 * ⚠️ 有一个成员**不由 `Session` 广播**：`usage`。账本不是会话消息的一部分，
 * 由 `repl` 在成功轮次直接交给 store（D-M4b-16）。它放进这个联合只是为了让
 * `store.append` 的签名不必放宽。
 */
export type SessionChange =
  | { type: 'message'; role: Role; content: string }
  | { type: 'clear' }
  | { type: 'model'; model: string }
  /**
   * 账本记录。
   *
   * **唯一一个不由 `Session` 广播的变体** —— 账本不是会话消息的一部分，
   * 由 `repl` 在成功轮次直接交给 store（D-M4b-16）。放进这个联合是为了让
   * `store.append` 的签名不必放宽，不是因为它真的属于「会话状态」。
   */
  | { type: 'usage'; entry: UsageEntry };

/** 日志里的一行 */
export type SessionRecord =
  | { type: 'meta'; id: string; createdAt: string; model: string }
  | SessionChange;

/**
 * 一个会话的概要，供 /sessions 展示。
 *
 * 刻意不含 createdAt：展示用的时间直接从 id 切（id 前 15 位就是本地时间），
 * 不必再经过 new Date(iso) + 时区换算 —— 那会让同一份文件在不同 TZ 的机器上
 * 显示成不同的时间，而 id 是死的、在哪台机器上都一样。
 */
export interface SessionSummary {
  id: string;
  /** `message` 记录的条数；`clear` / `model` 不算 */
  messageCount: number;
}

/** 一次 load 的结果 */
export interface LoadedSession {
  records: SessionRecord[];
  /** 被跳过的坏行数（JSON 解析失败、或形状不认识的行） */
  skipped: number;
}

/**
 * 会话存储的接缝。core 只认这个接口，实现由 cli 提供。
 *
 * 有了它，core 层完全不碰 node:fs；测试也能塞一个内存实现进来。
 */
export interface SessionStore {
  /** 创建会话文件并写入 meta 行；文件已存在时抛错（独占创建） */
  create(id: string, model: string): void;
  /** 追加一条变更记录；文件不存在时抛错 */
  append(id: string, change: SessionChange): void;
  /**
   * 读回全部记录。
   *
   * 「会话不存在」返回 null —— 那是正常分支，由调用方给出友好提示；
   * 其余 IO 错误（权限、目录不可读）**原样抛出**，两者不可混为一谈。
   */
  load(id: string): LoadedSession | null;
  /**
   * 列出全部会话，按 id 倒序（id 前缀是时间戳，故字典序倒序即时间倒序）。
   * 会话目录不存在时返回空数组，不抛错 —— 首次运行时目录还没被创建过。
   */
  list(): SessionSummary[];
}

/**
 * 会话 id 的形状：`YYYYMMDD-HHMMSS-xxxx`。
 *
 * 只允许数字、短横、小写十六进制 —— 不含 `/`、`.`，所以拼进路径时
 * 走不出会话目录。这是路径穿越的第一道防线（第二道在 cli/store.ts）。
 */
const SESSION_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** 校验会话 id 是否合法。见 SESSION_ID_PATTERN 的说明 */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * 生成会话 id。
 *
 * @param now 当前时间；传入而不是内部取，测试才能喂固定值
 * @param suffix 4 位小写十六进制，避免同一秒内启动两次撞名
 */
export function makeSessionId(now: Date, suffix: string): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');

  // 逐段取本地时间分量，**不要用 toISOString()** —— 后者是 UTC，
  // 东八区会得到早 8 小时的文件名。那是个安静的错误：
  // `ls` 出来看着也像那么回事，只是时间对不上。
  //
  // 注意 getMonth() 是 0 基的，所以要 +1。
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;

  return `${date}-${time}-${suffix}`;
}

/**
 * 记录 → 一行文本（**不含换行符**）。
 *
 * 包一层而不是各处直接 JSON.stringify，是为了让「一行一条 JSON」这个格式
 * 只有一个落点 —— 将来要加字段或换格式，改这里就够了。
 */
export function serializeRecord(record: SessionRecord): string {
  return JSON.stringify(record);
}

/**
 * 一行文本 → 记录。空行或坏行返回 null，**不抛错**。
 *
 * 「坏行不抛错」是刻意的：进程被 kill 时会留下半行，文件也可能被人手改坏，
 * 一行损坏不该让整场会话不可恢复（对齐 spec 的 D-M3-6）。
 * 调用方通过计数得知跳过了多少行。
 */
export function parseRecord(line: string): SessionRecord | null {
  const trimmed = line.trim();
  // 空行不是坏行 —— 文件末尾那个换行 split 之后就是空串
  if (trimmed === '') return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // 非法 JSON：半行、或手改坏了
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;

  // 这里必须断言：JSON.parse 的返回值是 any，而我们刚刚确认过它是个普通对象。
  // 断言只用于把它降级成「键未知的对象」，之后每个字段都逐个 typeof 校验，
  // 没有一行代码相信 JSON 里的内容。
  const record = value as Record<string, unknown>;

  switch (record.type) {
    case 'meta':
      if (
        typeof record.id !== 'string' ||
        typeof record.createdAt !== 'string' ||
        typeof record.model !== 'string'
      ) {
        return null;
      }
      return { type: 'meta', id: record.id, createdAt: record.createdAt, model: record.model };

    case 'message': {
      const role = record.role;
      if (role !== 'system' && role !== 'user' && role !== 'assistant') return null;
      if (typeof record.content !== 'string') return null;
      return { type: 'message', role, content: record.content };
    }

    case 'clear':
      return { type: 'clear' };

    case 'model':
      if (typeof record.model !== 'string') return null;
      return { type: 'model', model: record.model };

    case 'usage': {
      const entry = record.entry;
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
      const e = entry as Record<string, unknown>;

      if (typeof e.at !== 'string' || typeof e.model !== 'string') return null;
      if (typeof e.estimatedPromptTokens !== 'number') return null;
      if (typeof e.usage !== 'object' || e.usage === null || Array.isArray(e.usage)) return null;

      const u = e.usage as Record<string, unknown>;
      const numbers = [
        'promptTokens',
        'completionTokens',
        'totalTokens',
        'cachedTokens',
        'cacheMissTokens',
        'reasoningTokens',
      ];
      // 六个字段一个都不能少、都必须是数字 —— 缺一个就让整条记录当坏行跳过，
      // 而不是补 0 混过去：补 0 会让金额静默偏低，而坏行至少会被计数报出来
      for (const key of numbers) {
        if (typeof u[key] !== 'number') return null;
      }

      return {
        type: 'usage',
        entry: {
          at: e.at,
          model: e.model,
          usage: {
            promptTokens: u.promptTokens as number,
            completionTokens: u.completionTokens as number,
            totalTokens: u.totalTokens as number,
            cachedTokens: u.cachedTokens as number,
            cacheMissTokens: u.cacheMissTokens as number,
            reasoningTokens: u.reasoningTokens as number,
          },
          estimatedPromptTokens: e.estimatedPromptTokens,
        },
      };
    }

    default:
      // 不认识的 type 也当坏行跳过。将来真加了新记录类型，
      // 旧版本程序读到它会跳过而不是崩 —— 这条路径顺便充当了格式兼容位
      // （`usage` 在 M4b 之前正是靠它被跳过的，见 test/journal.test.ts）。
      return null;
  }
}

/**
 * 按顺序折叠记录，重建会话状态。
 *
 * @returns messages 重建出的历史；model 为 null 表示文件里既没有 meta
 *          也没有 model 记录（调用方回落到环境变量里的模型）
 */
export function replay(records: SessionRecord[]): {
  messages: Message[];
  model: string | null;
  usageEntries: UsageEntry[];
} {
  // 这三个变量就是本次回放的全部状态
  const messages: Message[] = [];
  let model: string | null = null;
  // 账本独立于 messages —— `clear` 清前者不清它（D-M4b-15）
  const usageEntries: UsageEntry[] = [];

  for (const record of records) {
    switch (record.type) {
      case 'meta':
        // 只有首个 meta 生效 —— 它是文件创建时写下的初始模型。
        // 后面若还有 meta（正常不会），不覆盖。
        if (model === null) model = record.model;
        break;

      case 'message':
        messages.push({ role: record.role, content: record.content });
        break;

      case 'model':
        model = record.model;
        break;

      case 'usage':
        usageEntries.push(record.entry);
        break;

      case 'clear':
        // **只清消息、不清模型、也不清账本**。
        //
        // 模型：`/clear` 清的是对话内容，不是会话配置（与 Session.clear() 对齐）。
        // 账本：记的是「这个会话文件累计花了多少」，钱已经花掉了，与消息内容无关
        //   （D-M4b-15）。顺手清掉会让 /usage 与账单对不上，而且这个改动
        //   看起来非常「对称」、非常容易被后人做出来 —— 所以测试专门钉了它。
        //
        // 这两条都必须与 Session.clear() 的语义严格对齐：这里若顺手把 model
        // 也置空，resume 出来的模型就会和清空前不一致。
        messages.length = 0;
        break;
    }
  }

  return { messages, model, usageEntries };
}
