/**
 * Provider/model policy matching for cache optimizations.
 *
 * The optimizer is intentionally fail-closed: a familiar model name is not
 * enough. The provider must also be explicitly trusted by configuration.
 */

export const DEFAULT_OPENAI_PROVIDERS = Object.freeze(['openai'])
export const DEFAULT_GPT_MODEL_PATTERNS = Object.freeze(['^gpt-'])

function uniqueStrings(values, fallback) {
  const source = Array.isArray(values) ? values : fallback
  return [...new Set(source.filter(value => typeof value === 'string' && value.length > 0))]
}

/** Compile and validate policy configuration once at plugin load. */
export function compilePolicy(config = {}) {
  const providers = uniqueStrings(config.openaiProviders, DEFAULT_OPENAI_PROVIDERS)
  const patternTexts = uniqueStrings(config.gptModelPatterns, DEFAULT_GPT_MODEL_PATTERNS)
  if (providers.length === 0) {
    throw new TypeError('dsh-cache-optimizer: openaiProviders must contain at least one exact provider id')
  }
  if (patternTexts.length === 0) {
    throw new TypeError('dsh-cache-optimizer: gptModelPatterns must contain at least one regular expression')
  }

  const patterns = patternTexts.map(text => {
    try {
      return new RegExp(text, 'i')
    } catch (error) {
      throw new TypeError(`dsh-cache-optimizer: invalid GPT model pattern ${JSON.stringify(text)}`, { cause: error })
    }
  })

  return Object.freeze({
    providers: Object.freeze(providers),
    providerSet: new Set(providers),
    patternTexts: Object.freeze(patternTexts),
    patterns: Object.freeze(patterns),
  })
}

/**
 * Return the declared route that is known before `agent/pre-step`.
 *
 * A previous `agent/request` observation is preferred because DSH can route
 * later steps through request middleware. The first step can only be optimized
 * when AgentOptions already declares provider + model; an unknown route is a
 * deliberate no-op.
 */
export function routeBeforePreStep(agent, observedRoute) {
  if (observedRoute?.provider && observedRoute?.model) {
    return { provider: observedRoute.provider, model: observedRoute.model, source: 'observed-request' }
  }
  const provider = agent?.options?.provider
  const model = agent?.options?.model
  if (!provider || !model) return undefined
  return { provider, model, source: 'agent-options' }
}

/** Match one route against the explicit OpenAI-GPT policy. */
export function matchesOpenAIGpt(route, policy) {
  if (!route?.provider || !route?.model) return false
  if (!policy.providerSet.has(route.provider)) return false
  return policy.patterns.some(pattern => pattern.test(route.model))
}
