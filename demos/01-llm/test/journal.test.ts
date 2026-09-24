// 会话日志的纯逻辑：序列化/解析、回放、id 生成与校验。
//
// 这个文件对应 M3 的 spec §7（JSONL 格式契约）与 §8（会话 id 与路径安全）。
// 它不需要文件系统 —— `journal.ts` 刻意不碰 node:fs，所以这里全是纯函数调用。
//
// 期望值一律**手写字面量**，不拿 `serializeRecord` 去生成 `parseRecord` 的输入、
// 也不拿被测函数去算期望值：那样两边同源，断言恒真，测不出任何东西。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidSessionId,
  makeSessionId,
  parseRecord,
  replay,
  serializeRecord,
  type SessionRecord,
} from '@/core/journal.ts';

// 把本文件的进程时区锚定到 Asia/Shanghai，让「本地时间」那组断言在任何机器上都成立、
// 并且**真的能抓到**误用 `toISOString()`。
//
// 为什么必须锚定：在 TZ=UTC 的机器上，「按本地分量取」与「把 UTC 串切片」的结果逐字符
// 相同 —— 那条断言会静默退化成空转（正是 D37 抱怨的「看着绿但什么都没说明」）。
// 实测：启动时 TZ=UTC 的进程里执行下面这行赋值，offset 由 0 变为 -480，即运行时生效。
// node --test 默认每个测试文件一个独立子进程，所以这次赋值的作用域只到本文件。
process.env.TZ = 'Asia/Shanghai';

test('前置条件：本进程时区已锚定为 Asia/Shanghai', () => {
  // 这条断言的是**测试自身的环境**，不是被测代码。
  // 有了它，万一某个平台忽略运行时 TZ 变更，这里会大声失败并说明原因，
  // 而不是让下面那条本地时间断言悄悄退化成空转。
  assert.equal(new Date(2026, 8, 24, 14, 30, 22).getUTCHours(), 6);
});

test('手写的 JSON 行能被解析成对应的记录', () => {
  // 方向一：**字符串字面量 → 记录对象**。
  // 输入是手写的线上格式，不用 serializeRecord 生成 —— 否则输入与期望同源。
  assert.deepEqual(parseRecord('{"type":"clear"}'), { type: 'clear' });
  assert.deepEqual(parseRecord('{"type":"model","model":"deepseek-v4-pro"}'), {
    type: 'model',
    model: 'deepseek-v4-pro',
  });
  assert.deepEqual(
    parseRecord('{"type":"message","role":"user","content":"什么是闭包"}'),
    { type: 'message', role: 'user', content: '什么是闭包' },
  );
  assert.deepEqual(
    parseRecord(
      '{"type":"meta","id":"20260924-143022-a3f1","createdAt":"2026-09-24T06:30:22.000Z","model":"deepseek-flash"}',
    ),
    {
      type: 'meta',
      id: '20260924-143022-a3f1',
      createdAt: '2026-09-24T06:30:22.000Z',
      model: 'deepseek-flash',
    },
  );
});

test('记录对象能被序列化成约定的 JSON 行', () => {
  // 方向二：**记录对象 → JSON.parse 后的对象**。
  // 用 JSON.parse 而不是字符串比对，是为了不钉键序，但 strict 的 deepEqual
  // 仍能抓出字段多写、少写或改名（比如 content 被写成 text）。
  const records: SessionRecord[] = [
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: '什么是闭包' },
    { type: 'message', role: 'assistant', content: '函数与词法作用域的组合' },
    { type: 'message', role: 'system', content: '你是 CLI AI 助手' },
    { type: 'clear' },
    { type: 'model', model: 'deepseek-v4-pro' },
  ];

  for (const record of records) {
    assert.deepEqual(JSON.parse(serializeRecord(record)), record);
  }
});

test('序列化 → 解析往返一致（自洽性，不单独证明格式对）', () => {
  // 这条只证明「自己跟自己一致」：两个方向的格式契约分别由上面两条用例钉住，
  // 单看这条，把 content 两边同时改名之类的变异是全绿的。
  const records: SessionRecord[] = [
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: '什么是闭包' },
    { type: 'clear' },
    { type: 'model', model: 'deepseek-v4-pro' },
  ];

  for (const record of records) {
    assert.deepEqual(parseRecord(serializeRecord(record)), record);
  }
});

test('序列化结果是一行紧凑 JSON（不拼换行、不美化）', () => {
  // 「一行一条 JSON」是文件格式的契约本身，不只是实现细节：
  // 多一个换行会让一次写入变成两条记录，缩进会让 load 的逐行 split 失效。
  // 所以这里直接钉住线上的字节形状，而不是只测往返。
  assert.equal(serializeRecord({ type: 'clear' }), '{"type":"clear"}');
  assert.equal(
    serializeRecord({ type: 'message', role: 'user', content: 'a' }),
    '{"type":"message","role":"user","content":"a"}',
  );
  assert.equal(
    serializeRecord({ type: 'model', model: 'deepseek-flash' }),
    '{"type":"model","model":"deepseek-flash"}',
  );
});

test('空行与纯空白行返回 null（不算坏行）', () => {
  // 末尾那个换行 split 之后就是空串 —— 它必须被当作「没有这一行」，
  // 否则每个会话文件都会平白多出一条「坏行」计数。
  assert.equal(parseRecord(''), null);
  assert.equal(parseRecord('   '), null);
  assert.equal(parseRecord('\t'), null);
});

test('非法 JSON 返回 null 而不抛错', () => {
  // 进程被 kill 会留下半行；文件也可能被人手改坏。
  // 「一行损坏不该让整场会话不可恢复」（spec D-M3-6），所以这里必须是 null 而不是 throw。
  assert.equal(parseRecord('{'), null);
  assert.equal(parseRecord('{"type":"message","role":"user"'), null);
  assert.equal(parseRecord('这不是 JSON'), null);
});

test('合法 JSON 但不是普通对象时返回 null', () => {
  // 数组、null、数字、字符串都能被 JSON.parse 成功解析，
  // 但它们没有 type 字段可言，必须与坏行同等待遇。
  assert.equal(parseRecord('[]'), null);
  assert.equal(parseRecord('null'), null);
  assert.equal(parseRecord('42'), null);
  assert.equal(parseRecord('"message"'), null);
});

test('字段缺失或类型不符的记录返回 null', () => {
  // 这里刻意不在 JSON 里相信任何东西：每个字段都逐个 typeof 校验。
  // 下面每一条都对应 parseRecord 里的一个校验分支。
  const badLines = [
    // meta 三个字段都必须是非空字符串
    '{"type":"meta","createdAt":"2026-09-24T06:30:22.000Z","model":"deepseek-flash"}',
    '{"type":"meta","id":42,"createdAt":"2026-09-24T06:30:22.000Z","model":"deepseek-flash"}',
    '{"type":"meta","id":"20260924-143022-a3f1","model":"deepseek-flash"}',
    '{"type":"meta","id":"20260924-143022-a3f1","createdAt":"2026-09-24T06:30:22.000Z"}',
    // message 的 role 只认三种，content 必须是字符串
    '{"type":"message","role":"tool","content":"a"}',
    '{"type":"message","content":"a"}',
    '{"type":"message","role":"user","content":123}',
    '{"type":"message","role":"user"}',
    // model 记录的 model 必须是字符串
    '{"type":"model"}',
    '{"type":"model","model":null}',
  ];

  for (const line of badLines) {
    assert.equal(parseRecord(line), null, `应判为坏行：${line}`);
  }
});

test('不认识的 type 返回 null —— 这是格式的前向兼容位', () => {
  // 将来真加了新记录类型，旧版本程序读到它应当**跳过**而不是崩。
  // 这条用例把「未知即跳过」钉成有意行为，免得被当成漏判而改成抛错。
  assert.equal(parseRecord('{"type":"usage","promptTokens":10}'), null);
  assert.equal(parseRecord('{"foo":"bar"}'), null);
});

test('replay：meta 定初始模型，message 按序累积', () => {
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: '第一问' },
    { type: 'message', role: 'assistant', content: '第一答' },
  ]);

  assert.deepEqual(result, {
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ],
    model: 'deepseek-flash',
  });
});

test('replay：model 记录覆盖 meta 里的初始模型', () => {
  // `/model <name>` 切过模型后 resume，必须接着用**切换后**的模型，
  // 否则用户改过的设置会在重启后悄悄回退。
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'model', model: 'deepseek-v4-pro' },
    { type: 'message', role: 'user', content: '第一问' },
  ]);

  assert.equal(result.model, 'deepseek-v4-pro');
});

test('replay：只有首个 meta 生效，后续 meta 不覆盖', () => {
  // 正常文件里 meta 只出现在第一行。这条钉住的是回放的取舍：
  // meta 代表「文件创建时的初始模型」，它可以被 model 记录覆盖，但不被另一个 meta 覆盖。
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: '初始模型' },
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T07:00:00.000Z', model: '后来的模型' },
  ]);

  assert.equal(result.model, '初始模型');
});

test('replay：clear 清空消息，但**不清模型**', () => {
  // 这条是 spec §7 与 D-M3 特意点名的坑：`/clear` 清的是对话内容，不是会话配置
  // （与 Session.clear() 不影响 currentModel 严格对齐）。
  // 回放时若顺手把 model 也置空，resume 出来的模型就会与 clear 前不一致。
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: 'clear 之前说的' },
    { type: 'clear' },
  ]);

  assert.deepEqual(result, { messages: [], model: 'deepseek-flash' });
});

test('replay：clear 只影响它之前的消息，之后的消息照常累积', () => {
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'deepseek-flash' },
    { type: 'message', role: 'user', content: '被清掉的' },
    { type: 'clear' },
    { type: 'message', role: 'user', content: 'clear 之后说的' },
    { type: 'message', role: 'assistant', content: 'clear 之后的回答' },
  ]);

  assert.deepEqual(result.messages, [
    { role: 'user', content: 'clear 之后说的' },
    { role: 'assistant', content: 'clear 之后的回答' },
  ]);
});

test('replay：meta / model / message / clear 交错时按顺序折叠', () => {
  const result = replay([
    { type: 'meta', id: '20260924-143022-a3f1', createdAt: '2026-09-24T06:30:22.000Z', model: 'A' },
    { type: 'message', role: 'user', content: '1' },
    { type: 'model', model: 'B' },
    { type: 'message', role: 'assistant', content: '2' },
    { type: 'clear' },
    { type: 'model', model: 'C' },
    { type: 'message', role: 'user', content: '3' },
  ]);

  assert.deepEqual(result, {
    messages: [{ role: 'user', content: '3' }],
    model: 'C',
  });
});

test('replay：空记录数组给出空会话与 null 模型', () => {
  // model 为 null 表示「文件里既没有 meta 也没有 model 记录」，
  // 由调用方回落到环境变量里的模型（见 src/index.ts）。
  // 0 字节的空文件走的就是这条路径。
  assert.deepEqual(replay([]), { messages: [], model: null });
});

test('makeSessionId：用本地时间分量，不是 UTC', () => {
  // 这条钉住 spec §8 点名的坑：**不能用 toISOString()**。
  // 文件顶部已把本进程锚定到 Asia/Shanghai（UTC+8），于是 14:30 本地 = 06:30 UTC，
  // 误用 toISOString() 会得到 20260924-063022-ab12，被这条抓住。
  //
  // 注意构造方式：必须用**本地构造器** `new Date(2026, 8, 24, 14, 30, 22)` 逐分量喂。
  // 若写成 `new Date('2026-09-24T14:30:22Z')`，期望值本身就依赖机器时区了 ——
  // 那才是真正的 flaky（在 UTC+8 下正确实现会算出 22:30:22）。
  assert.equal(
    makeSessionId(new Date(2026, 8, 24, 14, 30, 22), 'ab12'),
    '20260924-143022-ab12',
  );
});

test('makeSessionId：月/日/时/分/秒的单个数字都补成两位', () => {
  // 1 月 5 日 3:07:09 —— 五个分量全是单位数。
  // 少补一个零会让 id 变成 202615-... 这种长度不符的形状，
  // 于是 isValidSessionId 会拒掉自己刚生成的 id。
  assert.equal(
    makeSessionId(new Date(2026, 0, 5, 3, 7, 9), '0000'),
    '20260105-030709-0000',
  );
});

test('makeSessionId：年份固定四位、suffix 原样带上', () => {
  assert.equal(
    makeSessionId(new Date(2026, 11, 31, 23, 59, 59), 'ffff'),
    '20261231-235959-ffff',
  );
});

test('makeSessionId 的输出通过 isValidSessionId（格式自洽）', () => {
  // 第一条断言用的是**测试内手写**的正则，独立于被测代码。
  const id = makeSessionId(new Date(2026, 8, 24, 14, 30, 22), 'a3f1');
  assert.match(id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);

  // 第二条断言的是两个函数之间的契约：**自己生成的 id 必须能被自己校验通过**。
  // 它确实是在拿被测代码验证被测代码，所以单看它证明不了格式对不对 ——
  // 但「改了 id 格式却忘了同步白名单正则」会让新会话无法被 --resume 恢复，
  // 而这条能抓住那个自相矛盾。上面那条手写正则负责钉住格式本身。
  assert.equal(isValidSessionId(id), true);
});

test('isValidSessionId 只放行 YYYYMMDD-HHMMSS-xxxx 形状', () => {
  const cases: Array<[string, boolean]> = [
    ['20260924-143022-a3f1', true],
    ['20260105-030709-0000', true],
    // 路径穿越：这几个是 `--resume` 必须拦下的输入（spec §8）
    ['../../etc/passwd', false],
    ['..', false],
    ['a/b', false],
    ['/', false],
    ['20260924-143022-a3f1/../../../etc/passwd', false],
    ['', false],
    // 大写十六进制不在白名单里
    ['20260924-143022-A3F1', false],
    // 位数不符
    ['2026924-143022-a3f1', false],
    ['20260924-14302-a3f1', false],
    ['20260924-143022-a3f', false],
    ['20260924-143022-a3f11', false],
    // 分隔符写错
    ['20260924_143022_a3f1', false],
    ['20260924-143022-a3f1.jsonl', false],
    ['./20260924-143022-a3f1', false],
    [' 20260924-143022-a3f1', false],
    ['20260924-143022-a3f1 ', false],
  ];

  for (const [id, expected] of cases) {
    assert.equal(isValidSessionId(id), expected, `isValidSessionId(${JSON.stringify(id)})`);
  }
});
