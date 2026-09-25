// 把任意异常映射成 HTTP 状态码。
//
// **不引入错误类型体系**（spec §11）：llm/deepseek.ts 至今只抛裸 Error
// （消息里带着上游状态码的字符串），引入带 code 的 LLMError 是 01-llm
// 明确推给 M6 的欠账，本项目只在 HTTP 边界做最小可区分的映射。

/**
 * 唯一一条硬约束：**上游的 status 绝不原样透出**。
 *
 * `res.status(401)` 会把「我们的 DeepSeek key 无效」变成
 * 「你这个浏览器用户没登录」，前端会去查一个根本不存在的登录态。
 * 上游状态码只允许出现在 message 文本里。
 */
export function mapErrorToStatus(error: unknown): { status: number; code: string } {
  const message = error instanceof Error ? error.message : String(error);

  // deepseek.ts 的非 2xx 抛错格式（见 llm/deepseek.ts）
  if (/^DeepSeek API error \d{3}:/.test(message)) {
    return { status: 502, code: 'upstream_error' };
  }

  // undici 的连接失败、DNS 失败、连接被中途掐断
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|aborted/i.test(message)) {
    return { status: 504, code: 'upstream_unreachable' };
  }

  return { status: 500, code: 'internal' };
}
