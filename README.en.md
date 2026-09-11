# dsh-cache-optimizer

A **model-aware prompt-cache optimizer for DeepSeek Harness**. The first policy targets explicitly trusted OpenAI GPT routes and mirrors one important property of current Codex prompt construction: preserve the already-cached history prefix and place a newly emitted runtime-context update before the current user message.

[中文](README.md)

Version `0.1.0` is deliberately fail-closed. If the provider and model cannot be identified confidently, the plugin changes nothing.

## What v0.1 changes

For an explicitly allowed OpenAI GPT route, the plugin recognizes only the runtime-context user message owned by `@deepseek-ai/dsh-system-prompt` and transforms the current pre-step batch from:

```text
[existing cached history]
current user message
DSH runtime-context update
```

to:

```text
[existing cached history]
DSH runtime-context update
current user message
```

No historical message is rewritten, and unrelated messages keep their relative order.

## Safety boundary

By default the policy requires both:

```text
provider == "openai"
model matches /^gpt-/i
```

A route such as `openrouter/gpt-5.6` or `lmstudio/gpt-5.6` is a no-op unless its provider id is explicitly added to `openaiProviders`. The plugin also refuses to classify `time-context`, third-party snapshots, tool results, or opaque user-role context as movable DSH runtime context.

## Install

```bash
dsh plugin --profile default add github:rffanlab/dsh-cache-optimizer
```

For the Web profile:

```bash
dsh plugin --profile web add github:rffanlab/dsh-cache-optimizer
```

## Configuration

```yaml
enabled: true
openaiProviders:
  - openai
gptModelPatterns:
  - '^gpt-'
warnOnLateRouteChange: true
```

Provider aliases must be opted in explicitly.

## Important limitation

DSH currently resolves `agent/request` after `agent/pre-step`. Therefore the first pre-step can only use the route declared in `agent.options`. The plugin observes the final `agent/request` config; if later middleware changes provider/model after admission, that Agent is marked unsafe and prompt reordering is disabled for subsequent steps.

The plugin does **not** inject OpenAI `prompt_cache_key` in v0.1. The public `llm/stream` seam receives immutable request options and its `next()` does not accept replacement options, while `agent/request` is intentionally not a model-visible message mutation boundary. A clean cache-key implementation needs a provider adapter or an upstream request-field seam.

See [docs/CODEX_PROMPT_CACHE_STUDY.md](docs/CODEX_PROMPT_CACHE_STUDY.md) for the source study behind the design.

## Test

```bash
npm test
npm run check
```

## License

MIT
