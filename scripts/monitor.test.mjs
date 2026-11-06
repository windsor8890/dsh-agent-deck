import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './test-helpers.mjs'

// Host boundaries are in-memory sources; all folding, retention and aggregation
// run through the shipped monitor with a deterministic wall clock.
async function monitorFixture(ids = []) {
  let now = 1000000
  class Clock extends Date { static now() { return now } }
  const sources = new Map()
  const releases = new Map()
  const unsubscribes = new Map()
  let listListener
  let listUnsubscribes = 0
  let list = { ids, byId: Object.fromEntries(ids.map((id) => [id, { id, title: id, running: true }])) }
  const ctx = { sessions: {
    list: {
      getSnapshot: () => list,
      subscribe(listener) { listListener = listener; return () => { listUnsubscribes += 1 } },
    },
    retain(id) {
      let listener
      let revision = 0
      let entries = []
      const eventSource = {
        getSnapshot: () => ({ revision, entries, change: { kind: 'append', entries } }),
        subscribe(callback) {
          listener = callback
          return () => { unsubscribes.set(id, (unsubscribes.get(id) || 0) + 1) }
        },
      }
      sources.set(id, (next) => { revision += 1; entries = next; listener() })
      return { binding: { eventSource }, release() { releases.set(id, (releases.get(id) || 0) + 1) } }
    },
  } }
  const { api } = loadClient(['createMonitor'], { globals: { Date: Clock } })
  const monitor = api.createMonitor(ctx)
  await Promise.resolve()
  return {
    monitor, releases, unsubscribes,
    advance(ms) { now += ms },
    rows(rows) {
      list = { ids: rows.map((row) => row.id), byId: Object.fromEntries(rows.map((row) => [row.id, row])) }
      listListener()
    },
    emit(id, entries) { sources.get(id)(entries) },
    phase(id, kind) {
      const event = kind === 'think'
        ? { type: 'transient', event: { time: now, data: { chunk: { type: 'reasoning-delta', text: 'thinking' } } } }
        : kind === 'out'
          ? { type: 'transient', event: { time: now, data: { chunk: { type: 'text-delta', text: 'output' } } } }
          : { type: 'event', event: { type: 'tool/call', time: now, data: { callId: id + '-call', name: 'bash', arguments: {} } } }
      sources.get(id)([event])
    },
    snapshot() {
      const unsubscribe = monitor.subscribe(() => {})
      const snapshot = monitor.getSnapshot()
      unsubscribe()
      return JSON.parse(JSON.stringify(snapshot))
    },
    listUnsubscribes: () => listUnsubscribes,
  }
}

test('flush releases idle sessions without any viewer or further list publications', async () => {
  const f = await monitorFixture(['a'])
  f.rows([{ id: 'a', running: false }])
  f.advance(180000)
  f.monitor.flush()
  assert.equal(f.releases.get('a') || 0, 0, 'hold remains intact at the boundary')
  f.advance(1)
  f.monitor.flush()
  assert.equal(f.releases.get('a'), 1, 'scheduled flush must expire the retain')
  assert.equal(f.unsubscribes.get('a'), 1, 'expired sources must be unsubscribed')
  assert.equal(f.monitor.getSnapshot().totals.count, 0)
  f.monitor.flush()
  f.monitor.dispose()
  assert.equal(f.releases.get('a'), 1, 'expiry, later ticks and disposal release only once')
  assert.equal(f.listUnsubscribes(), 1)
})

test('one flush expires multiple held desks and seats overflow agents in freed slots', async () => {
  const ids = Array.from({ length: 10 }, (_, index) => 'agent-' + index)
  const f = await monitorFixture(ids)
  const before = f.snapshot()
  assert.equal(before.totals.desks, 8)
  assert.equal(before.totals.overflow, 2)
  f.rows(ids.map((id, index) => ({ id, running: index >= 2 })))
  f.advance(180001)
  f.monitor.flush()
  assert.equal(f.releases.get(ids[0]), 1)
  assert.equal(f.releases.get(ids[1]), 1)
  const after = f.snapshot()
  assert.equal(after.totals.count, 8)
  assert.equal(after.totals.desks, 8)
  assert.equal(after.totals.overflow, 0)
  assert.deepEqual(after.agents.filter((agent) => agent.id === ids[8] || agent.id === ids[9]).map((agent) => agent.deskSlot).sort(), [0, 1])
  for (const agent of after.agents.filter((agent) => ids.slice(2, 8).includes(agent.id))) {
    assert.equal(agent.deskSlot, before.agents.find((old) => old.id === agent.id).deskSlot)
  }
  f.monitor.dispose()
  for (const id of ids) assert.equal(f.releases.get(id), 1)
})

test('concurrent think and act agents each contribute half of aggregate agent time', async () => {
  const f = await monitorFixture(['thinker', 'actor'])
  f.phase('thinker', 'think')
  f.phase('actor', 'act')
  f.advance(60000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 50, act: 50, out: 0, wait: 0 })
  f.monitor.dispose()
})

test('empty and newly observed agents keep unobserved time in wait', async () => {
  const empty = await monitorFixture()
  assert.deepEqual(empty.snapshot().phaseMix, { think: 0, act: 0, out: 0, wait: 100 })
  empty.monitor.dispose()
  const f = await monitorFixture(['a'])
  f.phase('a', 'think')
  f.advance(15000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 25, act: 0, out: 0, wait: 75 })
  f.monitor.dispose()
})

test('staggered phases include idle agent time and retain every phase contribution', async () => {
  const f = await monitorFixture(['a', 'b'])
  f.phase('a', 'think')
  f.advance(15000)
  f.phase('b', 'act')
  f.advance(15000)
  f.phase('a', 'out')
  f.advance(30000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 25, act: 38, out: 25, wait: 12 })
  f.monitor.dispose()
})

test('held time becomes wait instead of extending the last active phase', async () => {
  const f = await monitorFixture(['a'])
  f.phase('a', 'think')
  f.advance(15000)
  f.rows([{ id: 'a', running: false }])
  f.advance(45000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 25, act: 0, out: 0, wait: 75 })
  f.monitor.dispose()
})

test('phase rounding preserves three concurrent contributions and totals exactly 100', async () => {
  const f = await monitorFixture(['a', 'b', 'c'])
  f.phase('a', 'think')
  f.phase('b', 'act')
  f.phase('c', 'out')
  f.advance(60000)
  const mix = f.snapshot().phaseMix
  assert.equal(mix.wait, 0)
  for (const kind of ['think', 'act', 'out']) assert.ok(mix[kind] >= 33 && mix[kind] <= 34)
  assert.equal(Object.values(mix).reduce((sum, pct) => sum + pct, 0), 100)
  f.monitor.dispose()
})

test('resuming the same phase preserves the preceding held wait interval', async () => {
  const f = await monitorFixture(['a'])
  f.phase('a', 'think')
  f.advance(15000)
  f.rows([{ id: 'a', running: false }])
  f.advance(30000)
  f.rows([{ id: 'a', running: true }])
  f.phase('a', 'think')
  f.advance(15000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 50, act: 0, out: 0, wait: 50 })
  f.monitor.dispose()
})

test('a completed turn contributes wait after its terminal event', async () => {
  const f = await monitorFixture(['a'])
  f.phase('a', 'out')
  f.advance(15000)
  f.emit('a', [{ type: 'event', event: { type: 'turn/end', time: 1015000, data: { reason: { kind: 'completed' } } } }])
  f.advance(45000)
  assert.deepEqual(f.snapshot().phaseMix, { think: 0, act: 0, out: 25, wait: 75 })
  f.monitor.dispose()
})

test('a running call outside the display cap keeps its agent running', async () => {
  const f = await monitorFixture(['a'])
  f.emit('a', Array.from({ length: 19 }, (_, index) => ({
    type: 'event', event: { type: 'tool/call', time: 1000000, data: { callId: 'call-' + index, name: 'bash', arguments: {} } },
  })))
  f.emit('a', Array.from({ length: 18 }, (_, index) => ({
    type: 'event', event: { type: 'tool/result', time: 1000000, data: { message: { toolCallId: 'call-' + (index + 1) } } },
  })))
  f.advance(7000)
  const agent = f.snapshot().agents[0]
  assert.equal(agent.tools.length, 18)
  assert.ok(agent.tools.every((tool) => tool.state === 'ok'))
  assert.equal(agent.state, 'run', 'hidden in-flight tools still represent active work')
  f.emit('a', [{ type: 'event', event: { type: 'tool/result', time: 1007000, data: { message: { toolCallId: 'call-0' } } } }])
  f.advance(7000)
  assert.equal(f.snapshot().agents[0].state, 'wait')
  f.monitor.dispose()
})
