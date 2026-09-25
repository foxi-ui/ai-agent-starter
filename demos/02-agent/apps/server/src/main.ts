// 服务端的进程入口。**整个 src/ 里只有这一个文件碰 process。**
//
// 它负责装配：把具体实现（DeepSeek client、真实工具注册表、会话表）
// 造出来交给 createApp；createApp 只认接口，所以测试能塞假的进去。

import { resolveConfig } from '@/llm/config.ts';
import { createDeepSeekClient } from '@/llm/deepseek.ts';
import { createToolRegistry } from '@/tools/registry.ts';
import { createSessionRegistry } from '@/http/session-registry.ts';
import { createApp } from '@/http/app.ts';
import { newSessionId } from '@/http/ids.ts';
import type { LLMClientConfig } from '@/llm/client.ts';

const DEFAULT_PORT = 3000;
/** 只监听回环地址。这是个本机开发工具，不是可暴露的服务（spec D17） */
const DEFAULT_HOST = '127.0.0.1';

/**
 * 读配置。缺 key 就让进程在**启动时**死掉 ——
 * 带着空 key 起来只会让第一次请求拿到一个 401 再回头猜原因。
 *
 * 写成独立函数而不是内联的 try/catch：`process.exit` 的类型是 `never`，
 * 于是这个函数在所有路径上都满足「有返回值」，不必引入一个可空的 `let config`。
 */
function loadConfig(): LLMClientConfig {
  try {
    return resolveConfig(process.env);
  } catch (error) {
    process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const config = loadConfig();

// 端口 0 表示「由内核分配一个空闲端口」—— 子进程测试靠这个避免端口冲突
const port = Number(process.env.AI_AGENT_PORT ?? DEFAULT_PORT);
const host = process.env.AI_AGENT_HOST ?? DEFAULT_HOST;

const sessions = createSessionRegistry({ newId: newSessionId, model: config.model });

const app = createApp({
  client: createDeepSeekClient(config),
  registry: createToolRegistry(),
  sessions,
  model: config.model,
  // 诊断日志的真实实现放在入口 —— 这是 `src/` 里唯一允许碰 process 的文件，
  // 也是 `http/app.ts` 的 logError 之所以必填的原因
  logError: (message: string) => {
    process.stderr.write(message + '\n');
  },
});

const server = app.listen(port, host, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  // 这一行走 **stdout**：它是服务端最主要的一条给人看的信息，
  // 而且测试要从这里读出「内核分了哪个端口」。
  // （01-llm 的 stdout/stderr 分流规矩不适用于服务端 —— 那边 stdout 要留给模型回答。）
  process.stdout.write(`[http] listening on http://${host}:${actualPort}\n`);
});

// 优雅退出：让子进程测试能干净地收掉它，也让 Ctrl+C 不留悬挂连接
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // close() 只停止接受新连接，keep-alive 的连接会拖住回调 ——
    // 主动断掉它们，否则 Ctrl+C 之后进程要等好几秒才退
    server.closeAllConnections();
  });
}
