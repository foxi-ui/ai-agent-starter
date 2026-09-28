// 命令行参数解析。
//
// 对应 spec §9（CLI 参数契约）与 §11 里「参数未知 / 缺值 → stderr + 退出码 1」两行。
// `parseArgs` 刻意是纯函数、抛错而不打印，所以这里不需要子进程也不需要捕获输出 ——
// 「把错误信息写出去 + 设退出码」由 src/index.ts 负责，那部分在 index.test.ts 里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, DEFAULT_MAX_CONTEXT } from '@/cli/args.ts';

/** spec §7 规定：**所有**抛错消息都要附这一行用法（整行钉死，不是只匹配开头） */
const USAGE_PATTERN =
  /用法：pnpm start \[--resume <会话 id>\] \[--show-reasoning\] \[--no-thinking\] \[--max-context <n>\]$/;

const VALID_ID = '20260924-143022-a3f1';

/** 三个开关的默认值：全关，预算取默认。用它来写「其余不变」那部分期望值 */
const DEFAULTS = {
  showReasoning: false,
  noThinking: false,
  maxContext: DEFAULT_MAX_CONTEXT,
};

/** 跑一次解析并返回错误消息；没抛错就是用例失败 */
function expectThrow(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`parseArgs(${JSON.stringify(argv)}) 应当抛错，但它正常返回了`);
}

test('无参数即开新会话，三个开关取默认值', () => {
  assert.deepEqual(parseArgs([]), { kind: 'fresh', ...DEFAULTS });
  assert.equal(DEFAULT_MAX_CONTEXT, 64_000);
});

test('--resume 加合法 id 解析成恢复会话', () => {
  assert.deepEqual(parseArgs(['--resume', VALID_ID]), {
    kind: 'resume',
    id: VALID_ID,
    ...DEFAULTS,
  });
});

test('任何非法输入都抛错，且消息里同时有**具体错因**和用法行', () => {
  // 只断言 /用法/ 太松 —— 两个字而已，任何一条错误消息都能满足它。
  // 所以每条都断言具体子句，其中涉及 id 的还要求**带出出错的那个值**：
  // 用户复制粘贴一个坏 id 时，得从提示里看出到底哪儿不对。
  const cases: Array<[string[], RegExp]> = [
    // 缺值：说明缺的是什么，而不是笼统报「参数错误」
    [['--resume'], /--resume 需要一个会话 id/],
    // 多余参数：把多出来的部分原样报出来
    [['--resume', VALID_ID, 'extra'], /参数过多：extra/],
    // 路径穿越（spec §8 点名的三例）：id 会被拼进文件路径，必须过白名单
    [['--resume', '../../etc/passwd'], /会话 id 不合法：\.\.\/\.\.\/etc\/passwd/],
    [['--resume', 'a/b'], /会话 id 不合法：a\/b/],
    [['--resume', ''], /会话 id 不合法/],
    // 形状不符：大写十六进制不在白名单里
    [['--resume', '20260924-143022-A3F1'], /会话 id 不合法：20260924-143022-A3F1/],
    // 拼错的标志。这条是本文件最重要的一条 ——
    // 它若被静默忽略，程序会**悄悄开一个全新会话**，用户以为续上了、实际前面聊的全丢了，
    // 而且不会有任何提示。宁可报错。
    [['--resum', VALID_ID], /未知参数：--resum/],
    [['-x'], /未知参数：-x/],
    // 不带值的裸 `--`
    [['--'], /未知参数：--/],
  ];

  for (const [argv, reason] of cases) {
    const message = expectThrow(argv);
    assert.match(message, reason, `parseArgs(${JSON.stringify(argv)}) 的错因不对：${message}`);
    assert.match(message, USAGE_PATTERN, `缺少用法行：${message}`);
  }
});

test('`--` 被当成未知参数（pnpm 会把它原样转发进来）', () => {
  // 这条钉的是 parseArgs 自己的契约：argv 里出现 `--` 就是不认识。
  //
  // 为什么会有这一条：`pnpm start -- --resume <id>` 里的 `--` 被 pnpm 10.34.5 与
  // node v22.23.2 **原样**当作脚本参数转发，于是脚本收到的 argv[0] 就是 `--`，
  // 程序报「未知参数：--」并退出码 1。正确写法是不加 `--` 的 `pnpm start --resume <id>`。
  // （pnpm 逐层转发的实测过程见 docs/troubleshooting.md T13 —— parseArgs 看不见 pnpm，
  // 它只能测到「收到 `--` 就报错」这一层，转发的成因不归这条用例管。）
  assert.match(expectThrow(['--']), /未知参数：--/);
});

test('id 校验发生在解析阶段，任何 argv 都不会被当成空参数放过', () => {
  // 边界：argv 长度为 1 或 > 2 时走的是「缺值 / 过多」分支，不会去读 argv[1] 当 id。
  // 这条把「先卡长度、再验 id」的顺序钉住：若顺序反了，
  // ['--resume'] 会先读到 undefined 再报「不合法：undefined」，错因就偏了。
  assert.match(expectThrow(['--resume']), /需要一个会话 id/);
  assert.match(expectThrow(['--resume', VALID_ID, 'x']), /参数过多/);
});

test('抛出的确实是 Error，消息不含用法行之外的杂质', () => {
  // index.ts 直接把 message 写给 stderr，所以消息的形状就是用户看到的东西。
  // 这里确认它不以换行开头/结尾（否则 stderr 会出现空行）。
  let caught: unknown;
  try {
    parseArgs(['--resume', 'bad id']);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, '应当抛 Error 实例');
  const message = (caught as Error).message;
  assert.equal(message, message.trim(), `消息首尾不该有空白：${JSON.stringify(message)}`);
});

// ── M4a：三个开关 ──────────────────────────────────────────────────────

test('--show-reasoning 与 --no-thinking 各自打开对应开关', () => {
  assert.deepEqual(parseArgs(['--show-reasoning']), {
    kind: 'fresh',
    ...DEFAULTS,
    showReasoning: true,
  });
  assert.deepEqual(parseArgs(['--no-thinking']), {
    kind: 'fresh',
    ...DEFAULTS,
    noThinking: true,
  });
});

test('--max-context 覆盖默认预算', () => {
  assert.equal(parseArgs(['--max-context', '400']).maxContext, 400);
  // 下界：1 是合法的 —— 存在的意义就是能调到极小以便观察裁剪
  assert.equal(parseArgs(['--max-context', '1']).maxContext, 1);
});

test('三个开关与 --resume 任意顺序共存', () => {
  const expected = {
    kind: 'resume',
    id: VALID_ID,
    showReasoning: true,
    noThinking: false,
    maxContext: 400,
  };
  assert.deepEqual(parseArgs(['--resume', VALID_ID, '--show-reasoning', '--max-context', '400']), expected);
  assert.deepEqual(parseArgs(['--max-context', '400', '--show-reasoning', '--resume', VALID_ID]), expected);
  assert.deepEqual(parseArgs(['--show-reasoning', '--resume', VALID_ID, '--max-context', '400']), expected);
});

test('布尔开关重复给是幂等的', () => {
  assert.deepEqual(parseArgs(['--no-thinking', '--no-thinking']), {
    kind: 'fresh',
    ...DEFAULTS,
    noThinking: true,
  });
});

test('--no-thinking 与 --show-reasoning 同时给要报错', () => {
  // 关了 thinking 服务端就不会吐 reasoning，--show-reasoning 于是什么都不显示。
  // 静默接受的话，用户会以为「模型这次没思考」—— 而事实是它思考了、被自己关掉了。
  for (const argv of [
    ['--no-thinking', '--show-reasoning'],
    ['--show-reasoning', '--no-thinking'],
  ]) {
    const message = expectThrow(argv);
    assert.match(message, /--no-thinking 与 --show-reasoning 不能同时使用/);
    assert.match(message, USAGE_PATTERN);
  }
});

test('--max-context 的各类非法输入都报错，且带出收到的值', () => {
  const cases: Array<[string[], RegExp]> = [
    // 缺值
    [['--max-context'], /--max-context 需要一个正整数/],
    // 非数字
    [['--max-context', 'abc'], /收到：abc/],
    // 小数（正则里的 \d+ 挡掉小数点）
    [['--max-context', '1.5'], /收到：1\.5/],
    // 负数
    [['--max-context', '-1'], /收到：-1/],
    // 0 通不过 `> 0` 那道
    [['--max-context', '0'], /收到：0/],
    // 空串：一个数字都没有
    [['--max-context', ''], /--max-context 需要一个正整数/],
    // 超出安全整数范围
    [['--max-context', '999999999999999999999'], /收到：999999999999999999999/],
    // 后面跟的是另一个开关而不是数字 —— 把收到的值报出来，
    // 用户才看得出「我少写了一个参数」而不是「这个开关坏了」
    [['--max-context', '--no-thinking'], /收到：--no-thinking/],
  ];

  for (const [argv, reason] of cases) {
    const message = expectThrow(argv);
    assert.match(message, reason, `parseArgs(${JSON.stringify(argv)}) 的错因不对：${message}`);
    assert.match(message, USAGE_PATTERN, `缺少用法行：${message}`);
  }
});

test('--resume 重复给是报错而不是后者覆盖前者', () => {
  // 与布尔开关相反：它带值，重复给有歧义（到底续哪个？）。
  // 让后者静默胜出，就等于悄悄忽略了前一个 —— 同样是「静默地没做用户要的事」。
  const message = expectThrow(['--resume', VALID_ID, '--resume', VALID_ID]);
  assert.match(message, /参数过多：--resume/);
  assert.match(message, USAGE_PATTERN);
});
