// 会话存储的文件实现 —— 全项目唯一读写会话日志的地方。
//
// 对应 spec §7（JSONL 格式契约）、§8（路径安全）与 §11（错误与边界）。
//
// 这里**真的写临时目录，不 mock node:fs**：store 的职责就是与文件系统打交道，
// 把 fs 换掉等于把这个文件唯一值得测的东西换掉了。每个用例一个独立 home
// （`mkdtempSync` + `t.after` 清理），免得「目录里恰好一个文件」这类断言互相污染。
//
// 期望值一律手写字面量：文件内容用**字符串字面量**喂进去、用 `JSON.parse` 读回来，
// 不经过 `serializeRecord` / `parseRecord` —— 那两个正是被测对象。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '@/cli/store.ts';

const ID = '20260924-143022-a3f1';

/** 每个用例一个全新的临时 home；用完自动删 */
function tempHome(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-chat-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 用**手写的** JSON 行铺一个会话文件，返回文件路径。不经过 serializeRecord。 */
function writeSession(home: string, id: string, lines: string[]): string {
  const path = join(home, `${id}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

const META_LINE =
  '{"type":"meta","id":"20260924-143022-a3f1","createdAt":"2026-09-24T06:30:22.000Z","model":"deepseek-flash"}';

test('create 写出恰好一行 meta，行尾有换行', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  store.create(ID, 'deepseek-flash');

  const path = join(home, `${ID}.jsonl`);
  const text = readFileSync(path, 'utf8');

  // 「一行一个 JSON 对象，行尾 \n，文件末尾有换行」是 §7 的字节级契约。
  // split 后长度恰好 2（一行内容 + 末尾那个换行切出的空串），
  // 少一个换行会变成 1，多写一行会变成 3。
  assert.equal(text.split('\n').length, 2, `应当是「一行 + 末尾换行」：${JSON.stringify(text)}`);
  assert.ok(text.endsWith('\n'));

  const meta = JSON.parse(text.split('\n')[0]) as Record<string, unknown>;
  assert.equal(meta.type, 'meta');
  assert.equal(meta.id, ID);
  assert.equal(meta.model, 'deepseek-flash');
  // createdAt 存的是 UTC 的 ISO 串（给人看的时间走 id，不走这里）。
  // 断言完整形状而不是 Date.parse 能过 —— 后者连 'Sep 24 2026' 也放行。
  assert.match(String(meta.createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('create 用独占创建：文件已存在时抛错，且**不覆盖**原有内容', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  store.create(ID, 'deepseek-flash');
  // 关键：先追加一条记录再二次 create。
  // 若只写 meta 就二次 create，两次 createdAt 可能落在同一毫秒，
  // 那么把 'wx' 误改成 'w' 截断重写出的字节与原来**逐字节相同**，用例照样全绿 ——
  // 一条空转的假绿。多这一条 message，截断就必然可见。
  store.append(ID, { type: 'message', role: 'user', content: '先写一条' });

  const path = join(home, `${ID}.jsonl`);
  const before = readFileSync(path, 'utf8');

  assert.throws(() => store.create(ID, '另一个模型'), /EEXIST/);

  assert.equal(readFileSync(path, 'utf8'), before, '二次 create 不得改动已有文件');
  assert.equal(before.split('\n').length, 3, 'meta + message + 末尾换行');
});

test('append 追加到末尾，顺序与写入顺序一致', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  store.create(ID, 'deepseek-flash');
  store.append(ID, { type: 'message', role: 'user', content: '第一问' });
  store.append(ID, { type: 'message', role: 'assistant', content: '第一答' });
  store.append(ID, { type: 'clear' });
  store.append(ID, { type: 'model', model: 'deepseek-v4-pro' });

  const loaded = store.load(ID);
  assert.ok(loaded !== null);
  assert.equal(loaded.skipped, 0);

  // 首行是 create 写的 meta，createdAt 由它自己取现在的时间，
  // 所以只钉形状（id / model 是确定值），不去猜那个时间戳。
  const [meta, ...rest] = loaded.records;
  assert.equal(meta.type, 'meta');
  assert.deepEqual(
    { id: meta.type === 'meta' ? meta.id : null, model: meta.type === 'meta' ? meta.model : null },
    { id: ID, model: 'deepseek-flash' },
  );

  // 后面四条是 append 写的，全是手写字面量 —— 顺序错一位就会被抓住
  assert.deepEqual(rest, [
    { type: 'message', role: 'user', content: '第一问' },
    { type: 'message', role: 'assistant', content: '第一答' },
    { type: 'clear' },
    { type: 'model', model: 'deepseek-v4-pro' },
  ]);

  assert.ok(readFileSync(join(home, `${ID}.jsonl`), 'utf8').endsWith('\n'));
});

test('load 读回手写的文件内容，坏行计入 skipped 而好行照常解析', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  writeSession(home, ID, [
    META_LINE,
    '{"type":"message","role":"user","content":"好行"}',
    '这不是 JSON',
    '{"type":"message","role":"us', // 进程被 kill 时留下的半行
    '{"type":"message","role":"assistant","content":"也是好行"}',
  ]);

  const loaded = store.load(ID);
  assert.ok(loaded !== null);
  assert.equal(loaded.skipped, 2, '两行坏行');
  assert.deepEqual(
    loaded.records.map((r) => r.type),
    ['meta', 'message', 'message'],
  );
});

test('load 不把文件末尾的空行算成坏行', () => {
  const home = tempHome(test);
  const store = createFileStore(home);
  writeSession(home, ID, [META_LINE]);

  const loaded = store.load(ID);
  assert.ok(loaded !== null);
  // 末尾那个换行 split 之后就是一个空串 —— 它必须被当作「没有这一行」。
  // 若把空行也计入 skipped，每个正常会话都会被报「已跳过 1 行」。
  assert.equal(loaded.skipped, 0);
  assert.equal(loaded.records.length, 1);
});

test('load 不存在的会话返回 null（正常分支，不是错误）', () => {
  const home = tempHome(test);
  const store = createFileStore(home);
  assert.equal(store.load(ID), null);
});

test('load 0 字节的空文件得到空会话（spec §11）', () => {
  const home = tempHome(test);
  const store = createFileStore(home);
  writeSession(home, ID, ['']);

  // 空文件应当是「空会话、正常恢复」，而不是「坏行」或「不存在」。
  // 它的记录为空、model 为 null，由调用方回落到环境变量里的模型。
  assert.deepEqual(store.load(ID), { records: [], skipped: 0 });
});

test('load 遇到读不了的会话文件时抛错，**不伪装成「会话不存在」**', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  // 用「同名目录」制造一个非 ENOENT 的 IO 错误（EISDIR）。
  // 不用 chmod：以 root 运行时权限位不起作用，那种用例在 CI 上会假绿。
  mkdirSync(join(home, `${ID}.jsonl`));

  // 关键区别：返回 null 会让调用方提示「会话不存在」，把人引去查一个
  // 其实就在那儿的问题。只有 ENOENT 才是「不存在」。
  assert.throws(() => store.load(ID), /EISDIR/);
});

test('list 按 id 倒序（id 前缀是时间戳）', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  // id 用手写字面量，不用 makeSessionId(new Date(), ...)：
  // 同一秒内生成的 id 只差随机后缀，倒序就变成「按后缀排」，约 50% 概率假红。
  const older = '20260923-101500-7c2e';
  const newer = '20260924-143022-a3f1';
  writeSession(home, older, [META_LINE.replace(ID, older)]);
  writeSession(home, newer, [META_LINE]);

  assert.deepEqual(
    store.list().map((s) => s.id),
    [newer, older],
  );
});

test('list 的条数只数 message 记录，clear / model / meta 不算', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  writeSession(home, ID, [
    META_LINE,
    '{"type":"message","role":"user","content":"1"}',
    '{"type":"clear"}',
    '{"type":"model","model":"deepseek-v4-pro"}',
    '{"type":"message","role":"assistant","content":"2"}',
  ]);

  // 5 行里有 2 条 message。若实现改成数总行数，这条会变成 5。
  assert.deepEqual(store.list(), [{ id: ID, messageCount: 2 }]);
});

test('list 跳过本工具之外的文件', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  writeSession(home, ID, [META_LINE]);
  writeFileSync(join(home, 'notes.txt'), '别人的笔记', 'utf8');
  writeFileSync(join(home, 'abc.jsonl'), '{"type":"clear"}\n', 'utf8'); // id 形状不合法
  mkdirSync(join(home, 'subdir'));

  assert.deepEqual(
    store.list().map((s) => s.id),
    [ID],
  );
});

test('list 里单个读不了的会话文件被跳过，不让整条列表失败', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  writeSession(home, ID, [META_LINE]);
  // 一个坏文件不该毁掉整个 /sessions 列表
  mkdirSync(join(home, '20260923-101500-7c2e.jsonl'));

  assert.deepEqual(
    store.list().map((s) => s.id),
    [ID],
  );
});

test('list 在会话目录不存在时返回空数组（首次运行）', () => {
  const home = tempHome(test);
  const store = createFileStore(join(home, '还没建过'));
  assert.deepEqual(store.list(), []);
});

test('create 会自动逐级建出会话目录（spec §11）', () => {
  const home = tempHome(test);
  const dir = join(home, 'a', 'b', 'c');
  const store = createFileStore(dir);

  assert.equal(existsSync(dir), false);
  store.create(ID, 'deepseek-flash');

  assert.equal(existsSync(join(dir, `${ID}.jsonl`)), true);
  assert.equal(store.load(ID)?.records.length, 1);
});

test('路径穿越的 id 在 create / append / load 三处都被拒', () => {
  const home = tempHome(test);
  const store = createFileStore(home);

  // id 会被拼进文件路径，所以白名单是第一道防线（spec §8）。
  // 这里确认三个入口都过同一道校验 —— 只有 load 校验是不够的，
  // create 能让程序往任意路径写文件。
  for (const bad of ['../../etc/passwd', 'a/b', '', '..', `${ID}.jsonl`]) {
    assert.throws(() => store.create(bad, 'm'), /会话 id 不合法/, `create(${JSON.stringify(bad)})`);
    assert.throws(() => store.append(bad, { type: 'clear' }), /会话 id 不合法/, `append(${JSON.stringify(bad)})`);
    assert.throws(() => store.load(bad), /会话 id 不合法/, `load(${JSON.stringify(bad)})`);
  }

  // 被拒之后目录里不该留下任何东西
  assert.deepEqual(store.list(), []);
});

// ⚠️ 下面两条是**已知缺陷**的表征用例（characterization test），不是契约。
// 它们把「实现当前实际怎么做」钉成可见行为，好让缺陷不被遗忘；
// 修好之后这两条会变红，那时应当把它们改成断言契约行为。
// 本任务只报告缺陷、不修改生产代码。

test('【已知缺陷】append 到不存在的会话不抛错，而是建出一个没有 meta 行的文件', () => {
  // 缺陷：core/journal.ts 里 SessionStore.append 的注释契约写的是「文件不存在时抛错」，
  // 但 cli/store.ts 的实现用 appendFileSync 的默认 flag 'a'，而 'a' 在文件不存在时
  // 会**创建**它（Node 文档：append data to a file, creating the file if it does not yet exist）。
  //
  // 影响：会话文件在对话中途被删或被移走时，append 会凭空造出一个**没有 meta 行**的日志。
  // 于是 replay 拿到的 model 为 null（回落到环境变量、丢掉用户切过的模型），
  // list() 也会把它当成一个正常会话列出来。
  //
  // 修法（待定，未实施）：append 前先确认文件存在（accessSync / existsSync），
  // 不存在则抛错。**不要**简单把 flag 改成 'r+' —— appendFileSync 用 'r+' 时写入起点是 0，
  // 会覆盖文件开头。
  //
  // 修好之后：本用例应当改成 assert.throws(...)，并断言目录里没有多出文件。
  const home = tempHome(test);
  const store = createFileStore(home);

  store.append(ID, { type: 'message', role: 'user', content: '没有 meta 的孤儿记录' });

  const path = join(home, `${ID}.jsonl`);
  assert.equal(existsSync(path), true, '当前行为：文件被静默创建');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]), {
    type: 'message',
    role: 'user',
    content: '没有 meta 的孤儿记录',
  });
  assert.deepEqual(store.load(ID)?.records, [
    { type: 'message', role: 'user', content: '没有 meta 的孤儿记录' },
  ]);
});

test('【已知缺陷】会话目录是文件系统根时，合法 id 被第二道防线误拒', () => {
  // 缺陷：cli/store.ts 的 pathOf 用 `full.startsWith(root + sep)` 判断越界。
  // 当 dir 为 '/' 时 `root + sep` 是 '//'，而 resolve('/', name) 是 '/name'，
  // 于是 startsWith('//') 为 false —— **一个完全合法的 id 被判成「会话路径越界」**。
  //
  // 这条同时说明第二道防线的处境：正则先行已排除 '/' 与 '.'，所以任何穿越类输入
  // 都在上面那句 isValidSessionId 就抛了；这道检查在正则不放宽时**唯一可达的路径
  // 就是这个误报**。也就是说它当下并没有在防穿越，只是在根目录下误伤。
  //
  // 修法（待定，未实施）：把拼接后的前缀写成 `root === sep ? sep : root + sep`，
  // 或改用 path.relative() 判断。
  //
  // 只调 load：pathOf 在它内部先抛，不会往 '/' 写任何东西。
  // （create 会先跑 ensureDir，虽然也在 pathOf 处就抛，但不值得冒这个险。）
  const store = createFileStore('/');
  assert.throws(() => store.load(ID), /会话路径越界/);
});
