# AI Agent 新手学习路线与工程落地实践规划

> 目标：从 AI Agent 新手出发，通过项目驱动的方式，逐步掌握 LLM、Tool Calling、Agent、MCP、RAG、Memory、Workflow、Evaluation、安全与生产化，并最终具备独立设计、开发、评测和部署 AI Agent 系统的能力。

---

## 一、学习目标

不要把目标设定为：

> 学完 LangChain、RAG、MCP、Multi-Agent 等所有知识。

更合理的目标是：

> 能够独立设计、开发、调试、评测和部署一个可靠的 AI Agent 系统。

最终应该能够回答：

- 为什么需要 Agent？
- Agent 和普通 Chatbot 有什么区别？
- 什么场景适合 Agent，什么场景适合 Workflow？
- Tool Calling 是如何工作的？
- MCP 解决什么问题？
- RAG 为什么会失败？
- Memory 应该保存什么？
- Agent 为什么会无限循环？
- 如何限制 Agent 权限？
- 如何让 Agent 支持失败恢复？
- 如何测试 Agent？
- 如何衡量 Agent 是否真的变好了？
- 如何降低 Token 和 API 成本？
- 如何降低 Agent 延迟？
- 如何处理 Prompt Injection？
- 什么时候需要 Multi-Agent？
- 什么时候 Multi-Agent 是过度设计？
- 如何把 Agent 部署到生产环境？

---

# 二、Agent 全景知识图

```text
                    AI Agent
                       |
        +--------------+--------------+
        |              |              |
        v              v              v
       LLM            Tools         Memory
        |              |              |
   理解/推理/决策    调用外部能力     保存上下文
        |              |              |
        +--------------+--------------+
                       |
                       v
                     Agent
                       |
             +---------+---------+
             |                   |
             v                   v
           RAG                 Workflow
             |                   |
       知识检索增强          多步骤执行
             |                   |
             +---------+---------+
                       |
                       v
                  Evaluation
                       |
                       v
                 Production
```

核心知识领域：

| 领域 | 学习内容 | 重要程度 |
|---|---|---|
| LLM 基础 | Prompt、Token、Context、Tool Calling | ★★★★★ |
| Agent 原理 | Agent Loop、ReAct、规划、执行、状态 | ★★★★★ |
| Tools | Function Calling、MCP、API、Shell | ★★★★★ |
| RAG | Embedding、Vector Search、Hybrid Search、Rerank | ★★★★★ |
| Memory | 短期状态、长期记忆、任务状态 | ★★★★☆ |
| Workflow | DAG、状态机、Human-in-the-loop | ★★★★★ |
| Evaluation | Dataset、指标、Trace、回归测试 | ★★★★★ |
| Multi-Agent | Agent 协作、角色拆分 | ★★★☆☆ |
| Security | 权限、Prompt Injection、Sandbox | ★★★★★ |
| Production | 日志、监控、成本、重试、部署 | ★★★★★ |

---

# 三、整体学习路线

建议按照 6 个阶段进行，整体约 4～6 个月。

每天投入 1～2 小时即可。

```text
阶段 0：LLM 基础
       ↓
阶段 1：第一个 Agent
       ↓
阶段 2：Tools + MCP
       ↓
阶段 3：RAG + Memory
       ↓
阶段 4：Workflow + Multi-Agent
       ↓
阶段 5：Evaluation + Production
       ↓
最终项目：AI Software Factory
```

核心原则：

> 概念 → 最小实验 → 工程能力 → 完整项目 → 生产化 → 反向补理论

---

# 四、阶段 0：LLM 基础

## 目标

成为能够正确使用 LLM API 的工程师，而不是一开始就学习模型训练。

## 学习内容

### 1. LLM 基本概念

- Token
- Context Window
- Temperature
- Top-P
- System Prompt
- User Prompt
- Assistant
- Streaming
- Structured Output

### 2. 理解普通 LLM 调用

```text
Prompt
  ↓
LLM
  ↓
Output
```

### 3. 理解 Agent 型调用

```text
Prompt
  ↓
LLM
  ↓
Tool Call
  ↓
程序执行
  ↓
Tool Result
  ↓
LLM
  ↓
Final Answer
```

第二种模式是后续 Agent 工程的基础。

---

# 五、实践项目 1：CLI AI Assistant

不要使用 LangChain，直接调用模型 API。

项目：

```text
ai-chat
```

基础能力：

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

## 需要掌握

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

---

# 六、阶段 1：真正理解 Agent

这一阶段不要急着使用复杂框架。

自己实现一个最简单的 Agent。

## Agent 最基本循环

```text
User
 ↓
LLM
 ↓
需要工具？
 ↓
 +-- No → Answer
 |
 +-- Yes
       ↓
     Tool
       ↓
   Tool Result
       ↓
      LLM
       ↓
     Answer
```

例如：

```text
用户：
北京今天天气怎么样？

Agent：
需要天气工具

Tool Call：
weather("Beijing")

Tool Result：
25°C, Sunny

Final：
北京今天 25°C，晴天。
```

---

# 七、实践项目 2：Mini Coding Agent

这个项目非常适合有软件开发经验的人。

项目：

```text
mini-coding-agent
```

提供工具：

```text
read_file
write_file
list_files
search_code
run_command
```

例如：

```text
用户：
帮我分析 src 目录中的登录模块
```

Agent：

```text
list_files
 ↓
search_code
 ↓
read_file
 ↓
分析
 ↓
输出报告
```

进一步支持代码修改：

```text
用户：
帮我给登录接口增加参数校验
```

执行：

```text
search
 ↓
read
 ↓
修改
 ↓
run test
 ↓
test失败？
   ↓
修复
 ↓
再次测试
 ↓
完成
```

## 这一阶段要真正理解

> Agent 的本质不是“AI 会写代码”，而是：

```text
LLM
+
Tools
+
State
+
Execution Loop
```

---

# 八、阶段 2：Tools + MCP

这是 Agent 工程非常重要的一部分。

## 学习内容

- Function Calling
- Tool Schema
- Tool Registry
- MCP
- MCP Server
- MCP Client
- Resource
- Prompt
- Permission

理解：

```text
Agent
 |
 +-- filesystem
 +-- database
 +-- Git
 +-- browser
 +-- HTTP API
 +-- MCP
```

---

# 九、实践项目 3：Developer Agent

制作一个个人开发助手：

```text
Developer Agent
```

工具：

```text
Git
Filesystem
Shell
Database
HTTP
```

例如：

```text
用户：
帮我检查这个项目最近有哪些 bug。
```

Agent：

```text
git log
 ↓
git diff
 ↓
搜索 TODO
 ↓
运行测试
 ↓
分析
 ↓
生成报告
```

进一步接入：

```text
GitHub
Jira
Notion
数据库
```

这一阶段开始进入真正的 Agent Engineering。

---

# 十、阶段 3：RAG

这时候再学习 RAG。

不要把 RAG 和 Agent 完全等同。

RAG 更适合被理解为：

> Agent 的知识获取能力。

核心流程：

```text
Document
 ↓
Chunking
 ↓
Embedding
 ↓
Vector DB
 ↓
Retrieval
 ↓
Rerank
 ↓
Context
 ↓
LLM
```

## 第一层

- Embedding
- Vector Search

## 第二层

- Chunking
- Metadata
- Hybrid Search
- Rerank

## 第三层

- Query Rewrite
- Multi Query
- Parent Document
- Context Compression

---

# 十一、实践项目 4：个人技术知识库 Agent

项目：

```text
my-ai-knowledge
```

知识范围可以包括：

```text
React
Vue
React Native
Node
Java
Claude Code
TeamAI
MCP
AI Agent
```

使用方式：

```text
用户：
React Native 中 TypeScript 路径别名怎么配置？
```

流程：

```text
Query
 ↓
Retrieval
 ↓
Rerank
 ↓
Relevant Docs
 ↓
LLM
 ↓
Answer
```

进一步：

```text
Agent
 ↓
搜索知识库
 ↓
判断是否足够
 ↓
如果不足
 ↓
Web Search
 ↓
综合答案
```

---

# 十二、阶段 3.5：Memory

Memory 不应该简单理解为：

> 把所有聊天记录都保存下来。

应该理解成多个层次：

```text
短期状态
Long Context
长期记忆
用户偏好
任务状态
知识库
```

可以划分为：

```text
Conversation Memory
User Profile
Project Memory
Task Memory
Knowledge Base
```

---

# 十三、实践项目 5：Personal AI Assistant

这是一个值得长期维护的项目。

架构：

```text
                 Personal AI
                      |
        +-------------+-------------+
        |             |             |
        v             v             v
   Chat Agent    Coding Agent   Knowledge Agent
        |             |             |
        v             v             v
     Memory       Git/Shell        RAG
        |             |             |
        +-------------+-------------+
                      |
                     MCP
```

能力：

```text
问答
代码分析
知识库
文件管理
Git
任务管理
Web Search
```

这个项目可以不断演进，最终成为自己的个人 AI 助手。

---

# 十四、阶段 4：Workflow

这是 Agent 工程非常重要的一步。

不是所有任务都应该交给 Agent 自由发挥。

例如：

```text
需求
 ↓
分析
 ↓
设计
 ↓
编码
 ↓
测试
 ↓
Review
 ↓
部署
```

这种任务更适合：

```text
Workflow
```

而不是：

```text
一个超级 Agent
```

---

# 十五、重点学习状态机

例如：

```text
START
 ↓
ANALYZE
 ↓
PLAN
 ↓
IMPLEMENT
 ↓
TEST
 ↓
REVIEW
 ↓
PASS
 ↓
END
```

如果：

```text
TEST FAIL
```

则：

```text
TEST
 ↓
ANALYZE_ERROR
 ↓
FIX
 ↓
TEST
```

这就是：

> Agent + Workflow

---

# 十六、实践项目 6：AI 软件开发流水线

这是非常值得投入的项目。

项目：

```text
AI Software Factory
```

输入：

```text
需求：
增加用户注册功能
```

自动执行：

```text
Requirement Agent
        ↓
Architecture Agent
        ↓
Implementation Agent
        ↓
Test Agent
        ↓
Review Agent
        ↓
Human Approval
        ↓
Merge
```

关键不是完全自动化，而是：

```text
AI
 ↓
生成
 ↓
验收
 ↓
Human
 ↓
继续
```

这与“每个环节验收、输出稳定”的 AI 编程工作流高度一致。

---

# 十七、阶段 5：Evaluation

很多 Agent 初学者会忽略 Evaluation。

但真正进入工程阶段后，这是必须掌握的。

基本流程：

```text
100 个测试问题
       ↓
     Agent
       ↓
     Answer
       ↓
   Evaluator
       ↓
     Score
```

重点指标：

```text
正确率
工具调用正确率
RAG Recall
RAG Precision
Hallucination
Latency
Token
Cost
Task Success Rate
```

核心思想：

> 不要只凭感觉判断 Agent 是否变好了。

而应该建立可重复的测试集和评测流程。

---

# 十八、实践项目 7：Agent Evaluation Platform

可以制作一个简单的平台：

```text
                    Evaluation
                        |
           +------------+------------+
           |            |            |
           v            v            v
        Dataset       Agent       Evaluator
           |            |            |
           +------------+------------+
                        |
                      Report
```

例如：

```text
Dataset：
100 条问题

Agent V1：
Accuracy 78%

Agent V2：
Accuracy 86%

Agent V3：
Accuracy 89%
```

最终能力从：

> “这个 Agent 好像挺聪明。”

提升到：

> “我能够用数据证明这个 Agent 是否真的变好了。”

---

# 十九、阶段 6：Security + Production

在正式部署之前，需要学习 Agent 安全与生产工程。

## 安全

重点：

```text
Prompt Injection
Tool Permission
Least Privilege
Sandbox
Sensitive Data
Command Execution
File Access
Network Access
User Authentication
Authorization
Audit Log
```

尤其是 Coding Agent：

```text
Agent
 ↓
Shell
 ↓
Filesystem
 ↓
Git
```

必须考虑权限边界。

---

## 生产化

重点：

```text
Logging
Tracing
Metrics
Retry
Timeout
Rate Limit
Caching
Token Cost
Model Fallback
Error Recovery
State Persistence
Observability
Deployment
```

---

# 二十、Multi-Agent

不要太早学习。

推荐顺序：

```text
Single Agent
 ↓
Tool Agent
 ↓
RAG Agent
 ↓
Workflow
 ↓
Human-in-the-loop
 ↓
Multi-Agent
```

很多系统一开始就设计：

```text
Research Agent
Coding Agent
Reviewer Agent
Manager Agent
Planner Agent
```

容易出现：

```text
Agent 套 Agent
 ↓
Token 爆炸
 ↓
Latency 增加
 ↓
Debug 困难
 ↓
结果不稳定
```

所以 Multi-Agent 应该解决明确的问题，而不是为了“看起来高级”。

---

# 二十一、最终综合项目：AI Software Factory

最终建议做一个真正有规模的 AI 软件研发平台。

```text
                         AI Dev Platform
                               |
                  +------------+------------+
                  |                         |
                  v                         v
              Frontend                  Backend
                  |                         |
                  +------------+------------+
                               |
                         Agent Gateway
                               |
        +----------------------+----------------------+
        |                      |                      |
        v                      v                      v
   Coding Agent         Knowledge Agent        Review Agent
        |                      |                      |
        v                      v                      v
      Tools                   RAG                   Tools
        |                      |                      |
        +----------------------+----------------------+
                               |
                           Workflow
                               |
                 +-------------+-------------+
                 |             |             |
                 v             v             v
              Planning      Coding        Testing
                 |             |             |
                 +-------------+-------------+
                               |
                           Evaluation
                               |
                               v
                         Human Approval
```

---

# 二十二、推荐技术栈

不要同时学习大量 Agent 框架。

## 基础

```text
Python
TypeScript
HTTP
JSON
Async
Git
Docker
```

你已经有前后端开发经验，因此 Python 重点补 AI 工程相关能力即可。

## LLM

建议至少熟悉 2～3 家模型 API：

```text
OpenAI
Anthropic
DeepSeek
```

重点不是记 API，而是掌握：

```text
Messages
Tool Calling
Structured Output
Streaming
Context
```

## Agent Framework

推荐顺序：

```text
原生 LLM API
 ↓
LangGraph
 ↓
MCP
```

不要一开始同时学习：

```text
LangChain
AutoGen
CrewAI
Dify
Coze
...
```

---

# 二十三、项目驱动学习顺序

不要采用：

```text
学 LLM
 ↓
学 RAG
 ↓
学 Agent
 ↓
学 MCP
 ↓
学 Multi-Agent
 ↓
最后做项目
```

推荐：

```text
项目
 ↓
遇到问题
 ↓
学习对应知识
 ↓
解决问题
 ↓
总结
 ↓
进入下一阶段
```

对应项目：

## 项目 1：AI Chat

学习：

```text
LLM API
Prompt
Context
Streaming
```

↓

## 项目 2：Coding Agent

学习：

```text
Tool Calling
Agent Loop
State
```

↓

## 项目 3：Knowledge Agent

学习：

```text
Embedding
RAG
Rerank
Memory
```

↓

## 项目 4：Developer Agent

学习：

```text
MCP
Git
Shell
Filesystem
```

↓

## 项目 5：AI Software Factory

学习：

```text
Workflow
State Machine
Human Approval
Evaluation
```

↓

## 项目 6：Production Agent

学习：

```text
Security
Observability
Cost
Latency
Deployment
```

---

# 二十四、每个阶段都留下工程资产

不要做完 Demo 就删除。

建议建立：

```text
01-llm/
02-agent/
03-tools/
04-mcp/
05-rag/
06-memory/
07-workflow/
08-evaluation/
09-production/
```

每个项目至少维护：

```text
README.md
ARCHITECTURE.md
HOW-IT-WORKS.md
DECISIONS.md
EVALUATION.md
```

同时记录：

```text
问题
 ↓
尝试
 ↓
失败
 ↓
原因
 ↓
解决
 ↓
经验
```

半年以后得到的就不是：

> “我看过很多 Agent 教程。”

而是：

> “我有一套自己的 Agent Engineering 方法论。”

---

# 二十五、结合软件开发背景的学习主线

如果本身已经有软件开发经验，可以把学习分成两条线。

```text
                    AI Agent
                       |
           +-----------+-----------+
           |                       |
           v                       v
    Agent Engineering        AI Coding Agent
           |                       |
        RAG/Memory              Claude Code
        Tools/MCP               TeamAI
        Workflow               Skills
        Evaluation              MCP
           |                       |
           +-----------+-----------+
                       |
                       v
                AI Software Factory
```

对于已经熟悉软件开发的人，第二条线可以作为主线：

```text
AI Coding Agent
       ↓
AI 软件研发工作流
       ↓
AI Software Factory
```

这样能够直接把学习成果应用到日常开发中。

---

# 二十六、建议的阶段验收标准

每个阶段都必须“验收”，不要只看教程完成度。

## 阶段 0 验收

能够：

- 独立调用 LLM API
- 实现 Streaming
- 管理上下文
- 使用 Structured Output
- 处理 API 错误
- 统计 Token / Cost

## 阶段 1 验收

能够：

- 自己实现 Agent Loop
- 自己定义 Tool
- 处理 Tool Result
- 实现基本任务循环
- 防止无限循环

## 阶段 2 验收

能够：

- 理解 Function Calling
- 编写 MCP Server
- 接入 MCP Tool
- 实现权限控制
- 将外部服务接入 Agent

## 阶段 3 验收

能够：

- 构建完整 RAG
- 理解 Embedding
- 实现 Chunking
- 实现 Retrieval
- 使用 Rerank
- 分析 RAG 失败原因

## 阶段 4 验收

能够：

- 设计 Workflow
- 使用状态机
- 实现失败重试
- 实现 Human-in-the-loop
- 判断何时应该使用 Workflow 而不是 Agent

## 阶段 5 验收

能够：

- 建立 Agent Evaluation Dataset
- 定义指标
- 建立回归测试
- 分析 Agent Trace
- 统计 Token / Cost / Latency
- 处理 Prompt Injection
- 实现权限控制
- 完成基本生产部署

---

# 二十七、最终能力模型

最终希望形成：

```text
                 AI Agent Engineer
                        |
       +----------------+----------------+
       |                |                |
       v                v                v
    AI 基础          Agent 工程        软件工程
       |                |                |
      LLM            Tools/MCP        Architecture
      Prompt         RAG              Testing
      Context        Memory           Git
      Model          Workflow         CI/CD
       |                |                |
       +----------------+----------------+
                        |
                        v
                  Production AI
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
       Reliable       Secure        Observable
```

最终目标不是：

> “会使用某一个 Agent 框架。”

而是：

> **面对一个真实业务问题，能够判断是否需要 Agent，选择合适的模型、Tools、RAG、Memory、Workflow 和评测方案，并把系统可靠地落地到生产环境。**

---

# 二十八、推荐的最终学习路线总览

```text
第 1 阶段
LLM API
    ↓
AI Chat

第 2 阶段
Agent Loop
Tool Calling
    ↓
Coding Agent

第 3 阶段
MCP
Tools
    ↓
Developer Agent

第 4 阶段
RAG
Memory
    ↓
Knowledge Agent

第 5 阶段
Workflow
State Machine
Human-in-the-loop
    ↓
AI Software Factory

第 6 阶段
Evaluation
Security
Observability
Production
    ↓
Production AI Agent

第 7 阶段
Multi-Agent
    ↓
复杂 AI 系统
```

---

# 二十九、最重要的学习原则

## 原则 1：不要追框架

框架会不断变化。

优先掌握：

```text
LLM
Tool
State
Context
RAG
Workflow
Evaluation
Security
```

---

## 原则 2：不要只做 Demo

Demo 的目标是理解概念。

真正成长来自：

```text
失败
 ↓
Debug
 ↓
定位原因
 ↓
修改架构
 ↓
重新评测
```

---

## 原则 3：Agent 必须可观测

每一个 Agent 都应该能够回答：

```text
它为什么调用这个 Tool？
调用了几次？
每次花了多少 Token？
耗时多久？
哪个步骤失败？
为什么失败？
最终为什么得到这个结果？
```

---

## 原则 4：每个环节都验收

尤其适合软件开发型 Agent：

```text
需求
 ↓
验收

设计
 ↓
验收

代码
 ↓
测试

测试
 ↓
验收

Review
 ↓
验收

部署
 ↓
验收
```

不要追求：

> 一句话让 Agent 自动完成所有事情。

更可靠的方向是：

> **AI 自动执行 + 明确检查点 + 必要的人类审批。**

---

## 原则 5：用真实项目驱动学习

最终最值得投入的不是十几个 Demo，而是一个持续演进的项目：

```text
AI Coding Agent
       ↓
Developer Agent
       ↓
Knowledge Agent
       ↓
Workflow
       ↓
Evaluation
       ↓
AI Software Factory
```

这样学习、工程实践和日常软件开发能够形成闭环。

---

# 三十、最终目标

经过完整学习后，希望形成以下能力：

```text
看到业务问题
      ↓
判断是否适合 Agent
      ↓
设计 Agent Architecture
      ↓
选择模型
      ↓
设计 Tools
      ↓
设计 RAG / Memory
      ↓
设计 Workflow
      ↓
加入 Human Approval
      ↓
建立 Evaluation
      ↓
加入 Security
      ↓
加入 Observability
      ↓
控制 Cost / Latency
      ↓
部署 Production
      ↓
持续评测和迭代
```

这才是 AI Agent 学习的终点：

> **不是“学会 Agent”，而是具备 AI Agent 系统工程能力。**
