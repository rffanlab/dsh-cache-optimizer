import assert from 'node:assert/strict'
import test from 'node:test'
import { compilePolicy, matchesOpenAIGpt, routeBeforePreStep } from '../src/policy.js'

const policy = compilePolicy({})

test('matches only explicitly trusted OpenAI GPT routes', () => {
  assert.equal(matchesOpenAIGpt({ provider: 'openai', model: 'gpt-5.6' }, policy), true)
  assert.equal(matchesOpenAIGpt({ provider: 'openai', model: 'gpt-5.6-codex' }, policy), true)
  assert.equal(matchesOpenAIGpt({ provider: 'openrouter', model: 'gpt-5.6' }, policy), false)
  assert.equal(matchesOpenAIGpt({ provider: 'lmstudio', model: 'gpt-5.6' }, policy), false)
  assert.equal(matchesOpenAIGpt({ provider: 'openai', model: 'o4-mini' }, policy), false)
})

test('provider aliases require explicit configuration', () => {
  const aliased = compilePolicy({ openaiProviders: ['openai', 'openai-prod'] })
  assert.equal(matchesOpenAIGpt({ provider: 'openai-prod', model: 'gpt-5.6' }, aliased), true)
})

test('unknown first-step route fails closed', () => {
  assert.equal(routeBeforePreStep({ options: {} }), undefined)
})

test('observed request route wins on later steps', () => {
  const agent = { options: { provider: 'openai', model: 'gpt-5.6' } }
  assert.deepEqual(
    routeBeforePreStep(agent, { provider: 'other', model: 'model-x' }),
    { provider: 'other', model: 'model-x', source: 'observed-request' },
  )
})
