// 通过 `node --import ./loader.mjs ...` 加载本文件，向 Node 注册 @/ 别名钩子。
//
// 注意：--import 只是「导入」模块，并不会自动把其中的 resolve 导出当作钩子。
// 必须显式调用 module.register()，才会让 loader-hooks.mjs 在钩子线程中生效。
import { register } from 'node:module';

register('./loader-hooks.mjs', import.meta.url);
