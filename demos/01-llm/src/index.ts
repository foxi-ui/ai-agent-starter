// 程序入口：解析配置 → 组装依赖 → 启动 REPL。
//
// 这里是唯一允许直接接触 process 的地方
// （读环境变量、读写标准输入输出、决定退出码）。

import { runRepl } from '@/cli/repl.ts';
import { resolveConfig, type Config } from '@/cli/config.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';

// 先解析配置。缺少 API key 就完全没必要进入 REPL，
// 所以在启动前就拦下来。
let config: Config;
try {
  config = resolveConfig(process.env);
} catch (error) {
  // 错误信息写给 stderr 而不是 stdout，避免污染正常输出
  console.error((error as Error).message);
  // 退出码 1 表示失败。脚本和 CI 靠它判断这次运行是否正常
  process.exit(1);
}

// 依赖注入：工厂造出具体客户端，再交给 runRepl。
// runRepl 只认 LLMClient 接口，所以这里换成任何实现都能跑。
runRepl(createDeepSeekClient(config), {
  input: process.stdin,
  // 模型回答与命令结果 → stdout
  output: process.stdout,
  // 错误与诊断 → stderr，两条流互不污染
  errorOutput: process.stderr,
  prompt: 'You: ',
  model: config.model,
});
