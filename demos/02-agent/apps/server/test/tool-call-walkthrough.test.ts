import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '@/tools/registry.ts';
import type { Message, ToolCall } from '@/core/types.ts';

/**
 * 垂直切片：**不接模型**，手工把一次工具调用走完。
 *
 * 这九条用例连起来读，就是 L4 那个循环体的一次迭代 ——
 * 先把一次迭代手工做对，再去写循环。
 *
 * **读的时候要分清哪几条是真覆盖、哪几条是旁白：**
 * - ①④⑦⑧⑨ 打的是**真的** `createToolRegistry()`，它们的负载面是**注册表本身与 `weather.ts`**：
 *   改坏这两处会红；只改 `calculator.ts` 不会 —— 这九条里没有一条碰它。
 *   ⑨ 尤其是本文件独有的一条：它走完「解析 → 派发 → 序列化 → 拼两条消息」，
 *   这条**消息组装接缝**别处没有覆盖。
 * - ②③⑤⑥ 是**可执行的旁白**：断言的字符串/字面量就在它们上面一两行手写着。
 *   其中 ②⑥ 的校验发生在编译期（`ToolCall` / `Message` 的类型标注由 `tsc` 把关）；
 *   ③（`as unknown` 把类型检查关掉了）与 ⑤（字面量直接喂给 `JSON.stringify`）
 *   则**没有任何东西在检查** —— 既无编译期把关，也无实现依赖。
 *   留着它们是让读的人**看见**模型那一轮的产出长什么样，
 *   但**不要把它们算成覆盖率** —— 任何实现改动都不会让它们变红。
 *
 * 为什么不含「参数不是合法 JSON」那条：解析是**循环的职责**（见 L4 的
 * core/agent.ts），注册表拿到的永远是「已经解析好的参数」。这里不越位。
 */

const registry = createToolRegistry();

test('① 声明：模型看到的工具只是一份说明书，没有任何实现', () => {
  const weather = registry.list().find((tool) => tool.name === 'weather');
  assert.ok(weather);
  // description 是给模型看的 —— 它决定模型「知不知道什么时候该用这个工具」
  assert.ok(weather.description.length > 0);
  // parameters 是给模型看的参数规格 —— 它决定模型传什么名字的参
  assert.deepStrictEqual(weather.parameters.required, ['city']);
});

test('② 开单：模型的全部产出就是这张结构化的调用单', () => {
  // 关键在于：模型**没有执行任何东西**，它只是输出了这段文字结构。
  // 函数名与参数都是字符串，去执行的是我们。
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  // arguments 是 **JSON 字符串**而不是对象 —— 模型逐字生成文本，中途可能截断，
  // 所以它天然可能是非法 JSON（那一条由 L4 的循环负责兜底）
  assert.strictEqual(typeof toolCall.function.arguments, 'string');
});

test('③ 解析：把参数字符串 parse 成真正的参数', () => {
  const argumentsText = '{"city":"Beijing"}';
  const args = JSON.parse(argumentsText) as unknown;
  assert.deepStrictEqual(args, { city: 'Beijing' });
});

test('④ 派发：注册表按名字找工具，参数交给工具自己校验', async () => {
  const result = await registry.execute('weather', { city: 'Beijing' });
  assert.deepStrictEqual(result, {
    ok: true,
    value: { city: 'Beijing', temperature: '25°C', condition: 'Sunny' },
  });
});

test('⑤ 序列化：成功结果 stringify 之后才能放进 tool 消息', () => {
  // tool 消息的 content 必须是**字符串**，而上游 API 只认这一种形状
  const content = JSON.stringify({ city: 'Beijing', temperature: '25°C', condition: 'Sunny' });
  assert.strictEqual(content, '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}');
});

test('⑥ 拼回：两条消息，tool 那条靠 tool_call_id 认领调用单', () => {
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
    },
  ];

  // 少了 tool_call_id 这个字段，上游不知道这条结果在回应哪张单，直接 400。
  // 这就是 Message 必须是可辨识联合、而不能是扁平 interface 的原因（L1）。
  assert.strictEqual(messages[1]?.role === 'tool' ? messages[1].tool_call_id : null, 'call_1');
});

test('⑦ 失败路径：参数缺失时工具报错，而不是程序崩掉', async () => {
  const result = await registry.execute('weather', {});
  assert.strictEqual(result.ok, false);
  // 错误文本要能**指导模型改** —— 它只会照着自己看得懂的话改
  assert.ok(!result.ok && result.error.includes('city'));
});

test('⑧ 未知名工具：模型编出一个不存在的工具名，也是 {ok:false} 而不是抛错', async () => {
  const result = await registry.execute('get_weather', {});
  assert.strictEqual(result.ok, false);
  assert.ok(!result.ok && result.error.includes('get_weather'));
});

test('⑨ 连起来：这一串动作就是 L4 那个循环体的一次迭代', async () => {
  // 手工写死的「模型这一轮的产出」
  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'weather', arguments: '{"city":"Beijing"}' },
  };

  // ② 解析参数
  const args = JSON.parse(toolCall.function.arguments) as unknown;
  // ③ 派发执行
  const result = await registry.execute(toolCall.function.name, args);
  // ④ 结果转成 tool 消息的 content
  const content = result.ok ? JSON.stringify(result.value) : result.error;
  // ⑤ 拼成两条要回喂给模型的消息
  const added: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    { role: 'tool', tool_call_id: toolCall.id, content },
  ];

  // 下面这个字符串由 JSON.stringify 精确匹配，因此它同时钉住了 weather.ts 里
  // value 的**属性插入顺序**（city, temperature, condition）。
  // 单纯重排那几个键、行为完全不变，也会让这条变红 —— 那是误报，不是回归。
  assert.deepStrictEqual(added, [
    { role: 'assistant', content: null, tool_calls: [toolCall] },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"city":"Beijing","temperature":"25°C","condition":"Sunny"}',
    },
  ]);
});
