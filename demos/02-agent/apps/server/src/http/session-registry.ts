// 服务端的会话表：一个会话 id 对应一个 Session 实例。
//
// 两件事必须放在一起做，所以它们在同一个文件里：
//
//   1. 持有会话（Map + FIFO 上限）
//   2. **串行化同一会话上的请求**
//
// 第 2 条不是优化，是正确性（spec §11 要点 3）：Session.append 是同步无锁的，
// 而 runSessionTurn 中间有 await。两个请求同时在途时，两条 user 消息会都先落地，
// 第二条的 toMessages() 里就出现「assistant{tool_calls} 没有对应的 tool 回应」，
// 上游直接 400 —— 而那个报错完全不指向并发。
// 锁必须与 Map 在同一个持有者手里，才有地方存这条链。

import { Session } from '@/core/session.ts';

/** 会话不存在。HTTP 层据此返回 404，与「服务端出错」区分开 */
export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`会话不存在：${id}`);
    this.name = 'SessionNotFoundError';
  }
}

export interface SessionRegistry {
  create(): { session: Session; id: string };
  /** 取会话；不存在返回 null */
  get(id: string): Session | null;
  /**
   * 在指定会话上串行执行 `fn`。
   *
   * 同一个 id 上的多次调用按发起顺序一个接一个跑，不同 id 互不影响。
   * 会话不存在时抛 `SessionNotFoundError`。
   */
  run<T>(id: string, fn: (session: Session) => Promise<T>): Promise<T>;
  /** 当前持有的会话数。**不暴露给 HTTP**，只给测试与诊断用 */
  size(): number;
}

export function createSessionRegistry(options: {
  newId: () => string;
  model: string;
  /** 上限；超出后按创建顺序淘汰最早的。默认 100（spec D16） */
  maxSessions?: number;
}): SessionRegistry {
  const maxSessions = options.maxSessions ?? 100;

  // Map 保持插入顺序，所以「第一个键」就是最早创建的那个 —— FIFO 不需要额外的队列
  const sessions = new Map<string, Session>();
  /**
   * 每个会话的队尾。存进去的**一定是不会 reject 的承诺**：
   * 没人在等它的 promise 一旦 reject 就会触发 unhandledRejection。
   */
  const tails = new Map<string, Promise<void>>();

  const evictOldest = (): void => {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) return;
      sessions.delete(oldest.value);
      tails.delete(oldest.value);
    }
  };

  return {
    create() {
      const id = options.newId();
      const session = new Session(options.model);
      sessions.set(id, session);
      evictOldest();
      return { session, id };
    },

    get(id) {
      return sessions.get(id) ?? null;
    },

    async run<T>(id: string, fn: (session: Session) => Promise<T>): Promise<T> {
      const session = sessions.get(id);
      if (!session) throw new SessionNotFoundError(id);

      const previous = tails.get(id) ?? Promise.resolve();

      // 两个分支都调 fn：前一次的失败是**它的**失败，不该让这一次也失败
      const current = previous.then(
        () => fn(session),
        () => fn(session),
      );

      // 队尾存「忽略结果的版本」：只需要顺序，不要把上一轮的值或错误带下去
      tails.set(
        id,
        current.then(
          () => undefined,
          () => undefined,
        ),
      );

      return await current;
    },

    size() {
      return sessions.size;
    },
  };
}
