/**
 * Safe, source-aware message reordering for the OpenAI GPT policy.
 */

export const DSH_SYSTEM_PROMPT_SOURCE = '@deepseek-ai/dsh-system-prompt'

/** True only for the runtime-context snapshot owned by DSH system-prompt. */
export function isHarnessRuntimeContext(message) {
  return message?.role === 'user'
    && message?.source?.kind === 'plugin'
    && message.source.plugin === DSH_SYSTEM_PROMPT_SOURCE
}

/**
 * Move DSH's current runtime-context update immediately before the first
 * currently claimed message, preserving every other message's relative order.
 *
 * `claimedMessages` comes from the `agent/pre-step` payload and has stable ids,
 * so no text heuristics are used. Third-party plugin messages, time-context,
 * tool results, and opaque user-role context are never classified as movable.
 */
export function moveRuntimeContextBeforeClaimed(messages, claimedMessages) {
  if (!Array.isArray(messages) || messages.length < 2) {
    return { messages, moved: false, reason: 'too-short' }
  }
  if (!Array.isArray(claimedMessages) || claimedMessages.length === 0) {
    return { messages, moved: false, reason: 'no-claimed-message' }
  }

  const claimedIds = new Set(claimedMessages.map(message => message?.id).filter(Boolean))
  if (claimedIds.size === 0) return { messages, moved: false, reason: 'claimed-message-has-no-id' }

  const firstClaimedIndex = messages.findIndex(message => claimedIds.has(message?.id))
  if (firstClaimedIndex < 0) return { messages, moved: false, reason: 'claimed-message-replaced' }

  const movableIndexes = []
  for (let index = firstClaimedIndex + 1; index < messages.length; index += 1) {
    if (isHarnessRuntimeContext(messages[index])) movableIndexes.push(index)
  }
  if (movableIndexes.length === 0) return { messages, moved: false, reason: 'no-runtime-context-after-user' }

  const movableSet = new Set(movableIndexes)
  const runtimeContexts = movableIndexes.map(index => messages[index])
  const remaining = messages.filter((_message, index) => !movableSet.has(index))
  const insertionIndex = remaining.findIndex(message => claimedIds.has(message?.id))
  if (insertionIndex < 0) return { messages, moved: false, reason: 'claimed-message-replaced' }

  return {
    messages: [
      ...remaining.slice(0, insertionIndex),
      ...runtimeContexts,
      ...remaining.slice(insertionIndex),
    ],
    moved: true,
    reason: 'codex-style-runtime-context-prefix',
  }
}
