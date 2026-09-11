# Codex Prompt / Prompt Cache 源码研究（2026-09-11）

本文记录 `dsh-cache-optimizer` v0.1 的设计依据。目标不是照抄 Codex 的 API 字段，而是确认它为了 Prompt Cache 稳定性实际维持了什么请求不变量，再判断哪些不变量能在 DeepSeek Harness 的插件 seam 中安全复刻。

## 研究版本

- OpenAI Codex：研究时 default branch 对应搜索结果 commit `624ccf794703e2d84e748fc3ef547d6191a8c0a4`
- DeepSeek Harness：研究时 `master` 对应 commit `c291e7961a515f6d7af9304e7fd1d257929aef26`

## 1. Codex 不是简单地“system 放前面”

Codex 的 `Prompt` 把输入历史、tool specs、base instructions 分开持有。普通 Responses 请求保持 `instructions` 和 `tools` 为独立 wire fields；Responses Lite 则会把 tools 与 base instructions 构造成最前面的 developer/context prefix items，并为这些前缀使用基于 thread + 内容的确定性 UUID。

关键源码：

- `openai/codex/codex-rs/core/src/client.rs`
- `openai/codex/codex-rs/core/src/client_common.rs`

这说明它关心的是**可重复的请求前缀形状**，而不是某个单一 role 的机械排序。

## 2. 最关键的缓存测试：首轮上下文在用户输入之前

`codex-rs/core/tests/suite/prompt_caching.rs` 中的 `prefixes_context_and_instructions_once_and_consistently_across_requests` 明确断言：

```text
request 1 input:
  permissions
  cached contextual user prefix (AGENTS.md + environment context)
  hello 1

request 2 input:
  [request 1 的整个 input 前缀保持一致]
  hello 2
```

也就是说，首轮的稳定上下文位于第一条动态用户 prompt 之前；第二轮不会重新排列第一轮前缀，而是继续 append。

## 3. Context 改变时，不回头改旧前缀

同一文件的 `overrides_turn_context_but_keeps_cached_prefix_and_key_constant` 测试更重要：线程 settings 在第一轮之后发生变化时，Codex 要求：

1. `prompt_cache_key` 保持不变；
2. 第一轮完整 input 仍然逐项保持为第二轮的前缀；
3. 新 permissions message 和新的 environment context **追加在旧前缀之后**；
4. 第二轮用户消息再追加到这些 context update 之后。

抽象成结构就是：

```text
[old cached prefix]
[new context update]
[current user message]
```

这正是 v0.1 在 DSH 当前未提交的 pre-step batch 中复刻的行为。

## 4. 当前 Codex 的 prompt_cache_key 是 session ID

研究过程中修正了一个容易误判的点：当前 Codex 默认不是把 thread ID 直接当 `prompt_cache_key`。

`codex-rs/core/src/client.rs` 当前实现：

```text
prompt_cache_key override exists -> override
otherwise -> responses_metadata.session_id
```

`codex-rs/core/tests/suite/prompt_cache_key.rs` 还专门验证：根 Agent 与子 Agent 的 thread ID 不同，但 API-key 场景下共享同一个 session ID，因此 `prompt_cache_key` 也相同。

这说明 Codex 把缓存 affinity 绑定在比单个 child thread 更稳定的 session 边界上。

## 5. Tools 与 base instructions 的稳定性

`prompt_tools_are_consistent_across_requests` 测试会比较连续请求中的 base instructions 与工具名称集合。Codex 在 session 启动时解析 base instructions；dynamic tools 也在 thread 启动时确定/持久化。其目的同样是避免早期请求结构无意义抖动。

DSH 当前 `dsh-system-prompt` 已经默认按工具名做确定性排序（或按 `toolOrder`），因此 v0.1 不重复实现 tool sorting。

## 6. DSH 当前与 Codex 最大的可修差异

`packages/core/agent-loop/src/agent.ts` 当前 pre-step 顺序是：

```text
claimed = 当前 inbox 消息
assembly = systemPrompt.assemble(...)
runtimeContext = RuntimeContextProjection.project(...)
default decision.messages = runtimeContext ? [...claimed, runtimeContext] : claimed
```

因此当前 batch 的默认形状是：

```text
[current user]
[runtime context]
```

`packages/core/agent-loop/src/runtime-context.ts` 给这个 runtime context 一个非常可靠的来源标识：

```text
source.kind = plugin
source.plugin = @deepseek-ai/dsh-system-prompt
```

并且每条 message 有稳定 `id`。因此插件可以在 `agent/pre-step` waterfall 返回后精确识别：

- 哪些是本次真正 claimed 的消息；
- 哪一条是 DSH 官方 runtime-context；
- 不必用字符串、role 猜测或宽泛地移动所有 plugin context。

## 7. 为什么不在 v0.1 注入 prompt_cache_key

DSH 当前：

- `agent/pre-step` 可以替换即将 admission 的 messages；
- `agent/request` 可以替换 `LlmCallConfig`，但其文档明确要求 model-visible content 使用 logged channels，不能在这里改 messages；
- `llm/stream` 收到 `GenerateOptions`，但 `next` 的签名是 `() => AsyncIterable<StreamChunk>`，不是 `next(newOptions)`；Agent Loop 发出的请求还会被冻结并受 reconstructability invariant 约束。

同时，在当前 DSH 源码中搜索不到一个公开的 provider-neutral `promptCacheKey` / `prompt_cache_key` 配置字段。

因此 v0.1 如果为了“看起来完整”而在 stream 层私自短路/重做 OpenAI 请求，会破坏 Harness 的 adapter ownership 和 session reconstructability。这个代价大于收益。

## 8. v0.1 的最终规则

只在：

```text
provider ∈ explicitOpenAIProviderIds
AND model matches explicit GPT patterns
```

时，针对**当前尚未提交的 pre-step batch**执行：

```text
[claimed..., DSH runtime-context]
        ↓
[DSH runtime-context, claimed...]
```

更精确地说，runtime-context 被插到第一条仍存在的 claimed message 之前；其他 plugin message 保留相对顺序。

以下情况一律 PASS：

- provider 未知；
- model 未知；
- provider 不在明确 allowlist；
- model 不命中 GPT policy；
- claimed message identity 已被其他插件替换；
- 只有第三方 snapshot / time-context；
- 没有新的 DSH runtime-context update。

## 9. 当前 seam 的一个限制：late route override

最终 `agent/request` 路由发生在 `agent/pre-step` 之后，所以插件在第一步无法知道后续某个 middleware 会不会把 `openai/gpt-*` 临时改到别的 provider/model。

v0.1 的处理：

- 第一步只信任显式 `agent.options.provider/model`；
- 观察每次 `agent/request` 的最终 config；
- 一旦检测到 late route change，标记该 Agent lifecycle 为 unsafe；
- 后续所有 step 停止 Prompt 重排并输出 warning。

理想 upstream 方案是在 prompt admission 前暴露 resolved provider/model，然后 model policy 可以做到严格零歧义。

## 10. 后续 A/B 验证

DSH 自己已经区分：

```text
inputTokens          = uncached input
cacheReadTokens      = cached read
cacheWriteTokens     = cache write
```

因此真实验证不需要猜测。后续应对同一工作负载跑：

- baseline DSH；
- dsh-cache-optimizer；
- 相同 OpenAI GPT provider/model；
- 相同 tools / system prompt / session 长度。

记录：

- cache read rate；
- uncached input；
- TTFT；
- 总请求耗时；
- 首个 prefix divergence 的 message id/source。

只有 A/B 数据确认收益之后，再继续做 OpenAI provider-level cache affinity。
