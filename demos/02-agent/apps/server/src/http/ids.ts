// 会话 id：`YYYYMMDD-HHMMSS-xxxx`（本地时间 + 4 位随机十六进制），
// 可读、按字典序排就是时间序，随机后缀避免同一秒内建两个会话撞名（spec §11 要点 4）。
//
// 因为本项目没有文件系统，**不需要路径穿越校验** —— id 只用来查 Map，
// 查不到就是 404。（01-llm 的那套白名单校验是给文件名用的，这里用不上。）

import { randomBytes } from 'node:crypto';

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function newSessionId(now: Date = new Date()): string {
  // 逐段取**本地时间**分量，不要用 toISOString() —— 后者是 UTC，
  // 东八区会得到早 8 小时的时间。那是个安静的错误：`ls` 出来看着也像那么回事。
  //
  // 注意 getMonth() 是 0 基的，所以要 +1。
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
  const time = `${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
  return `${date}-${time}-${randomBytes(2).toString('hex')}`;
}
