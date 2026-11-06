import fs from 'node:fs'
import vm from 'node:vm'

// Execute the shipped bundle. Only the VM's copy exposes private functions;
// production exports and the dependency-free plugin format remain unchanged.
export function loadClient(names = [], options = {}) {
  let entry
  const window = {
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    addEventListener() {},
    removeEventListener() {},
    setInterval,
    clearInterval,
    devicePixelRatio: 1,
    ...options.window,
    __ModuleLoader__: { load: (value) => { entry = value } },
  }
  const sandbox = {
    console,
    document: {
      createElement: () => ({ getContext: () => null, style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    ...options.globals,
    window,
  }
  window.document = sandbox.document
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const marker = 'return { inject, apply }'
  if (!source.includes(marker)) throw new Error('Client factory export not found')
  vm.runInNewContext(source.replace(marker, `return { inject, apply, ${names.join(', ')} }`), sandbox, { filename: 'client.js' })
  const noop = () => {}
  const react = options.react || {
    createElement: (...args) => ({ args }),
    useRef: (current) => ({ current }),
    useEffect: noop,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
  }
  const api = entry.factory((name) => {
    if (name === 'react') return react
    throw new Error('Unexpected dependency: ' + name)
  })
  return { api, sandbox, window }
}
