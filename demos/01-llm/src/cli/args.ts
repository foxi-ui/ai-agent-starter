// 命令行参数解析。
//
// 单独一个文件、纯函数、抛错而不打印：这样它能在不碰 process 的前提下被推理。
// 「把错误信息写出去 + 设退出码」留在 src/index.ts（唯一允许碰 process 的地方）。

import { isValidSessionId } from '@/core/journal.ts';

/**
 * 上下文软预算的默认值（token）。
 *
 * 取十进制的 64K 而不是 2^16 —— 它约束的是 **token 数**不是字节数。
 * 这个数字在 1M 上下文下几乎不会命中；它能被 `--max-context` 调小到几百，
 * 正是为了让裁剪在真实使用中能被观察到（见 D-M4a-9）。
 */
export const DEFAULT_MAX_CONTEXT = 64_000;

/** 本次启动的形态与三个开关 */
export type Args = {
  /** 展开思考全文到 stderr，来自 --show-reasoning */
  showReasoning: boolean;
  /** 关闭 thinking，来自 --no-thinking */
  noThinking: boolean;
  /** 上下文软预算（token），来自 --max-context，默认 DEFAULT_MAX_CONTEXT */
  maxContext: number;
} & (
  | { kind: 'fresh' }
  | { kind: 'resume'; id: string }
);

/**
 * 用法提示。出错时附在错误信息后面 —— 用户看到的第一眼就知道该怎么写。
 *
 * **不要写成 `pnpm start -- --resume <id>`**：实测（pnpm 10.34.5）那个 `--`
 * 会被原样转发进来、成为 argv[0]，于是报「未知参数：--」。这与 npm 的
 * 「`--` 之后才是脚本参数」惯例相反，所以这里按实测结果写。
 */
const USAGE =
  '用法：pnpm start [--resume <会话 id>] [--show-reasoning] [--no-thinking] [--max-context <n>]';

/**
 * 解析 `--max-context` 的值。
 *
 * 正则先挡掉负数、小数、空串（`-1` 带减号、`1.5` 带小数点、`''` 一个数字都没有），
 * 再挡掉 0 与超出安全整数范围的巨值。
 */
function parseMaxContext(raw: string | undefined): number {
  if (raw === undefined) {
    throw new Error(`--max-context 需要一个正整数\n${USAGE}`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--max-context 需要一个正整数，收到：${raw}\n${USAGE}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--max-context 需要一个正整数，收到：${raw}\n${USAGE}`);
  }
  return value;
}

/**
 * 解析 `process.argv.slice(2)`（即去掉 node 与脚本路径之后的部分）。
 *
 * 参数之间**顺序无关**：`--resume <id>` 与三个开关可以任意排列。
 *
 * @throws 参数非法时抛出 Error，消息里带一行用法
 */
export function parseArgs(argv: string[]): Args {
  let showReasoning = false;
  let noThinking = false;
  let maxContext = DEFAULT_MAX_CONTEXT;
  let resumeId: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--show-reasoning':
        // 布尔开关重复给是幂等的：它们是开关不是参数，重复不改变语义
        showReasoning = true;
        break;

      case '--no-thinking':
        noThinking = true;
        break;

      case '--max-context':
        maxContext = parseMaxContext(argv[i + 1]);
        i += 1;
        break;

      case '--resume': {
        // 重复给 `--resume` 是有歧义的（到底续哪个？），报错而不是让后者覆盖前者
        if (resumeId !== undefined) {
          throw new Error(`参数过多：${arg}\n${USAGE}`);
        }

        const id = argv[i + 1];
        if (id === undefined) {
          throw new Error(`--resume 需要一个会话 id\n${USAGE}`);
        }

        // id 会被拼进文件路径，所以必须过白名单。
        // `--resume ../../etc/passwd` 就是一次路径穿越 —— 见 core/journal.ts 的
        // SESSION_ID_PATTERN 与 cli/store.ts 的第二道防线。
        if (!isValidSessionId(id)) {
          throw new Error(`会话 id 不合法：${id}\n${USAGE}`);
        }

        resumeId = id;
        i += 1;
        break;
      }

      default:
        // 未知参数**必须报错，不能忽略**。
        // 反例：`--resum xxx`（少一个 e）若被静默忽略，程序会开一个全新会话，
        // 用户以为续上了、实际上前面聊的全丢了 —— 这种失败没有任何提示，
        // 比直接报错糟糕得多。
        //
        // 不带减号的多余词（`--resume <id> extra` 里的 extra）走「参数过多」，
        // 与「写错了一个开关名」是两种不同的错，提示也要分开。
        if (arg.startsWith('-')) {
          throw new Error(`未知参数：${arg}\n${USAGE}`);
        }
        throw new Error(`参数过多：${arg}\n${USAGE}`);
    }
  }

  // 关了 thinking 服务端就不会吐 reasoning_content，--show-reasoning 于是
  // 什么都不会显示。用户会以为「模型这次没思考」，而事实是它思考了、
  // 只是被自己关掉了 —— **静默地没做用户要的事，比报错更糟**（同 args 里
  // 「未知参数必须报错」的立论）。
  if (noThinking && showReasoning) {
    throw new Error(`--no-thinking 与 --show-reasoning 不能同时使用\n${USAGE}`);
  }

  const switches = { showReasoning, noThinking, maxContext };
  return resumeId === undefined
    ? { kind: 'fresh', ...switches }
    : { kind: 'resume', id: resumeId, ...switches };
}
