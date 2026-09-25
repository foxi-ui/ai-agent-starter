// 查天气 —— **确定性 mock**，不联网、不需要 key。
//
// 本阶段的学习目标是 tool calling 这条链路本身（模型怎么开调用单、
// 程序怎么执行、结果怎么回喂），不是「怎么调第三方天气 API」。
// 用一个内置小表把网络这个变量消掉，失败原因才能收敛到链路自己身上（spec D10）。

import type { Tool, ToolResult } from '@/core/types.ts';
import type { ToolDefinition } from '@/core/tool-registry.ts';

/** 内置的「天气数据库」。键是小写城市名 */
const WEATHER_TABLE: Record<string, { temperature: string; condition: string }> = {
  beijing: { temperature: '25°C', condition: 'Sunny' },
  shanghai: { temperature: '28°C', condition: 'Cloudy' },
  shenzhen: { temperature: '31°C', condition: 'Thunderstorm' },
  hangzhou: { temperature: '27°C', condition: 'Light Rain' },
  chengdu: { temperature: '23°C', condition: 'Overcast' },
};

/** 未收录城市的兜底值 */
const FALLBACK = { temperature: '22°C', condition: 'Partly Cloudy' };

const declaration: Tool = {
  name: 'weather',
  description: '查询某个城市今天的天气。需要知道某地天气时使用。',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '城市名，例如 Beijing、Shanghai' },
    },
    required: ['city'],
  },
};

export const weatherTool: ToolDefinition = {
  declaration,

  run(args: unknown): ToolResult {
    // 参数形状不可信 —— 模型可能传字符串、传 null、干脆不传。
    // 校验不过就返回错误文本，它会作为 tool 消息回喂给模型，让它自己改。
    if (typeof args !== 'object' || args === null) {
      return { ok: false, error: '参数必须是对象，且包含 city 字段' };
    }
    const city = (args as { city?: unknown }).city;
    if (typeof city !== 'string' || city.trim() === '') {
      return { ok: false, error: '缺少 city 参数，或 city 不是非空字符串' };
    }

    const trimmed = city.trim();
    const hit = WEATHER_TABLE[trimmed.toLowerCase()];

    if (!hit) {
      // 兜底**这条路径**要明说是模拟数据（命中路径不带这个 note —— 表内数据是真的）
      // —— 否则模型会把编出来的天气当事实转述给用户
      return {
        ok: true,
        value: { city: trimmed, ...FALLBACK, note: '模拟数据：该城市不在内置表中' },
      };
    }

    return { ok: true, value: { city: trimmed, ...hit } };
  },
};
