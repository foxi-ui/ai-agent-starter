# 排错记录

> 回答：遇到这个报错怎么定位和修？

每条写四件事：**症状 / 原因 / 解决 / 避免**（下次怎么不踩）。
`来源` 一行注明它是**实测踩到的**还是**按已知行为预先规避的** —— 后者同样有用，
但你不该以为它已经被本项目验证过。

---

## T1. 服务端测试整个文件卡到超时，报错看起来像「测试挂死」

**症状**

`node --import ./loader.mjs --test test/http-app.test.ts` 不返回，最后报超时。
单条用例看不出任何问题。

**原因**

`undici`（Node 的 `fetch`）默认**复用连接**（keep-alive），而 `server.close()`
只停止接受新连接、会一直等现有连接结束 —— 于是 `await new Promise(resolve => server.close(resolve))`
永远不 resolve。

**解决**

关之前先主动断开所有连接：

```ts
server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
```

**避免**

任何「起一个临时端口、跑完就关」的测试辅助函数都要带 `closeAllConnections()`。
`apps/server/test/http-app.test.ts` 的 `withServer` 就是模板。

来源：已知行为，本项目实现时就写进了 `withServer`（spec §14 的测试策略点名了它）。

---

## T2. `import { Request } from 'express'` 运行时报「does not provide an export named」

**症状**

```console
SyntaxError: The requested module 'express' does not provide an export named 'Request'
```

而 `pnpm run typecheck` **退出码 0**，完全放行。

**原因**

`Request` / `Response` / `NextFunction` / `Express` 都是**类型**，运行时并不存在。
Node 的原生类型擦除看不出一个导入是「只当类型用」还是「要值」，于是原样保留了这条值导入。
`tsc` 则知道它们是类型 —— 所以两边都不报错，只有运行时才炸。

**解决**

只当类型用的导入**必须**写 `import type`：

```ts
import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
```

**避免**

这条与服务端那条跨阶段约束是同一件事（根 `AGENTS.md` 的「不用需要代码变换的 TS 特性」一节）。
前端由 `verbatimModuleSyntax: true` 在**类型检查阶段**强制它，服务端只能靠纪律。

来源：已知行为，`src/http/app.ts` 里已按此写并附了注释。

---

## T3. `app.get('*')` 启动即抛「Missing parameter name」

**症状**

服务端**还没开始服务**就抛：

```console
TypeError: Missing parameter name at 1
```

**原因**

express 5 换用了 path-to-regexp v8，**不再接受裸 `*`**。这条在 express 4 上是标准写法，
所以从 4 抄过来的 404 兜底会在启动时炸。

**解决**

404 兜底改用 `app.use`，不写路径：

```ts
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: '没有这个接口' } });
});
```

**避免**

配套的一条：**兜底必须返回 JSON**。express 默认的 HTML 错误页会让前端的 `res.json()`
抛 `SyntaxError`，表现为一个完全不指向真正原因的解析错误。

来源：已知行为（spec §11 的两个 4→5 陷阱之一），`src/http/app.ts` 已按此写。

---

## T4. 不带 `Content-Type` 的 POST 返回 500 而不是 400

**症状**

```bash
curl -X POST localhost:3000/api/sessions/<id>/messages -d 'message=hi'
```

得到 `500 internal`，服务端日志里是 `TypeError: Cannot read properties of undefined (reading 'message')`。

**原因**

express 4 在没有 json content-type 时会把 `req.body` 兜底成 `{}`，**express 5 不兜底，留成
`undefined`**。于是 `req.body.message` 直接抛 `TypeError`，落到错误中间件变成 500。

**解决**

先判 `undefined` 再判类型：

```ts
const body = req.body as { message?: unknown } | undefined;
if (typeof body?.message !== 'string' || body.message.trim() === '') {
  res.status(400).json({ error: { code: 'invalid_message', message: 'message 必须是非空字符串' } });
  return;
}
```

**避免**

这是「客户端发错了」而不是「服务端炸了」，状态码必须是 **400**。
测试落点：`test/http-app.test.ts` 的 `不带 Content-Type 发请求 → 400（而不是 500）`。

来源：已知行为（spec §11 的第二个 4→5 陷阱），`src/http/app.ts` 已按此写。

---

## T5. 前端请求触发 CORS 报错

**症状**

浏览器控制台：

```text
Access to fetch at 'http://localhost:3000/api/sessions' from origin 'http://localhost:5173'
has been blocked by CORS policy
```

**先试过什么、为什么没用**

「加一个 `cors` 中间件」能让报错消失 —— 但那是**治错了病**：它把「前端绕过了 Vite proxy」
这个真正的错误固化下来，而且同源部署时那行中间件就成了没人敢删的遗留物。

**原因**

`apps/web/src/api.ts` 里写了绝对地址（`http://localhost:3000/...`），
于是请求根本没走 Vite 的 proxy，浏览器按同源策略直接拦下。

**解决**

路径一律写成**相对**的 `/api/...`，由 `vite.config.ts` 的 proxy 反代到服务端：

```ts
const BASE = '/api';
```

**避免**

代理配置是整个前端里**唯一**允许出现服务端地址的地方。
将来改成 `express.static` 同源部署时，前端代码一行都不用改。

来源：已知行为（spec §12 / D17），`src/api.ts` 里已按此写并附了注释。

---

## T6. 上游 400 说 tools 结构不对

**症状**

```console
DeepSeek API error 400: ... tools ...
```

而从我们这边看不出任何问题 —— 请求体里的 `tools` 明明有 `name` / `description` / `parameters`。

**原因**

**少包了一层。** 内部的 `Tool` 是**扁平**的 `{name, description, parameters}`，
而线上的 `tools` 数组元素要再包一层 `{type:'function', function:{…}}`（OpenAI 约定）。
少包一层上游直接 400，**而报错信息里不会提到「少包了一层」**。

**解决**

序列化只走一个函数（`llm/deepseek.ts` 的 `toWireTools`），别在调用点手拼。

**避免**

这个层级由一条**逐字断言包装层级**的测试钉住：`test/deepseek.test.ts` 的
`带 tools 时请求体按线上的包装层级发送（type/function 两层）`。
注意那条测试**钉的是一个假设**（对照官方文档核实过的），不是独立验证 —— 核实记录写在
`toWireTools` 的注释里。

来源：已知行为（L3 的 Task 5 Step 1 已对照 DeepSeek API Reference 核实），未实际踩到。

---

## T7. L1 / L2 期间 `pnpm test` 一直红，L3 一做完就绿了

**症状**

`pnpm test` 报 `Cannot find module '@/llm/sse.ts'`，`tsc --noEmit` 报 `TS2307` 与
`TS2305: Module '@/core/types.ts' has no exported member 'StreamEvent'`。
红的是 `src/llm/deepseek.ts` 与 `test/deepseek.test.ts` 这一条链，其它文件全绿。

**先试过什么、为什么没用**

「顺手把它修掉」是错的。`deepseek.ts` 是从阶段一原样复制过来的，它值导入了
`@/llm/sse.ts` —— 而 `sse.ts` 按 D5 的处置**不复制过来**。这个文件整体就是 L3 要重写的对象；
提前「修一下」等于把 L3 的工作做掉，而且是在不了解 L3 要把它改成什么形状的前提下做。

**原因**

复制起点（4 个文件）与目标形状之间隔着一个还没执行到的步骤。

**解决**

按计划走：L3 重写 `deepseek.ts`（去流式、发 tools、解析 tool_calls），那条红随之消失。

**避免**

**一条长期挂着的红是有信息量的**，不要因为它刺眼就提前处理。
判断标准：它是不是**下一步**要改的那个文件？是 → 留着。不是 → 现在修。

来源：**实测**（L1、L2 两个阶段全程红着，L3 重写后消失）。

---

## T8（跨阶段）`@/` 别名「类型检查能过、运行时炸」

**症状**

```console
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '@/core/session.ts'
```

而 `tsc --noEmit` 全绿。

**原因**

`tsc` 认 `tsconfig.json` 的 `paths`，**Node 不认**：

| 写法 | 类型检查 | 运行时 |
| --- | --- | --- |
| `import type { X } from '@/...'` | ✅ | ✅（整条语句在运行前被擦除，**侥幸能用**） |
| `import { X } from '@/...'`（值导入） | ✅ | ❌ `ERR_MODULE_NOT_FOUND` |

只要代码里暂时只有 `import type`，一切看起来正常，隐患被完全掩盖。

**解决**

`loader.mjs` 通过 `--import` 注册 `loader-hooks.mjs` 里的 resolve 钩子，把 `@/x` 映射回
`src/x` 的真实文件 URL。（必须拆成两个文件 —— `--import` 只是导入模块，
不会自动把其中的 `resolve` 导出当作钩子。）

**避免**

`start` / `dev` / `test` 三个脚本**都要带** `--import ./loader.mjs`。
漏一个会得到最坏的组合：**测试全绿、`pnpm start` 挂掉**。

> 详细版在 `demos/01-llm/docs/troubleshooting.md` 的 T4 与 T10。

来源：跨阶段通用，见上。

---

## T9（跨阶段）不用需要「代码变换」的 TS 特性

**症状**

```console
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
TypeScript parameter property is not supported in strip-only mode
```

而 `pnpm run typecheck` 报 exit 0。

**原因**

参数属性（构造函数参数上加 `private` / `public` / `readonly`）需要**代码变换** ——
编译器要额外生成 `this.x = x`。而本项目的硬约束是「Node 原生类型擦除、不引入构建步骤」，
剥离器只做**擦除**不做变换。同类语法还有 `enum` / `namespace` / 实验性装饰器。

**这是最容易漏的一类坑**：`tsc` 认为合法（它对），Node 认为不受支持（它对），
两边都不报错，只有真正运行时才炸。

**解决**

写成显式字段 + 构造函数里赋值，语义完全等价。

**避免**

- **判断标准**：把类型标注全删掉，代码是否仍是合法 JS？是 → 能擦除；否 → 不能用
- **永远不要只凭 `tsc --noEmit` 通过就认为能跑**

> 详细版在 `demos/01-llm/docs/troubleshooting.md` 的 T11。

来源：跨阶段通用，见上。

---

## T10（跨阶段）`pnpm start -- --resume <id>` 里的 `--` 被原样转发

**症状**

```console
$ pnpm start -- --resume 20260924-224330-a3f1
未知参数：--
```

**原因**

按 npm 的惯例，`--` 之后才是传给脚本的参数 —— 但实测（pnpm 10.34.5）**pnpm 与 `node`
都会把 `--` 原样作为第一个参数传给脚本**，它们只在「第一个非选项参数」处停止解析自己的选项，
并不会吃掉 `--`。于是 `--` 成了脚本收到的第一个参数。

**解决**

去掉 `--`：`pnpm start --resume <id>`。

**避免**

这不是「pnpm 的坑」，是**照惯例推断工具行为**的坑。凡是要写进文档的命令，**实测跑一遍**再落笔。

来源：跨阶段通用，见 `demos/01-llm/docs/troubleshooting.md` 的 T13（那边有完整的 argv 对照表）。
