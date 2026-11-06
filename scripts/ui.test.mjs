import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClient } from './test-helpers.mjs'

function agent(overrides = {}) {
  return {
    id: 'unit-1', name: 'Fixture', tag: 'A1', state: 'run', held: false, deskSlot: 0,
    color: '#55ffff', ctx: 12, ctxTokens: 1200, tps: 3, displayTps: 3,
    tokens: { in: 1200, out: 2, cache: 0, cacheWrite: 0, reasoning: 0 },
    think: '', out: '', tools: [], toolLog: [], phases: [], files: [], todos: [],
    tpsHistory: [0, 3], calls: 0, errors: 0, turn: 1, step: 1, elapsed: 1000,
    ...overrides,
  }
}

// Run the original stage drawing loop; replace only browser Canvas/RAF boundaries.
function stageHarness(agents) {
  let nextFrame, now = 0, depth = 0, lowestDepth = 0, fills = 0
  const gradient = { addColorStop() {} }
  const noop = () => {}
  const context = new Proxy({
    save() { depth++ },
    restore() { depth--; lowestDepth = Math.min(lowestDepth, depth) },
    fillRect() { fills++ },
    measureText: (text) => ({ width: String(text).length * 5 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  }, { get: (target, key) => key in target ? target[key] : noop })
  const canvas = {
    width: 960, height: 600, style: {}, getContext: () => context,
    getBoundingClientRect: () => ({ width: 960, height: 600, left: 0, top: 0 }),
    addEventListener() {}, removeEventListener() {},
  }
  const { api } = loadClient(['startStage'], {
    globals: { performance: { now: () => now } },
    window: { requestAnimationFrame: (callback) => { nextFrame = callback; return 1 } },
  })
  const stop = api.startStage(canvas, () => ({
    mode: 'office', agents, totals: { tps: agents.length * 3 }, history: [], toolStats: [],
    topology: { edges: [] }, prefs: { visits: false, actions: false },
  }))
  return {
    frame() { now += 100; nextFrame(); return { depth, lowestDepth, fills } },
    stop,
  }
}

for (const [name, agents] of [['empty', []], ['active', [agent()]]]) {
  test(`office Canvas stack remains balanced across 100 ${name} frames`, () => {
    const stage = stageHarness(agents)
    try {
      for (let frame = 1; frame <= 100; frame++) {
        const result = stage.frame()
        assert.equal(result.depth, 0, `Canvas save stack leaked at frame ${frame}`)
        assert.equal(result.lowestDepth, 0, 'Canvas restore ran without a matching save')
        assert.ok(result.fills > 0, 'office drawing must actually execute')
      }
    } finally { stage.stop() }
  })
}

test('ANALYZE exposes full available reasoning, output and tool arguments with escaped telemetry', () => {
  const { api } = loadClient(['analyzeHtml'])
  const think = '<think-start> ' + 'reasoning '.repeat(100) + ' <think-end>'
  const out = '<output-start> ' + 'answer '.repeat(100) + ' <output-end>'
  const arg = '<arg-start> ' + 'parameter '.repeat(100) + ' <arg-end>'
  const html = api.analyzeHtml(agent({ think, out, tools: [{ name: '<exec>', arg, state: 'err', ms: 1200 }] }))
  for (const marker of ['think-start', 'think-end', 'output-start', 'output-end', 'arg-start', 'arg-end', 'exec']) {
    assert.ok(html.includes(`&lt;${marker}&gt;`), `${marker} must be readable escaped text`)
    assert.ok(!html.includes(`<${marker}>`), `${marker} must not become HTML`)
  }
  assert.ok(html.includes('1.2s'))
  assert.ok(html.includes('data-s="err"'))
  for (const title of ['CONTEXT PRESSURE', 'TASK PROGRESS', 'TOOL MATRIX', 'PHASE TIMELINE', 'FILE HEAT', 'THRUPUT TRACE']) {
    assert.ok(html.includes(title), `${title} widget must remain available`)
  }
})

test('ANALYZE describes empty THINK, ACT and OUT detail channels', () => {
  const { api } = loadClient(['analyzeHtml'])
  const html = api.analyzeHtml(agent())
  assert.ok(html.includes('no reasoning channel'))
  assert.ok(html.includes('no tool calls yet'))
  assert.ok(html.includes('no output yet'))
})

test('phase timeline does not show terminal waiting time as ACT', () => {
  const { api } = loadClient(['timelineWidget'], {
    globals: { Date: class extends Date { static now() { return 60000 } } },
  })
  const html = api.timelineWidget(agent({ phases: [{ kind: 'think', t: 10000 }, { kind: 'wait', t: 20000 }] }))
  const lanes = [...html.matchAll(/data-lane-segments="([^"]+)"/g)]
    .map((match) => JSON.parse(decodeURIComponent(match[1])))
  assert.equal(lanes[0].length, 1, 'completed reasoning remains visible')
  assert.deepEqual(lanes[1], [], 'waiting time is not tool execution')
  assert.deepEqual(lanes[2], [])
})

test('ticker displays escaped alert text with its severity', () => {
  const { api } = loadClient(['tickerHtml'])
  for (const [level, kind] of [['err', 'err'], ['warn', 'wait']]) {
    const html = api.tickerHtml({ agents: [], log: [], alerts: [{ level, text: '<failed> & retry' }], totals: { count: 0, tps: 0, tin: 0, tout: 0 } })
    assert.ok(html.includes('ALERT &lt;failed&gt; &amp; retry'))
    assert.ok(html.includes(`data-k="${kind}"`))
    assert.ok(!html.includes('[object Object]'))
  }
})

test('room summary shows the newest recent call and handles no calls', () => {
  const { api } = loadClient(['roomSummaryHtml'])
  const view = { agents: [], totals: {}, recentCalls: [{ t: 200, name: 'newest', ms: 200 }, { t: 100, name: 'oldest', ms: 100 }] }
  const html = api.roomSummaryHtml(view)
  assert.ok(html.includes('newest · 200ms'))
  assert.ok(!html.includes('oldest'))
  assert.ok(api.roomSummaryHtml({ agents: [], totals: {} }).includes('no calls yet'))
})
