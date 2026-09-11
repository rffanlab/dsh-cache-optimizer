# dsh-cache-optimizer

**面向模型的 DeepSeek Harness Prompt Cache 优化插件。第一阶段只针对明确的 OpenAI GPT 路由，按 Codex 当前源码的“保持旧前缀、把新的上下文更新放到当前用户消息之前”的方式优化 DSH 请求编排。**

[English](README.en.md)

> 当前版本：`0.1.0`。策略刻意保守：无法确认 Provider + Model 时不做任何改写。

## 为什么做这个插件

DeepSeek Harness 当前 Agent Loop 会先 claim 当前批用户消息，再把 `@deepseek-ai/dsh-system-prompt` 生成的 runtime-context snapshot 追加到该批消息末尾，因此一个典型新轮次会形成：

```text
[历史缓存前缀]
当前用户消息
当前 runtime-context 更新
```

而 Codex 当前的 prompt-cache 测试明确保护另一种结构：既有历史前缀保持原样；新的 permissions / environment context 变化追加在旧前缀之后，但位于本轮用户消息之前：

```text
[历史缓存前缀]
当前 context 更新
当前用户消息
```

这样不会为了更新环境上下文去重写历史前缀，同时也不会让每次变化的用户 prompt 提前切断后面的可复用上下文。

详细源码研究见 [docs/CODEX_PROMPT_CACHE_STUDY.md](docs/CODEX_PROMPT_CACHE_STUDY.md)。

## v0.1 做什么

只在以下条件全部满足时启用重排：

- Provider **精确命中**配置的 OpenAI Provider ID；默认仅 `openai`；
- Model 命中 GPT 模式；默认 `^gpt-`；
- 当前 pre-step 中存在由 DSH 官方 `@deepseek-ai/dsh-system-prompt` 产生的 runtime-context user message；
- 当前 claim 的用户消息仍可通过稳定 `message.id` 在最终 pre-step decision 中定位。

命中时只执行一个变换：

```text
Before: [...other, current-user, dsh-runtime-context, ...other]
After:  [...other, dsh-runtime-context, current-user, ...other]
```

所有其他消息保持相对顺序不变。

## 明确不做什么

v0.1 **不会**：

- 修改 DeepSeek、Claude、Gemini、Qwen 等非 OpenAI GPT 请求；
- 因为模型名字叫 `gpt-*` 就信任 OpenRouter、LM Studio 或自定义 OpenAI-compatible Provider；
- 移动 `time-context`、第三方 snapshot、tool result 或来源未知的 user-role context；
- 重写历史消息；
- 修改 tools schema；DSH 当前已经对工具 schema 做确定性排序；
- 在 `llm/stream` 偷改冻结请求；
- 伪造 `prompt_cache_key`。

最后一点是有意为之：当前 DSH 的公开 `llm/stream` waterfall 接收不可变 `GenerateOptions`，`next()` 不接收替换后的 options；而 `agent/request` 明确只允许改 call config，不能注入模型可见消息。OpenAI 专有的 `prompt_cache_key` 需要 Provider adapter / upstream seam 才能干净实现，计划放到后续阶段。

## 安装

默认 profile：

```bash
dsh plugin --profile default add github:rffanlab/dsh-cache-optimizer
```

Web profile：

```bash
dsh plugin --profile web add github:rffanlab/dsh-cache-optimizer
```

升级：

```bash
dsh plugin --profile default update dsh-cache-optimizer
```

包内声明了 `dsh.bundle.patch`，无需手改 `cordis.yml`。

## 默认策略

```yaml
enabled: true
openaiProviders:
  - openai
gptModelPatterns:
  - '^gpt-'
warnOnLateRouteChange: true
```

### Provider 别名必须显式授权

如果你的 DSH OpenAI Provider 不是 `openai`，例如你自己配置成 `openai-prod`，需要明确加入：

```yaml
openaiProviders:
  - openai
  - openai-prod
```

插件不会因为 endpoint “看起来像 OpenAI”或模型名字包含 GPT 就自动放行。

## 动态路由的边界

DSH 当前顺序是：

```text
system-prompt/assemble
agent/pre-step
step/start
agent/request
prepareCall
buildRequest
```

也就是说，真正的 `agent/request` 动态路由发生在 pre-step **之后**。因此 v0.1 的第一步只能依据 Agent 已声明的 `agent.options.provider/model` 决策。

插件会观察 `agent/request` 最终给出的 provider/model：如果发现有 late route override，立刻把该 Agent 标记为不安全，后续 step 全部停止重排并输出 warning。

这是当前 DSH 扩展 seam 的客观限制。要做到“100% 根据本次最终 resolved route 再决定 prompt 编排”，需要 DSH 在 prompt admission 前暴露 resolved route，或者增加 provider-aware message transformation seam。

## Codex 中我们复刻的不是“模板”，而是三个原则

1. **稳定前缀不回写**：已经进入历史的前缀尽量不因为后续环境变化而重排。
2. **上下文更新先于当前用户输入**：新的环境/权限上下文放在旧历史之后、本轮用户消息之前。
3. **缓存身份保持 session 稳定**：当前 Codex 源码的 `prompt_cache_key` 默认使用 session ID；子 Agent 即使 thread ID 不同仍共享 session cache key。

v0.1 只实现了 DSH 插件层能安全实现的第 2 条，并且保持第 1 条不被破坏。第 3 条需要 Provider 层支持。

## 测试

```bash
npm test
npm run check
```

当前单元测试覆盖：

- OpenAI GPT 命中；
- OpenRouter / LM Studio 同名 GPT 不命中；
- Provider 别名必须显式加入；
- 未知路由 fail-closed；
- DSH runtime-context 精确来源识别；
- `time-context` / 第三方 snapshot 不移动；
- claim 消息被其他插件替换时不猜测、不改写。

## 下一步

- 用真实 DSH + OpenAI GPT 做 A/B：记录 uncached input、cache read、TTFT；
- 增加 request-shape inspector，定位首次 prefix divergence；
- 研究 `llm-pi-ai` / OpenAI Responses adapter 的最小扩展点，为 `prompt_cache_key` 提供合法注入；
- 若 upstream 接受，增加 **resolved-route-before-admission** seam，彻底消除 late route 的不确定性；
- 只有在分别研究 Claude / Gemini / DeepSeek 的缓存语义后，才新增各自 policy，绝不共用 OpenAI 重排规则。

## License

MIT
