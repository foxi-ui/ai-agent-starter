// 线上契约的**抄写**（spec D15）。
//
// 为什么不跨包 import 服务端的类型：那要把服务端的 @types/node 拖进前端 tsconfig，
// 而这份 tsconfig 刻意设了 `types: []` —— 前端不应依赖 Node 的类型。
// 而且线上契约本来就不是服务端的内部 `Message` 联合，它是 `TranscriptItem`，是另一个东西。
//
// 真正的守卫在 apps/server/test/http-app.test.ts：那里逐字断言了响应 JSON 的键与形状。
// 这份文件改了而那边没改，服务端测试不会红 —— 所以改这里之前先看一眼那份测试。

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** 模型给的原始 JSON 字符串 */
      argumentsText: string;
      /** true=成功，false=失败，null=没等到结果 */
      ok: boolean | null;
      result: string;
    };

/** `POST /api/sessions` 的响应 */
export interface CreateSessionResponse {
  sessionId: string;
  model: string;
}

/**
 * `POST /api/sessions/:id/messages` 的响应。
 *
 * `items` 是**本轮新增**的展示项（工具轨迹 + 回答），**不含用户那条** ——
 * 前端已经知道自己发了什么。整段会话由 `GET` 提供，两者同一种形状（spec §9）。
 */
export interface SendMessageResponse {
  items: TranscriptItem[];
  stopReason: 'answered' | 'max-steps';
}

/** `GET /api/sessions/:id/messages` 的响应。`items` 是**整段会话** */
export interface HistoryResponse {
  items: TranscriptItem[];
}

/** 所有非 2xx 响应的统一形状 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}
