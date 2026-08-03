---
name: deepseek-helper
description: "DeepSeek API 助手 - 编程辅助、模型选择、API调用指南、定价信息"
metadata: { "openclaw": { "emoji": "🤖" } }
---

# DeepSeek API 助手

帮助用户高效使用 DeepSeek 系列模型，包括模型选择建议、API 调用示例、编程辅助和定价计算。

## 功能概述

- **模型选择指南**: deepseek-v4-flash vs deepseek-v4-pro 的使用场景对比
- **API 调用示例**: 提供 Python、curl、Node.js 等语言的调用代码
- **定价计算**: 根据 token 用量估算费用（输入 ¥1/百万tokens，输出 ¥2/百万tokens）
- **Prompt 优化**: 针对 DeepSeek 模型特性优化提示词
- **错误排查**: 常见 API 错误码解读和解决方案

## 模型对比

| 模型 | 适用场景 | 上下文长度 |
|------|---------|-----------|
| deepseek-v4-flash | 日常对话、文案写作、知识问答，快且便宜 | 128K |
| deepseek-v4-pro | 复杂推理、数学、代码生成与审查 | 128K |

> ⚠️ 旧名 `deepseek-chat` / `deepseek-coder` / `deepseek-reasoner` 已下线，
> api.deepseek.com 现在只接受 `deepseek-v4-flash` 和 `deepseek-v4-pro`，
> 用旧名调用会直接返回 HTTP 400。

## 使用示例

### 基础 API 调用
```
帮我写一个调用 DeepSeek API 的 Python 脚本，实现多轮对话
```

### 模型选择
```
我要做一个客服机器人，应该用 deepseek-v4-flash 还是 deepseek-v4-pro？
```

### 费用估算
```
我每天大约处理 1000 条用户消息，平均每条 500 token，帮我算下月费用
```

### 错误排查
```
调用 DeepSeek API 返回 429 错误，怎么处理？
```

## 适用场景

- 首次接入 DeepSeek API 的开发者
- 需要在 deepseek-v4-flash 和 deepseek-v4-pro 之间做选择
- 想要优化 API 调用成本
- 排查 API 调用问题
- 需要快速生成 API 调用代码片段

## 不适用场景

- 需要调用 OpenAI / Claude 等其他模型的 API（请使用对应工具）
- 需要实时获取 DeepSeek 最新公告（本技能基于已知信息）
- 需要部署私有化 DeepSeek 模型（涉及运维，超出范围）

## 关键提示

- DeepSeek API 兼容 OpenAI 格式，base_url 改为 `https://api.deepseek.com`
- 国内访问无需翻墙，延迟低
- 支持 function calling 和 JSON mode
- 建议使用 stream 模式提升用户体验
- API Key 申请地址: https://platform.deepseek.com
