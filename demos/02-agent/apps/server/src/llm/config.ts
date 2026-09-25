// 配置解析：环境变量 → LLMClientConfig。
//
// 它住在 llm/ 而不是某个「入口」文件里，是因为它产出的就是
// 「怎么连 LLM 服务商」这件事的配置，而且是**纯函数** ——
// env 由参数传入，自己不读 process.env、不打印、不碰 IO，因此可以离线测。
//
// 做成参数而不是内部读 process.env，还有一个实际好处：
// 测试能构造任意环境，不必改全局状态。

import type { LLMClientConfig } from '@/llm/client.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

/**
 * 从环境变量解析出客户端配置。
 *
 * @throws 缺少 `DEEPSEEK_API_KEY` 时抛错 —— 与其带着空 key 发请求、
 *   拿到一个 401 再猜原因，不如在启动时就死掉
 */
export function resolveConfig(env: NodeJS.ProcessEnv): LLMClientConfig {
  const apiKey = env.DEEPSEEK_API_KEY;
  // 用 `!apiKey` 而不是 `??`：空串也是「没配」，而 `'' ?? x` 会放行空串
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量（可写在 .env.local 里）');
  }

  return {
    apiKey,
    baseUrl: env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
    model: env.AI_CHAT_MODEL ?? DEFAULT_MODEL,
  };
}
