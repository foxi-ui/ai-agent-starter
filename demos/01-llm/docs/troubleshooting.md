# 排错记录

> 回答：遇到这个报错时怎么定位、怎么修、怎么避免再犯。
> 只记**实际踩过或已确认会踩**的坑，每条都写明来源（实测 / 记录在案）。

**T1–T5 是本项目自身的坑，T6–T8 是附带的（不是本项目的代码问题，但会在本项目的工作中遇到）。**

---

## T1. 单文件跑测试整文件失败：`Cannot find package '@/cli'`

**症状**

```console
$ node --test test/repl.test.ts
not ok 1 - test/repl.test.ts
# tests 1
# pass 0
# fail 1
```

注意：报的是**整个文件**失败，只有 1 个 test，**不是**某条用例失败。很容易误读成「用例写错了」。

**原因**

测试文件用 `@/cli/repl.ts` 这类别名导入源码。两件事叠加：

1. Node 的原生类型擦除**不读 `tsconfig.json` 的 `paths`**，所以 Node 不认 `@/`；
2. `node --test test/x.test.ts` 是手敲的命令，**没带** `package.json` 脚本里的 `--import ./loader.mjs`。

**定位**

看报错里的关键词 —— 是 `Cannot find **package** '@/cli'`（当成裸包名去找），而不是 `Cannot find module`：

```console
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@/cli' imported from .../test/repl.test.ts
  code: 'ERR_MODULE_NOT_FOUND'
```

**解决**

带 loader：

```bash
node --import ./loader.mjs --test test/repl.test.ts
# 或直接用脚本（已内置）
pnpm test
```

**验证**

应该看到每个用例逐个 `ok`：

```console
ok 1 - 一问一答并打印回答
ok 2 - 错误写 stderr，不污染 stdout
...
# pass 4
```

**避免**

从 `package.json` 的 `scripts` 复制命令，不要手敲。规则已写进根 `AGENTS.md`。

---

## T2. `pnpm start > answers.txt` 里混进了 pnpm 的命令横幅

**症状**

```console
$ printf 'hi\n' | pnpm start 1>out.txt 2>err.txt
$ cat out.txt

> ai-chat@1.0.0 start /Users/.../demos/01-llm
> node --env-file-if-exists=.env --env-file-if-exists=.env.local --import ./loader.mjs src/index.ts

You:
```

**原因**

那两行是 **pnpm 自己**回显即将执行的脚本，走的是 stdout，**不是本程序的输出**。

**定位**

看行首的 `>` —— 那是 pnpm 的格式。对比直接跑 node：

```bash
node --import ./loader.mjs src/index.ts
```

**解决**

用 `--silent`：

```bash
pnpm --silent start > answers.txt
```

**验证**

`out.txt` 恰好只有 `You: `，没有一个字节的多余内容。

**避免**

判断「stdout 是否干净」时，先分清是**程序输出**还是**工具输出**。这条坑本身不影响程序的正确性，只会让人误以为分流没生效。

---

## T3. 值导入写 `.ts` 扩展名，`tsc` 报 TS5097

**症状**

```console
error TS5097: An import path can only end with a '.ts' extension
when 'allowImportingTsExtensions' is enabled.
```

**原因**

配合 Node 原生类型擦除，值导入必须写真实文件名（`'./x.ts'`，运行时需要它）。而 TypeScript 默认不允许导入路径以 `.ts` 结尾。

**解决**

`tsconfig.json` 开启：

```json
{ "compilerOptions": { "allowImportingTsExtensions": true } }
```

该选项要求 `noEmit`（或 `emitDeclarationOnly`），本项目已是 `noEmit: true`，无冲突。

**验证**

`pnpm run typecheck` 退出码 0。

**避免**

本项目已配置好。新建阶段项目时**复制 tsconfig 不要漏这一项** —— 这是当初发现的一处 spec 缺口，已记入 `DECISIONS.md` 的 D11。

---

## T4. `@/` 别名「类型检查能过、运行时炸」

**症状**

`tsc --noEmit` 全绿，但一运行就：

```console
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '@/core/session.ts'
```

**原因**

`tsc` 认 `tsconfig.json` 的 `paths`，**Node 不认**。两者用的是两套解析规则：

| 写法 | 类型检查 | 运行时 |
| --- | --- | --- |
| `import type { X } from '@/...'` | ✅ | ✅（整条语句在运行前被擦除，**侥幸能用**） |
| `import { X } from '@/...'`（值导入） | ✅ | ❌ `ERR_MODULE_NOT_FOUND` |

**这是最容易骗过人的地方**：只要代码里暂时只有 `import type`，一切看起来正常，隐患被完全掩盖。

**解决**

注册 resolve 钩子，把 `@/x` 映射回 `src/x`：

```text
loader.mjs         通过 node --import 加载，调用 module.register()
      ↓ 注册
loader-hooks.mjs   在钩子线程里把 @/x 解析为 src/x 的真实文件 URL
```

必须拆成两个文件 —— **`--import` 只是「导入」模块，不会自动把其中的 `resolve` 导出当作钩子**，这一点不符合直觉。

**验证**

```bash
node --import ./loader.mjs src/index.ts   # 能起来
```

**避免**

`start` 与 `test` 两个脚本**都要带** `--import ./loader.mjs`。漏一个会得到最坏的组合：测试全绿、`pnpm start` 挂掉。

来源：`DECISIONS.md` D10（脚手架阶段发现的隐患，不是运行时实测崩溃）。

---

## T5. 报错写进了 stdout，污染重定向文件

**症状**

```console
$ printf 'hi\n' | DEEPSEEK_API_KEY=bad-key pnpm start 1>out.txt 2>err.txt
$ cat out.txt
You:
[error] DeepSeek API error 401: Authentication Fails ...
$ cat err.txt
（空）
```

**原因**

`ReplOptions` 原本只有一个注入的输出流 `output`，`catch` 分支也往它写。而 spec §8 明确要求「打印错误到 **stderr**」。**测试测不出来** —— 因为测试里两条流是同一个注入对象，断言全绿。

**定位**

把两条流分开重定向（`1>` / `2>`），一眼就能看出错在哪条。

**解决**

`ReplOptions` 增加**必填**的 `errorOutput`，错误走它；`index.ts` 传 `process.stderr`。

必填是刻意的：让「忘记分流」在**类型检查**阶段就暴露，而不是等用户重定向 stdout 时才发现。

**验证**

```console
$ cat out.txt
You:
$ cat err.txt
[error] DeepSeek API error 401: Authentication Fails ...
```

**避免**

**注入单一输出流做断言时，「写错流」这类偏差是测不出来的。** 两条流都要做成注入参数，分流本身才成为可断言的行为。

来源：实测。修好后归档在 `DECISIONS.md` D13。

---

## T6（附）统计会话 token / 成本时数字虚高约 2.5–2.8 倍

> 与 `01-llm` 的代码无关，但做成本复盘时会遇到。

**症状**

累加 Claude Code 会话 JSONL 里的 `usage` 得到 42.37M tokens，实际只有 **15.03M**。

**原因**

同一个 API 响应会被写成**多条** `type: "assistant"` 条目（一条一个 content block），**每条都带一份完整的 `usage`**。直接累加就重复计数了。同理，`tool_use` block 也会重复，工具调用次数也被虚高。

**定位**

对比 `message.id` 去重前后的条目数：

```console
assistant 条目数: 184
去重后 message.id 数: 73
→ 重复倍数 2.52x
```

**解决**

按 `message.id` 去重后再累加：

```js
const bag = {};
for (const e of entries) {
  const id = e.message.id;
  if (bag[id]) continue;          // 同一个 API 响应只算一次
  bag[id] = e.message.usage;
}
```

**验证**

去重前后比值应在 **2.5–2.8** 区间。去重后的 `message.id` 个数才是真实 API 调用次数。

**避免**

报成本时**同时给两个口径**，不要只给一个：

| 口径 | `2bc17a91` 会话 |
| --- | --- |
| 文档价目表（`01-full-design.md` §12 的 flash 峰值价） | $0.321 |
| 本地 `cost-state` 记账 | $12.16 |

两者差约 **38 倍**，原因未查明（可能 `deepseek-flash[1M]` 有独立价目表，也可能本地计价模型没跟上）。**要拿准数只能核对真实账单。**

---

## T7（附）运行 `.ts` 报 `ERR_UNKNOWN_FILE_EXTENSION`

**症状**

```console
Error [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"
```

**原因**

Node 版本过低，或未开启原生类型擦除。

**解决**

升到 Node ≥ 22（本项目在 **v22.23.2** 验证）。临时验证可用：

```bash
node --experimental-strip-types src/index.ts
```

**验证**

`node -v` 应 ≥ 22；`node src/index.ts` 能直接跑起来。

来源：`README.md` 已记录。

---

## T8（附）批量改文件时循环只跑了一次：zsh 不分割 `$VAR`

> 与 `01-llm` 的代码无关，但做**跨文件批量替换**（改文档引用、改配置项）时会遇到。
> 本仓库的 shell 是 **zsh**（macOS 默认），而网上绝大多数脚本是照 bash 写的。

**症状**

```console
$ FILES="demos/01-llm/README.md demos/01-llm/DECISIONS.md"
$ for f in $FILES; do sed -i '' 's|a|b|' "$f"; done
sed: demos/01-llm/README.md demos/01-llm/DECISIONS.md: No such file or directory
```

**tells —— 报错里把整串文件名当一个路径**（中间的空格还在），而不是逐个报「找不到第一个文件」。

**原因**

zsh 默认**不对未加引号的变量展开做词分割**（与 bash 相反）。所以 `$FILES` 整体是一个词，循环只跑一次，`sed` 拿到的是一个含空格的超长文件名。

实测三种写法的差异：

```console
$ zsh -c 'FILES="a.txt b.txt"; for f in $FILES;   do echo "[$f]"; done'
[a.txt b.txt]            # ← 只跑一次

$ bash -c 'FILES="a.txt b.txt"; for f in $FILES;  do echo "[$f]"; done'
[a.txt]
[b.txt]                  # ← bash 会分割

$ zsh -c 'set -- a.txt b.txt; for f in "$@";      do echo "[$f]"; done'
[a.txt]
[b.txt]                  # ← 正确
```

**定位**

在循环体里加一行 `echo "[$f]"` 数迭代次数。如果只跑了一次、且内容里带空格，就是这个坑。

**解决**

四选一（前两个推荐）：

```bash
# 1. set -- + "$@"（本次采用）
set -- file1 file2 file3
for f in "$@"; do sed -i '' 's|a|b|' "$f"; done

# 2. zsh 数组
files=(file1 file2 file3)
for f in $files; do sed -i '' 's|a|b|' "$f"; done

# 3. 显式开启分割
for f in ${=FILES}; do ...; done

# 4. 改用 bash 跑
bash -c 'FILES="..."; for f in $FILES; do ...; done'
```

**验证**

`echo "[$f]"` 的迭代次数应等于文件个数。改完再 `grep` 一遍旧值，残留应为 0。

**避免**

- **zsh 里不要用「空格分隔的字符串」当文件列表** —— 要么用数组，要么用 `"$@"`
- 这个失败是**响亮且安全**的：命令直接报错退出，一个字节都没改。所以看到这个报错不用慌，修完重跑即可；真正危险的是它「静默地只改了一半」
- 批量替换前先 `git status` 确认工作区干净，这样即使改错也能一眼看出

来源：实测（2026-09-24 批量同步阶段目录引用时踩到）。
