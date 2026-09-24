// 演示 readline 的两种消费方式，以及它们对「请求时序」的影响。
//
//   A. for await (const line of rl)   拉模型（pull）→ 串行
//   B. rl.on('line', handler)         推模型（push）→ 并发
//
// 结论：本项目必须用 A。用 B 的话，`session.append('assistant', ...)`
// 会按「回答到达的先后」写入数组，把对话历史顺序打乱。
//
// 相关文档：docs/how-conversation-works.html（「关联知识」一节）
//
// 运行：node examples/readline-pull-vs-push.mjs
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';

// 用假模型代替 HTTP 请求。
// 故意让「越早问的越慢」—— 这样两种写法的差异一眼可见。
const DELAY = { 一: 300, 二: 200, 三: 100 };
const QUESTIONS = Object.keys(DELAY);

const SINK = { write: () => true }; // 吞掉 readline 自己往 output 写的东西
const input = () => Readable.from(QUESTIONS.map((q) => q + '\n'));

let t0 = 0; // 本轮实验的起点，用来算相对时刻
const ask = async (q) => {
  const start = Date.now() - t0;
  await new Promise((resolve) => setTimeout(resolve, DELAY[q]));
  return { q, start, end: Date.now() - t0 };
};

// ── A：for await —— 每轮跑完才拉下一行 ────────────────────────
async function withForAwait() {
  t0 = Date.now();
  const rl = createInterface({ input: input(), output: SINK });
  const marks = [];

  for await (const line of rl) {
    const q = line.trim();
    if (!q) continue;
    // 这里的 await 会让循环停住 —— rl.next() 直到这行跑完才被再次调用。
    // 这正是串行的来源。
    marks.push(await ask(q));
  }

  return marks;
}

// ── B：rl.on('line') —— 行一到就触发，不等上一次 ───────────────
function withOnLine() {
  t0 = Date.now();
  const rl = createInterface({ input: input(), output: SINK });
  const pending = [];

  rl.on('line', (line) => {
    const q = line.trim();
    if (!q) return;
    // 故意不 await：三个请求会同时在途。
    pending.push(ask(q));
  });

  // 用 Promise.all 等全部落地 —— 而不是 setTimeout 猜一个时长，
  // 否则量出来的总耗时是假的。
  return new Promise((resolve) => {
    rl.on('close', () => resolve(Promise.all(pending)));
  });
}

// ── 输出 ─────────────────────────────────────────────────────
function report(label, marks) {
  const order = (key) => [...marks].sort((a, b) => a[key] - b[key]).map((m) => m.q);
  const span = Math.max(...marks.map((m) => m.end));

  console.log(`\n${label}`);
  console.log(`  发出顺序  ${order('start').join(' → ')}`);
  console.log(`  完成顺序  ${order('end').join(' → ')}`);
  console.log(`  总跨度    ${span}ms`);

  for (const m of marks) {
    // 每 10ms 画一格，用条形把时间线画出来
    const bar = '█'.repeat(Math.max(1, Math.round((m.end - m.start) / 10)));
    const start = String(m.start).padStart(4);
    const end = String(m.end).padStart(4);
    console.log(`  ${m.q}  起 ${start}ms  止 ${end}ms  ${bar}`);
  }
}

report('A. for await —— 拉模型，串行', await withForAwait());
report("B. rl.on('line') —— 推模型，并发", await withOnLine());

console.log('\nA 的请求依次出发，总跨度约等于三个请求之和；');
console.log('B 的请求同时出发，总跨度只等于最慢的那一个，但完成顺序被打乱了。');
