import { runRepl } from '@/cli/repl.ts';
import { resolveConfig, type Config } from '@/cli/config.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';

let config: Config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  output: process.stdout,
  prompt: 'You: ',
});
