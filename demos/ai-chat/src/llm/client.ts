import type { ChatResult, Message } from "@/core/types.ts";

export interface LLMClient {
  chat(messages: Message[]): Promise<ChatResult>;
}

export interface LLMClientConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export type LLMClientFactory = (config: LLMClientConfig) => LLMClient;