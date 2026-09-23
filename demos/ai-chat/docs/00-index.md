# ai-chat（原始需求）
## 目标
实现一个ai对话，在cli模式下。CLI AI Assistant

不要使用 LangChain，直接调用模型 API。

## 项目简介

### 基础能力：

```text
$ ai-chat

You: 什么是 React Server Components？

AI: ...

You: 总结刚才内容

AI: ...
```

逐步增加：

```text
/clear
/history
/model
/usage
```

然后增加：

```text
streaming
structured output
conversation history
error handling
token statistics
```

## 实践完成有本人会掌握以下知识

```text
LLM API
   ↓
消息结构
   ↓
上下文管理
   ↓
Streaming
   ↓
错误处理
   ↓
Token 统计
```