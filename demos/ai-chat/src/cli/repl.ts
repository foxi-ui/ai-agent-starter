import { createInterface } from 'node:readline';
import { Session } from '@/core/session.ts';
import type { LLMClient } from '@/llm/client.ts';

export const SYSTEM_PROMPT = '你是 CLI AI 助手，简洁直接地回答问题。';

export interface ReplOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  prompt: string;
}

export async function runRepl(
  client: LLMClient,
  options: ReplOptions,
): Promise<void> {
  const session = new Session();
  const rl = createInterface({ input: options.input, output: options.output });

  const write = (text: string) => {
    options.output.write(text + '\n');
  };

  write(options.prompt);

  // for await 逐行处理：每行的异步工作 await 完成后才进入下一行，
  // 循环在输入流关闭（rl 触发 close）时自然结束，避免异步竞态。
  for await (const line of rl) {
    const question = line.trim();
    if (question === '') continue;

    session.append('user', question);
    try {
      const result = await client.chat(session.toMessages(SYSTEM_PROMPT));
      session.append('assistant', result.content);
      write(result.content);
    } catch (error) {
      write(`[error] ${(error as Error).message}`);
    }
  }
}
