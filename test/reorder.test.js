import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DSH_SYSTEM_PROMPT_SOURCE,
  isHarnessRuntimeContext,
  moveRuntimeContextBeforeClaimed,
} from '../src/reorder.js'

function user(id, source = { kind: 'user' }) {
  return { id, role: 'user', content: [{ type: 'text', text: id }], source }
}

const runtime = user('runtime', {
  kind: 'plugin',
  plugin: DSH_SYSTEM_PROMPT_SOURCE,
  form: 'snapshot',
  sections: [{ name: 'sandbox', text: 'sandbox' }],
})

test('recognizes only DSH system-prompt runtime context', () => {
  assert.equal(isHarnessRuntimeContext(runtime), true)
  assert.equal(isHarnessRuntimeContext(user('time', { kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [] })), false)
})

test('moves DSH runtime context before the current claimed user message', () => {
  const current = user('user-1')
  const result = moveRuntimeContextBeforeClaimed([current, runtime], [current])
  assert.equal(result.moved, true)
  assert.deepEqual(result.messages.map(message => message.id), ['runtime', 'user-1'])
})

test('preserves unrelated plugin context and relative order', () => {
  const before = user('before', { kind: 'plugin', plugin: 'stable-other' })
  const current = user('user-1')
  const time = user('time', { kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [] })
  const result = moveRuntimeContextBeforeClaimed([before, current, runtime, time], [current])
  assert.deepEqual(result.messages.map(message => message.id), ['before', 'runtime', 'user-1', 'time'])
})

test('does not move opaque or third-party snapshots', () => {
  const current = user('user-1')
  const time = user('time', { kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [] })
  const input = [current, time]
  const result = moveRuntimeContextBeforeClaimed(input, [current])
  assert.equal(result.moved, false)
  assert.equal(result.messages, input)
})

test('does nothing when a plugin replaced the claimed message identity', () => {
  const claimed = user('user-1')
  const replacement = user('user-2')
  const input = [replacement, runtime]
  const result = moveRuntimeContextBeforeClaimed(input, [claimed])
  assert.equal(result.moved, false)
  assert.equal(result.reason, 'claimed-message-replaced')
})
