// SSE（Server-Sent Events）分帧：把字节流切下来的**字符串块**切成一条条事件。
//
// 这一层只懂 SSE 协议本身，**不懂 DeepSeek / OpenAI**：
// `data: [DONE]` 对它就是一条 `data` 为 "[DONE]" 的普通事件，含义由调用方解释。
//
// 为什么是纯函数：SSE 按字节到达，一条事件可能被 TCP 切成两次 read()，
// 一次 read() 也可能含多条事件。用「传入残余缓冲、返回新残余」的纯函数形态，
// 这套最容易出错的逻辑就能用「喂字符串、断言字符串」测透，
// 而不必去构造假的可读流。

/** 一条 SSE 事件 */
export interface SseEvent {
  /** `event:` 字段的值；缺省为 'message' */
  event: string;
  /** 该事件的 `data:` 内容（多行 data 已按规范用 \n 拼接） */
  data: string;
}

/** SSE 规范里没有 `event:` 字段时的事件名 */
const DEFAULT_EVENT = 'message';

/**
 * 解析一个事件块（已被空行分隔出来的那一段）。
 *
 * @returns 有 data 才返回事件；只有注释或其他字段的块返回 null
 */
function parseBlock(block: string): SseEvent | null {
  let event = DEFAULT_EVENT;
  const dataLines: string[] = [];

  for (const line of block.split('\n')) {
    // 空行不该出现在块内；':' 开头是注释（服务端用它做 keep-alive）
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    // 没有冒号的行按规范是「字段名 + 空值」。本项目用不到这种形态，直接忽略。
    // 注意：`data`（无冒号）真实含义是「data 为空串」，这里不实现该分支。
    if (colon === -1) continue;

    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    // 规范：冒号后若紧跟一个空格，该空格是分隔符，要剥掉；多余空格属于数据
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // id / retry 等其他字段本项目用不到，忽略
  }

  // 规范：data 缓冲为空的块不 dispatch
  if (dataLines.length === 0) return null;

  return { event, data: dataLines.join('\n') };
}

/**
 * 把新到的文本与上一次的残余拼起来，切出能完整解析的事件。
 *
 * @param chunk 本次新到的文本（调用方已用 TextDecoder 解好码）
 * @param buffer 上一次返回的 `rest`；首次调用可省略
 */
export function parseSse(
  chunk: string,
  buffer?: string,
): { events: SseEvent[]; rest: string } {
  // 先拼接、后规范化换行。顺序不能反：
  // buffer 尾部可能是一个落单的 '\r'，单独看它无法判断是否与下一块的 '\n' 成对。
  const text = (buffer ?? '') + chunk;
  const normalized = text.replace(/\r\n/g, '\n');

  const parts = normalized.split('\n\n');
  // 最后一段可能是不完整的，留到下次；文本以空行结尾时它是空串
  const rest = parts.pop() ?? '';

  const events: SseEvent[] = [];
  for (const part of parts) {
    const parsed = parseBlock(part);
    if (parsed) events.push(parsed);
  }

  return { events, rest };
}
