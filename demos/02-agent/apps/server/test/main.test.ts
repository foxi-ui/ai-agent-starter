import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * 子进程级集成测试：断言真实的启动行为与退出码。
 *
 * 为什么不直接用单元测试：把 process.exit(1) 改成 throw，单元测试依然全绿，
 * 而脚本与 CI 的判断依据已经坏了。
 */
function runServer(env: Record<string, string>) {
  let out = '';
  let err = '';
  const child = spawn(process.execPath, ['--import', './loader.mjs', 'src/main.ts'], {
    cwd: process.cwd(),
    // 用确定的 env，**不继承**父进程真实的 DEEPSEEK_API_KEY ——
    // 否则「缺 key 该退出」这类用例会被父进程的环境悄悄救活
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  return { child, stdout: () => out, stderr: () => err };
}

test('缺 DEEPSEEK_API_KEY 时退出码 1，错误走 stderr', async () => {
  const { child, stderr } = runServer({});

  const [code] = (await once(child, 'exit')) as [number];
  assert.strictEqual(code, 1);
  assert.match(stderr(), /DEEPSEEK_API_KEY/);
});

test('起来后在 stdout 打印真实端口，能真的服务，SIGTERM 能干净退出', async () => {
  const { child, stdout } = runServer({
    DEEPSEEK_API_KEY: 'test-key-not-used',
    AI_AGENT_PORT: '0',
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`没等到端口公告，stdout=${stdout()}`)), 10_000);
      const poll = setInterval(() => {
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout());
        if (match) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      }, 20);
    });

    assert.ok(port > 0, 'port 0 应被内核替换成真实端口');

    const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST' });
    assert.strictEqual(response.status, 201);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
