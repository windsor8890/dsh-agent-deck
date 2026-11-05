#!/usr/bin/env node
/**
 * Hermetic checks for the dsh-agent-deck client bundle.
 *
 * Runs with plain Node (no dependencies):
 *   - syntax check for client.js
 *   - embedded sprite payloads vs assets/ hashes
 *   - module-loader contract + pure prefs/action helpers
 *   - DOM/README/package reference integrity
 *   - stale debug-marker and bundle-size guards
 *
 * Usage: npm test   (or: node scripts/check.mjs)
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const results = []
let failures = 0

function check(name, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, name, detail: typeof detail === 'string' ? detail : '' })
  } catch (error) {
    failures += 1
    results.push({ ok: false, name, detail: error && error.message ? error.message : String(error) })
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8')
}
function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

const client = read('client.js')
const readme = read('README.md')
const pkg = JSON.parse(read('package.json'))
const ASSET_NAMES = ['front', 'happy', 'stand', 'side', 'rest', 'slack', 'game']

// ---------------------------------------------------------------- syntax
check('client.js passes node --check', () => {
  const run = spawnSync(process.execPath, ['--check', 'client.js'], { cwd: root, encoding: 'utf8' })
  assert(run.status === 0, (run.stderr || run.stdout || 'node --check failed').trim())
  return 'exit 0'
})

// ---------------------------------------------------------------- sprites
const spriteSources = {}
check('seven embedded sprite data URIs are present', () => {
  for (const name of ASSET_NAMES) {
    const pattern = new RegExp("const GIRL_" + name.toUpperCase() + "_SRC = 'data:image/(webp|png);base64,([^']+)'")
    const match = client.match(pattern)
    assert(match, 'missing GIRL_' + name.toUpperCase() + '_SRC')
    assert(match[1] === 'webp', name + ' must be WebP')
    spriteSources[name] = Buffer.from(match[2], 'base64')
  }
  return ASSET_NAMES.length + ' payloads'
})
check('embedded sprite bytes match assets/*.webp', () => {
  for (const name of ASSET_NAMES) {
    const file = path.join(root, 'assets', 'whale-girl-' + name + '.webp')
    assert(fs.existsSync(file), 'missing ' + path.relative(root, file))
    assert(sha256(fs.readFileSync(file)) === sha256(spriteSources[name]), name + ' hash mismatch')
  }
  return 'hashes match'
})
check('GIRL_SPRITE_SRC maps all seven pose keys', () => {
  const block = client.slice(client.indexOf('const GIRL_SPRITE_SRC = {'), client.indexOf('}', client.indexOf('const GIRL_SPRITE_SRC = {')) + 1)
  for (const key of ASSET_NAMES) assert(block.includes(key + ': GIRL_'), 'missing pose key ' + key)
  return '7 keys'
})

// ---------------------------------------------------------------- module contract + helpers
const hook = {}
check('module loader contract loads and exports the plugin', () => {
  let loaded = null
  const localStorage = { getItem: () => null, setItem: () => {} }
  const windowStub = {
    __ModuleLoader__: { load: (entry) => { loaded = entry } },
    localStorage,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  }
  windowStub.window = windowStub
  const sandbox = {
    window: windowStub,
    document: {
      createElement: () => ({ getContext: () => null, style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    devicePixelRatio: 1,
    __AGENT_DECK_TEST__: hook,
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = sandbox.document
  vm.createContext(sandbox)
  vm.runInContext(client, sandbox, { filename: 'client.js' })
  assert(loaded && typeof loaded.factory === 'function', 'window.__ModuleLoader__.load was not called')
  const noop = () => {}
  const react = {
    createElement: (...args) => ({ args }),
    useRef: (initial) => ({ current: initial }),
    useEffect: noop,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
  }
  const plugin = loaded.factory((name) => {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  assert(plugin && typeof plugin.apply === 'function', 'plugin.apply missing')
  assert(Array.isArray(plugin.inject), 'plugin.inject is not an array')
  for (const service of ['slots', 'locale', 'sessions', 'theme']) {
    assert(plugin.inject.includes(service), 'plugin.inject missing ' + service)
  }
  return 'factory + inject'
})

check('prefs normalization clamps values', () => {
  const { normalizePrefs, DEFAULT_PREFS } = hook
  assert(normalizePrefs(null).visitPace === DEFAULT_PREFS.visitPace, 'null prefs must default')
  const parsed = normalizePrefs({ visits: false, visitPace: 'nope', maxVisitors: 7, actions: false })
  assert(parsed.visits === false && parsed.actions === false, 'boolean prefs lost')
  assert(parsed.visitPace === 'chill', 'invalid pace must fall back to chill')
  assert(parsed.maxVisitors === 2, 'invalid maxVisitors must fall back to 2')
  assert(normalizePrefs({ maxVisitors: 1 }).maxVisitors === 1, 'maxVisitors=1 not preserved')
  return 'defaults + clamps'
})

check('visit pace and visitor limit math', () => {
  const { visitPaceFor, visitLimitFor } = hook
  assert(visitPaceFor({ visitPace: 'lively' }) === 0.65, 'lively pace wrong')
  assert(visitPaceFor({ visitPace: 'normal' }) === 1, 'normal pace wrong')
  assert(visitPaceFor({}) === 1.5, 'default chill pace wrong')
  assert(visitLimitFor(8, { visits: true, maxVisitors: 2 }, false) === 2, '8 seats should cap at 2')
  assert(visitLimitFor(2, { visits: true, maxVisitors: 2 }, false) === 1, '2 seats should allow 1')
  assert(visitLimitFor(8, { visits: true, maxVisitors: 1 }, false) === 1, 'maxVisitors=1 not honored')
  assert(visitLimitFor(8, { visits: false }, false) === 0, 'visited disabled must be 0')
  assert(visitLimitFor(8, { visits: true }, true) === 0, 'reduced motion must stop visits')
  return 'pace + limits'
})

check('wait actions follow real session state', () => {
  const { waitActionFor } = hook
  const prefs = { actions: true }
  assert(waitActionFor({ state: 'run', deskSlot: 0 }, prefs, 0, false) === '', 'RUN must not slack')
  assert(waitActionFor({ state: 'wait', held: true, deskSlot: 0 }, prefs, 0, false) === '', 'held must sleep')
  assert(waitActionFor({ state: 'wait', pending: true, deskSlot: 0 }, prefs, 0, false) === 'slack', 'pending must show phone')
  assert(waitActionFor({ state: 'wait', deskSlot: 0 }, prefs, 0, false) === 'slack', 'slot0 t0 must slack')
  assert(waitActionFor({ state: 'wait', deskSlot: 0 }, prefs, 24000, false) === 'game', 'slot0 t24s must alternate to game')
  assert(waitActionFor({ state: 'wait', deskSlot: 1 }, prefs, 0, false) === 'game', 'slot parity must alternate')
  assert(waitActionFor({ state: 'wait', pending: true, deskSlot: 0 }, { actions: false }, 0, false) === '', 'actions off must suppress')
  assert(waitActionFor({ state: 'wait', pending: true, deskSlot: 0 }, prefs, 0, true) === '', 'reduced motion must suppress')
  return 'run/wait/pending/held matrix'
})

// ---------------------------------------------------------------- static integrity
check('all $(\'id\') lookups exist in the template', () => {
  const ids = new Set()
  for (const match of client.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) ids.add(match[1])
  for (const id of ids) assert(client.includes('id="' + id + '"'), 'missing element id: ' + id)
  return ids.size + ' ids'
})
check('README local asset/doc references exist', () => {
  const refs = new Set()
  for (const match of readme.matchAll(/(?:docs|assets)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g)) refs.add(match[0])
  for (const ref of refs) assert(fs.existsSync(path.join(root, ref)), 'README references missing file: ' + ref)
  return refs.size + ' refs'
})
check('package files cover runtime assets', () => {
  const entries = pkg.files || []
  assert(entries.includes('client.js'), 'client.js missing from package files')
  assert(entries.includes('assets/*.webp'), 'assets/*.webp missing from package files')
  assert(entries.includes('README.md'), 'README.md missing from package files')
  return entries.length + ' entries'
})
check('no test/debug leftovers in production client', () => {
  for (const marker of ['TEMP EMPTY-STATE TEST', 'NXT BREAK', '__dbg', 'console.log(']) {
    assert(!client.includes(marker), 'found leftover marker: ' + marker)
  }
  return 'clean'
})

// ---------------------------------------------------------------- size budget
const clientBytes = Buffer.byteLength(client, 'utf8')
const gzipBytes = zlib.gzipSync(Buffer.from(client), { level: 9 }).length
const assetBytes = ASSET_NAMES.reduce(
  (total, name) => total + fs.statSync(path.join(root, 'assets', 'whale-girl-' + name + '.webp')).size,
  0,
)
check('client bundle stays under the WebP size budget', () => {
  const budget = 700 * 1024
  assert(clientBytes < budget, 'client.js is ' + clientBytes + ' bytes, budget is ' + budget)
  return clientBytes + ' bytes (' + Math.round((clientBytes / 1024) * 10) / 10 + ' KiB)'
})

// ---------------------------------------------------------------- summary
for (const result of results) {
  const mark = result.ok ? 'PASS' : 'FAIL'
  console.log(mark.padEnd(5) + result.name + (result.detail ? ' — ' + result.detail : ''))
}
console.log('')
console.log('client.js  ' + clientBytes + ' bytes · gzip ' + gzipBytes + ' bytes')
console.log('assets     ' + assetBytes + ' bytes (7 WebP)')
console.log('checks     ' + (results.length - failures) + '/' + results.length + ' passed')
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
