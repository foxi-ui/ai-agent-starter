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
 * 这里的 switch 没有 `default`，但**并非没有穷尽性守卫** —— 返回注解
 * `: CommandResult` 加上 `strict` 就是那个守卫：给 `CommandName` 加第 4 个命令名
 * 却忘了在这里处理时，函数会有路径走到末尾却不返回，编译器报 TS2366。
 *
 * 它与 `cli/render.ts` 的 `renderCommandResult` 里那个显式 `never` 守卫
 * **同为编译期的穷尽性守卫，但作用于不同的联合类型、写法也必须不同**：
 * 那边函数返回 void，漏一个变体时编译器不会出声，
 * 所以才必须显式写出来。两者守的轴也不同 —— 这边守 `CommandName`（新增命令忘了实现），
 * 那边守 `CommandResult`（新增结果类型忘了渲染）。
 *
 * 看到「一处有一处没有」时不要试图去「统一」它们：把这边的返回注解改成显式守卫
 * 会改变公开签名；把那边显式的删掉则直接失去守卫。
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
      //
      // 这里是**纯查询**，不得写 session.model —— 查询是只读操作，
      // 用户的 `/model`（含只有尾随空白的 `/model `，那是 trim 后的空参数）
      // 不该产生任何副作用。
      //
      // 下面那条赋值刻意留在 if **之后**，别顺手上移：
      // 上移后查询分支就会写模型 —— 写空串时返回值也会跟着变（用例会红），
      // 但若是写回「与当前同名」的值，返回值一模一样、所有值断言都看不出差别。
      // `test/commands.test.ts` 的 setter 探针用例（写入计数必须为 0）就是为了钉住后者。
      if (argument === '') {
        return { kind: 'model-current', model: session.model };
      }
      // 刻意不校验名字：维护一份模型清单必然会过期，
      // 写错的模型名交给下一次请求的 API 报错（走 stderr 的现有错误路径）
      session.model = argument;
      return { kind: 'model-changed', model: argument };
  }
}
