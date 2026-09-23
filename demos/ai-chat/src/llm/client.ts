// LLM 客户端的接口定义（只有类型，没有实现）。
//
// 这是整个架构的「接缝」：CLI 只依赖这个接口，不关心背后
// 是 DeepSeek 还是别的服务商。好处是测试时可以塞一个假实现进去，
// 于是 REPL 的全部行为都能在没有网络、没有 API key 的情况下断言。

import type { ChatResult, Message } from "@/core/types.ts";

/**
 * 一次对话补全的调用入口。
 *
 * 所有实现都必须满足这个约定：给定完整的消息数组，返回模型的回答。
 */
export interface LLMClient {
  /**
   * 发送一次请求，拿到模型的回答。
   *
   * @param messages 完整对话历史（含 system），按时间顺序排列
   * @returns 模型回答；失败时应当抛出 Error，而不是返回空值
   */
  chat(messages: Message[]): Promise<ChatResult>;
}

/** 连接一个 LLM 服务所需的配置 */
export interface LLMClientConfig {
  /** API 密钥。只从环境变量读入，禁止写死在代码里 */
  apiKey: string;
  /** 服务地址，例如 https://api.deepseek.com */
  baseUrl: string;
  /** 模型名，例如 deepseek-flash */
  model: string;
}

/**
 * 「配置 → 客户端」的工厂函数类型。
 *
 * 用于依赖注入：入口拿到配置后调用工厂造出客户端，再把它传给
 * `runRepl`。`runRepl` 全程只认 `LLMClient` 接口，不知道具体实现。
 */
export type LLMClientFactory = (config: LLMClientConfig) => LLMClient;
