export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量，请先设置后重试。');
  }
  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: env.AI_CHAT_MODEL ?? 'deepseek-flash',
  };
}
