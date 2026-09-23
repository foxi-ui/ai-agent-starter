// Node 的原生类型擦除（type stripping）不解析 tsconfig.json 的 `paths`，
// 所以 `@/` 别名只在 `import type` 里能侥幸工作——一旦出现在值导入中，
// 运行时就会报 ERR_MODULE_NOT_FOUND。这个 resolve 钩子把 `@/x` 映射回
// src/x 的真实文件 URL，使别名在类型导入和值导入中都可用。
//
// 本文件只导出钩子，不要直接传给 --import；由 loader.mjs 负责注册。
// 零依赖：只用 node: 内置模块。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

// 以钩子文件自身位置推导项目根目录，而非依赖 cwd，
// 这样测试运行器派生的子进程也能正确解析。
const projectRoot = dirname(fileURLToPath(import.meta.url));

const ALIAS_PREFIX = '@/';

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    const target = pathToFileURL(
      resolvePath(projectRoot, 'src', specifier.slice(ALIAS_PREFIX.length)),
    ).href;
    // shortCircuit 只跳过后续的 resolve 钩子；load 阶段仍走默认加载器，
    // 因此原生类型擦除照常生效。
    return { url: target, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
