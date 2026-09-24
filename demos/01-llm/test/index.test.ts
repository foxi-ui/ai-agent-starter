// 入口文件的集成测试：真的把 src/index.ts 当子进程跑一遍。
//
// 退出码是进程级行为，单元测试断言不了——只能起一个真实进程观察。
// 本用例不触网：缺少 API key 时程序在发起请求之前就退出了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// 以本文件位置推导项目根，而不是依赖 cwd——
// 测试运行器可能从子目录派生进程。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 额外命令行参数，以及要喂给 stdin 的行（每行自动补换行） */
interface RunOptions {
  args?: string[];
  stdin?: string[];
}

function runCli(env: NodeJS.ProcessEnv, options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      ['--import', './loader.mjs', 'src/index.ts', ...(options.args ?? [])],
      {
        cwd: projectRoot,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // 无输入时也**必须**关掉 stdin：不关的话子进程读不到 EOF，
    // await 永不返回、整个文件超时。行为上等价于原来的 'ignore'。
    child.stdin.on('error', () => {
      // 子进程在读完 stdin 之前就退出（比如缺 key、参数非法）时，
      // 父进程侧的写入会拿到 EPIPE。那是预期内的，不该让测试进程崩掉。
    });
    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin.map((line) => line + '\n').join(''));
    }
    child.stdin.end();

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

// ── 会话持久化的子进程用例 ─────────────────────────────────────────────
//
// 这些用例把 AI_CHAT_HOME 指向各自的临时目录，绝不碰仓库里的 .sessions/。

const SESSION_ID = '20260924-143022-a3f1';

/** 每个用例一个独立 home，用完自动删 */
function tempHome(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-index-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 构造子进程环境。
 *
 * `DEEPSEEK_API_KEY` 与 `AI_CHAT_MODEL` 都**显式**设成确定值：
 * `pnpm test` 会用 `--env-file-if-exists` 加载 `.env` / `.env.local`，
 * 于是父进程里可能带着真实的 key 和本机的模型设置。不覆盖的话，
 * 错误路径的用例会先撞上「缺 key」，断言永远看不到真正要看的错因；
 * 模型相关的断言则会悄悄依赖开发者本机的配置。
 */
function runEnv(home: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: 'dummy-key-not-used-offline',
    AI_CHAT_MODEL: 'test-model',
    AI_CHAT_HOME: home,
    ...overrides,
  };
}

/** 用**手写的** JSON 行铺一个会话文件，不经过 serializeRecord */
function writeSessionFile(home: string, id: string, lines: string[]): string {
  const path = join(home, `${id}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

const META_LINE = `{"type":"meta","id":"${SESSION_ID}","createdAt":"2026-09-24T06:30:22.000Z","model":"deepseek-flash"}`;
const USER_LINE = '{"type":"message","role":"user","content":"用一句话说明什么是闭包"}';
const ASSISTANT_LINE =
  '{"type":"message","role":"assistant","content":"闭包是函数与其词法作用域的组合"}';

test('--resume 拿到路径穿越的 id：退出码 1，且不碰任何文件', async (t) => {
  const home = tempHome(t);

  const result = await runCli(runEnv(home), { args: ['--resume', '../../etc/passwd'] });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /会话 id 不合法：\.\.\/\.\.\/etc\/passwd/);
  // stdout 必须干净：此时还没有任何模型回答
  assert.equal(result.stdout, '');
  // 被拦下之后不该留下任何东西
  assert.deepEqual(readdirSync(home), []);
});

test('--resume 指向不存在的会话：退出码 1，且不偷偷开新会话', async (t) => {
  const home = tempHome(t);

  const result = await runCli(runEnv(home), { args: ['--resume', SESSION_ID] });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /会话不存在：20260924-143022-a3f1/);
  // 提示里带上会话目录，用户才知道该去哪儿找
  assert.ok(result.stderr.includes(home), `应指出会话目录：${result.stderr}`);
  // 关键：**没有**新建一个会话文件。静默换成新会话会让用户
  // 前面聊的内容全丢，而且他未必立刻发现。
  assert.deepEqual(readdirSync(home), []);
});

test('参数非法时报错并附用法，退出码 1', async (t) => {
  const home = tempHome(t);
  const cases: Array<[string[], RegExp]> = [
    [['--resume'], /--resume 需要一个会话 id/],
    [['--resum', SESSION_ID], /未知参数：--resum/],
    [['--'], /未知参数：--/],
  ];

  for (const [args, reason] of cases) {
    const result = await runCli(runEnv(home), { args });
    assert.equal(result.code, 1, `${args.join(' ')} 应当退出码 1`);
    assert.match(result.stderr, reason);
    assert.match(result.stderr, /用法：pnpm start \[--resume <会话 id>\]/);
    assert.equal(result.stdout, '', '错误信息不该进 stdout');
  }

  assert.deepEqual(readdirSync(home), [], '参数错误发生在创建任何文件之前');
});

test('新会话：stderr 报出 id，落盘恰好一行 meta', async (t) => {
  const home = tempHome(t);

  const result = await runCli(runEnv(home));

  assert.equal(result.code, 0);
  // stdout 只该有提示符：会话横幅是诊断信息，走 stderr
  assert.equal(result.stdout, 'You: ');

  const match = /\[session\] (\S+)/.exec(result.stderr);
  assert.ok(match !== null, `stderr 应报出会话 id：${result.stderr}`);
  const id = match[1];
  // spec §8 的 id 形状，正则写在测试里（不用 isValidSessionId 去验，那会自证）
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);

  // 目录里恰好一个文件，名字就是刚报出来的那个 id
  assert.deepEqual(readdirSync(home), [`${id}.jsonl`]);

  const text = readFileSync(join(home, `${id}.jsonl`), 'utf8');
  // 「一行一个 JSON、末尾有换行」的字节级契约
  assert.equal(text.split('\n').length, 2, `应当只是一行：${JSON.stringify(text)}`);

  const meta = JSON.parse(text.split('\n')[0]) as Record<string, unknown>;
  assert.equal(meta.type, 'meta');
  assert.equal(meta.id, id);
  assert.equal(meta.model, 'test-model');
  // createdAt 由 create 取当下时间，所以只钉形状（UTC 的 ISO 串），不钉值
  assert.match(String(meta.createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('打开一个已有会话：日志一行都不增长（回放不走广播）', async (t) => {
  // 实施计划里点名的第 2 号人工审查项，这里做端到端版本。
  // 若 Session 构造时把回放出来的历史逐条 append 一遍，每恢复一条就多写一行 ——
  // 打开一次日志翻一倍，打开两次翻两番。这条看的就是文件行数。
  const home = tempHome(t);
  const path = writeSessionFile(home, SESSION_ID, [META_LINE, USER_LINE, ASSISTANT_LINE]);
  const before = readFileSync(path, 'utf8');

  const result = await runCli(runEnv(home), { args: ['--resume', SESSION_ID] });

  assert.equal(result.code, 0);
  // 恰好 2 条 —— 坏行没被算进消息数
  assert.ok(
    result.stderr.includes(`[resumed] ${SESSION_ID}（2 条消息）`),
    `stderr：${result.stderr}`,
  );
  // 逐字节不变：既没多写行，也没被重写
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readFileSync(path, 'utf8').split('\n').length, 4, '三行 + 末尾换行');
});

test('会话含坏行：警告一次、其余照常恢复、退出码 0', async (t) => {
  const home = tempHome(t);
  // 中间那行是进程被 kill 时留下的半条记录
  const path = writeSessionFile(home, SESSION_ID, [
    META_LINE,
    '{"type":"message","role":"us',
    USER_LINE,
  ]);
  const before = readFileSync(path, 'utf8');

  const result = await runCli(runEnv(home), { args: ['--resume', SESSION_ID] });

  assert.equal(result.code, 0, '一行损坏不该让整场会话不可恢复');
  assert.match(result.stderr, /\[警告\] 已跳过 1 行无法解析的记录/);
  // 关键：坏行之后的**好行照常恢复**（1 条消息，而不是 0 条）。
  // 少了这条断言，实现把整份记录都丢掉也能全绿。
  assert.ok(
    result.stderr.includes(`[resumed] ${SESSION_ID}（1 条消息）`),
    `stderr：${result.stderr}`,
  );
  // 坏行不被静默"修复"掉，也不触发重写
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('--resume 沿用文件里记的模型（model 记录覆盖 meta）', async (t) => {
  const home = tempHome(t);
  writeSessionFile(home, SESSION_ID, [
    META_LINE,
    '{"type":"model","model":"deepseek-v4-pro"}',
    USER_LINE,
  ]);

  // `/model` 无参数是纯查询：不发请求、不改状态，所以这条不触网
  const result = await runCli(runEnv(home), {
    args: ['--resume', SESSION_ID],
    stdin: ['/model'],
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('当前模型：deepseek-v4-pro'), `stdout：${result.stdout}`);
  // 查询走 stdout，而 [resumed] 横幅走 stderr —— 两条流各归各的
  assert.ok(!result.stdout.includes('[resumed]'));
});

test('文件里没记模型时回落到 AI_CHAT_MODEL', async (t) => {
  const home = tempHome(t);
  // 没有 meta 也没有 model 记录（连第一行都不是 meta）——
  // replay 给出 model === null，由 index.ts 回落到环境变量
  writeSessionFile(home, SESSION_ID, [USER_LINE]);

  const result = await runCli(runEnv(home, { AI_CHAT_MODEL: 'fallback-model' }), {
    args: ['--resume', SESSION_ID],
    stdin: ['/model'],
  });

  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('当前模型：fallback-model'), `stdout：${result.stdout}`);
});

test('会话目录建不出来（父路径是普通文件）：退出码 1', async (t) => {
  const home = tempHome(t);
  const blocker = join(home, 'afile');
  writeFileSync(blocker, 'x', 'utf8');

  // 用结构制造 ENOTDIR，而不是 chmod 555 —— 以 root 运行时权限位不起作用
  const result = await runCli(runEnv(join(blocker, 'sub')));

  assert.equal(result.code, 1);
  assert.match(result.stderr, /无法创建会话文件/);
  // 建不了文件就别开始了 —— 这场对话注定存不下来
  assert.equal(result.stdout, '');
});

test('会话文件读不了（是目录，EISDIR）：退出码 1，不伪装成「会话不存在」', async (t) => {
  const home = tempHome(t);
  mkdirSync(join(home, `${SESSION_ID}.jsonl`));

  const result = await runCli(runEnv(home), { args: ['--resume', SESSION_ID] });

  assert.equal(result.code, 1);
  // 报「无法读取」而不是「会话不存在」：后者会把人引去查一个
  // 其实就在那儿的问题
  assert.match(result.stderr, /无法读取会话文件/);
  assert.ok(!result.stderr.includes('会话不存在'), `stderr：${result.stderr}`);
});

test('/sessions 在真实进程里列出当前会话并打 * 标记', async (t) => {
  // 这条覆盖的是**接线**，不是渲染格式（格式在 test/render.test.ts 里用手写字面量钉住）：
  // 当前会话 id 要从 src/index.ts 一路传到 cli/repl.ts 的 CommandDeps，
  // 中间任何一环传错或传空，`*` 就不会出现在当前会话那行 —— 分段测试看不出来。
  const home = tempHome(t);

  const result = await runCli(runEnv(home), { stdin: ['/sessions'] });

  assert.equal(result.code, 0);
  const match = /\[session\] (\S+)/.exec(result.stderr);
  assert.ok(match !== null, `stderr 应报出会话 id：${result.stderr}`);
  const id = match[1];

  // 行形如 `* <id>  MM-DD HH:MM  0 条`；时间列的具体切片另有测试钉住，这里只钉形状
  const pattern = new RegExp(`\\* ${id}  \\d{2}-\\d{2} \\d{2}:\\d{2}  0 条`);
  assert.match(result.stdout, pattern, `stdout：${JSON.stringify(result.stdout)}`);
  // 命令结果走 stdout，而 [session] 横幅走 stderr
  assert.ok(!result.stdout.includes('[session]'));
});

test('缺 API key 时在创建任何会话文件之前退出', async (t) => {
  const home = tempHome(t);
  const env = runEnv(home);
  delete env.DEEPSEEK_API_KEY;

  const result = await runCli(env);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /DEEPSEEK_API_KEY/);
  // resolveConfig 排在创建 store 之前，所以连目录都不该留下
  assert.deepEqual(readdirSync(home), []);
});

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
