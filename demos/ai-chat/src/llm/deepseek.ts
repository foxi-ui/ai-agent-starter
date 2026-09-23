import type { LLMClient, LLMClientConfig } from '@/llm/client.ts';
import type { Message, ChatResult } from '@/core/types.ts';

export function createDeepSeekClient(config: LLMClientConfig): LLMClient {
  const url = `${config.baseUrl}/chat/completions`;

  return {
    async chat(messages: Message[]): Promise<ChatResult> {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, messages }),
      });

      if (!response.ok) {
        const text = await response.text();
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { error?: { message?: string } };
          if (parsed.error?.message) detail = parsed.error.message;
        } catch {
          // 保留原始 body 作为错误信息
        }
        throw new Error(
          `DeepSeek API error ${response.status}: ${detail}`,
        );
      }

      const data = (await response.json()) as {
        choices: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices[0]?.message?.content ?? '';
      return { content };
    },
  };
}
