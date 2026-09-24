// 入口文件的集成测试：真的把 src/index.ts 当子进程跑一遍。
//
// 退出码是进程级行为，单元测试断言不了——只能起一个真实进程观察。
// 本用例不触网：缺少 API key 时程序在发起请求之前就退出了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// 以本文件位置推导项目根，而不是依赖 cwd——
// 测试运行器可能从子目录派生进程。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--import', './loader.mjs', 'src/index.ts'],
      {
        cwd: projectRoot,
        env,
        // stdin 用 ignore：程序读不到输入会立刻结束，不会挂住测试
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('缺少 DEEPSEEK_API_KEY 时提示到 stderr 并以退出码 1 退出', async () => {
  // 复制一份环境变量再删掉 key，而不是直接传 {}：
  // `pnpm test` 会加载 .env / .env.local，父进程里可能已经存在真实 key，
  // 必须显式删除才是「模拟未配置」。
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;

  const result = await runCli(env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /DEEPSEEK_API_KEY/);
  // stdout 必须干净：此时还没有任何模型回答，
  // 提示信息跑到 stdout 会让 `> answers.txt` 收到一行垃圾
  assert.equal(result.stdout, '');
});
