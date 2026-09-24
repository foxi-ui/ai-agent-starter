// 会话存储的文件实现 —— 全项目唯一读写会话日志的地方。
//
// 放在 cli 层而不是 core：core 不做 IO（它只认 core/journal.ts 里的
// SessionStore 接口），这样解析与回放逻辑仍然可以脱离文件系统被推理。
//
// 文件名即会话 id：<id>.jsonl。id 的格式保证了它不含路径分隔符。

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  isValidSessionId,
  parseRecord,
  serializeRecord,
  type LoadedSession,
  type SessionChange,
  type SessionRecord,
  type SessionStore,
  type SessionSummary,
} from '@/core/journal.ts';

const FILE_SUFFIX = '.jsonl';

export function createFileStore(dir: string): SessionStore {
  // 目录可能还不存在 —— 会话目录是运行时产物，不在仓库里。
  // recursive: true 让「已存在」不报错，于是不需要先 existsSync 判断
  // （那样还得处理 TOCTOU，虽然这里无所谓，但少一个分支）。
  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true });
  };

  /**
   * id → 绝对路径，顺带确认它没跑到目录外面去。
   *
   * 第一道防线是 isValidSessionId 的白名单正则，这里是第二道。
   * 两道都要有：正则保证「现在的 id 长什么样」，这道保证「即使将来
   * 正则被放宽、或有人绕过了正则，也走不出会话目录」。
   */
  const pathOf = (id: string): string => {
    if (!isValidSessionId(id)) {
      throw new Error(`会话 id 不合法：${id}`);
    }
    const root = resolve(dir);
    const full = resolve(root, id + FILE_SUFFIX);
    if (!full.startsWith(root + sep)) {
      throw new Error(`会话路径越界：${id}`);
    }
    return full;
  };

  const create = (id: string, model: string): void => {
    ensureDir();
    const meta: SessionRecord = {
      type: 'meta',
      id,
      // 存 UTC 的 ISO 串：它是无歧义的机器可读时间。
      // 给人看的时间不走这里，走 id（见 core/journal.ts 的说明）。
      createdAt: new Date().toISOString(),
      model,
    };
    // flag 'wx' = **独占创建**：文件已存在就抛错，绝不覆盖。
    // 用默认的 'w' 会在 id 撞名时静默截断掉已有会话 —— 那是数据丢失，
    // 而且用户要过很久才会发现。宁可让启动失败。
    writeFileSync(pathOf(id), serializeRecord(meta) + '\n', {
      encoding: 'utf8',
      flag: 'wx',
    });
  };

  const append = (id: string, change: SessionChange): void => {
    ensureDir();
    appendFileSync(pathOf(id), serializeRecord(change) + '\n', { encoding: 'utf8' });
  };

  const load = (id: string): LoadedSession | null => {
    const path = pathOf(id);

    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // 只有「文件不存在」才是正常分支，返回 null 让调用方给友好提示；
      // 权限之类的 IO 错误必须抛出去 —— 把它伪装成「会话不存在」会让人
      // 去查一个根本不存在的问题（文件明明就在那儿）。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const records: SessionRecord[] = [];
    let skipped = 0;

    for (const line of text.split('\n')) {
      const record = parseRecord(line);
      if (record !== null) {
        records.push(record);
        continue;
      }
      // 空行不算坏行：文件末尾那个换行 split 之后就是一个空串
      if (line.trim() !== '') skipped += 1;
    }

    return { records, skipped };
  };

  const list = (): SessionSummary[] => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (error) {
      // 首次运行时目录还没被创建过，这是正常情况而不是错误
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const summaries: SessionSummary[] = [];

    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;

      const id = name.slice(0, -FILE_SUFFIX.length);
      // 不是本工具命名的文件，跳过（比如别人放进来的笔记）
      if (!isValidSessionId(id)) continue;

      let loaded: LoadedSession | null;
      try {
        loaded = load(id);
      } catch {
        // 单个文件读不了就跳过，而不是让整条 /sessions 失败 ——
        // 一个坏文件不该毁掉整个列表。注意 resume 那条路径仍会如实报错，
        // 因为它只读一个文件、且用户明确指名了它。
        continue;
      }
      if (loaded === null) continue;

      summaries.push({
        id,
        messageCount: loaded.records.filter((record) => record.type === 'message').length,
      });
    }

    // id 以 YYYYMMDD-HHMMSS 开头，所以字典序倒序就是时间倒序。
    // 用 id 排序而不是文件 mtime：mtime 会被人手动 mv、cp 之类的操作改掉。
    summaries.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    return summaries;
  };

  return { create, append, load, list };
}
