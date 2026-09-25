// 会话状态：按顺序累积对话消息。
//
// 只负责「记住说过什么」，不碰网络、也不负责打印。
//
// 默认仍然是**无副作用**的纯类：不传 onChange 时，它的行为与 M1 完全一致。
// 需要落盘时由调用方注入一个回调，三个变更点改完状态就广播一次 ——
// 广播比「调用方记得在每处补写」可靠，因为 `/clear` 与 `/model <name>`
// 是 executeCommand **内部**改的状态，调用方看不见它们。

import type { Message, Role } from '@/core/types.ts';
import type { SessionChange } from '@/core/journal.ts';

/** 构造 Session 时的可选项 */
export interface SessionOptions {
  /** 回放得到的历史消息。不传即空会话 */
  history?: Message[];
  /** 变更广播。不传则完全退回「无副作用」的纯行为 */
  onChange?: (change: SessionChange) => void;
}

/**
 * 一段对话的消息记录。
 *
 * 类本身只持有内存状态；「退出即清空」由注入的 onChange 打破 ——
 * 传了它，每次变更就会落到磁盘（见 cli/repl.ts），不传则与 M1 完全一致。
 */
export class Session {
  /** 已累积的消息，按时间顺序排列 */
  private messages: Message[];

  /**
   * 本会话当前使用的模型。
   *
   * 它属于「会话状态」而不是「client 配置」——`/model` 能中途切换它，
   * 每次请求再把它作为 per-call 参数传给 client。
   */
  private currentModel: string;

  /** 变更广播回调；不传就是 undefined，此时这个类与 M1 的行为完全一致 */
  private onChange?: (change: SessionChange) => void;

  /**
   * @param model 初始模型，通常来自 `resolveConfig` 的 `config.model`
   * @param options 初始历史与变更广播，都可选
   */
  constructor(model: string, options: SessionOptions = {}) {
    // 刻意不用 `constructor(private currentModel: string)` 这种参数属性写法：
    // 本项目靠 Node 的原生类型擦除直接跑 .ts，而擦除模式（strip-only）
    // 不支持 TS 独有的参数属性语法，会在运行时报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
    // 注意 tsc --noEmit 不会拦下它 —— 类型检查能过、运行才炸，所以只能靠这条注释守着。
    this.currentModel = model;

    // 回放结果直接铺成初始状态，**不经过 append**。
    // 这是必须的：构造时若也广播，每恢复一条历史就多写一行日志 ——
    // 打开一次会话，文件就翻一倍。
    //
    // 复制一份而不是直接引用调用方的数组，免得外部还拿着它改。
    this.messages = options.history ? [...options.history] : [];

    this.onChange = options.onChange;
  }

  /**
   * 追加一条消息到会话末尾。
   *
   * @param role 谁说的：user 是用户，assistant 是 AI
   * @param content 消息正文
   */
  append(role: Role, content: string): void {
    this.messages.push({ role, content });
    // **先改内存、再广播**是刻意的顺序：广播的实现（写文件）抛错时，
    // 内存状态已经改好了，不会留下「推了一半」的中间态。
    // 磁盘落后于内存 + 一次警告，是选定的降级方向（见 cli/repl.ts）。
    this.onChange?.({ type: 'message', role, content });
  }

  /**
   * 组装出「这一次要发给 API 的完整消息数组」。
   *
   * 返回 `[system, ...历史消息]`：system 提示永远排在最前。
   * 因为它是每次请求都要重新带上、且位置固定的稳定前缀，
   * 它不属于对话历史，所以不存在 `messages` 里，而是每次现加。
   *
   * @param systemPrompt 系统提示；传空串则不插入 system 消息
   */
  toMessages(systemPrompt: string): Message[] {
    const messages: Message[] = [];
    if (systemPrompt !== '') {
      messages.push({ role: 'system', content: systemPrompt });
    }
    // 用 concat 生成新数组返回，保证「返回的不是内部那个数组」，
    // 免得调用方 push/splice 改到会话状态。
    //
    // 注意它**不保证元素隔离** —— concat 与 slice 一样只复制外层数组，
    // 里面的 Message 对象仍是共享的。这是刻意的，别顺手改成深拷贝：
    // 这个方法每轮请求都跑，结果直送 JSON.stringify（见 llm/deepseek.ts），
    // 全链路上没有任何改动方，深拷贝只会为每轮多分配 N 个小对象。
    // 与 history() 的处置不同是**刻意分开**的，不是漏改：那边有 spec 明文
    // 要求「外部改不动内部状态」，且在用户手敲 /history 才触发的冷路径上。
    return messages.concat(this.messages);
  }

  /** 当前模型 */
  get model(): string {
    return this.currentModel;
  }

  /** 切换当前模型；只影响后续请求，不改动已有消息 */
  set model(name: string) {
    this.currentModel = name;
    this.onChange?.({ type: 'model', model: name });
  }

  /**
   * 清空所有消息，返回清掉的条数。
   *
   * 不影响当前模型 —— `/clear` 清的是对话内容，不是会话配置。
   * 返回条数是为了让调用方能给出「已清空 N 条消息」这种有信息量的反馈。
   */
  clear(): number {
    const removed = this.messages.length;
    this.messages = [];
    this.onChange?.({ type: 'clear' });
    return removed;
  }

  /**
   * 返回消息列表的**副本**，外部改不动内部状态。
   *
   * 这里要的是**深**拷贝而不是 `slice()`：slice 只换掉外层数组，
   * 元素仍是内部那些对象，调用方一句 `snapshot[0].content = 'x'`
   * 就穿透进来改了会话状态。spec 写的契约是「外部改不动内部状态」，
   * 所以元素也必须是新的。
   *
   * `{ ...message }` 在这里是**完备**的深拷贝、不是半吊子加固：
   * `Message` 是扁平结构（role / content 都是原始类型），没有嵌套对象
   * 或数组需要递归复制。将来若给 Message 加了嵌套字段，这一行必须
   * 同步升级成真正的深拷贝。
   */
  history(): Message[] {
    return this.messages.map((message) => ({ ...message }));
  }
}
