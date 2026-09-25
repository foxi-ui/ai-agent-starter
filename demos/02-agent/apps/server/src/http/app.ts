// HTTP 层的全部路由与中间件。**导出的是「造 app」而不是「跑 app」** ——
// 不在这里 listen，测试才能用临时端口把它跑起来、跑完就关（spec §11 要点 1）。
//
// 这一层是唯一允许 import express 的地方；core / llm / tools / presentation
// 都不知道它的存在。

import express from 'express';
// 只当类型用的导入必须写 `import type`：Node 的原生类型擦除看不出
// `Request` 是个类型，会原样保留这条值导入，运行时抛
// 「does not provide an export named 'Request'」，而 tsc 完全放行。
import type { Express, NextFunction, Request, Response } from 'express';

import { runSessionTurn } from '@/core/agent.ts';
import { SYSTEM_PROMPT } from '@/core/prompt.ts';
import { foldTranscript } from '@/presentation/transcript.ts';
import { SessionNotFoundError } from '@/http/session-registry.ts';
import { mapErrorToStatus } from '@/http/errors.ts';
import type { SessionRegistry } from '@/http/session-registry.ts';
import type { ToolRegistry } from '@/core/tool-registry.ts';
import type { LLMClient } from '@/llm/client.ts';

export interface AppDeps {
  client: LLMClient;
  registry: ToolRegistry;
  sessions: SessionRegistry;
  /** 建会话时用的模型名 */
  model: string;
  systemPrompt?: string;
  maxSteps?: number;
  /**
   * 服务端诊断日志。**必填、且由调用方注入** ——
   * 这里刻意**不给**一个写 `process.stderr` 的默认实现：
   * spec §3 的硬约束是「只有 `src/main.ts` 碰 `process`」，
   * 而 `http/` 里出现 `process.stderr` 就把那条约束破了（哪怕只在一个兜底分支里）。
   * 由 main.ts 注入真实现、测试注入空实现，这一层就永远不碰 process。
   */
  logError: (message: string) => void;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const systemPrompt = deps.systemPrompt ?? SYSTEM_PROMPT;
  const logError = deps.logError;
  const sessionPath = '/api/sessions/:id/messages';

  // 请求体限制：这个接口只收一句话，32KB 远远够用，
  // 顺带挡掉「发一个巨大 body 把内存吃掉」这种最朴素的情况
  app.use(express.json({ limit: '32kb' }));

  app.post('/api/sessions', (_req: Request, res: Response) => {
    const { session, id } = deps.sessions.create();
    res.status(201).json({ sessionId: id, model: session.model });
  });

  app.post(sessionPath, async (req: Request, res: Response) => {
    // express 5 在没有 `content-type: application/json` 时不给 req.body 兜底成 {}，
    // 而是留成 undefined —— 直接取 .message 会抛 TypeError 变成 500。
    // 所以这里必须先判 undefined 再判类型（spec §11 的 4→5 陷阱之一）。
    const body = req.body as { message?: unknown } | undefined;
    if (typeof body?.message !== 'string' || body.message.trim() === '') {
      res.status(400).json({
        error: { code: 'invalid_message', message: 'message 必须是非空字符串' },
      });
      return;
    }
    const question = body.message.trim();
    const sessionId = req.params.id;

    try {
      const turn = await deps.sessions.run(sessionId, async (session) =>
        await runSessionTurn(session, deps.client, deps.registry, question, {
          systemPrompt,
          ...(deps.maxSteps === undefined ? {} : { maxSteps: deps.maxSteps }),
        }),
      );

      res.json({
        // `items` 是**本轮新增**的展示项：工具轨迹 + 最终回答。
        // **不含用户那条** —— 前端已经知道自己发了什么，也已经先渲染出来了。
        // 整段会话的展示项由 GET 提供，两者同一个 foldTranscript，只差范围（spec §9）。
        items: foldTranscript(turn.added),
        stopReason: turn.stopReason,
      });
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        res.status(404).json({ error: { code: 'session_not_found', message: error.message } });
        return;
      }
      // 其余交给错误中间件。express 5 会把 async handler 的 rejected promise
      // 自动转过去 —— 这正是选 express 5 而不是 4 的主要理由（spec D12）
      throw error;
    }
  });

  app.get(sessionPath, (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const session = deps.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({
        error: { code: 'session_not_found', message: `会话不存在：${sessionId}` },
      });
      return;
    }
    // 刻意**不加会话锁**：history() 返回的是深拷贝，读不会与在途的一轮打架；
    // 加锁反而会让一次刷新页面等完一个几十秒的回答
    res.json({ items: foldTranscript(session.history()) });
  });

  // 404 兜底。**不用 `app.get('*')`** —— express 5 的 path-to-regexp v8
  // 不再接受裸 `*`，会在启动时就抛「Missing parameter name」（spec §11 的另一个 4→5 陷阱）。
  // 用 app.use 更稳，而且必须返回 JSON：express 默认的 HTML 错误页会让
  // 前端的 res.json() 抛 SyntaxError，表现为一个完全不指向原因的解析错误。
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'not_found', message: '没有这个接口' } });
  });

  // 错误中间件：必须**恰好一个、注册在最后**，且是 4 参函数
  // （express 按函数 arity 识别它，写成 3 参会变成普通中间件）
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // body-parser 解析失败时抛的 SyntaxError **自带 status: 400**，
    // 不先放行它就会被当成服务端错误返回 500（spec §13）
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: { code: 'invalid_body', message: '请求体不是合法 JSON' },
      });
      return;
    }

    const mapped = mapErrorToStatus(error);
    const detail = error instanceof Error ? error.message : String(error);
    logError(`[http] ${mapped.status} ${mapped.code}: ${detail}`);
    res.status(mapped.status).json({ error: { code: mapped.code, message: detail } });
  });

  return app;
}
