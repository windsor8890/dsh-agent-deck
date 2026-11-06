import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './test-helpers.mjs'

const { api } = loadClient(['newFold', 'foldWindow'])
let sequence = 0
const event = (type, data = {}, time = 1000) => ({ type: 'event', event: { type, data, time, seq: ++sequence } })
const live = (attemptId, chunk, time = 1001) => ({ type: 'transient', event: { type: 'assistant/live-chunk', time, seq: sequence + 0.5, data: { attemptId, turn: 1, step: 1, chunk } } })
function source() {
  const f = api.newFold()
  let entries = []
  return {
    f,
    append(...rows) { entries.push(...rows); api.foldWindow(f, { entries, change: { kind: 'append', entries: rows } }) },
    settle(attemptId, entry) {
      entries = entries.filter((row) => row.type !== 'transient' || row.event.data.attemptId !== attemptId)
      if (entry) {
        const index = entries.findIndex((row) => row.event.seq > entry.event.seq)
        entries.splice(index < 0 ? entries.length : index, 0, entry)
      }
      api.foldWindow(f, { entries, change: { kind: 'settle-assistant', attemptId, ...(entry ? { entry } : {}) } })
    },
  }
}
const callChunk = (id, name = 'read_file') => ({ type: 'tool-call-delta', id, name, argumentsDelta: '{"path":"a"}' })
const message = (content, usage = { outputTokens: 7, inputTokens: 20 }) => event('assistant/message', { turn: 1, step: 1, message: { content }, usage }, 1100)

for (const outcome of ['failed', 'abandoned']) {
  test(`${outcome} attempt retires text, reasoning, tools and throughput before same-step retry`, () => {
    const s = source()
    s.append(event('turn/start', { turn: 1 }), event('step/start', { step: 1 }))
    s.append(live('A', { type: 'text-delta', text: 'DISCARDED ' }), live('A', { type: 'reasoning-delta', text: 'BAD THINK' }), live('A', callChunk('phantom')))
    s.settle('A', outcome === 'failed' ? event('assistant/attempt', { turn: 1, step: 1, outcome: { kind: 'failed' } }) : undefined)
    s.append(live('B', { type: 'text-delta', text: 'GOOD' }, 1200), live('B', { type: 'reasoning-delta', text: 'RETRY' }, 1201))
    assert.equal(s.f.out, 'GOOD')
    assert.equal(s.f.think, 'RETRY')
    assert.equal(s.f.calls, 0)
    assert.equal(s.f.tools.length, 0)
    assert.equal(s.f.chars.reduce((sum, row) => sum + row.n, 0), 9)
  })
}

test('successful append and retirement without entry preserve throughput and count durable usage once', () => {
  const s = source()
  s.append(event('turn/start', { turn: 1 }), event('step/start', { step: 1 }))
  s.append(live('A', { type: 'text-delta', text: 'GOOD' }), live('A', callChunk('tool-A')))
  const committed = message([{ type: 'text', text: 'GOOD' }, { type: 'tool-call', id: 'tool-A', name: 'read_file', arguments: {} }])
  s.append(committed, event('step/end', { turn: 1, step: 1 }, 1200))
  const phases = JSON.stringify(s.f.phases)
  s.settle('A')
  assert.equal(s.f.tokens.out, 7)
  assert.equal(s.f.calls, 1)
  assert.equal(s.f.chars.reduce((sum, row) => sum + row.n, 0), 4)
  assert.equal(s.f.out, 'GOOD')
  assert.equal(JSON.stringify(s.f.phases), phases)
})

test('settlement with successful entry uses source order and preserves streamed throughput', () => {
  const s = source()
  s.append(event('turn/start', { turn: 1 }), live('A', { type: 'text-delta', text: 'GOOD' }))
  s.settle('A', message([{ type: 'text', text: 'GOOD' }]))
  assert.equal(s.f.tokens.out, 7)
  assert.equal(s.f.liveOut, 0)
  assert.equal(s.f.chars.reduce((sum, row) => sum + row.n, 0), 4)
  s.settle('A')
  assert.equal(s.f.tokens.out, 7)
})

test('interrupted settlement keeps its durable partial content but removes uncommitted tools', () => {
  const s = source()
  s.append(event('turn/start', { turn: 1 }), live('A', { type: 'text-delta', text: 'PARTIAL EXTRA' }), live('A', callChunk('phantom')))
  const entry = message([{ type: 'text', text: 'PARTIAL' }])
  entry.event.data.interrupted = true
  s.settle('A', entry)
  assert.equal(s.f.out, 'PARTIAL')
  assert.equal(s.f.calls, 0)
  assert.equal(s.f.tools.length, 0)
})

test('failed same-kind retry preserves accepted phase timing and leaves a wait gap', () => {
  const s = source()
  s.append(event('turn/start', { turn: 1 }), event('step/start', { step: 1 }))
  s.append(live('A', { type: 'reasoning-delta', text: 'accepted' }, 1010))
  s.append(message([{ type: 'reasoning', text: 'accepted' }]), event('step/end', { turn: 1, step: 1 }, 1110))
  s.settle('A')
  const acceptedPhase = JSON.stringify(s.f.phases[0])
  s.append(event('step/start', { step: 2 }, 1120))
  const failed = live('B', { type: 'text-delta', text: 'discarded' }, 1200)
  failed.event.data.step = 2
  s.append(failed)
  s.settle('B')
  assert.equal(JSON.stringify(s.f.phases[0]), acceptedPhase)
  assert.equal(s.f.phases.at(-1).kind, 'wait')
  assert.equal(s.f.phases.at(-1).t, 1200)
  assert.equal(s.f.chars.reduce((sum, row) => sum + row.n, 0), 8)
})

test('long MCP names and same-name calls settle by identity in result order', () => {
  const s = source()
  const name = 'mcp__workspace__a_really_long_tool_name_shared_by_both_calls'
  s.append(event('turn/start'), event('tool/call', { callId: 'one', name }, 1000), event('tool/call', { callId: 'two', name }, 1010))
  s.append(event('tool/result', { message: { toolCallId: 'one', isError: true } }, 1020))
  assert.equal(s.f.toolLog[0].state, 'err')
  assert.equal(s.f.toolLog[0].name, name)
  assert.equal(s.f.toolLog[0].ms, 20)
  assert.equal(s.f.toolLog[1].state, 'run')
  s.append(event('tool/result', { message: { toolCallId: 'two' } }, 1040))
  assert.equal(s.f.toolLog[1].state, 'ok')
  assert.equal(s.f.toolLog[1].ms, 30)
})

test('19 streamed calls remain 19 after durable messages/calls and evicted results settle', () => {
  const s = source()
  s.append(event('turn/start', { turn: 1 }))
  const blocks = Array.from({ length: 19 }, (_, i) => ({ type: 'tool-call', id: `call-${i}`, name: 'read_file', arguments: { path: String(i) } }))
  s.append(...blocks.map((b) => live('A', callChunk(b.id))))
  assert.equal(s.f.calls, 19)
  assert.equal(s.f.tools.length, 18)
  s.append(message(blocks))
  assert.equal(s.f.calls, 19)
  s.append(...blocks.map((b) => event('tool/call', { callId: b.id, name: b.name, arguments: b.arguments }, 1200)))
  assert.equal(s.f.calls, 19)
  s.append(event('tool/result', { message: { toolCallId: 'call-0', isError: true } }, 1400))
  assert.equal(s.f.toolLog.find((row) => row.id === 'call-0').state, 'err')
  assert.equal(s.f.runningTools, 18)
  s.append(...blocks.slice(1).map((b) => event('tool/result', { message: { toolCallId: b.id } }, 1500)))
  s.append(event('tool/result', { message: { toolCallId: 'call-0', isError: true } }, 1600))
  assert.equal(s.f.runningTools, 0)
  assert.equal(s.f.calls, 19)
})

test('new turns clear call identities while retaining historical call totals', () => {
  const s = source()
  s.append(event('turn/start'), event('tool/call', { callId: 'reused', name: 'read_file' }))
  s.append(event('turn/start'), event('tool/call', { callId: 'reused', name: 'read_file' }))
  assert.equal(s.f.calls, 2)
  assert.equal(s.f.runningTools, 1)
  assert.equal(s.f.tools.length, 1)
})

test('turn end closes running tools and active phase without negative counts from late results', () => {
  const s = source()
  s.append(event('turn/start'), event('tool/call', { callId: 'one', name: 'read_file' }))
  s.append(event('turn/end', { reason: { kind: 'interrupted' } }, 1600))
  assert.equal(s.f.runningTools, 0)
  assert.equal(s.f.phases.at(-1).kind, 'wait')
  assert.notEqual(s.f.tools[0].state, 'run')
  s.append(event('tool/result', { message: { toolCallId: 'one' } }, 1700))
  assert.equal(s.f.runningTools, 0)
})
