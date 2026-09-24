// 命令行参数解析。
//
// 对应 spec §9（CLI 参数契约）与 §11 里「参数未知 / 缺值 → stderr + 退出码 1」两行。
// `parseArgs` 刻意是纯函数、抛错而不打印，所以这里不需要子进程也不需要捕获输出 ——
// 「把错误信息写出去 + 设退出码」由 src/index.ts 负责，那部分在 index.test.ts 里测。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '@/cli/args.ts';

/** spec §9 规定：**所有**抛错消息都要附这一行用法 */
const USAGE_PATTERN = /用法：pnpm start \[--resume <会话 id>\]/;

const VALID_ID = '20260924-143022-a3f1';

/** 跑一次解析并返回错误消息；没抛错就是用例失败 */
function expectThrow(argv: string[]): string {
  try {
    parseArgs(argv);
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail(`parseArgs(${JSON.stringify(argv)}) 应当抛错，但它正常返回了`);
}

test('无参数即开新会话', () => {
  assert.deepEqual(parseArgs([]), { kind: 'fresh' });
});

test('--resume 加合法 id 解析成恢复会话', () => {
  assert.deepEqual(parseArgs(['--resume', VALID_ID]), { kind: 'resume', id: VALID_ID });
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
