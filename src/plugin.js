import z from '@deepseek-ai/schemastery'
import { compilePolicy, matchesOpenAIGpt, routeBeforePreStep } from './policy.js'
import { moveRuntimeContextBeforeClaimed } from './reorder.js'

/** Cordis plugin name used in diagnostics and configuration. */
export const name = 'dsh-cache-optimizer'

/** No hard service injection is required; hooks operate on the live Agent payload. */
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true),
  openaiProviders: z.array(z.string()).default(['openai']),
  gptModelPatterns: z.array(z.string()).default(['^gpt-']),
  warnOnLateRouteChange: z.boolean().default(true),
})

function sameRoute(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model
}

/**
 * Install a conservative Codex-style prefix preservation policy for OpenAI GPT.
 *
 * The plugin intentionally changes no non-OpenAI route and does not mutate the
 * provider wire request. It only reorders DSH-owned runtime-context snapshots
 * within the current uncommitted pre-step batch.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const policy = compilePolicy(config)
  const lastObservedRoute = new WeakMap()
  const disabledByLateRouteChange = new WeakSet()

  // Observe the final config produced by agent/request middleware for the next
  // pre-step. This hook does not modify provider/model or model-visible input.
  ctx.on('agent/request', async ({ agent }, next) => {
    const configForRequest = await next()
    const nextRoute = {
      provider: configForRequest?.provider,
      model: configForRequest?.model,
    }
    const previous = lastObservedRoute.get(agent)
    const declared = agent?.options?.provider && agent?.options?.model
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined

    if (previous === undefined && declared !== undefined && !sameRoute(declared, nextRoute)) {
      disabledByLateRouteChange.add(agent)
      if (config.warnOnLateRouteChange !== false) {
        console.warn(
          `[dsh-cache-optimizer] agent ${String(agent?.id ?? '(unknown)')}: `
          + `agent/request changed route ${declared.provider}/${declared.model} -> `
          + `${String(nextRoute.provider)}/${String(nextRoute.model)} after pre-step; `
          + 'disabling prompt reordering for later steps in this agent lifecycle',
        )
      }
    } else if (previous !== undefined && !sameRoute(previous, nextRoute)) {
      // A dynamic router changed provider/model after the current pre-step was
      // already admitted. Fail closed from the next step onward.
      disabledByLateRouteChange.add(agent)
      if (config.warnOnLateRouteChange !== false) {
        console.warn(
          `[dsh-cache-optimizer] agent ${String(agent?.id ?? '(unknown)')}: `
          + `late route change ${previous.provider}/${previous.model} -> `
          + `${String(nextRoute.provider)}/${String(nextRoute.model)}; `
          + 'disabling prompt reordering for this agent lifecycle',
        )
      }
    }

    if (nextRoute.provider && nextRoute.model) lastObservedRoute.set(agent, nextRoute)
    return configForRequest
  })

  // Prepend + await next(): process the fully composed pre-step decision while
  // keeping the framework's authoritative reject semantics.
  ctx.on('agent/pre-step', async ({ agent, messages: claimedMessages }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || disabledByLateRouteChange.has(agent)) return decision

    const route = routeBeforePreStep(agent, lastObservedRoute.get(agent))
    if (!matchesOpenAIGpt(route, policy)) return decision

    const reordered = moveRuntimeContextBeforeClaimed(decision.messages, claimedMessages)
    if (!reordered.moved) return decision
    return { ...decision, messages: reordered.messages }
  }, { prepend: true })
}

export { compilePolicy, matchesOpenAIGpt, routeBeforePreStep } from './policy.js'
export { DSH_SYSTEM_PROMPT_SOURCE, isHarnessRuntimeContext, moveRuntimeContextBeforeClaimed } from './reorder.js'
