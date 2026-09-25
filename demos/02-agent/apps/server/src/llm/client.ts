// LLM 客户端的接口。core 层只认它，不知道背后是 DeepSeek。
//
// 它是本项目最重要的一个测试接缝：测试塞一个手写的对象字面量进来，
// 整个 Agent 循环就能在没有网络、没有 API key 的情况下被断言。

import type { ChatOptions, ChatResult, Message } from '@/core/types.ts';

export interface LLMClient {
  chat(messages: Message[], options?: ChatOptions): Promise<ChatResult>;
}

export interface LLMClientConfig {
  /** API key，只从环境变量读，禁止写死 */
  apiKey: string;
  /** 例如 https://api.deepseek.com */
  baseUrl: string;
  model: string;
}
