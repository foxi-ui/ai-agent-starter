// 命令行参数解析。
//
// 单独一个文件、纯函数、抛错而不打印：这样它能在不碰 process 的前提下被推理。
// 「把错误信息写出去 + 设退出码」留在 src/index.ts（唯一允许碰 process 的地方）。

import { isValidSessionId } from '@/core/journal.ts';

/** 本次启动的形态：开新会话，或恢复一个已存在的会话 */
export type Args = { kind: 'fresh' } | { kind: 'resume'; id: string };

/**
 * 用法提示。出错时附在错误信息后面 —— 用户看到的第一眼就知道该怎么写。
 *
 * **不要写成 `pnpm start -- --resume <id>`**：实测（pnpm 10.34.5）那个 `--`
 * 会被原样转发进来、成为 argv[0]，于是报「未知参数：--」。这与 npm 的
 * 「`--` 之后才是脚本参数」惯例相反，所以这里按实测结果写。
 */
const USAGE = '用法：pnpm start [--resume <会话 id>]';

/**
 * 解析 `process.argv.slice(2)`（即去掉 node 与脚本路径之后的部分）。
 *
 * @throws 参数非法时抛出 Error，消息里带一行用法
 */
export function parseArgs(argv: string[]): Args {
  if (argv.length === 0) return { kind: 'fresh' };

  const [flag] = argv;

  // 未知参数**必须报错，不能忽略**。
  // 反例：`--resum xxx`（少一个 e）若被静默忽略，程序会开一个全新会话，
  // 用户以为续上了、实际上前面聊的全丢了 —— 这种失败没有任何提示，
  // 比直接报错糟糕得多。
  if (flag !== '--resume') {
    throw new Error(`未知参数：${flag}\n${USAGE}`);
  }

  if (argv.length === 1) {
    throw new Error(`--resume 需要一个会话 id\n${USAGE}`);
  }

  if (argv.length > 2) {
    throw new Error(`参数过多：${argv.slice(2).join(' ')}\n${USAGE}`);
  }

  // 走到这里 argv.length 必为 2
  const id = argv[1];

  // id 会被拼进文件路径，所以必须过白名单。
  // `--resume ../../etc/passwd` 就是一次路径穿越 —— 见 core/journal.ts 的
  // SESSION_ID_PATTERN 与 cli/store.ts 的第二道防线。
  if (!isValidSessionId(id)) {
    throw new Error(`会话 id 不合法：${id}\n${USAGE}`);
  }

  return { kind: 'resume', id };
}
