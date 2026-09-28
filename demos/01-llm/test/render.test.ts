import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import {
  createStreamRenderer,
  renderCommandResult,
  renderUnknownCommand,
} from '@/cli/render.ts';

function collector(): { chunks: string[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { chunks, stream };
}

function setup(showReasoning = false) {
  const out = collector();
  const err = collector();
  const renderer = createStreamRenderer({
    output: out.stream,
    errorOutput: err.stream,
    showReasoning,
  });
  return { out, err, renderer };
}

test('text-delta 逐字写 stdout，不加换行', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '你好' });
  renderer.onEvent({ type: 'text-delta', text: '，世界' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 你好，世界\n');
  assert.deepEqual(err.chunks, []);
});

test('首个 reasoning-delta 在 stderr 写一行指示，且只写一次', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'reasoning-delta', text: '想' });
  renderer.onEvent({ type: 'reasoning-delta', text: '继续想' });
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考中…]\n');
  // 思考内容本身不出现
  assert.ok(!err.chunks.join('').includes('想'));
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('没有 reasoning 时 stderr 完全安静', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('finish 调两次只补一个换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.finish();
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 答\n');
});

test('整轮没有任何事件时，finish 不写任何东西（一上来就抛错的情形）', () => {
  const { out, renderer } = setup();
  renderer.finish();

  assert.deepEqual(out.chunks, []);
});

test('done 但整轮没有正文时，仍然写出 AI: 前缀', () => {
  // 与 M1 的非流式路径保持一致：那边对空回答写的是 `write(\`AI: ${content}\`)`，
  // content 为空串时同样会输出 `AI: `。两条路径的形状不能不一样。
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: \n');
});

test('前缀只写一次（多个 text-delta 不会重复前缀）', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '一' });
  renderer.onEvent({ type: 'text-delta', text: '二' });
  renderer.onEvent({ type: 'text-delta', text: '三' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 一二三\n');
});

test('finish_reason 为 length 时 stderr 警告截断', () => {
  const { out, err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半句' });
  renderer.onEvent({ type: 'done', reason: 'length' });
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半句\n');
  assert.equal(err.chunks.join(''), '[警告] 回答被截断（finish_reason=length）\n');
});

test('finish_reason 为 stop 时不警告', () => {
  const { err, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '答' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.deepEqual(err.chunks, []);
});

test('已输出正文但流中途失败：finish 仍补换行', () => {
  const { out, renderer } = setup();
  renderer.onEvent({ type: 'text-delta', text: '半截' });
  // 模拟 repl 的 catch 分支之后调用 finish
  renderer.finish();

  assert.equal(out.chunks.join(''), 'AI: 半截\n');
});

// ── M4a：--show-reasoning 展开思考全文 ────────────────────────────────
//
// 两种模式都走 stderr：stdout 的契约是「只有模型回答与命令结果」，
// `pnpm start > answers.txt` 必须拿到干净的答案文件（见 D-M4a-6）。

test('展开思考时全文写 stderr，stdout 一个字的思考都没有', () => {
  const { out, err, renderer } = setup(true);
  renderer.onEvent({ type: 'reasoning-delta', text: '先想' });
  renderer.onEvent({ type: 'reasoning-delta', text: '再想' });
  renderer.onEvent({ type: 'text-delta', text: '答案' });
  renderer.finish();

  // 前缀只写一次，正文紧随其后，末尾由 finish 补一个换行
  assert.equal(err.chunks.join(''), '[思考] 先想再想\n');
  // 关键断言：stdout 里没有「想」字
  assert.equal(out.chunks.join(''), 'AI: 答案\n');
  assert.ok(!out.chunks.join('').includes('想'), '思考文字泄漏到了 stdout');
});

test('展开思考时只补一个换行（finish 调两次也一样）', () => {
  const { err, renderer } = setup(true);
  renderer.onEvent({ type: 'reasoning-delta', text: '想' });
  renderer.finish();
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考] 想\n');
});

test('无 reasoning 时两种模式都不写任何前缀', () => {
  // 服务端忽略了 thinking 参数时就是这种情况：不能留下一个孤零零的 `[思考] `
  for (const showReasoning of [false, true]) {
    const { out, err, renderer } = setup(showReasoning);
    renderer.onEvent({ type: 'text-delta', text: '答' });
    renderer.onEvent({ type: 'done', reason: 'stop' });
    renderer.finish();

    assert.deepEqual(err.chunks, [], `showReasoning=${showReasoning}`);
    assert.equal(out.chunks.join(''), 'AI: 答\n', `showReasoning=${showReasoning}`);
  }
});

test('有思考但整轮没有正文时，stdout 仍补 AI: 前缀', () => {
  // 前缀的写出与思考无关：这两条流互不影响
  const { out, err, renderer } = setup(true);
  renderer.onEvent({ type: 'reasoning-delta', text: '想' });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考] 想\n');
  assert.equal(out.chunks.join(''), 'AI: \n');
});

test('默认模式下思考全文不出现（只留一行指示）', () => {
  // 与上面第一条对照：同一条事件流，开关不同，stderr 的形状完全不同
  const { err, renderer } = setup(false);
  renderer.onEvent({ type: 'reasoning-delta', text: '先想' });
  renderer.onEvent({ type: 'reasoning-delta', text: '再想' });
  renderer.finish();

  assert.equal(err.chunks.join(''), '[思考中…]\n');
});

test('renderCommandResult /clear 反馈条数', () => {
  const out = collector();
  renderCommandResult({ kind: 'cleared', removed: 3 }, { output: out.stream });
  assert.equal(out.chunks.join(''), '已清空 3 条消息。\n');
});

test('renderCommandResult /model 查询与切换', () => {
  const a = collector();
  renderCommandResult({ kind: 'model-current', model: 'deepseek-flash' }, { output: a.stream });
  assert.equal(a.chunks.join(''), '当前模型：deepseek-flash\n');

  const b = collector();
  renderCommandResult({ kind: 'model-changed', model: 'deepseek-v4-pro' }, { output: b.stream });
  assert.equal(b.chunks.join(''), '已切换模型：deepseek-v4-pro\n');
});

test('renderCommandResult /history 编号列出，带角色前缀', () => {
  const out = collector();
  renderCommandResult(
    {
      kind: 'history',
      messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '回答' },
      ],
    },
    { output: out.stream },
  );
  assert.equal(out.chunks.join(''), '1. [user] 问题\n2. [assistant] 回答\n');
});

test('renderCommandResult /history 空会话给明确提示', () => {
  const out = collector();
  renderCommandResult({ kind: 'history', messages: [] }, { output: out.stream });
  assert.equal(out.chunks.join(''), '(当前会话没有消息)\n');
});

test('renderCommandResult /history 每条截断到 200 字符', () => {
  const out = collector();
  const long = 'x'.repeat(250);
  renderCommandResult(
    { kind: 'history', messages: [{ role: 'user', content: long }] },
    { output: out.stream },
  );
  const text = out.chunks.join('');
  assert.equal(text, `1. [user] ${'x'.repeat(200)}…\n`);
});

test('renderCommandResult /history 恰好 200 字符不截断', () => {
  // 边界：截断条件是 `<= 200` 原样返回，写成 `< 200` 就会把恰好 200 的消息
  // 也切掉一截并加省略号。这条用例专门钉住这个「差一个」的边界。
  const out = collector();
  renderCommandResult(
    { kind: 'history', messages: [{ role: 'user', content: 'x'.repeat(200) }] },
    { output: out.stream },
  );
  assert.equal(out.chunks.join(''), `1. [user] ${'x'.repeat(200)}\n`);

  // 边界另一侧：201 已经越界，必须截断
  const over = collector();
  renderCommandResult(
    { kind: 'history', messages: [{ role: 'user', content: 'x'.repeat(201) }] },
    { output: over.stream },
  );
  assert.equal(over.chunks.join(''), `1. [user] ${'x'.repeat(200)}…\n`);
});

test('renderUnknownCommand 写 stderr，可用列表来自 COMMAND_NAMES', () => {
  const err = collector();
  renderUnknownCommand('/foo', { errorOutput: err.stream });
  assert.equal(
    err.chunks.join(''),
    '未知命令：/foo。可用：/clear /history /model /sessions\n',
  );
});

// ── /sessions 的列表渲染（spec §10）────────────────────────────────────
//
// 时间列从 id 里**就地切片**得来（id 前 15 位就是本地时间），所以这里的期望值
// 全是手写字面量 —— 切片下标写错一位，下面每条都会现形。

test('renderCommandResult /sessions 每行一个会话，当前会话行首打 *', () => {
  const out = collector();
  renderCommandResult(
    {
      kind: 'sessions',
      sessions: [
        { id: '20260924-143022-a3f1', messageCount: 6 },
        { id: '20260923-101500-7c2e', messageCount: 12 },
      ],
      currentId: '20260924-143022-a3f1',
    },
    { output: out.stream },
  );

  // 逐字节断言：行首标记、列间**两个**空格、时间格式、`N 条` 全在这两行里。
  // 非当前会话行首是一个空格，于是与 `*` 等宽、两列对齐。
  assert.equal(
    out.chunks.join(''),
    '* 20260924-143022-a3f1  09-24 14:30  6 条\n' +
      '  20260923-101500-7c2e  09-23 10:15  12 条\n',
  );
});

test('renderCommandResult /sessions 当前会话不在列表里时，没有行带 *', () => {
  const out = collector();
  renderCommandResult(
    {
      kind: 'sessions',
      sessions: [{ id: '20260924-143022-a3f1', messageCount: 6 }],
      // 指着一个不在列表里的 id（比如当前会话尚未落盘）
      currentId: '20991231-235959-ffff',
    },
    { output: out.stream },
  );

  const text = out.chunks.join('');
  assert.ok(!text.includes('*'), `不该出现 * 标记：${text}`);
});

test('renderCommandResult /sessions 空列表给明确提示', () => {
  const out = collector();
  renderCommandResult({ kind: 'sessions', sessions: [], currentId: 'x' }, { output: out.stream });
  assert.equal(out.chunks.join(''), '(还没有历史会话)\n');
});

test('renderCommandResult /sessions 的时间列按 id 精确切片', () => {
  // 边界：月/日/时/分全是需要补零或需要跨位读取的数字。
  // 下标写成 slice(4,6)/slice(6,8)/slice(9,11)/slice(11,13) 才对；
  // 比如把时分写成 slice(10,12)/slice(12,14) 会得到 `90:70`，
  // 把日写成 slice(7,9) 会得到 `-0`。
  const out = collector();
  renderCommandResult(
    {
      kind: 'sessions',
      sessions: [
        { id: '20260105-090700-0000', messageCount: 0 },
        { id: '20261231-235959-ffff', messageCount: 1 },
      ],
      currentId: '20260105-090700-0000',
    },
    { output: out.stream },
  );

  assert.equal(
    out.chunks.join(''),
    '* 20260105-090700-0000  01-05 09:07  0 条\n' +
      '  20261231-235959-ffff  12-31 23:59  1 条\n',
  );
});

// ── usage 事件（M4b） ─────────────────────────────────────────────────

test('usage 事件不产生任何输出', () => {
  // 这条测的是一个**安静的**错误：渲染器的最后一个分支是隐式的 done，
  // 加了 usage 变体之后它会掉进去，写出一个空的 `AI: ` 前缀 ——
  // 屏幕上多一行、重定向到文件里也多一行，而没有任何报错。
  //
  // 用量是用户敲 /usage 才看的东西，不该混进 stdout（D-M4b-7）。
  const { out, err, renderer } = setup();

  renderer.onEvent({
    type: 'usage',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      cachedTokens: 5,
      cacheMissTokens: 5,
      reasoningTokens: 2,
    },
  });
  renderer.finish();

  // out.chunks / err.chunks 是本文件既有 collector() 的形状
  assert.deepEqual(out.chunks, []);
  assert.deepEqual(err.chunks, []);
});

test('usage 夹在正文与 done 之间时，正文与前缀不受影响', () => {
  const { out, err, renderer } = setup();

  const u = {
    promptTokens: 1, completionTokens: 1, totalTokens: 2,
    cachedTokens: 0, cacheMissTokens: 1, reasoningTokens: 0,
  };
  renderer.onEvent({ type: 'text-delta', text: '你好' });
  renderer.onEvent({ type: 'usage', usage: u });
  renderer.onEvent({ type: 'done', reason: 'stop' });
  renderer.finish();

  // `AI: ` 前缀只写一次；usage 事件不额外产生前缀
  assert.equal(out.chunks.join(''), 'AI: 你好\n');
  assert.deepEqual(err.chunks, []);
});
