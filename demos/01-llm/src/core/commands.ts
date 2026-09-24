// 斜杠命令的解析与执行。
//
// 这一层只做三件事：解析输入、改 Session、返回**结构化结果**。
// 它**不打印任何东西** —— core 层不许写 stdout/stderr，
// 「把结果变成文字」是 cli/render.ts 的职责。
//
// 好处：命令的全部行为都能在无 IO 的情况下断言。

import type { Message } from '@/core/types.ts';
import type { Session } from '@/core/session.ts';

/** 当前支持的命令名 */
export type CommandName = 'clear' | 'history' | 'model';

/**
 * 全部可用命令。
 *
 * 未知命令的提示文案由它拼出来（见 `cli/render.ts`），
 * 所以新增命令只要改这一处。
 */
export const COMMAND_NAMES: readonly CommandName[] = ['clear', 'history', 'model'];

/**
 * 一行输入的解析结果。
 *
 * 三态而不是「命令 / null」：以 `/` 开头但名字不认识（`/foo`）必须与
 * 「不是命令」（`今天天气怎么样`）区分开 —— 前者要报未知命令，
 * 后者要发给模型。用 null 表达不了这个区别。
 */
export type ParsedCommand =
  | { kind: 'none' }
  | { kind: 'known'; name: CommandName; argument: string }
  | { kind: 'unknown'; input: string };

/** 命令执行的结果，供 cli 层渲染 */
export type CommandResult =
  | { kind: 'cleared'; removed: number }
  | { kind: 'history'; messages: Message[] }
  | { kind: 'model-current'; model: string }
  | { kind: 'model-changed'; model: string };

/**
 * 解析一行输入。
 *
 * 识别规则：`line.trim()` 以 `/` 开头即视为命令尝试。
 *
 * @param line 原始输入行
 */
export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return { kind: 'none' };

  const body = trimmed.slice(1);
  // 名字到第一个空白为止，其余全是参数
  const spaceAt = body.search(/\s/);
  const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
  const argument = spaceAt === -1 ? '' : body.slice(spaceAt).trim();

  if ((COMMAND_NAMES as readonly string[]).includes(name)) {
    return { kind: 'known', name: name as CommandName, argument };
  }
  return { kind: 'unknown', input: trimmed };
}

/**
 * 执行一个已知命令。
 *
 * @param name 命令名
 * @param argument 参数（可能为空串）
 * @param session 被操作的会话；`/clear` 与 `/model` 会改它
 */
export function executeCommand(
  name: CommandName,
  argument: string,
  session: Session,
): CommandResult {
  switch (name) {
    case 'clear':
      return { kind: 'cleared', removed: session.clear() };

    case 'history':
      return { kind: 'history', messages: session.history() };

    case 'model':
      // 无参数 = 查询；有参数 = 切换
      if (argument === '') {
        return { kind: 'model-current', model: session.model };
      }
      // 刻意不校验名字：维护一份模型清单必然会过期，
      // 写错的模型名交给下一次请求的 API 报错（走 stderr 的现有错误路径）
      session.model = argument;
      return { kind: 'model-changed', model: argument };
  }
}
