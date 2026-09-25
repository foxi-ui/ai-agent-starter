// 与服务端说话的唯一入口。
//
// **路径一律是相对的**（`/api/...`）：dev 时由 Vite 的 proxy 反代到 :3000，
// 将来同源部署时不用改一行。写成 `http://localhost:3000/...` 会让 proxy 完全失效、
// 触发 CORS 报错，而那个报错会把人引向「加 cors 中间件」这个错误解法。

import type {
  ApiErrorBody,
  CreateSessionResponse,
  HistoryResponse,
  SendMessageResponse,
} from './types.ts';

const BASE = '/api';

/** 带状态码与业务 code 的错误，方便调用方区分「会话没了」与「其它失败」 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init);

  if (!response.ok) {
    // 服务端保证错误体是 JSON；但万一不是（比如反向代理插了一页 HTML），
    // 也不能让 res.json() 的 SyntaxError 把真正的原因盖掉
    let code = 'unknown';
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // 保留上面的兜底文案
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
}

export async function createSession(): Promise<CreateSessionResponse> {
  return await request<CreateSessionResponse>('/sessions', { method: 'POST' });
}

export async function sendMessage(sessionId: string, message: string): Promise<SendMessageResponse> {
  return await request<SendMessageResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

export async function fetchHistory(sessionId: string): Promise<HistoryResponse> {
  return await request<HistoryResponse>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
}
