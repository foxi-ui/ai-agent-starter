// 程序入口：解析配置与参数 → 新建或恢复会话 → 组装依赖 → 启动 REPL。
//
// 这里是唯一允许直接接触 process 的地方
// （读环境变量与命令行、读写标准输入输出、决定退出码）。

import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { runRepl } from '@/cli/repl.ts';
import { resolveConfig, type Config } from '@/cli/config.ts';
import { parseArgs, type Args } from '@/cli/args.ts';
import { createFileStore } from '@/cli/store.ts';
import { replay, makeSessionId, type LoadedSession } from '@/core/journal.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import type { Message } from '@/core/types.ts';

/** 会话目录的默认位置。跟着 cwd 走，可用 AI_CHAT_HOME 覆盖 */
const DEFAULT_SESSION_DIR = '.sessions';

// 配置与参数一起解析。
//
// **顺序是刻意的**：resolveConfig 排在 parseArgs 前面 ——
// 缺 key 与参数写错同时发生时先报缺 key，保持 M1 的既有行为不变。
// 两者都在创建任何文件之前退出。
let config: Config;
let args: Args;
try {
  config = resolveConfig(process.env);
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  // 错误信息写给 stderr 而不是 stdout，避免污染正常输出。
  // 退出码 1 表示失败，脚本和 CI 靠它判断这次运行是否正常
  console.error((error as Error).message);
  process.exit(1);
}

const sessionDir = process.env.AI_CHAT_HOME ?? DEFAULT_SESSION_DIR;
const store = createFileStore(sessionDir);

let sessionId: string;
let model: string;
let history: Message[];

if (args.kind === 'resume') {
  sessionId = args.id;
  model = config.model;
  history = [];

  let loaded: LoadedSession | null = null;
  try {
    loaded = store.load(sessionId);
  } catch (error) {
    console.error(`无法读取会话文件：${(error as Error).message}`);
    process.exit(1);
  }

  if (loaded === null) {
    // 不偷偷开一个新会话 —— 用户明确指名了要续哪个，
    // 静默换成新会话会把他前面聊的内容全丢掉，且他未必立刻发现
    console.error(`会话不存在：${sessionId}（会话目录：${resolve(sessionDir)}）`);
    process.exit(1);
  }

  if (loaded.skipped > 0) {
    // 坏行不致命：一行损坏不该让整场会话不可恢复
    console.error(`[警告] 已跳过 ${loaded.skipped} 行无法解析的记录`);
  }

  const replayed = replay(loaded.records);
  history = replayed.messages;
  // 文件里没记过模型（没有 meta 也没有 model 记录）时回落到环境变量的模型
  model = replayed.model ?? config.model;

  console.error(`[resumed] ${sessionId}（${history.length} 条消息）`);
} else {
  // 随机后缀避免同一秒内启动两次撞名
  sessionId = makeSessionId(new Date(), randomBytes(2).toString('hex'));
  model = config.model;
  history = [];

  try {
    store.create(sessionId, model);
  } catch (error) {
    // 建不了文件就别开始了：这场对话注定存不下来，早点死比聊完才发现好
    console.error(`无法创建会话文件：${(error as Error).message}`);
    process.exit(1);
  }

  console.error(`[session] ${sessionId}`);
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
  model,
  sessionId,
  history,
  store,
});
