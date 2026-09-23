// 读取并整理环境变量。
//
// 把「环境变量名 → 配置对象」这一步单独拎出来，有两个好处：
//   1. 入口文件保持干净，只负责组装和启动；
//   2. 默认值和校验逻辑可以被单独测试——测试直接传一个对象进来，
//      不必真的去改 process.env。

/** 连接 DeepSeek 所需的全部配置 */
export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * 从环境变量解析出配置。
 *
 * - `DEEPSEEK_API_KEY`  必需，缺失则抛错
 * - `DEEPSEEK_BASE_URL` 可选，默认 https://api.deepseek.com
 * - `AI_CHAT_MODEL`     可选，默认 deepseek-flash（最便宜，适合反复调试）
 *
 * @param env 环境变量对象。之所以传入而不是内部直接读 process.env，
 *            是为了让测试能自由构造输入
 * @throws 缺少 DEEPSEEK_API_KEY 时抛出
 */
export function resolveConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.DEEPSEEK_API_KEY;
  // 这里用 if 而不是 ??，是因为空字符串「」也应当算缺失。
  // ?? 只对 null / undefined 生效，拦不住空串。
  if (!apiKey) {
    throw new Error('缺少 DEEPSEEK_API_KEY 环境变量，请先设置后重试。');
  }
  return {
    apiKey,
    // ?? 的含义：左侧是 null / undefined 时才取右侧的默认值
    baseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    model: env.AI_CHAT_MODEL ?? 'deepseek-flash',
  };
}
