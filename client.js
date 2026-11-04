/**
 * Agent Deck — cyberpunk HUD console for live agent telemetry.
 *
 * Client half of the `dsh-agent-deck` bundle. It reads the Host's live
 * session state through the shared client Session controller:
 *   - `ctx.sessions.list`            → which Sessions exist and which run right now
 *   - `ctx.sessions.retain(id)`      → the live event window for one Session,
 *                                      including transient assistant stream frames
 *   - `ctx.uiSession.sessionStatus`  → pending-interaction (waiting-on-human) facts
 *
 * Nothing is written back to the Session log; this panel is strictly read-only.
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-deck',
  factory(require) {
    const React = require('react')
    const { useRef, useEffect, useState } = React
    const h = React.createElement

    //#region constants
    const NS = 'watchtower'
    const PANEL_ID = 'watchtower'
    const MAX_CARDS = 8
    // 4×2 office desks — one stable seat per Session until the idle hold expires.
    const DESK_COUNT = 8
    // an agent that stops running keeps its desk for a while, so idle sessions
    // stay visible in the office instead of disappearing the moment they pause
    const IDLE_HOLD_MS = 180000
    const FLUSH_MS = 100
    const THINK_CAP = 1800
    const OUT_CAP = 1400
    const MAX_TOOLS = 18
    const MAX_TOOLLOG = 160
    const MAX_PHASES = 420
    const MAX_FILES = 40
    const LOG_CAP = 40

    const DICT = {
      zh: {
        panel: '监控室',
        title: '监控室',
        intro: '实时观看每个工作中的智能体的思考、执行与输出',
        standby: '暂无工作中的智能体',
        standbyHint: '派一个任务给任意会话，它的遥测会在这里亮起',
        units: '智能体单元',
        live: '实时',
        agents: '智能体',
        thruput: '吞吐',
        alerts: '告警',
        tools: '工具',
        telemetry: '遥测',
        aggregate: '聚合吞吐',
        globalScope: '全局 // 全部单元',
        think: '思考',
        act: '执行',
        out: '输出',
        noReasoning: '— 无思考通道 —',
        standbyStream: '待命…',
        ctx: '上下文',
        local: '本地',
        calls: '调用',
        err: '错误',
        turns: '回合',
        tokensIn: '输入 token',
        tokensOut: '输出 token',
        contextLoad: '上下文负载',
        eventLog: '事件日志',
        openSession: '打开会话',
        syncing: '同步中',
        waiting: '等待',
        running: '运行',
        error: '异常',
      },
      en: {
        panel: 'Control Room',
        title: 'Agent Deck',
        intro: "Watch every working agent's thinking, tool calls and output live",
        standby: 'NO ACTIVE UNITS',
        standbyHint: 'Send any session a task and its telemetry lights up here',
        units: 'AGENT UNITS',
        live: 'LIVE',
        agents: 'AGENTS',
        thruput: 'THRUPUT',
        alerts: 'ALERTS',
        tools: 'TOOLS',
        telemetry: 'TELEMETRY',
        aggregate: 'AGGREGATE THROUGHPUT',
        globalScope: 'GLOBAL // ALL UNITS',
        think: 'THINK',
        act: 'ACT',
        out: 'OUT',
        noReasoning: '— no reasoning channel —',
        standbyStream: 'standby…',
        ctx: 'CTX',
        local: 'LOCAL',
        calls: 'calls',
        err: 'err',
        turns: 'turns',
        tokensIn: 'TOKENS IN',
        tokensOut: 'TOKENS OUT',
        contextLoad: 'CONTEXT LOAD',
        eventLog: 'EVENT LOG',
        openSession: 'open session',
        syncing: 'SYNC',
        waiting: 'WAIT',
        running: 'RUN',
        error: 'ERR',
      },
    }

    const STATE_COLOR = { run: '#55ffff', wait: '#ffff55', err: '#ff5555', sync: '#555555' }
    // Stable per-agent identity colors (IBM 5153 accents, assigned round-robin).
    const AGENT_COLORS = ['#55ffff', '#ff55ff', '#ffff55', '#55ff55', '#ff5555', '#5555ff', '#00aaaa', '#aa00aa', '#c47e00', '#00aa00']
    // Resolved host theme scheme (`light` | `dark`); kept current by ctx.theme.
    let activeScheme = 'dark'

    //#endregion

    //#region utils
    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    function esc(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ESC_MAP[c])
    }
    function tail(value, cap) {
      const s = String(value == null ? '' : value)
      return s.length > cap ? '…' + s.slice(-cap) : s
    }
    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v))
    }
    /** '#rrggbb' + alpha -> rgba() string (canvas-safe). */
    function hexA(hex, alpha) {
      if (!hex || hex.length < 7) return 'rgba(85,255,255,' + alpha + ')'
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
    }
    /** Resolve a host theme snapshot to the scheme the panel renders. */
    function themeSchemeOf(snapshot) {
      const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : ''
      return scheme === 'light' ? 'light' : 'dark'
    }
    function fmtNum(n) {
      const v = Number(n) || 0
      if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
      if (v >= 1e4) return (v / 1e3).toFixed(1) + 'k'
      if (v >= 1e3) return (v / 1e3).toFixed(2) + 'k'
      return String(Math.round(v))
    }
    function pad2(n) {
      return n < 10 ? '0' + n : String(n)
    }
    function fmtClock(d) {
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }
    function fmtDur(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      const s = total % 60
      const m = Math.floor(total / 60) % 60
      const hh = Math.floor(total / 3600)
      return hh > 0 ? hh + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s)
    }
    function errorText(err) {
      if (!err) return 'unknown error'
      if (typeof err === 'string') return err
      return String(err.message || err.code || err)
    }
    function blocksOf(content) {
      return Array.isArray(content) ? content : []
    }
    function textOf(content) {
      return blocksOf(content)
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join('')
    }
    function reasoningOf(content) {
      return blocksOf(content)
        .filter((b) => b && b.type === 'reasoning')
        .map((b) => b.text || '')
        .join('')
    }
    /** Human-facing argument summary: known tools get their salient field, others a compact JSON head. */
    function argPreview(name, args) {
      let parsed
      try {
        parsed = typeof args === 'string' ? JSON.parse(args || '{}') : args
      } catch (err) {
        parsed = undefined
      }
      if (parsed && typeof parsed === 'object') {
        const pick = (...keys) => {
          for (const key of keys) {
            const v = parsed[key]
            if (typeof v === 'string' && v !== '') return v
            if (Array.isArray(v) && v.length > 0) return String(v[0])
          }
          return undefined
        }
        const salient = pick('command', 'path', 'file_path', 'pattern', 'query', 'queries', 'url', 'name', 'id', 'text')
        if (salient) return tail(salient.replace(/\s+/g, ' '), 62)
        const keys = Object.keys(parsed).slice(0, 2)
        if (keys.length > 0) {
          return tail(keys.map((k) => k + ':' + String(parsed[k]).replace(/\s+/g, ' ')).join(' '), 62)
        }
      }
      const raw = typeof args === 'string' ? args : JSON.stringify(args || {})
      return tail(String(raw || '').replace(/\s+/g, ' '), 62)
    }

    const WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch', 'str_replace_editor', 'notebook_edit', 'create_directory'])
    const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep', 'lsp', 'search', 'list_directory'])

    /** First path-like field of a tool-call argument payload. */
    function pathOfArguments(args) {
      let parsed
      try {
        parsed = typeof args === 'string' ? JSON.parse(args || '{}') : args
      } catch (err) {
        return ''
      }
      if (!parsed || typeof parsed !== 'object') return ''
      const candidate = parsed.path || parsed.file_path || parsed.filePath || parsed.target || parsed.pattern || parsed.file
      return typeof candidate === 'string' ? candidate : ''
    }

    /** Parse a `todo_write` argument payload into the plan the agent is working through. */
    function todosOfArguments(args) {
      let parsed
      try {
        parsed = typeof args === 'string' ? JSON.parse(args || '{}') : args
      } catch (err) {
        return null
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.todos)) return null
      return parsed.todos
        .filter((todo) => todo && typeof todo === 'object')
        .slice(0, 14)
        .map((todo) => ({ content: String(todo.content || '').slice(0, 140), status: String(todo.status || 'pending') }))
    }

    /** Record a phase change for the swimlane timeline (adjacent duplicates collapse). */
    function markPhase(f, kind, at) {
      const time = at || Date.now()
      const last = f.phases[f.phases.length - 1]
      if (last && last.kind === kind) {
        last.until = time
        return
      }
      f.phases.push({ t: time, kind, until: time })
      if (f.phases.length > MAX_PHASES) f.phases.splice(0, f.phases.length - MAX_PHASES)
    }

    function logTool(f, name, at) {
      f.toolLog.push({ t: at || Date.now(), name: String(name || 'tool').slice(0, 26), state: 'run' })
      if (f.toolLog.length > MAX_TOOLLOG) f.toolLog.splice(0, f.toolLog.length - MAX_TOOLLOG)
    }

    function settleLastTool(f, name, state, elapsed) {
      for (let i = f.toolLog.length - 1; i >= 0; i--) {
        const entry = f.toolLog[i]
        if (entry.name === name && entry.state === 'run') {
          entry.state = state || 'ok'
          if (typeof elapsed === 'number' && elapsed >= 0) entry.ms = elapsed
          return
        }
      }
    }

    /** Fold one touched path into the per-agent file heat list. */
    function bumpFile(f, path, kind, at) {
      if (!path || typeof path !== 'string') return
      const key = path.replace(/\\/g, '/').slice(-90)
      let row = f.files[key]
      if (!row) {
        row = f.files[key] = { r: 0, w: 0, t: at || Date.now() }
        f.filesOrder.push(key)
        while (f.filesOrder.length > MAX_FILES) {
          const dropped = f.filesOrder.shift()
          delete f.files[dropped]
        }
      }
      row.t = at || Date.now()
      if (kind === 'w') row.w += 1
      else row.r += 1
    }
    //#endregion

    //#region telemetry fold
    function newFold() {
      return {
        turn: 0,
        step: 0,
        turnAt: 0,
        model: '',
        provider: '',
        cw: 0,
        think: '',
        out: '',
        pendingThink: '',
        pendingText: '',
        tools: [],
        tokens: { in: 0, out: 0, cache: 0, cacheWrite: 0, reasoning: 0 },
        liveIn: 0,
        liveOut: 0,
        chars: [],
        toolLog: [],
        phases: [],
        files: Object.create(null),
        filesOrder: [],
        todos: [],
        errors: 0,
        calls: 0,
        activity: 0,
        lastAt: 0,
        endState: '',
      }
    }

    function resetFold(f) {
      const fresh = newFold()
      for (const key of Object.keys(fresh)) f[key] = fresh[key]
    }

    function bumpChars(f, text, at) {
      if (!text) return
      const now = at || Date.now()
      f.chars.push({ t: now, n: text.length })
      while (f.chars.length > 0 && now - f.chars[0].t > 3000) f.chars.shift()
      f.lastAt = now
      f.activity += 1
    }

    function mergeUsage(f, usage, authoritative) {
      if (!usage) return
      if (authoritative) {
        if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) f.tokens.in = usage.inputTokens
        if (typeof usage.cacheReadTokens === 'number') f.tokens.cache = usage.cacheReadTokens
        if (typeof usage.cacheWriteTokens === 'number') f.tokens.cacheWrite = usage.cacheWriteTokens
        if (typeof usage.outputTokens === 'number') f.tokens.out += usage.outputTokens
        if (typeof usage.reasoningTokens === 'number') f.tokens.reasoning += usage.reasoningTokens
        f.liveIn = 0
        f.liveOut = 0
      } else {
        if (typeof usage.inputTokens === 'number' && usage.inputTokens > 0) f.liveIn = usage.inputTokens
        if (typeof usage.outputTokens === 'number') f.liveOut = usage.outputTokens
      }
    }

    function pushTool(f, row) {
      if (f.tools.some((t) => t.id === row.id && row.id)) return
      f.tools.push(row)
      f.calls += 1
      if (f.tools.length > MAX_TOOLS) {
        const running = f.tools.filter((t) => t.state === 'run').slice(-MAX_TOOLS)
        const keepDone = Math.max(0, MAX_TOOLS - running.length)
        const done = keepDone > 0 ? f.tools.filter((t) => t.state !== 'run').slice(-keepDone) : []
        f.tools = done.concat(running).sort((a, b) => (a.at || 0) - (b.at || 0))
      }
    }

    function applyChunk(f, chunk, at) {
      if (!chunk || typeof chunk !== 'object') return
      switch (chunk.type) {
        case 'reasoning-delta':
          f.pendingThink += chunk.text || ''
          if (f.pendingThink.length > THINK_CAP * 3) f.pendingThink = f.pendingThink.slice(-THINK_CAP * 3)
          f.think = tail(f.pendingThink, THINK_CAP)
          bumpChars(f, chunk.text, at)
          markPhase(f, 'think', at)
          break
        case 'text-delta':
          f.pendingText += chunk.text || ''
          if (f.pendingText.length > OUT_CAP * 3) f.pendingText = f.pendingText.slice(-OUT_CAP * 3)
          f.out = tail(f.pendingText, OUT_CAP)
          bumpChars(f, chunk.text, at)
          markPhase(f, 'out', at)
          break
        case 'tool-call-delta': {
          let row = chunk.id ? f.tools.find((t) => t.id === chunk.id) : undefined
          markPhase(f, 'act', at)
          if (!row) {
            row = { id: chunk.id || 'live-' + f.tools.length, name: chunk.name || 'tool', arg: '', state: 'run', at: at || Date.now() }
            pushTool(f, row)
          }
          if (chunk.name) row.name = chunk.name
          row.raw = tail(String(row.raw || '') + String(chunk.argumentsDelta || ''), 120)
          row.arg = tail(String(row.raw).replace(/\s+/g, ' '), 62)
          f.lastAt = at || Date.now()
          f.activity += 1
          break
        }
        case 'block-end': {
          const block = chunk.block
          if (block && block.type === 'tool-call') {
            const row = f.tools.find((t) => t.id === block.id)
            if (row) {
              row.name = block.name || row.name
              row.arg = argPreview(row.name, block.arguments)
            }
          }
          break
        }
        case 'usage':
          mergeUsage(f, chunk.usage, false)
          break
        default:
          break
      }
    }

    function applyDurable(f, event, entry) {
      const data = event.data || {}
      switch (event.type) {
        case 'turn/start':
          f.turn = data.turn || f.turn + 1
          f.step = 0
          f.turnAt = event.time || Date.now()
          f.pendingText = ''
          f.pendingThink = ''
          f.out = ''
          f.think = ''
          f.tools = []
          f.errors = 0
          f.endState = ''
          break
        case 'step/start':
          f.step = data.step || f.step + 1
          f.pendingText = ''
          f.pendingThink = ''
          break
        case 'user/message':
          f.activity += 1
          f.lastAt = event.time || Date.now()
          break
        case 'assistant/message': {
          const message = data.message || {}
          const source = message.source || {}
          if (source.model) f.model = source.model
          const text = textOf(message.content)
          const reasoning = reasoningOf(message.content)
          if (text) {
            f.out = tail(text, OUT_CAP)
            f.pendingText = ''
          }
          if (reasoning) {
            f.think = tail(reasoning, THINK_CAP)
            f.pendingThink = ''
          }
          for (const block of blocksOf(message.content)) {
            if (block && block.type === 'tool-call' && block.id) {
              let row = f.tools.find((t) => t.id === block.id)
              if (!row) {
                row = { id: block.id, name: block.name, arg: argPreview(block.name, block.arguments), state: 'run', at: event.time || Date.now() }
                pushTool(f, row)
              }
            }
          }
          mergeUsage(f, data.usage, true)
          f.activity += 1
          f.lastAt = event.time || Date.now()
          markPhase(f, 'out', event.time || Date.now())
          break
        }
        case 'tool/call': {
          const at = event.time || Date.now()
          pushTool(f, {
            id: data.callId,
            name: data.name || 'tool',
            arg: argPreview(data.name, data.arguments),
            state: 'run',
            at,
          })
          logTool(f, data.name || 'tool', at)
          const touched = pathOfArguments(data.arguments)
          if (touched) bumpFile(f, touched, WRITE_TOOLS.has(data.name) ? 'w' : 'r', at)
          if (data.name === 'todo_write') {
            const todos = todosOfArguments(data.arguments)
            if (todos) f.todos = todos
          }
          markPhase(f, 'act', at)
          f.lastAt = at
          break
        }
        case 'tool/result': {
          const message = data.message || {}
          const row = f.tools.find((t) => t.id === message.toolCallId)
          const failed = Boolean(data.error || message.isError)
          const elapsed = row && row.at ? Math.max(0, (event.time || Date.now()) - row.at) : 0
          if (row) {
            row.state = failed ? 'err' : 'ok'
            row.ms = elapsed
            settleLastTool(f, row.name, failed ? 'err' : 'ok', elapsed)
          }
          if (failed) {
            f.errors += 1
            f.lastAt = event.time || Date.now()
          }
          f.activity += 1
          break
        }
        case 'request/header': {
          const config = (data.header && data.header.config) || {}
          if (config.model) f.model = config.model
          if (config.provider && !f.provider) f.provider = config.provider
          break
        }
        case 'request/context':
          if (data.model) f.model = data.model
          if (data.contextWindow) f.cw = data.contextWindow
          break
        case 'turn/end': {
          const reason = data.reason || {}
          if (reason.kind === 'error') {
            f.endState = 'err'
            f.errors += 1
            f.out = tail(String((reason.error && reason.error.message) || 'turn failed'), OUT_CAP)
          } else if (reason.kind === 'aborted' || reason.kind === 'interrupted') {
            f.endState = 'wait'
          } else {
            f.endState = 'run'
          }
          f.lastAt = event.time || Date.now()
          break
        }
        default:
          break
      }
      if (entry && entry.type === 'event' && event.time) f.lastAt = Math.max(f.lastAt, event.time)
    }

    function foldWindow(f, window) {
      const change = window && window.change
      if (change && change.kind === 'append' && Array.isArray(change.entries)) {
        for (const entry of change.entries) applyEntry(f, entry)
        return
      }
      if (change && change.kind === 'settle-assistant') {
        // The settlement carries the durable assistant entry itself; its attempt's
        // transient rows are already retired by the source.
        if (change.entry) applyEntry(f, change.entry)
        return
      }
      resetFold(f)
      const entries = (window && window.entries) || []
      for (let i = 0; i < entries.length; i++) applyEntry(f, entries[i])
    }

    function applyEntry(f, entry) {
      if (!entry || !entry.event) return
      if (entry.type === 'transient') {
        const data = entry.event.data || {}
        applyChunk(f, data.chunk, entry.event.time)
        return
      }
      applyDurable(f, entry.event, entry)
    }
    //#endregion

    //#region monitor store
    function createMonitor(ctx) {
      const records = new Map()
      // Session id -> desk slot (0..DESK_COUNT-1). Seats are stable: assigned on
      // first sight, kept through the 3-minute idle hold, released on detach.
      const deskSlots = new Map()
      const log = []
      const listeners = new Set()
      let view = {
        rev: 0,
        ts: Date.now(),
        agents: [],
        totals: { count: 0, tps: 0, tpsDisplay: 0, tin: 0, tout: 0, cache: 0, ctxTokens: 0, desks: 0, overflow: 0, tools: 0, errors: 0, turns: 0 },
        alerts: [],
        topology: { nodes: [], edges: [] },
        history: [],
        toolBins: [],
        toolStats: [],
        recentCalls: [],
        filesAgg: [],
        models: [],
        plan: { done: 0, total: 0 },
        phaseMix: { think: 0, act: 0, out: 0, wait: 0 },
        startedAt: Date.now(),
      }
      let dirty = true
      let lastNotifiedRev = -1
      let listSource = null
      let listSnapshot = null
      let unsubscribeList = null
      let unsubscribeStatus = null
      let statusTries = 0
      let disposed = false
      let nextTag = 1
      let displayTpsTotal = 0
      const monitorStartedAt = Date.now()

      function noteLog(kind, text) {
        log.push({ t: Date.now(), kind, text: String(text == null ? '' : text).slice(0, 160) })
        if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP)
      }

      function pendingOf(id) {
        try {
          const status = pendingStatus.get(id)
          return status && status.pendingInteraction ? status.pendingInteraction : null
        } catch (err) {
          return null
        }
      }
      const pendingStatus = new Map()

      function agentState(rec) {
        if (rec.error) return 'err'
        if (!rec.bound) return 'sync'
        if (pendingOf(rec.id)) return 'wait'
        const fold = rec.fold
        if (fold.endState === 'err') return 'err'
        // A tool still in flight (long bash, web fetch) means work is ongoing even
        // though no stream frames arrive; do not drift into WAIT.
        if (fold.tools.some((tool) => tool.state === 'run')) return 'run'
        const idleFor = Date.now() - (fold.lastAt || rec.attachedAt)
        if (idleFor > 6000) return 'wait'
        return 'run'
      }

      function toAgent(rec) {
        const fold = rec.fold
        const now = Date.now()
        let chars = 0
        for (const sample of fold.chars) if (now - sample.t <= 3000) chars += sample.n
        const tps = chars / 3 / 3.5
        const inputTokens = fold.tokens.in || fold.liveIn || 0
        const outputTokens = fold.tokens.out + (fold.liveOut || 0)
        const cacheTokens = fold.tokens.cache + (fold.tokens.cacheWrite || 0)
        const ctxTokens = inputTokens + cacheTokens
        const ctxPct = fold.cw > 0 ? clamp(Math.round((ctxTokens / fold.cw) * 100), 0, 100) : -1
        if (!rec.tpsHistory) rec.tpsHistory = []
        if (!rec.lastTpsAt || now - rec.lastTpsAt >= 90) {
          rec.tpsHistory.push(Math.round(tps * 10) / 10)
          rec.lastTpsAt = now
          if (rec.tpsHistory.length > 72) rec.tpsHistory.shift()
        }
        const files = Object.keys(fold.files)
          .map((path) => ({ path, r: fold.files[path].r, w: fold.files[path].w, t: fold.files[path].t }))
          .sort((a, b) => b.w * 3 + b.r - (a.w * 3 + a.r))
          .slice(0, 8)
        const todoDone = fold.todos.filter((todo) => todo.status === 'completed').length
        // displayed throughput eases toward the real value so the readout rolls
        if (rec.displayTps === undefined) rec.displayTps = tps
        else rec.displayTps += (tps - rec.displayTps) * 0.22
        const displayTps = Math.max(0, rec.displayTps)
        // throughput trend: last 6 samples against the previous 6
        const history = rec.tpsHistory || []
        const average = (slice) => (slice.length > 0 ? slice.reduce((sum, value) => sum + value, 0) / slice.length : 0)
        const recentAvg = average(history.slice(-6))
        const olderAvg = average(history.slice(-12, -6))
        const tpsDelta = olderAvg > 0.4 ? Math.round(((recentAvg - olderAvg) / olderAvg) * 100) : 0
        const title = (rec.row && (rec.row.displayTitle || rec.row.title)) || rec.id
        return {
          id: rec.id,
          deskSlot: deskSlots.has(rec.id) ? deskSlots.get(rec.id) : -1,
          tag: rec.tag,
          color: rec.color || AGENT_COLORS[0],
          name: title,
          cwd: (rec.row && rec.row.cwd) || '',
          origin: (rec.row && rec.row.origin) || '',
          state: rec.idleSince ? 'wait' : agentState(rec),
          held: Boolean(rec.idleSince),
          model: fold.model || '',
          turn: fold.turn || 0,
          step: fold.step || 0,
          think: fold.think || '',
          out: fold.out || '',
          tools: fold.tools.slice(-MAX_TOOLS),
          tokens: { in: inputTokens, out: outputTokens, cache: fold.tokens.cache, cacheWrite: fold.tokens.cacheWrite || 0, reasoning: fold.tokens.reasoning },
          ctxTokens,
          tps,
          displayTps,
          tpsDelta,
          ctx: ctxPct,
          cw: fold.cw,
          calls: fold.calls,
          errors: fold.errors,
          elapsed: Math.max(0, now - (fold.turnAt || rec.attachedAt)),
          lastAt: fold.lastAt || rec.attachedAt,
          error: rec.error || '',
          activity: fold.activity,
          files,
          todos: fold.todos,
          todoDone,
          todoTotal: fold.todos.length,
          toolLog: fold.toolLog,
          phases: fold.phases,
          tpsHistory: history,
        }
      }

      /** Live agents plus the ancestors that connect them, as one topology graph. */
      function buildTopology(agents) {
        const snapshot = listSnapshot
        if (!snapshot || !snapshot.byId) {
          return {
            nodes: agents.map((a) => ({ id: a.id, name: a.name, tag: a.tag, parentId: '', running: true, state: a.state, tps: a.tps })),
            edges: [],
          }
        }
        const byId = snapshot.byId
        const active = new Map()
        for (const agent of agents) active.set(agent.id, agent)
        const included = new Set()
        for (const agent of agents) {
          let id = agent.id
          let guard = 0
          while (id && byId[id] && guard++ < 12 && !included.has(id)) {
            included.add(id)
            id = byId[id].parentId
          }
        }
        const nodes = []
        for (const id of included) {
          const row = byId[id] || {}
          const agent = active.get(id)
          nodes.push({
            id,
            name: agent ? agent.name : row.displayTitle || row.title || id,
            tag: agent ? agent.tag : '·',
            parentId: row.parentId || '',
            running: Boolean(agent),
            state: agent ? agent.state : 'idle',
            tps: agent ? agent.tps : 0,
            displayTps: agent ? agent.displayTps : 0,
            color: agent ? agent.color : '#555555',
          })
        }
        const edges = []
        for (const node of nodes) {
          if (node.parentId && included.has(node.parentId)) edges.push({ from: node.parentId, to: node.id })
        }
        return { nodes, edges }
      }

      /**
       * Give every tracked Session a stable desk while seats are free. Running
       * Sessions win over held ones, and earlier arrivals win within a class; a
       * Session that is already seated never moves. When all desks are taken the
       * newcomer stays in the overflow tray (STANDBY +N) until a seat frees.
       */
      function ensureDesks() {
        const used = new Set(deskSlots.values())
        const free = []
        for (let slot = 0; slot < DESK_COUNT; slot++) if (!used.has(slot)) free.push(slot)
        if (free.length === 0) return
        const unseated = []
        for (const [id, rec] of records) if (!deskSlots.has(id)) unseated.push(rec)
        if (unseated.length === 0) return
        unseated.sort((a, b) => {
          const rank = (rec) => (rec.idleSince ? 1 : 0)
          if (rank(a) !== rank(b)) return rank(a) - rank(b)
          return (a.attachedAt || 0) - (b.attachedAt || 0)
        })
        for (const rec of unseated) {
          if (free.length === 0) break
          deskSlots.set(rec.id, free.shift())
        }
      }

      function rebuild() {
        ensureDesks()
        const agents = []
        for (const rec of records.values()) agents.push(toAgent(rec))
        agents.sort((a, b) => {
          const rank = (s) => (s === 'run' ? 0 : s === 'wait' ? 1 : s === 'err' ? 2 : 3)
          if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state)
          return b.activity - a.activity
        })
        const totals = { count: agents.length, tps: 0, tin: 0, tout: 0, cache: 0, ctxTokens: 0, desks: 0, overflow: 0, tools: 0, errors: 0, turns: 0 }
        const alerts = []
        let planDone = 0
        let planTotal = 0
        for (const a of agents) {
          totals.tps += a.tps
          totals.tin += a.tokens.in
          totals.tout += a.tokens.out
          totals.cache += a.tokens.cache + a.tokens.cacheWrite
          totals.ctxTokens += a.ctxTokens
          if (a.deskSlot >= 0) totals.desks += 1
          totals.tools += a.calls
          totals.errors += a.errors
          totals.turns += a.turn
          planDone += a.todoDone
          planTotal += a.todoTotal
          if (a.state === 'err') alerts.push({ level: 'err', text: a.name + ' — ' + (a.error || 'turn failed') })
          if (a.state === 'wait' && a.error) alerts.push({ level: 'warn', text: a.name + ' — ' + a.error })
        }
        totals.overflow = agents.length - totals.desks
        // --- live-window aggregates for the HUD layers ---
        const now = Date.now()
        const windowStart = now - TIMELINE_WINDOW
        const toolMap = new Map()
        const recentCalls = []
        const fileMap = new Map()
        const modelMap = new Map()
        const phaseMs = { think: 0, act: 0, out: 0 }
        for (const agent of agents) {
          for (const entry of agent.toolLog) {
            if (entry.t < windowStart) continue
            let stat = toolMap.get(entry.name)
            if (!stat) {
              stat = { name: entry.name, calls: 0, errs: 0, msSum: 0, msCount: 0 }
              toolMap.set(entry.name, stat)
            }
            stat.calls += 1
            if (entry.state === 'err') stat.errs += 1
            if (typeof entry.ms === 'number' && entry.ms > 0) {
              stat.msSum += entry.ms
              stat.msCount += 1
            }
            recentCalls.push({ t: entry.t, name: entry.name, state: entry.state, ms: entry.ms, tag: agent.tag })
          }
          for (const file of agent.files) {
            let row = fileMap.get(file.path)
            if (!row) {
              row = { path: file.path, r: 0, w: 0, t: 0 }
              fileMap.set(file.path, row)
            }
            row.r += file.r
            row.w += file.w
            row.t = Math.max(row.t, file.t)
          }
          if (agent.model) modelMap.set(agent.model, (modelMap.get(agent.model) || 0) + 1)
          const phases = agent.phases || []
          for (let index = 0; index < phases.length; index++) {
            const from = Math.max(windowStart, phases[index].t)
            const until = index + 1 < phases.length ? phases[index + 1].t : now
            const to = Math.min(now, until)
            if (to > from && phaseMs[phases[index].kind] !== undefined) phaseMs[phases[index].kind] += to - from
          }
        }
        const toolBins = new Array(24).fill(0)
        for (const agent of agents) {
          for (const entry of agent.toolLog) {
            const age = now - entry.t
            if (age < 0 || age > TIMELINE_WINDOW) continue
            const index = clamp(23 - Math.floor(age / (TIMELINE_WINDOW / 24)), 0, 23)
            toolBins[index] += 1
          }
        }
        recentCalls.sort((a, b) => b.t - a.t)
        const share = (ms) => Math.min(100, Math.max(0, Math.round((ms / TIMELINE_WINDOW) * 100)))
        const thinkPct = share(phaseMs.think)
        const actPct = Math.min(100 - thinkPct, share(phaseMs.act))
        const outPct = Math.min(100 - thinkPct - actPct, share(phaseMs.out))
        const waitPct = Math.max(0, 100 - thinkPct - actPct - outPct)
        const history = (view.history || []).concat([Math.round(totals.tps * 10) / 10]).slice(-72)
        // eased aggregate readout (odometer feel without re-rendering the DOM 60x)
        displayTpsTotal += (totals.tps - displayTpsTotal) * 0.22
        totals.tpsDisplay = displayTpsTotal
        view = {
          rev: view.rev + 1,
          ts: now,
          agents,
          totals,
          alerts,
          log,
          topology: buildTopology(agents),
          history,
          toolBins,
          plan: { done: planDone, total: planTotal },
          toolStats: Array.from(toolMap.values()).sort((a, b) => b.calls - a.calls),
          recentCalls: recentCalls.slice(0, 8),
          filesAgg: Array.from(fileMap.values())
            .sort((a, b) => b.w * 3 + b.r - (a.w * 3 + a.r))
            .slice(0, 8),
          models: Array.from(modelMap.entries()).map(([name, count]) => ({ name, count })),
          phaseMix: { think: thinkPct, act: actPct, out: outPct, wait: waitPct },
          startedAt: monitorStartedAt,
        }
        for (const entry of records.values()) {
          if (entry.error && !entry.errorLogged) {
            entry.errorLogged = true
            noteLog('err', entry.error)
          }
        }
        dirty = false
      }

      function attach(id, row) {
        const tagIndex = nextTag++
        const rec = {
          id,
          row,
          tag: '#' + pad2(tagIndex),
          color: AGENT_COLORS[(tagIndex - 1) % AGENT_COLORS.length],
          fold: newFold(),
          ref: null,
          unsub: null,
          bound: false,
          error: '',
          errorLogged: false,
          attachedAt: Date.now(),
          idleSince: 0,
          tpsHistory: [],
          lastTpsAt: 0,
        }
        records.set(id, rec)
        let retained
        try {
          retained = ctx.sessions.retain(id, { source: 'watchtower' })
        } catch (err) {
          rec.error = 'retain failed: ' + errorText(err)
          rebuild()
          return
        }
        rec.ref = retained
        const ready = retained && retained.ready && typeof retained.ready.then === 'function' ? retained.ready : Promise.resolve(retained && retained.binding)
        ready
          .then((binding) => {
            if (disposed || records.get(id) !== rec) return
            const eventSource = binding && binding.eventSource
            if (!eventSource || typeof eventSource.subscribe !== 'function') {
              rec.error = 'event source unavailable'
              rebuild()
              return
            }
            rec.bound = true
            let lastRevision = -1
            const onChange = () => {
              let window
              try {
                window = eventSource.getSnapshot()
              } catch (err) {
                return
              }
              if (!window) return
              if (window.revision === lastRevision) return
              lastRevision = window.revision
              try {
                // The first publication may already be a delta, so the whole visible
                // window is replayed once to pick up its turn/step/model baseline.
                if (!rec.folded) {
                  rec.folded = true
                  resetFold(rec.fold)
                  const entries = window.entries || []
                  for (let index = 0; index < entries.length; index++) applyEntry(rec.fold, entries[index])
                } else {
                  foldWindow(rec.fold, window)
                }
              } catch (err) {
                console.error('[watchtower] fold failed', err)
              }
              rebuild()
            }
            rec.unsub = eventSource.subscribe(onChange)
            onChange()
            noteLog('unit', 'unit online · ' + ((row && row.displayTitle) || id))
            rebuild()
          })
          .catch((err) => {
            if (records.get(id) !== rec) return
            rec.error = 'open failed: ' + errorText(err)
            rebuild()
          })
      }

      function detach(id) {
        const rec = records.get(id)
        if (!rec) return
        records.delete(id)
        deskSlots.delete(id)
        try {
          if (rec.unsub) rec.unsub()
        } catch (err) {
          /* ignore */
        }
        try {
          if (rec.ref && typeof rec.ref.release === 'function') rec.ref.release()
        } catch (err) {
          /* ignore */
        }
        noteLog('unit', 'unit offline · ' + ((rec.row && rec.row.displayTitle) || id))
        rebuild()
      }

      function expireIdle() {
        const now = Date.now()
        const expired = []
        for (const [id, rec] of records) {
          if (rec.idleSince && now - rec.idleSince > IDLE_HOLD_MS) expired.push(id)
        }
        for (const id of expired) detach(id)
        return expired.length > 0
      }

      function sync() {
        if (disposed) return
        let list
        try {
          list = listSource.getSnapshot()
        } catch (err) {
          return
        }
        if (!list || !Array.isArray(list.ids) || !list.byId) return
        listSnapshot = list
        const wanted = new Set()
        for (const id of list.ids) {
          const row = list.byId[id]
          if (!row || !row.running) continue
          wanted.add(id)
          if (!records.has(id)) attach(id, row)
          else {
            const rec = records.get(id)
            rec.row = row
            rec.idleSince = 0
          }
        }
        for (const [id, rec] of Array.from(records.entries())) {
          if (wanted.has(id)) continue
          const row = list.byId[id]
          // the Session itself may be gone (archived/deleted): release it at once
          if (!row) {
            detach(id)
            continue
          }
          rec.row = row
          if (!rec.idleSince) rec.idleSince = Date.now()
        }
        expireIdle()
        rebuild()
      }

      function ensureList() {
        if (listSource) return true
        try {
          const sessions = ctx.sessions
          const candidate = sessions && sessions.list
          if (candidate && typeof candidate.getSnapshot === 'function' && typeof candidate.subscribe === 'function') {
            listSource = candidate
            unsubscribeList = candidate.subscribe(sync)
            noteLog('sys', 'session rails connected')
            sync()
            return true
          }
        } catch (err) {
          /* retry */
        }
        return false
      }

      function subscribeStatus() {
        try {
          const uiSession = ctx.get ? ctx.get('uiSession') : undefined
          const source = uiSession && uiSession.sessionStatus
          if (source && typeof source.subscribe === 'function') {
            const update = () => {
              const snapshot = source.getSnapshot()
              pendingStatus.clear()
              if (snapshot && typeof snapshot.forEach === 'function') {
                snapshot.forEach((value, key) => pendingStatus.set(key, value))
              }
              rebuild()
            }
            unsubscribeStatus = source.subscribe(update)
            update()
          }
        } catch (err) {
          /* optional fact source */
        }
      }

      function ensureStatus() {
        if (unsubscribeStatus) return true
        statusTries += 1
        subscribeStatus()
        return Boolean(unsubscribeStatus)
      }

      ensureList()
      ensureStatus()

      return {
        getSnapshot() {
          expireIdle()
          if (dirty) {
            rebuild()
            // The caller already saw this revision; an idle flush must not publish it again.
            lastNotifiedRev = view.rev
          }
          return view
        },
        subscribe(listener) {
          listeners.add(listener)
          dirty = true
          return () => listeners.delete(listener)
        },
        flush() {
          ensureList()
          ensureStatus()
          const hasAgents = records.size > 0
          // A revision nobody saw (unit came or went) must still publish once, even
          // when it was the last unit: otherwise the panel freezes on a stale frame.
          if (!dirty && !hasAgents && view.rev === lastNotifiedRev) return
          if (!dirty && listeners.size === 0) return
          rebuild()
          lastNotifiedRev = view.rev
          for (const listener of Array.from(listeners)) {
            try {
              listener()
            } catch (err) {
              console.error('[watchtower] subscriber failed', err)
            }
          }
          // Units keep decaying (tokens/s, idle drift), so the next tick rebuilds again.
          dirty = hasAgents
        },
        noteLog,
        dispose() {
          disposed = true
          try {
            if (unsubscribeList) unsubscribeList()
          } catch (err) {
            /* ignore */
          }
          try {
            if (unsubscribeStatus) unsubscribeStatus()
          } catch (err) {
            /* ignore */
          }
          for (const id of Array.from(records.keys())) detach(id)
          listeners.clear()
        },
      }
    }
    //#endregion

    //#region styles
    const CSS = `
/* IBM 5153 CGA palette (16 colors, sampled from the reference swatch):
   0 #000000  1 #aa0000  2 #00aa00  3 #c47e00  4 #0000aa  5 #aa00aa  6 #00aaaa  7 #aaaaaa
   8 #555555  9 #ff5555 10 #55ff55 11 #ffff55 12 #5555ff 13 #ff55ff 14 #55ffff 15 #ffffff */
.nxt-root{
  --nxt-cy:#55ffff; --nxt-cy2:#00aaaa; --nxt-mg:#ff55ff; --nxt-mg2:#aa00aa;
  --nxt-am:#ffff55; --nxt-am2:#c47e00; --nxt-gr:#55ff55; --nxt-gr2:#00aa00;
  --nxt-rd:#ff5555; --nxt-rd2:#aa0000; --nxt-bl:#5555ff;
  --nxt-frame:#ffff55;
  --nxt-ink:#aaaaaa; --nxt-ink2:#ffffff; --nxt-dim:#aaaaaa; --nxt-mute:#555555;
  --nxt-line:rgba(255,255,85,0.18);
  position:relative; height:100%; width:100%; min-height:0; overflow:hidden; box-sizing:border-box;
  background:
    radial-gradient(120% 80% at 50% -10%, rgba(85,255,255,0.1), transparent 60%),
    radial-gradient(90% 60% at 100% 110%, rgba(255,85,255,0.08), transparent 60%),
    #000000;
  color:var(--nxt-ink);
  font-family:"JetBrains Mono","Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",ui-monospace,monospace;
  font-size:12px; line-height:1.45; letter-spacing:.02em;
  -webkit-font-smoothing:antialiased;
}
.nxt-root *{box-sizing:border-box; min-width:0}
.nxt-root::before{
  content:""; position:absolute; inset:0; pointer-events:none; z-index:0;
  background-image:radial-gradient(rgba(85,255,255,0.16) 1px, transparent 1px);
  background-size:26px 26px; opacity:.28;
}
.nxt-hud{position:relative; z-index:1; height:100%; display:grid; grid-template-rows:auto minmax(0,1fr) auto;}
.nxt-top{
  display:flex; align-items:center; gap:16px; padding:8px 14px; flex-wrap:wrap;
  padding-top:calc(8px + var(--dsh-frame-top-clearance, 0px));
  border-bottom:1px solid var(--nxt-line);
  background:linear-gradient(180deg, rgba(10,10,10,0.92), rgba(0,0,0,0.86));
}
.nxt-brand{display:flex; align-items:center; gap:9px; min-width:0}
.nxt-hex{width:14px; height:14px; flex:none; background:linear-gradient(135deg,var(--nxt-cy),var(--nxt-mg));
  clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); box-shadow:0 0 10px rgba(85,255,255,0.8);}
.nxt-title{font-size:13px; font-weight:600; letter-spacing:.30em; text-transform:uppercase;
  background:linear-gradient(90deg,#55ffff,#55ffff 40%,#ff55ff); -webkit-background-clip:text; background-clip:text; color:transparent;
  animation:nxt-glitch 9s steps(1,end) infinite;}
.nxt-sub{font-size:9px; letter-spacing:.22em; color:var(--nxt-dim); white-space:nowrap}
.nxt-chips{display:flex; align-items:center; gap:6px; flex:1; flex-wrap:wrap; justify-content:center}
.nxt-chip{display:inline-flex; align-items:center; gap:5px; padding:2px 8px; font-size:9px; letter-spacing:.16em;
  color:var(--nxt-dim); border:0; background:rgba(16,16,12,0.72); text-transform:uppercase; white-space:nowrap}
.nxt-chip b{color:var(--nxt-ink2); font-weight:600; font-variant-numeric:tabular-nums}
.nxt-chip i{font-style:normal; color:var(--nxt-dim); font-size:8px}
.nxt-chip.nxt-live{color:var(--nxt-frame)}
.nxt-dot{width:6px; height:6px; border-radius:50%; background:var(--nxt-cy); box-shadow:0 0 8px var(--nxt-cy); animation:nxt-pulse 1.6s ease-in-out infinite}
.nxt-chip.nxt-bad{color:var(--nxt-rd)}
.nxt-chip.nxt-bad b{color:var(--nxt-rd)}
.nxt-clock{display:flex; align-items:baseline; gap:6px; margin-left:auto; color:var(--nxt-ink); font-variant-numeric:tabular-nums; letter-spacing:.14em}
.nxt-clock #nxt-c-localtime{font-size:15px; color:#ffffff}
.nxt-clock em{font-style:normal; font-size:8px; letter-spacing:.2em; color:var(--nxt-dim)}
.nxt-back{flex:none; width:24px; height:24px; display:grid; place-items:center; padding:0; cursor:pointer; border-radius:0;
  border:1px solid rgba(255,85,255,0.5); background:rgba(10,10,10,0.8); color:#ff55ff; font:600 14px/1 "JetBrains Mono",Consolas,monospace}
.nxt-back:hover{background:rgba(255,85,255,0.16); color:#ffffff}

.nxt-body{display:grid; gap:9px; padding:9px 11px; min-height:0;
  grid-template-columns:minmax(268px, 25%) minmax(0,1fr) minmax(218px, 19%);}
.nxt-panel{position:relative; min-height:0; min-width:0; display:flex; flex-direction:column;
  border:1px solid var(--nxt-line);
  background:linear-gradient(180deg, rgba(10,10,10,0.82), rgba(0,0,0,0.88));
  box-shadow:inset 0 0 34px rgba(85,255,255,0.045);}
.nxt-phead{display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 9px 5px;
  border-bottom:1px solid rgba(255,255,85,0.08); font-size:9px; letter-spacing:.22em; color:var(--nxt-cy); text-transform:uppercase}
.nxt-phead>span:first-child{flex:none}
.nxt-phint{color:var(--nxt-dim); letter-spacing:.16em; font-size:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; text-align:right}

.nxt-wall{overflow:auto; padding:8px; display:flex; flex-direction:column; gap:8px; min-height:0; flex:1 1 auto; scrollbar-width:thin}
.nxt-wall::-webkit-scrollbar{width:6px}
.nxt-wall::-webkit-scrollbar-thumb{background:rgba(85,255,255,0.25)}
.nxt-card{position:relative; border:0; border-left:2px solid rgba(255,255,255,0.14); background:linear-gradient(180deg, rgba(10,10,10,0.94), rgba(0,0,0,0.94));
  padding:7px 8px 6px; cursor:pointer; transition:border-color .18s, transform .18s, box-shadow .18s; border-left-width:2px;
  display:flex; flex-direction:column; flex:1 1 auto; min-height:158px; overflow:hidden}
.nxt-card:hover{border-left-color:var(--nxt-frame); background:rgba(16,17,20,0.98)}
.nxt-card[data-state="run"]{border-left-color:var(--nxt-cy); box-shadow:inset 2px 0 12px -6px var(--nxt-cy)}
.nxt-card[data-state="wait"]{border-left-color:var(--nxt-am)}
.nxt-card[data-state="err"]{border-left-color:var(--nxt-rd); animation:nxt-alarm 2.2s ease-in-out infinite}
.nxt-card[data-state="sync"]{border-left-color:var(--nxt-dim)}
.nxt-card[data-focused="1"]{border-left-color:var(--nxt-mg); box-shadow:0 0 22px rgba(255,85,255,0.18)}
.nxt-chead{display:flex; align-items:center; gap:7px; min-width:0; flex:none}
.nxt-cidx{font-size:9px; color:var(--nxt-mg); letter-spacing:.1em; flex:none}
.nxt-cname{font-size:12px; font-weight:600; color:#ffffff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-cstate{font-size:8px; letter-spacing:.18em; padding:1px 5px; border:0; flex:none}
.nxt-card-open{flex:none; min-width:20px; min-height:18px; padding:1px 4px; cursor:pointer; border-radius:0;
  font:600 10px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; color:var(--nxt-cy);
  background:rgba(85,255,255,0.08); border:1px solid rgba(85,255,255,0.4)}
.nxt-card-open:hover{color:#000000; background:var(--nxt-cy); border-color:var(--nxt-cy)}
.nxt-card-open:focus-visible{outline:1px solid var(--nxt-am); outline-offset:1px}
.nxt-card[data-state="run"] .nxt-cstate{color:var(--nxt-cy)}
.nxt-card[data-state="wait"] .nxt-cstate{color:var(--nxt-am)}
.nxt-card[data-state="err"] .nxt-cstate{color:var(--nxt-rd)}
.nxt-card[data-state="sync"] .nxt-cstate{color:var(--nxt-dim)}
.nxt-cmeta{display:flex; align-items:center; gap:8px; margin-top:4px; font-size:8px; color:var(--nxt-dim);
  white-space:nowrap; overflow:hidden; font-variant-numeric:tabular-nums; flex:none}
.nxt-cmeta .nxt-grow{flex:1; overflow:hidden; text-overflow:ellipsis}
.nxt-live-dots{display:inline-flex; gap:2px; margin-left:4px; vertical-align:middle}
.nxt-live-dots i{width:3px; height:3px; background:currentColor; display:block; animation:nxt-dot 1.1s infinite ease-in-out}
.nxt-live-dots i:nth-child(2){animation-delay:.15s}
.nxt-live-dots i:nth-child(3){animation-delay:.3s}
.nxt-cspark{display:flex; align-items:center; gap:5px; margin-top:3px; height:18px; flex:none; overflow:hidden}
.nxt-cspark-num{font-size:18px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums}
.nxt-cspark-unit{font-size:8px; color:#555555; letter-spacing:.1em; flex:none}
.nxt-cspark-delta{font-size:8px; flex:none; letter-spacing:.04em}
.nxt-cspark-delta[data-dir="up"]{color:#55ff55}
.nxt-cspark-delta[data-dir="down"]{color:#ff5555}
.nxt-cspark-graph{flex:1; height:18px; min-width:40px; overflow:hidden}
.nxt-spark-svg{display:block; width:100%; height:100%}
.nxt-bar{display:inline-block; width:46px; height:4px; background:rgba(85,255,255,0.14); position:relative; overflow:hidden; vertical-align:middle}
.nxt-bar>i{display:block; height:100%; background:linear-gradient(90deg,var(--nxt-cy),var(--nxt-mg)); box-shadow:0 0 6px rgba(85,255,255,0.6)}
.nxt-sec{margin-top:5px; padding-top:4px;
  display:flex; flex-direction:column; flex:1 1 0; min-height:0}
.nxt-lbl{display:block; font-size:7px; letter-spacing:.26em; color:#55ffff; margin-bottom:2px; flex:none}
.nxt-stream{flex:1 1 0; min-height:0; max-height:none; overflow:hidden; font-size:10.5px; line-height:1.5; word-break:break-word;
  display:flex; flex-direction:column; justify-content:flex-end;
  -webkit-mask-image:linear-gradient(180deg, transparent 0, #000 12%, #000 100%); mask-image:linear-gradient(180deg, transparent 0, #000 12%, #000 100%)}
.nxt-stream>span{display:block; min-height:0}
.nxt-think{color:#55ffff; opacity:.92; font-style:italic}
.nxt-out{color:#ffffff}
.nxt-dim{color:#555555; font-style:normal}
.nxt-act{display:flex; flex-direction:column; justify-content:flex-end; gap:1px; flex:1 1 0; min-height:0; max-height:none; overflow:hidden}
.nxt-tool{display:flex; align-items:baseline; gap:5px; font-size:10px; white-space:nowrap; overflow:hidden}
.nxt-tool .nxt-ti{flex:none; width:9px; text-align:center}
.nxt-tool[data-s="run"] .nxt-ti{color:var(--nxt-cy); animation:nxt-blink 1.1s steps(2,end) infinite}
.nxt-tool[data-s="ok"] .nxt-ti{color:var(--nxt-gr)}
.nxt-tool[data-s="err"] .nxt-ti{color:var(--nxt-rd)}
.nxt-tool .nxt-tn{color:#ffff55; flex:none; max-width:42%; overflow:hidden; text-overflow:ellipsis}
.nxt-tool .nxt-ta{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-tool .nxt-tm{color:#555555; flex:none; font-size:9px}
.nxt-cfoot{display:flex; gap:8px; margin-top:5px; padding-top:4px;
  font-size:7.5px; color:#555555; letter-spacing:.1em; font-variant-numeric:tabular-nums; flex:none}
.nxt-standby{display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; padding:26px 10px; text-align:center}
.nxt-standby b{font-size:11px; letter-spacing:.28em; color:var(--nxt-dim)}
.nxt-standby span{font-size:10px; color:#555555; line-height:1.6}

.nxt-stage{position:relative; flex:1; min-height:0}
.nxt-stage canvas{display:block; width:100%; height:100%}
.nxt-legend{display:none}
.nxt-stage-tag{position:absolute; left:50%; top:10px; transform:translateX(-50%); pointer-events:none; font-size:8px; letter-spacing:.2em; color:#555555; white-space:nowrap}
.nxt-standby-tray{position:absolute; right:10px; top:34px; z-index:7; display:flex; flex-direction:column; gap:4px; max-width:220px}
.nxt-standby-tray[hidden]{display:none}
.nxt-standby-h{font-size:8px; letter-spacing:.2em; color:#ffff55; text-align:right; padding-right:2px}
.nxt-stby-row{display:flex; align-items:center; gap:6px; min-width:0; padding:3px 7px; cursor:pointer; border-radius:0;
  border:1px solid rgba(255,255,255,0.16); background:rgba(10,10,10,0.86); color:#aaaaaa; text-align:left;
  font:600 8px/1.2 "JetBrains Mono", ui-monospace, monospace; letter-spacing:.12em}
.nxt-stby-row:hover{border-color:var(--nxt-frame); color:#ffffff}
.nxt-stby-row b{color:var(--nxt-frame); flex:none}
.nxt-stby-row i{font-style:normal; flex:none}
.nxt-stby-row span{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* readouts: one horizontal row pinned to the bottom of the stage */
.nxt-stage-hud{position:absolute; left:10px; right:10px; bottom:10px; height:clamp(150px, 30%, 250px);
  display:flex; flex-direction:row; gap:8px; pointer-events:none; z-index:4}
.nxt-analyze-on .nxt-stage-hud{display:none}
.nxt-net-on .nxt-stage-hud{display:none}
.nxt-hud-off .nxt-stage-hud{display:none}
.nxt-shud{position:relative; flex:1 1 0; min-width:0; min-height:0; overflow:hidden; padding:6px 8px;
  background:rgba(0,0,0,0.78); border:0;
  font-size:9px; color:#aaaaaa; font-variant-numeric:tabular-nums; line-height:1.45}
.nxt-shud-h{display:flex; justify-content:space-between; gap:10px; font-size:8px; letter-spacing:.2em; color:#55ffff; margin-bottom:4px}
.nxt-shud-spark{margin-top:6px; height:34px; overflow:hidden}
.nxt-shud-spark svg{width:100%; height:34px; display:block}
.nxt-shud-grid{display:grid; grid-template-columns:1fr 1fr; gap:1px 14px}
.nxt-shud-kv{display:flex; justify-content:space-between; gap:8px; white-space:nowrap}
.nxt-shud-kv span{color:#00aaaa}
.nxt-shud-kv b{color:#ffffff; font-weight:600}
.nxt-shud-row{display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; margin-top:2px}
.nxt-shud-row .nxt-shud-tag{color:#ff55ff; flex:none}
.nxt-shud-row .nxt-shud-state{flex:none; font-size:8px; letter-spacing:.1em}
.nxt-shud-row .nxt-shud-name{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-shud-row .nxt-shud-num{color:#ffffff; flex:none}
.nxt-shud-bar{width:30px; height:3px; background:rgba(85,255,255,0.16); flex:none; overflow:hidden}
.nxt-shud-bar>i{display:block; height:100%; background:#55ffff}
.nxt-shud-line{display:flex; gap:6px; white-space:nowrap; overflow:hidden; margin-top:2px}
.nxt-shud-line .t{color:#555555; flex:none}
.nxt-shud-line .nm{color:#ffff55; flex:none; max-width:46%; overflow:hidden; text-overflow:ellipsis}
.nxt-shud-line .ms{color:#555555; flex:none; margin-left:auto}
.nxt-shud-legend{display:flex; gap:8px; margin-top:5px; font-size:7px; letter-spacing:.1em; color:#555555}
.nxt-shud-legend i{display:inline-block; width:5px; height:5px; margin-right:3px}

.nxt-rail{overflow:auto; padding:8px 9px; display:flex; flex-direction:column; justify-content:space-between; gap:9px; min-height:0; flex:1 1 auto; scrollbar-width:thin}
.nxt-rail::-webkit-scrollbar{width:6px}
.nxt-rail::-webkit-scrollbar-thumb{background:rgba(85,255,255,0.25)}
.nxt-block{display:flex; flex-direction:column; gap:4px}
.nxt-bh{display:flex; align-items:center; justify-content:space-between; font-size:8px; letter-spacing:.22em; color:#55ffff;
  border-bottom:1px solid rgba(85,255,255,0.1); padding-bottom:3px}
.nxt-kv{display:flex; align-items:baseline; justify-content:space-between; gap:8px; font-size:10px; font-variant-numeric:tabular-nums}
.nxt-kv span{color:var(--nxt-dim); font-size:9px; letter-spacing:.12em}
.nxt-kv b{color:#ffffff; font-weight:600}
.nxt-kv b.hot{color:var(--nxt-mg)}
.nxt-load{display:flex; align-items:center; gap:6px; font-size:9px; color:#aaaaaa; font-variant-numeric:tabular-nums}
.nxt-load .nxt-lname{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aaaaaa}
.nxt-load .nxt-bar{width:40px}
.nxt-load>span:not(.nxt-lname){color:#aaaaaa; font-size:8px; flex:none; font-variant-numeric:tabular-nums}
.nxt-log{display:flex; flex-direction:column; gap:2px; font-size:9px; line-height:1.5; max-height:150px; overflow:hidden}
.nxt-log-line{display:flex; gap:5px; white-space:nowrap}
.nxt-log-line .nxt-lt{color:#555555; flex:none; font-variant-numeric:tabular-nums}
.nxt-log-line .nxt-lk{flex:none; width:34px; color:#55ffff; letter-spacing:.1em}
.nxt-log-line .nxt-lm{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis}
.nxt-log-line[data-k="err"] .nxt-lk, .nxt-log-line[data-k="err"] .nxt-lm{color:var(--nxt-rd)}
.nxt-log-line[data-k="unit"] .nxt-lk{color:var(--nxt-mg)}
.nxt-log-line[data-k="sys"] .nxt-lk{color:var(--nxt-gr)}
.nxt-alerts{display:flex; flex-direction:column; gap:3px}
.nxt-alert{font-size:9px; color:var(--nxt-rd); border-left:2px solid var(--nxt-rd); padding:2px 6px; background:rgba(255,85,85,0.08);
  animation:nxt-blink 1.6s steps(2,end) infinite; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* right-rail dense widgets */
.nxt-rail-spark{width:100%; height:30px; display:block; flex:none}
.nxt-rail-spark polyline{fill:none; stroke:#55ffff; stroke-width:1.5}
.nxt-rail-spark .nxt-rail-fill{fill:rgba(85,255,255,0.14); stroke:none}
.nxt-unit-row{display:flex; align-items:center; gap:6px; font-size:9px; white-space:nowrap; overflow:hidden; margin-top:2px}
.nxt-unit-row .nxt-ut{color:#ff55ff; flex:none}
.nxt-unit-row .nxt-us{flex:none; width:28px; font-size:8px; letter-spacing:.08em}
.nxt-unit-row .nxt-un{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-unit-row .nxt-uv{color:#ffffff; flex:none; font-variant-numeric:tabular-nums}
.nxt-unit-viz{width:46px; height:12px; flex:none; overflow:hidden; opacity:.9}
.nxt-mini{display:flex; align-items:center; gap:6px; font-size:9px; white-space:nowrap; margin-top:2px}
.nxt-mini .nxt-mn{color:#aaaaaa; flex:none; width:58px; overflow:hidden; text-overflow:ellipsis}
.nxt-mini .nxt-mbar{flex:1; height:3px; background:rgba(85,255,255,0.14); overflow:hidden}
.nxt-mini .nxt-mbar>i{display:block; height:100%; background:#55ffff}
.nxt-mini .nxt-mbar>i.err{background:#ff5555}
.nxt-mini .nxt-mv{color:#ffffff; flex:none; width:30px; text-align:right; font-variant-numeric:tabular-nums}
.nxt-phase{display:flex; height:6px; margin-top:4px; overflow:hidden; background:rgba(85,255,255,0.08)}
.nxt-phase>i{display:block; height:100%}
.nxt-phase-legend{display:flex; justify-content:space-between; margin-top:3px; font-size:7px; color:#555555; letter-spacing:.06em}
.nxt-phase-legend span i{display:inline-block; width:5px; height:5px; margin-right:3px}
.nxt-sys{display:flex; justify-content:space-between; gap:8px; font-size:8px; color:#555555; letter-spacing:.06em; margin-top:2px}
.nxt-sys b{color:#aaaaaa; font-weight:500}
.nxt-code{display:flex; flex-direction:column; gap:1px; font-size:8.5px; line-height:1.55; font-variant-numeric:tabular-nums}
.nxt-code-line{display:flex; align-items:baseline; gap:6px; white-space:nowrap; overflow:hidden}
.nxt-code-line .k{color:#00aaaa; flex:none}
.nxt-code-line .v{color:#ffffff; font-weight:600; flex:none}
.nxt-code-line .c{margin-left:auto; color:#555555; font-style:normal; font-size:7px; flex:none}
.nxt-chipsinline{display:flex; gap:4px; margin-top:6px; flex-wrap:wrap}
.nxt-chipsinline b{font-weight:600; font-size:7px; letter-spacing:.12em; color:var(--nxt-frame); padding:1px 4px; white-space:nowrap; background:rgba(255,255,85,0.08)}
.nxt-chip .nxt-bar-wide{width:54px; height:5px; vertical-align:middle;
  background:repeating-linear-gradient(45deg, rgba(85,85,85,0.55) 0 2px, rgba(0,0,0,0.25) 2px 4px)}
.nxt-leader{display:flex; align-items:baseline; gap:6px; flex:1; min-width:0; overflow:hidden}
.nxt-leader>span{flex:none; color:#555555; font-size:7px; letter-spacing:.16em}
.nxt-leader>i{flex:1; min-width:8px; border-bottom:1px dotted rgba(255,255,85,0.26); transform:translateY(-2px)}
.nxt-leader>b{flex:none; max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aaaaaa; font-weight:500}

.nxt-ticker{display:flex; align-items:center; gap:14px; padding:4px 12px; border-top:1px solid var(--nxt-line);
  font-size:9px; color:#aaaaaa; letter-spacing:.08em; overflow:hidden; white-space:nowrap; background:rgba(0,0,0,0.9)}
.nxt-ticker .nxt-tk{flex:none; color:var(--nxt-cy); letter-spacing:.22em; font-size:8px}
.nxt-ticker .nxt-tv{overflow:hidden; text-overflow:ellipsis}
.nxt-ticker .nxt-ts{margin-left:auto; color:#555555; font-variant-numeric:tabular-nums; flex:none}

.nxt-vig{position:absolute; inset:0; pointer-events:none; z-index:6}
.nxt-vig{background:radial-gradient(125% 95% at 50% 42%, transparent 44%, rgba(0,0,0,.6) 100%)}

@keyframes nxt-pulse{0%,100%{opacity:1; transform:scale(1)}50%{opacity:.35; transform:scale(.72)}}
@keyframes nxt-dot{0%,80%,100%{opacity:.2; transform:translateY(0)}40%{opacity:1; transform:translateY(-1px)}}
@keyframes nxt-blink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes nxt-alarm{0%,100%{box-shadow:inset 2px 0 12px -6px var(--nxt-rd)}50%{box-shadow:inset 2px 0 22px -4px rgba(255,85,85,0.9)}}
@keyframes nxt-glitch{
  0%,88%,100%{transform:none; text-shadow:none}
  89%{transform:translateX(1px); text-shadow:1px 0 var(--nxt-mg), -1px 0 var(--nxt-cy)}
  91%{transform:translateX(-1px); text-shadow:-1px 0 var(--nxt-mg), 1px 0 var(--nxt-cy)}
  93%{transform:none; text-shadow:none}
}
@media (prefers-reduced-motion: reduce){
  .nxt-root .nxt-title,.nxt-root .nxt-dot,.nxt-root .nxt-alert,.nxt-root .nxt-card[data-state="err"]{animation:none}
}
.nxt-modes{display:flex; gap:4px; margin-left:8px; flex:none}
.nxt-mode{font:600 8px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.14em; padding:3px 6px; cursor:pointer;
  border:1px solid rgba(255,255,85,0.22); background:rgba(10,10,10,0.7); color:#aaaaaa; border-radius:0; text-transform:uppercase}
.nxt-mode:hover{color:var(--nxt-frame); border-color:rgba(255,255,85,0.5)}
.nxt-mode[data-active="1"]{color:#000000; background:#ffff55; border-color:#ffff55; box-shadow:none}
.nxt-cinema .nxt-wallpanel,.nxt-cinema .nxt-railpanel{display:none}
.nxt-cinema .nxt-body{grid-template-columns:minmax(0,1fr)}

.nxt-analyze{display:none; position:absolute; inset:0; padding:8px; gap:8px;
  grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr))}
.nxt-analyze-close{position:absolute; top:8px; right:8px; z-index:6; min-width:84px; min-height:24px; padding:6px 10px; cursor:pointer;
  font:600 8px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.12em; text-transform:uppercase;
  color:#000000; background:#ffff55; border:1px solid #ffff55; border-radius:0}
.nxt-analyze-close:focus-visible{outline:1px solid #ffffff; outline-offset:1px}
.nxt-analyze-close:hover{background:#ffffff; border-color:#ffffff}
.nxt-stage.nxt-analyze-on .nxt-analyze{display:grid}
.nxt-stage.nxt-analyze-on canvas{display:none}
.nxt-stage.nxt-analyze-on .nxt-legend{display:none}
.nxt-stage.nxt-analyze-on .nxt-stage-tag{display:none}
.nxt-stage.nxt-analyze-on .nxt-standby-tray{display:none}
.nxt-stage.nxt-net-on .nxt-legend{display:none}
.nxt-focus-on .nxt-wallpanel,.nxt-focus-on .nxt-railpanel{display:none}
.nxt-focus-on .nxt-body{grid-template-columns:minmax(0,1fr)}
.nxt-aw{position:relative; display:flex; flex-direction:column; gap:4px; min-height:0; min-width:0; overflow:hidden;
  border:0; background:linear-gradient(180deg, rgba(10,10,10,0.78), rgba(0,0,0,0.82)); padding:6px 7px}
.nxt-aw-h{display:flex; align-items:center; justify-content:space-between; font-size:8px; letter-spacing:.2em; color:#55ffff; text-transform:uppercase; flex:none}
.nxt-aw-h b{color:var(--nxt-cy); font-weight:600; letter-spacing:.08em}
.nxt-aw-body{flex:1; min-height:0; display:flex; flex-direction:column; gap:3px; overflow:hidden; justify-content:center}
.nxt-ring{width:100%; height:100%; max-height:112px; display:block}
.nxt-ring-bg{fill:none; stroke:rgba(85,255,255,0.14); stroke-width:7}
.nxt-ring-fg{fill:none; stroke:var(--nxt-cy); stroke-width:7; stroke-linecap:round; transform:rotate(-90deg); transform-origin:50% 50%;
  filter:drop-shadow(0 0 5px rgba(85,255,255,0.75))}
.nxt-ring-fg-hot{stroke:var(--nxt-mg); filter:drop-shadow(0 0 5px rgba(255,85,255,0.75))}
.nxt-ring-num{fill:#ffffff; font:600 19px "JetBrains Mono",Consolas,monospace; text-anchor:middle}
.nxt-ring-sub{fill:#55ffff; font:8px "JetBrains Mono",Consolas,monospace; text-anchor:middle; letter-spacing:.08em}
.nxt-kvrow{display:flex; justify-content:space-between; gap:6px; font-size:9px; color:#aaaaaa; font-variant-numeric:tabular-nums; flex:none}
.nxt-kvrow span{color:#55ffff; letter-spacing:.12em; font-size:8px}
.nxt-kvrow b{color:#aaaaaa; font-weight:600}
.nxt-heat{display:grid; grid-template-columns:56px repeat(12,minmax(0,1fr)); gap:2px; align-items:center; flex:1; min-height:0; align-content:center}
.nxt-heat-name{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:8px}
.nxt-heat-cell{height:11px; background:var(--nxt-cy); border-radius:0; display:block}
.nxt-lanes{display:flex; flex-direction:column; gap:4px; justify-content:center; flex:1; min-height:0}
.nxt-lane{display:flex; align-items:center; gap:5px; height:15px}
.nxt-lane-name{width:34px; flex:none; font-size:7px; letter-spacing:.1em; color:#55ffff}
.nxt-lane-track{position:relative; flex:1; height:9px; background:rgba(85,255,255,0.07); border-radius:0; overflow:hidden}
.nxt-lane-seg{position:absolute; top:0; bottom:0; border-radius:0; opacity:.85}
.nxt-files{display:flex; flex-direction:column; gap:3px; flex:1; min-height:0; overflow:hidden; justify-content:center}
.nxt-file{display:flex; align-items:center; gap:6px; font-size:9px; color:#aaaaaa; white-space:nowrap}
.nxt-file .nxt-fpath{flex:1; overflow:hidden; text-overflow:ellipsis; color:#aaaaaa}
.nxt-file .nxt-fbar{width:48px; height:4px; background:rgba(255,85,255,0.16); flex:none; overflow:hidden}
.nxt-file .nxt-fbar>i{display:block; height:100%; background:linear-gradient(90deg,var(--nxt-mg),var(--nxt-am)); box-shadow:0 0 6px rgba(255,85,255,0.6)}
.nxt-file .nxt-frw{width:38px; text-align:right; font-size:8px; color:#555555; flex:none}
.nxt-spark{width:100%; flex:1; min-height:48px; display:block}
.nxt-spark polyline{fill:none; stroke:var(--nxt-cy); stroke-width:1.6; filter:drop-shadow(0 0 4px rgba(85,255,255,0.8))}
.nxt-spark .nxt-spark-fill{fill:rgba(85,255,255,0.16); stroke:none}
.nxt-todo{display:flex; align-items:center; gap:5px; font-size:9px; color:#aaaaaa; white-space:nowrap; overflow:hidden; flex:none}
.nxt-todo i{flex:none; font-style:normal; width:9px; text-align:center}
.nxt-todo[data-done="1"]{color:#555555; text-decoration:line-through}
.nxt-todo[data-done="1"] i{color:var(--nxt-gr)}
.nxt-todo[data-done="0"] i{color:#55ffff}

@media (max-width: 1180px){
  .nxt-body{grid-template-columns:minmax(240px,30%) minmax(0,1fr); }
  .nxt-railpanel{display:none}
}
@media (max-width: 820px){
  .nxt-body{grid-template-columns:minmax(0,1fr)}
  .nxt-wallpanel{display:none}
}
/* Host theme follower: the HUD artwork is authored for a black canvas, so the
   light scheme is the same artwork inverted with its hue axis rotated back —
   every CSS/Canvas colour follows the Host without a second palette. Canvas
   sprites are counter-filtered in drawAgentGirl to keep their own colours. */
.nxt-root.nxt-light{filter:invert(1) hue-rotate(180deg); color-scheme:light}
`

    const SHELL = `
<div class="nxt-hud">
  <div class="nxt-top">
    <div class="nxt-brand">
      <span class="nxt-hex"></span>
      <span class="nxt-title">WATCHTOWER</span>
      <span class="nxt-sub">NX-07 // AGENT TELEMETRY</span>
    </div>
    <div class="nxt-chips">
      <span class="nxt-chip nxt-live"><i class="nxt-dot"></i>LIVE</span>
      <span class="nxt-chip">AGENTS <b id="nxt-c-count">0</b></span>
      <span class="nxt-chip" title="EST: chars of reasoning + output in the last 3s / 3s / 3.5; not a model token count">THRUPUT <b id="nxt-c-tps">0.0</b><i>est t/s</i></span>
      <span class="nxt-chip">CTX <i class="nxt-bar nxt-bar-wide"><i id="nxt-c-ctxbar" style="width:0%"></i></i><b id="nxt-c-ctx">—</b></span>
      <span class="nxt-chip">PLAN <i class="nxt-bar nxt-bar-wide"><i id="nxt-c-planbar" style="width:0%"></i></i><b id="nxt-c-plan">—</b></span>
      <span class="nxt-chip" id="nxt-c-alertchip">ALERTS <b id="nxt-c-alerts">0</b></span>
      <span class="nxt-chip">TOOLS <b id="nxt-c-tools">0</b></span>
    </div>
    <div class="nxt-clock"><span id="nxt-c-localtime">--:--:--</span><em>LOCAL</em></div>
    <button class="nxt-back" type="button" data-nav="conversation" title="Back to conversation" aria-label="Back to conversation">×</button>
  </div>
  <div class="nxt-body">
    <div class="nxt-panel nxt-wallpanel">
      <div class="nxt-phead"><span>AGENT UNITS</span><span class="nxt-phint" id="nxt-wallhint">LIVE FEED</span></div>
      <div class="nxt-wall" id="nxt-wall"></div>
    </div>
    <div class="nxt-panel nxt-stagepanel">
      <div class="nxt-phead"><span id="nxt-stage-title">AGGREGATE THROUGHPUT</span><span class="nxt-phint" id="nxt-stage-sub">GLOBAL // ALL UNITS</span>
        <div class="nxt-modes">
          <button type="button" class="nxt-mode" data-mode="office" data-active="1" title="Office floor">OFFICE</button>
          <button type="button" class="nxt-mode" data-mode="radar" title="Reactor radar">RADAR</button>
          <button type="button" class="nxt-mode" data-mode="net" title="Network view">NET</button>
          <button type="button" class="nxt-mode" data-cinema="1" title="Cinema layout (C)">CINEMA</button>
        </div>
      </div>
      <div class="nxt-stage" id="nxt-stage">
        <canvas id="nxt-canvas"></canvas>
        <div class="nxt-analyze" id="nxt-analyze"></div>
        <div class="nxt-stage-hud" id="nxt-stage-hud">
          <div class="nxt-shud" data-pos="tl" id="nxt-shud-tl"></div>
          <div class="nxt-shud" data-pos="tr" id="nxt-shud-tr"></div>
          <div class="nxt-shud" data-pos="bl" id="nxt-shud-bl"></div>
          <div class="nxt-shud" data-pos="br" id="nxt-shud-br"></div>
        </div>
        <div class="nxt-stage-tag" id="nxt-stage-tag"></div>
        <div class="nxt-standby-tray" id="nxt-standby-tray" hidden></div>
        <div class="nxt-legend"></div>
      </div>
    </div>
    <div class="nxt-panel nxt-railpanel">
      <div class="nxt-phead"><span>TELEMETRY</span><span class="nxt-phint">RAIL</span></div>
      <div class="nxt-rail" id="nxt-rail"></div>
    </div>
  </div>
  <div class="nxt-ticker" id="nxt-ticker"></div>
  <div class="nxt-vig"></div>
</div>
`

    //#endregion

    //#region html builders
    function toolHtml(tool) {
      const glyph = tool.state === 'ok' ? '✓' : tool.state === 'err' ? '!' : '▸'
      const ms = tool.ms ? (tool.ms < 1000 ? String(tool.ms) + 'ms' : (tool.ms / 1000).toFixed(1) + 's') : ''
      return (
        '<div class="nxt-tool" data-s="' +
        esc(tool.state) +
        '"><span class="nxt-ti">' +
        glyph +
        '</span><span class="nxt-tn">' +
        esc(tool.name || 'tool') +
        '</span><span class="nxt-ta">' +
        esc(tool.arg || '') +
        '</span><span class="nxt-tm">' +
        esc(ms) +
        '</span></div>'
      )
    }

    function stateLabel(state) {
      return state === 'run' ? 'RUN' : state === 'wait' ? 'WAIT' : state === 'err' ? 'ERR' : 'SYNC'
    }

    /** Inline sparkline markup (100xH viewBox, stretched by CSS). */
    function sparkMarkup(values, color, height) {
      const size = height || 18
      const series = Array.isArray(values) && values.length > 1 ? values : [0, 0]
      const peak = Math.max(1, ...series)
      const count = series.length
      const points = series
        .map((value, index) => ((index / (count - 1)) * 100).toFixed(1) + ',' + (size - 2 - (value / peak) * (size - 4)).toFixed(1))
        .join(' ')
      return (
        '<svg class="nxt-spark-svg" viewBox="0 0 100 ' + size + '" preserveAspectRatio="none">' +
        '<polygon points="0,' + size + ' ' + points + ' 100,' + size + '" fill="' + color + '" fill-opacity="0.14"/>' +
        '<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="1.3"/></svg>'
      )
    }

    /** Eased readout with a fallback for fixtures/older snapshots. */
    function shownTps(agent) {
      const value = agent && (agent.displayTps !== undefined ? agent.displayTps : agent.tps)
      return Number.isFinite(value) ? value : 0
    }

    /** Per-unit mini visualization: 0 = sparkline, 1 = tool bars, 2 = call queue. */
    function unitViz(agent, index) {
      const color = agent.color || '#55ffff'
      const kind = index % 3
      if (kind === 0) return sparkMarkup(agent.tpsHistory, color, 12)
      if (kind === 1) {
        const bins = new Array(6).fill(0)
        const now = Date.now()
        for (const entry of agent.toolLog || []) {
          const age = now - entry.t
          if (age < 0 || age > TIMELINE_WINDOW) continue
          const idx = clamp(5 - Math.floor(age / (TIMELINE_WINDOW / 6)), 0, 5)
          bins[idx] += 1
        }
        const peak = Math.max(1, ...bins)
        const bars = bins
          .map((value, i) => {
            const height = value === 0 ? 1 : Math.max(2, Math.round((value / peak) * 11))
            return '<rect x="' + (i * 8 + 1) + '" y="' + (12 - height) + '" width="5" height="' + height +
              '" fill="' + color + '" fill-opacity="' + (value === 0 ? 0.25 : 0.85) + '"/>'
          })
          .join('')
        return '<svg class="nxt-spark-svg" viewBox="0 0 46 12" preserveAspectRatio="none">' + bars + '</svg>'
      }
      const durations = (agent.tools || []).slice(-5).map((tool) => tool.ms || 0)
      const peak = Math.max(1, ...durations)
      const rows = durations
        .map((ms, i) => {
          const width = ms === 0 ? 2 : Math.max(3, Math.round((ms / peak) * 44))
          return '<rect x="0" y="' + (i * 2.4).toFixed(1) + '" width="' + width + '" height="1.7" fill="' + color + '" fill-opacity="0.75"/>'
        })
        .join('')
      return '<svg class="nxt-spark-svg" viewBox="0 0 46 12" preserveAspectRatio="none">' + rows + '</svg>'
    }

    function cardHtml(agent, focused) {
      const tools = agent.tools.length > 0 ? agent.tools.map(toolHtml).join('') : '<div class="nxt-tool"><span class="nxt-ta">—</span></div>'
      const think = agent.think
        ? '<div class="nxt-think nxt-stream"><span>' + esc(tail(agent.think, THINK_CAP)) + '</span></div>'
        : '<div class="nxt-think nxt-stream"><em class="nxt-dim">— no reasoning channel —</em></div>'
      const out = agent.out
        ? '<div class="nxt-out nxt-stream"><span>' + esc(tail(agent.out, OUT_CAP)) + '</span></div>'
        : '<div class="nxt-out nxt-stream"><em class="nxt-dim">standby…</em></div>'
      const ctxMeta =
        agent.ctx >= 0
          ? 'CTX <i class="nxt-bar"><i style="width:' + agent.ctx + '%"></i></i> ' + agent.ctx + '%'
          : 'CTX ' + fmtNum(agent.ctxTokens) + ' tok'
      return (
        '<div class="nxt-card" data-state="' +
        esc(agent.state) +
        '" data-id="' +
        esc(agent.id) +
        '"' +
        (focused === agent.id ? ' data-focused="1"' : '') +
        ' title="' +
        esc(agent.name + (agent.cwd ? '\n' + agent.cwd : '') + '\nCLICK: FOCUS · ↗: OPEN SESSION') +
        '">' +
        '<div class="nxt-chead"><span class="nxt-cidx" style="color:' +
        esc(agent.color) +
        '">' +
        esc(agent.tag) +
        '</span><span class="nxt-cname">' +
        esc(agent.name) +
        '</span><span class="nxt-cstate">' +
        stateLabel(agent.state) +
        (agent.state === 'run' ? '<span class="nxt-live-dots"><i></i><i></i><i></i></span>' : '') +
        '</span><button type="button" class="nxt-card-open" data-open="' +
        esc(agent.id) +
        '" title="Open session" aria-label="Open session">↗</button></div>' +
        '<div class="nxt-cmeta"><span class="nxt-leader"><span>MODEL</span><i></i><b>' +
        esc(agent.model || '—') +
        '</b></span><span>' +
        ctxMeta +
        '</span></div>' +
        '<div class="nxt-cspark"><span class="nxt-cspark-num" style="color:' +
        esc(agent.color) +
        '" title="EST tok/s: chars of reasoning + output in the last 3s, not an exact token count">' +
        shownTps(agent).toFixed(1) +
        '</span><span class="nxt-cspark-unit">est t/s</span>' +
        (agent.tpsDelta !== 0 ? '<span class="nxt-cspark-delta" data-dir="' + (agent.tpsDelta > 0 ? 'up' : 'down') + '">' + (agent.tpsDelta > 0 ? '▲' : '▼') + Math.abs(agent.tpsDelta) + '%</span>' : '') +
        '<span class="nxt-cspark-graph">' +
        sparkMarkup(agent.tpsHistory, agent.color, 18) +
        '</span></div>' +
        '<div class="nxt-sec"><span class="nxt-lbl">THINK</span>' +
        think +
        '</div>' +
        '<div class="nxt-sec"><span class="nxt-lbl">ACT</span><div class="nxt-act">' +
        tools +
        '</div></div>' +
        '<div class="nxt-sec"><span class="nxt-lbl">OUT</span>' +
        out +
        '</div>' +
        '<div class="nxt-cfoot"><span>T' +
        agent.turn +
        ' S' +
        agent.step +
        '</span><span>' +
        agent.calls +
        ' CALLS</span><span>' +
        agent.errors +
        ' ERR</span><span>' +
        fmtDur(agent.elapsed) +
        '</span></div>' +
        '</div>'
      )
    }

    function standbyHtml() {
      return (
        '<div class="nxt-standby"><b>NO ACTIVE UNITS</b>' +
        '<span>Send any session a task,<br/>its telemetry lights up here.</span></div>'
      )
    }

    function logHtml(log, limit) {
      const slice = log.slice(-limit)
      if (slice.length === 0) return '<div class="nxt-log-line"><span class="nxt-lm nxt-dim">no signal</span></div>'
      return slice
        .map((line) => {
          const d = new Date(line.t)
          const t = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
          return (
            '<div class="nxt-log-line" data-k="' +
            esc(line.kind) +
            '"><span class="nxt-lt">' +
            t +
            '</span><span class="nxt-lk">' +
            esc(String(line.kind).toUpperCase()) +
            '</span><span class="nxt-lm">' +
            esc(line.text) +
            '</span></div>'
          )
        })
        .join('')
    }

    const TIMELINE_WINDOW = 60000
    const TIMELINE_BINS = 12

    function widgetFrame(label, value, bodyHtml) {
      return '<div class="nxt-aw"><div class="nxt-aw-h"><span>' + label + '</span><b>' + value + '</b></div>' + bodyHtml + '</div>'
    }

    function ringSvg(pct, legend, hot) {
      const circumference = 2 * Math.PI * 40
      const dash = circumference * clamp(pct, 0, 100) / 100
      return (
        '<svg class="nxt-ring" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">' +
        '<circle class="nxt-ring-bg" cx="50" cy="50" r="40"/>' +
        '<circle class="nxt-ring-fg' + (hot ? ' nxt-ring-fg-hot' : '') + '" cx="50" cy="50" r="40" stroke-dasharray="' +
        circumference.toFixed(1) + '" stroke-dashoffset="' + (circumference - dash).toFixed(1) + '"/>' +
        '<text class="nxt-ring-num" x="50" y="45">' + legend.value + '</text>' +
        '<text class="nxt-ring-sub" x="50" y="59">' + legend.sub + '</text>' +
        '</svg>'
      )
    }

    function contextWidget(agent) {
      const hasWindow = agent.ctx >= 0
      const legend = hasWindow
        ? { value: agent.ctx + '%', sub: fmtNum(agent.ctxTokens) + ' TOK' }
        : { value: fmtNum(agent.ctxTokens), sub: 'TOK · WINDOW ?' }
      const body =
        '<div class="nxt-aw-body">' + ringSvg(hasWindow ? agent.ctx : 0, legend, agent.ctx > 85) +
        '<div class="nxt-kvrow"><span>CACHE</span><b>' + fmtNum(agent.tokens.cache + agent.tokens.cacheWrite) + '</b></div>' +
        '<div class="nxt-kvrow"><span>OUTPUT</span><b>' + fmtNum(agent.tokens.out) + '</b></div>' +
        '<div class="nxt-kvrow"><span>REASON</span><b>' + fmtNum(agent.tokens.reasoning) + '</b></div>' +
        '</div>'
      return widgetFrame('CONTEXT PRESSURE', 'CTX', body)
    }

    function taskWidget(agent) {
      const total = agent.todoTotal || 0
      const done = agent.todoDone || 0
      const pct = total > 0 ? Math.round((done / total) * 100) : 0
      const items = total > 0
        ? agent.todos.slice(0, 3).map((todo) =>
            '<div class="nxt-todo" data-done="' + (todo.status === 'completed' ? '1' : '0') + '"><i>' +
            (todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '▸' : '○') + '</i>' +
            esc(tail(todo.content, 46)) + '</div>',
          ).join('')
        : '<div class="nxt-todo"><i>·</i>no plan published</div>'
      const body =
        '<div class="nxt-aw-body">' + ringSvg(pct, { value: total > 0 ? pct + '%' : '—', sub: total > 0 ? done + '/' + total + ' TASKS' : 'NO TASKS' }, true) + items + '</div>'
      return widgetFrame('TASK PROGRESS', 'PLAN', body)
    }

    function matrixWidget(agent) {
      const now = Date.now()
      const span = TIMELINE_WINDOW
      const binMs = span / TIMELINE_BINS
      const rows = new Map()
      for (const event of agent.toolLog) {
        const age = now - event.t
        if (age < 0 || age > span) continue
        const index = clamp(TIMELINE_BINS - 1 - Math.floor(age / binMs), 0, TIMELINE_BINS - 1)
        let row = rows.get(event.name)
        if (!row) {
          row = new Array(TIMELINE_BINS).fill(0)
          rows.set(event.name, row)
        }
        row[index] += 1
      }
      if (rows.size === 0) {
        return widgetFrame('TOOL MATRIX', '60s', '<div class="nxt-aw-body"><div class="nxt-todo"><i>·</i>no tool activity in window</div></div>')
      }
      const entries = Array.from(rows.entries())
        .sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0))
        .slice(0, 6)
      let max = 1
      for (const entry of entries) for (const value of entry[1]) if (value > max) max = value
      const cells = entries
        .map(([name, row]) => {
          const label = '<div class="nxt-heat-name" title="' + esc(name) + '">' + esc(name) + '</div>'
          const bars = row
            .map((value) => '<i class="nxt-heat-cell" style="opacity:' + (value === 0 ? 0.06 : 0.2 + 0.8 * (value / max)).toFixed(2) + '"></i>')
            .join('')
          return label + bars
        })
        .join('')
      return widgetFrame('TOOL MATRIX', '60s', '<div class="nxt-heat">' + cells + '</div>')
    }

    function timelineWidget(agent) {
      const now = Date.now()
      const start = now - TIMELINE_WINDOW
      const phases = agent.phases || []
      const colors = { think: '#55ffff', act: '#ff55ff', out: '#55ff55' }
      const segments = { think: '', act: '', out: '' }
      for (let index = 0; index < phases.length; index++) {
        const phase = phases[index]
        const from = Math.max(start, phase.t)
        const until = index + 1 < phases.length ? phases[index + 1].t : now
        const to = Math.min(now, until)
        if (to <= from) continue
        const bucket = segments[phase.kind] !== undefined ? phase.kind : 'act'
        const left = ((from - start) / TIMELINE_WINDOW) * 100
        const width = Math.max(0.5, ((to - from) / TIMELINE_WINDOW) * 100)
        segments[bucket] +=
          '<i class="nxt-lane-seg" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%;background:' + colors[bucket] + '"></i>'
      }
      const lanes = [['think', 'THINK'], ['act', 'ACT'], ['out', 'OUT']]
        .map(
          ([kind, label]) =>
            '<div class="nxt-lane"><span class="nxt-lane-name">' + label + '</span><div class="nxt-lane-track">' + segments[kind] + '</div></div>',
        )
        .join('')
      return widgetFrame('PHASE TIMELINE', '60s', '<div class="nxt-lanes">' + lanes + '</div>')
    }

    function filesWidget(agent) {
      const files = agent.files || []
      if (files.length === 0) {
        return widgetFrame('FILE HEAT', 'FS', '<div class="nxt-aw-body"><div class="nxt-todo"><i>·</i>no touched paths yet</div></div>')
      }
      const max = Math.max(1, files.reduce((peak, file) => Math.max(peak, file.w * 3 + file.r), 0))
      const rows = files
        .slice(0, 6)
        .map((file) => {
          const weight = Math.max(4, Math.round(((file.w * 3 + file.r) / max) * 100))
          return (
            '<div class="nxt-file"><span class="nxt-fpath" title="' + esc(file.path) + '">' + esc(tail(file.path, 34)) + '</span>' +
            '<i class="nxt-fbar"><i style="width:' + weight + '%"></i></i>' +
            '<span class="nxt-frw">' + (file.w > 0 ? file.w + 'w' : '') + (file.r > 0 ? ' ' + file.r + 'r' : '') + '</span></div>'
          )
        })
        .join('')
      return widgetFrame('FILE HEAT', 'FS', '<div class="nxt-files">' + rows + '</div>')
    }

    function tpsWidget(agent) {
      const history = agent.tpsHistory && agent.tpsHistory.length > 1 ? agent.tpsHistory : [0, 0]
      const peak = Math.max(1, ...history)
      const count = history.length
      const points = history
        .map((value, index) => ((index / (count - 1)) * 100).toFixed(2) + ',' + (96 - (value / peak) * 84).toFixed(2))
        .join(' ')
      const area = '0,100 ' + points + ' 100,100'
      const body =
        '<div class="nxt-aw-body">' +
        '<svg class="nxt-spark" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon class="nxt-spark-fill" points="' + area + '"/>' +
        '<polyline points="' + points + '"/></svg>' +
        '<div class="nxt-kvrow"><span>NOW</span><b>' + shownTps(agent).toFixed(1) + ' est t/s</b></div>' +
        '<div class="nxt-kvrow"><span>PEAK</span><b>' + peak.toFixed(1) + ' est t/s</b></div>' +
        '</div>'
      return widgetFrame('THRUPUT TRACE', 'EST T/S', body)
    }

    function analyzeHtml(agent) {
      return (
        '<button type="button" class="nxt-analyze-close" data-focus-release="1" title="Release focus (Esc)">× RELEASE</button>' +
        contextWidget(agent) + taskWidget(agent) + matrixWidget(agent) + timelineWidget(agent) + filesWidget(agent) + tpsWidget(agent)
      )
    }

    function fmtMs(ms) {
      const value = Number(ms) || 0
      if (value <= 0) return ''
      return value < 1000 ? Math.round(value) + 'ms' : (value / 1000).toFixed(1) + 's'
    }

    function kvRow(label, value) {
      return '<div class="nxt-shud-kv"><span>' + label + '</span><b>' + value + '</b></div>'
    }

    /** Four readout panels in a horizontal row under the stage. */
    function stageHudHtml(view) {
      const totals = view.totals || {}
      const stamp = new Date().toISOString().slice(11, 19) + 'Z'
      const series = (view.history || []).slice(-56)
      const peak = Math.max(1, ...series)
      const tl =
        '<div class="nxt-shud-h"><span>AGGREGATE · THROUGHPUT (EST)</span><span>' + stamp + '</span></div>' +
        '<div class="nxt-shud-grid">' +
        kvRow('ACTIVE', totals.count || 0) +
        kvRow('TURNS', totals.turns || 0) +
        kvRow('TOOLS', totals.tools || 0) +
        kvRow('ERRORS', totals.errors || 0) +
        kvRow('TOK IN', fmtNum(totals.tin || 0)) +
        kvRow('TOK OUT', fmtNum(totals.tout || 0)) +
        kvRow('CACHE', fmtNum(totals.cache || 0)) +
        '</div>' +
        '<div class="nxt-shud-spark">' + sparkMarkup(series, '#55ffff', 34) + '</div>' +
        '<div class="nxt-shud-line"><span class="t">NOW</span><span class="nm">' +
        (totals.tpsDisplay || totals.tps || 0).toFixed(1) + ' EST T/S</span>' +
        '<span class="ms">PEAK ' + peak.toFixed(1) + '</span></div>'
      const seats = view.agents.filter((agent) => agent.deskSlot >= 0).sort((a, b) => a.deskSlot - b.deskSlot)
      const standby = view.agents.filter((agent) => agent.deskSlot < 0)
      const units =
        seats
          .slice(0, DESK_COUNT)
          .map((agent) => {
            const width = agent.ctx >= 0 ? agent.ctx : Math.min(100, Math.round(agent.ctxTokens / 2000))
            return (
              '<div class="nxt-shud-row"><span class="nxt-shud-tag" style="color:' + esc(agent.color) + '">' + esc(agent.tag) + '</span>' +
              '<span class="nxt-shud-state" style="color:' + (STATE_COLOR[agent.state] || STATE_COLOR.sync) + '">' + stateLabel(agent.state) + '</span>' +
              '<span class="nxt-shud-name">' + esc(agent.name || '') + '</span>' +
              '<span class="nxt-shud-bar"><i style="width:' + Math.max(2, width) + '%"></i></span>' +
              '<span class="nxt-shud-num">' + shownTps(agent).toFixed(1) + '</span></div>'
            )
          })
          .join('') || '<div class="nxt-shud-line"><span class="nm">no active units</span></div>'
      const standbyLine = standby.length > 0
        ? '<div class="nxt-shud-line"><span class="t">STBY</span><span class="nm">+' + standby.length + ' · ' +
          standby.slice(0, 3).map((agent) => esc(agent.tag)).join(' ') + '</span></div>'
        : ''
      const tr = '<div class="nxt-shud-h"><span>UNITS</span><span>' + (totals.desks || 0) + ' / ' + DESK_COUNT + ' DESKS' +
        (standby.length > 0 ? ' · +' + standby.length + ' STANDBY' : '') + '</span></div>' + units + standbyLine
      const toolStats = (view.toolStats || []).slice(0, 5)
      const maxTool = toolStats.length > 0 ? Math.max(1, toolStats[0].calls) : 1
      const tools =
        toolStats
          .map(
            (stat) =>
              '<div class="nxt-mini"><span class="nxt-mn">' + esc(stat.name) + '</span>' +
              '<span class="nxt-mbar"><i class="' + (stat.errs > 0 ? 'err' : '') + '" style="width:' +
              Math.max(6, Math.round((stat.calls / maxTool) * 100)) + '%"></i></span>' +
              '<span class="nxt-mv">' + stat.calls + '</span></div>',
          )
          .join('') || '<div class="nxt-mini"><span class="nxt-mn">no calls</span></div>'
      const bl =
        '<div class="nxt-shud-h"><span>TOOL MIX · 60s</span><span>' + (totals.tools || 0) + '</span></div>' + tools +
        '<div class="nxt-shud-legend"><span><i style="background:#55ffff"></i>RUN</span><span><i style="background:#ffff55"></i>WAIT</span>' +
        '<span><i style="background:#ff5555"></i>ERR</span><span><i style="background:#555555"></i>SYNC</span></div>'
      const calls = (view.recentCalls || []).slice(0, 5)
      const br =
        '<div class="nxt-shud-h"><span>RECENT CALLS</span><span>LIVE</span></div>' +
        (calls
          .map((call) => {
            const date = new Date(call.t)
            const time = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
            const color = call.state === 'run' ? '#55ffff' : call.state === 'err' ? '#ff5555' : '#55ff55'
            const glyph = call.state === 'run' ? '…' : call.state === 'err' ? '!' : '✓'
            return (
              '<div class="nxt-shud-line"><span class="t">' + time + '</span>' +
              '<span class="nm">' + esc(call.name) + '</span>' +
              '<span style="color:' + color + ';flex:none">' + glyph + '</span>' +
              '<span class="ms">' + esc(fmtMs(call.ms)) + '</span></div>'
            )
          })
          .join('') || '<div class="nxt-shud-line"><span class="nm">no calls in window</span></div>')
      return { tl, tr, bl, br }
    }

    function ratioSpark(history) {
      const values = Array.isArray(history) && history.length > 1 ? history : [0, 0]
      const peak = Math.max(1, ...values)
      const count = values.length
      const points = values
        .map((value, index) => ((index / (count - 1)) * 100).toFixed(1) + ',' + (28 - (value / peak) * 24).toFixed(1))
        .join(' ')
      return (
        '<svg class="nxt-rail-spark" viewBox="0 0 100 30" preserveAspectRatio="none">' +
        '<polygon class="nxt-rail-fill" points="0,30 ' + points + ' 100,30"/>' +
        '<polyline points="' + points + '"/></svg>'
      )
    }

    function railBlock(title, hint, body) {
      return '<div class="nxt-block"><div class="nxt-bh"><span>' + title + '</span><span>' + hint + '</span></div>' + body + '</div>'
    }

    function railHtml(view) {
      const totals = view.totals
      const history = view.history || []
      const peakTps = Math.max(1, history.length > 0 ? Math.max.apply(null, history) : 0)
      const nowTps = history.length > 0 ? history[history.length - 1] : totals.tps

      const global = railBlock(
        'GLOBAL',
        'Σ',
        '<div class="nxt-kv"><span>ACTIVE</span><b>' + totals.count + '</b></div>' +
          '<div class="nxt-kv"><span>TURNS</span><b>' + totals.turns + '</b></div>' +
          '<div class="nxt-kv"><span>TOOL CALLS</span><b>' + totals.tools + '</b></div>' +
          '<div class="nxt-kv"><span>TOKENS IN</span><b>' + fmtNum(totals.tin) + '</b></div>' +
          '<div class="nxt-kv"><span>TOKENS OUT</span><b>' + fmtNum(totals.tout) + '</b></div>' +
          '<div class="nxt-kv"><span>CACHE</span><b>' + fmtNum(totals.cache) + '</b></div>' +
          '<div class="nxt-kv"><span>ERRORS</span><b class="' + (totals.errors > 0 ? 'hot' : '') + '">' + totals.errors + '</b></div>',
      )

      const thruput =
        railBlock('THRUPUT', nowTps.toFixed(1) + ' est t/s', ratioSpark(history)) +
        railBlock(
          'LIVE',
          '60s',
          '<div class="nxt-kv"><span>NOW</span><b>' + nowTps.toFixed(1) + '</b></div>' +
            '<div class="nxt-kv"><span>PEAK</span><b>' + peakTps.toFixed(1) + '</b></div>' +
            '<div class="nxt-kv"><span>SAMPLES</span><b>' + history.length + '</b></div>',
        )

      const seatRows = view.agents.filter((a) => a.deskSlot >= 0).sort((a, b) => a.deskSlot - b.deskSlot)
      const overflowRows = view.agents.filter((a) => a.deskSlot < 0)
      const unitRows = seatRows.length
        ? seatRows
            .slice(0, DESK_COUNT)
            .map(
              (a) =>
                '<div class="nxt-unit-row"><span class="nxt-ut" style="color:' + esc(a.color) + '">' + esc(a.tag) + '</span>' +
                '<span class="nxt-us" style="color:' + (STATE_COLOR[a.state] || STATE_COLOR.sync) + '">' + stateLabel(a.state) + '</span>' +
                '<span class="nxt-un">' + esc(a.name || '') + '</span>' +
                '<span class="nxt-unit-viz">' + unitViz(a, a.deskSlot) + '</span>' +
                '<span class="nxt-uv">' + shownTps(a).toFixed(1) + '</span></div>',
            )
            .join('')
        : '<div class="nxt-unit-row"><span class="nxt-un nxt-dim">no units</span></div>'
      const units = railBlock('UNITS', String(totals.desks || 0) + (totals.overflow > 0 ? ' +' + totals.overflow : ''), unitRows)
      const standby = overflowRows.length
        ? railBlock(
            'STANDBY',
            String(overflowRows.length),
            overflowRows
              .slice(0, 6)
              .map(
                (a) =>
                  '<div class="nxt-unit-row"><span class="nxt-ut" style="color:' + esc(a.color) + '">' + esc(a.tag) + '</span>' +
                  '<span class="nxt-us" style="color:' + (STATE_COLOR[a.state] || STATE_COLOR.sync) + '">' + stateLabel(a.state) + '</span>' +
                  '<span class="nxt-un">' + esc(a.name || '') + '</span></div>',
              )
              .join('') +
              (overflowRows.length > 6
                ? '<div class="nxt-unit-row"><span class="nxt-un nxt-dim">+' + (overflowRows.length - 6) + ' more standby</span></div>'
                : ''),
          )
        : ''

      const maxTin = view.agents.reduce((max, a) => Math.max(max, a.ctxTokens), 0)
      const load = view.agents.length
        ? view.agents
            .map((a) => {
              const width = maxTin > 0 ? Math.max(2, Math.round((a.ctxTokens / maxTin) * 100)) : 0
              return (
                '<div class="nxt-load"><span class="nxt-lname">' + esc(a.tag + ' ' + a.name) +
                '</span><i class="nxt-bar"><i style="width:' + width + '%"></i></i><span>' + fmtNum(a.ctxTokens) + '</span></div>'
              )
            })
            .join('')
        : '<div class="nxt-load"><span class="nxt-lname nxt-dim">no load</span></div>'
      const ctx = railBlock('CONTEXT LOAD', 'CTX', load)

      const toolStats = (view.toolStats || []).slice(0, 6)
      const maxTool = toolStats.length > 0 ? Math.max(1, toolStats[0].calls) : 1
      const toolMix = toolStats.length
        ? toolStats
            .map(
              (stat) =>
                '<div class="nxt-mini"><span class="nxt-mn">' + esc(stat.name) + '</span>' +
                '<span class="nxt-mbar"><i class="' + (stat.errs > 0 ? 'err' : '') + '" style="width:' +
                Math.max(6, Math.round((stat.calls / maxTool) * 100)) + '%"></i></span>' +
                '<span class="nxt-mv">' + stat.calls + '</span></div>',
            )
            .join('')
        : '<div class="nxt-mini"><span class="nxt-mn nxt-dim">no calls yet</span></div>'
      const toolMixBlock = railBlock('TOOL MIX · 60s', String(totals.tools), toolMix)

      const latencies = (view.toolStats || [])
        .filter((stat) => stat.msCount > 0)
        .sort((a, b) => b.msSum / b.msCount - a.msSum / a.msCount)
        .slice(0, 5)
      const latency = latencies.length
        ? latencies
            .map((stat) => {
              const avg = stat.msSum / stat.msCount
              return (
                '<div class="nxt-mini"><span class="nxt-mn">' + esc(stat.name) + '</span>' +
                '<span class="nxt-mbar"><i style="width:' + Math.min(100, Math.max(3, Math.round(avg / 30))) + '%"></i></span>' +
                '<span class="nxt-mv">' + esc(fmtMs(avg)) + '</span></div>'
              )
            })
            .join('')
        : '<div class="nxt-mini"><span class="nxt-mn nxt-dim">no latency yet</span></div>'
      const latencyBlock = railBlock('TOOL LATENCY', 'AVG', latency)

      const mix = view.phaseMix || { think: 0, act: 0, out: 0, wait: 0 }
      const phase = railBlock(
        'PHASE MIX · 60s',
        '%',
        '<div class="nxt-phase">' +
          '<i style="width:' + mix.think + '%;background:#55ffff"></i>' +
          '<i style="width:' + mix.act + '%;background:#ff55ff"></i>' +
          '<i style="width:' + mix.out + '%;background:#55ff55"></i>' +
          '<i style="width:' + mix.wait + '%;background:#555555"></i></div>' +
          '<div class="nxt-phase-legend">' +
          '<span><i style="background:#55ffff"></i>THINK ' + mix.think + '</span>' +
          '<span><i style="background:#ff55ff"></i>ACT ' + mix.act + '</span>' +
          '<span><i style="background:#55ff55"></i>OUT ' + mix.out + '</span>' +
          '<span><i style="background:#555555"></i>WAIT ' + mix.wait + '</span></div>',
      )

      const files = view.filesAgg || []
      const maxFile = files.reduce((peak, file) => Math.max(peak, file.w * 3 + file.r), 1)
      const filesBody = files.length
        ? files
            .slice(0, 4)
            .map(
              (file) =>
                '<div class="nxt-file"><span class="nxt-fpath" title="' + esc(file.path) + '">' + esc(tail(file.path, 28)) +
                '</span><i class="nxt-fbar"><i style="width:' + Math.max(4, Math.round(((file.w * 3 + file.r) / maxFile) * 100)) +
                '%"></i></i><span class="nxt-frw">' + (file.w > 0 ? file.w + 'w' : '') + (file.r > 0 ? ' ' + file.r + 'r' : '') + '</span></div>',
            )
            .join('')
        : '<div class="nxt-todo"><i>·</i>no touched paths</div>'
      const filesBlock = railBlock('FILE ACTIVITY', 'FS', filesBody)

      const models =
        (view.models || [])
          .map((model) => '<div class="nxt-kv"><span>' + esc(model.name) + '</span><b>' + model.count + '</b></div>')
          .join('') || '<div class="nxt-kv"><span>unknown</span><b>—</b></div>'
      const modelsBlock = railBlock('MODELS', 'N', models)

      // the monitor's own beliefs, shown like a config file (borrowed from the
      // reference dashboard's "thresholds.py" panel)
      const codeLine = (key, value, note) =>
        '<div class="nxt-code-line"><span class="k">' + key + '</span><b class="v">' + value + '</b><i class="c">' + note + '</i></div>'
      const configBlock = railBlock(
        'agent-deck.ini',
        'SELF',
        '<div class="nxt-code">' +
          codeLine('tick_ms', '100', '# publish rate') +
          codeLine('tps', 'est', '# chars/3.5 · 3s') +
          codeLine('usage', 'exact', '# per message') +
          codeLine('window_ms', '60000', '# live window') +
          codeLine('think_cap', String(THINK_CAP), '# chars') +
          codeLine('out_cap', String(OUT_CAP), '# chars') +
          codeLine('tool_rows', String(MAX_TOOLS), '# per card') +
          codeLine('cards', String(MAX_CARDS), '# max units') +
          codeLine('desks', String(DESK_COUNT), '# fixed seats') +
          codeLine('visit_travel', '1200-3000ms', '# per visit') +
          codeLine('visit_chat', '2800-4600ms', '# per visit') +
          codeLine('visits', '1-3', '# on floor') +
          codeLine('retain_source', 'watchtower', '# read-only') +
          codeLine('palette', 'IBM 5153', '# 16 colors') +
          '</div>' +
          '<div class="nxt-chipsinline"><b>READ-ONLY</b><b>60S WINDOW</b><b>RETAIN</b></div>',
      )

      const alerts = view.alerts.length
        ? railBlock(
            'ALERTS',
            String(view.alerts.length),
            '<div class="nxt-alerts">' +
              view.alerts.slice(0, 4).map((alert) => '<div class="nxt-alert">' + esc(alert.text) + '</div>').join('') +
              '</div>',
          )
        : ''

      const logBlock = railBlock(
        'EVENT LOG',
        'LAST',
        '<div class="nxt-log">' + logHtml(view.log, 10) + '</div>',
      )

      const system = railBlock(
        'SYSTEM',
        'HOST',
        '<div class="nxt-sys"><span>UPTIME</span><b>' + fmtDur(Date.now() - (view.startedAt || Date.now())) + '</b></div>' +
          '<div class="nxt-sys"><span>DATA WINDOW</span><b>60s</b></div>' +
          '<div class="nxt-sys"><span>TICK</span><b>100ms</b></div>' +
          '<div class="nxt-sys"><span>UNITS TRACKED</span><b>' + totals.count + '</b></div>',
      )

      return (
        global + thruput + units + standby + ctx + toolMixBlock + latencyBlock + phase + filesBlock + modelsBlock + configBlock + alerts + logBlock + system
      )
    }

    function tickerHtml(view) {
      const last = view.log[view.log.length - 1]
      const totals = view.totals
      const text = last ? String(last.kind).toUpperCase() + ' // ' + last.text : 'AWAITING TELEMETRY'
      return (
        '<span class="nxt-tk">FEED</span><span class="nxt-tv">' +
        esc(text) +
        '</span><span class="nxt-ts">AGENTS ' +
        totals.count +
        ' · Σ ' +
        (totals.tpsDisplay !== undefined ? totals.tpsDisplay : totals.tps).toFixed(1) +
        ' est t/s · TOK ' +
        fmtNum(totals.tin) +
        '/' +
        fmtNum(totals.tout) +
        '</span>'
      )
    }
    //#endregion

    //#region canvas stage
    // reference sprites: five poses of the same whale-girl sheet (front / side /
    // stand / happy / rest). Backgrounds are keyed to transparency once, blue
    // pixels (hair, tail, fins) are recoloured per agent, and the content bounding
    // box keeps every pose aligned on the floor.
    // Whale-girl sprites generated by the local Codex imagegen tool from the
    // authorized community reference sheet + the asset-library Q-version
    // prompt (see docs/whale-girl-image-prompt.txt), then flood-keyed off the
    // white backdrop with edge decontamination. Five poses keep the runtime
    // keys: front / side / stand / happy / rest.
    const GIRL_FRONT_SRC = 'data:image/png;base64,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'
    const GIRL_HAPPY_SRC = 'data:image/png;base64,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'
    const GIRL_STAND_SRC = 'data:image/png;base64,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'
    const GIRL_SIDE_SRC = 'data:image/png;base64,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'
    const GIRL_REST_SRC = 'data:image/png;base64,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'
    const GIRL_SPRITE_SRC = {
      front: GIRL_FRONT_SRC,
      side: GIRL_SIDE_SRC,
      stand: GIRL_STAND_SRC,
      happy: GIRL_HAPPY_SRC,
      rest: GIRL_REST_SRC,
    }
    const girlPoseData = {}
    const girlVariants = new Map()
    function keyGirlPose(img) {
      try {
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const g = cv.getContext('2d')
        g.drawImage(img, 0, 0)
        const imageData = g.getImageData(0, 0, cv.width, cv.height)
        const px = imageData.data
        // Sprites may arrive either on a flat background (legacy sheets) or already
        // keyed to transparency (the current cutouts). Sample all four corners so a
        // future asset whose content touches one corner is not misdetected.
        const cornerAlpha = (x, y) => px[(y * cv.width + x) * 4 + 3]
        const alphaMasked =
          cornerAlpha(0, 0) < 16 &&
          cornerAlpha(cv.width - 1, 0) < 16 &&
          cornerAlpha(0, cv.height - 1) < 16 &&
          cornerAlpha(cv.width - 1, cv.height - 1) < 16
        const bgR = px[0]
        const bgG = px[1]
        const bgB = px[2]
        let minX = cv.width
        let minY = cv.height
        let maxX = 0
        let maxY = 0
        for (let i = 0; i < px.length; i += 4) {
          if (alphaMasked) {
            if (px[i + 3] < 16) continue
          } else {
            const d = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB)
            if (d < 52) {
              px[i + 3] = 0
              continue
            }
            if (px[i + 3] < 16) continue
          }
          const index = i / 4
          const x = index % cv.width
          const y = (index - x) / cv.width
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
        if (maxX <= minX || maxY <= minY) return null
        return {
          width: cv.width,
          height: cv.height,
          data: px,
          bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        }
      } catch (err) {
        return null
      }
    }
    const girlLoadingPoses = new Set()
    const girlPoseFailed = new Set()
    function ensureGirlSprites() {
      // Retry any pose that is not decoded yet; each pose is loaded at most once at
      // a time. A failed data URL is remembered so a broken asset cannot re-decode
      // 60 times per second forever (the procedural fallback stays in charge).
      for (const pose of Object.keys(GIRL_SPRITE_SRC)) {
        if (girlPoseData[pose] || girlLoadingPoses.has(pose) || girlPoseFailed.has(pose)) continue
        girlLoadingPoses.add(pose)
        const finish = () => {
          girlLoadingPoses.delete(pose)
        }
        try {
          const img = new Image()
          img.onload = function () {
            try {
              const data = keyGirlPose(img)
              if (data) girlPoseData[pose] = data
              else girlPoseFailed.add(pose)
            } catch (err) {
              girlPoseFailed.add(pose)
            }
            finish()
          }
          img.onerror = function () {
            girlPoseFailed.add(pose)
            finish()
          }
          img.src = GIRL_SPRITE_SRC[pose]
        } catch (err) {
          girlPoseFailed.add(pose)
          finish()
        }
      }
    }
    function hslToRgb(h, s, l) {
      const c = (1 - Math.abs(2 * l - 1)) * s
      const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      const m = l - c / 2
      let r = 0
      let g = 0
      let b = 0
      if (h < 60) {
        r = c
        g = x
      } else if (h < 120) {
        r = x
        g = c
      } else if (h < 180) {
        g = c
        b = x
      } else if (h < 240) {
        g = x
        b = c
      } else if (h < 300) {
        r = x
        b = c
      } else {
        r = c
        b = x
      }
      return [(r + m) * 255, (g + m) * 255, (b + m) * 255]
    }
    function rgbToHsl(r, g, b) {
      r /= 255
      g /= 255
      b /= 255
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const l = (max + min) / 2
      if (max === min) return [0, 0, l]
      const d = max - min
      const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      let h = 0
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      return [(h * 60 + 360) % 360, s, l]
    }
    function girlHue(hex) {
      const h = String(hex || '#55ffff').replace('#', '')
      return rgbToHsl(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))[0]
    }
    function girlPoseFor(mode) {
      // state -> generated pose:
      // busy uses the arms-up pose, idle the closed-eye one, error the back view,
      // walking uses the side sheet, and chatting uses the front pose.
      if (mode === 'busy') return 'stand'
      if (mode === 'idle') return 'happy'
      if (mode === 'error') return 'rest'
      if (mode === 'walk') return 'side'
      return 'front'
    }
    function girlSpriteFor(mode, color) {
      ensureGirlSprites()
      const pose = girlPoseFor(mode)
      // never substitute another pose: a wrong pose must not be cached, so a frame
      // that renders before the image decodes falls back to the procedural art
      const base = girlPoseData[pose]
      if (!base) return null
      const targetHue = girlHue(color)
      const key = pose + '|' + Math.round(targetHue)
      const cached = girlVariants.get(key)
      if (cached) return cached
      const cv = document.createElement('canvas')
      cv.width = base.width
      cv.height = base.height
      const g = cv.getContext('2d')
      const copy = new Uint8ClampedArray(base.data)
      for (let i = 0; i < copy.length; i += 4) {
        if (copy[i + 3] === 0) continue
        const hsl = rgbToHsl(copy[i], copy[i + 1], copy[i + 2])
        if (hsl[0] >= 168 && hsl[0] <= 285 && hsl[1] > 0.16 && hsl[2] > 0.28) {
          const out = hslToRgb(targetHue, Math.min(1, hsl[1] * 1.15), hsl[2])
          copy[i] = out[0]
          copy[i + 1] = out[1]
          copy[i + 2] = out[2]
        }
      }
      g.putImageData(new ImageData(copy, base.width, base.height), 0, 0)
      const result = { canvas: cv, bbox: base.bbox }
      girlVariants.set(key, result)
      return result
    }
    function drawAgentGirl(context, now, anchor, height, color, mode, seed, u, opts) {
      const options = opts || {}
      const reduced = Boolean(options.reduced)
      const sprite = girlSpriteFor(mode, color)
      if (!sprite) {
        // Fallback art must match the frame's scheme/mirroring too, otherwise a
        // failed/late sprite decode is visibly inconsistent with the sprites.
        context.save()
        const restoreFilter = context.filter || 'none'
        if (activeScheme === 'light') context.filter = 'invert(1) hue-rotate(180deg)'
        if (options.flip) {
          context.translate(anchor.x, 0)
          context.scale(-1, 1)
          context.translate(-anchor.x, 0)
        }
        drawAgentGirlArt(context, now, anchor, height, color, mode, seed, u, { reduced })
        context.filter = restoreFilter
        context.restore()
        return
      }
      const busy = mode === 'busy'
      const idle = mode === 'idle'
      const error = mode === 'error'
      const walk = mode === 'walk'
      const talk = mode === 'talk'
      const H = height
      // Animated states: breathing while idle/busy, a step bounce while walking,
      // a head-nod while chatting, and a shake when the turn failed. Reduced-motion
      // keeps the pose but freezes all of these procedural offsets.
      const breath = reduced
        ? 0
        : idle
          ? Math.sin(now / 1500 + seed) * 0.012
          : busy
            ? Math.sin(now / 260 + seed) * 0.01
            : talk
              ? Math.sin(now / 320 + seed) * 0.008
              : 0
      const bob = reduced
        ? 0
        : walk
          ? Math.abs(Math.sin(now / 140 + seed)) * H * 0.02
          : busy
            ? Math.sin(now / 300 + seed) * H * 0.008
            : idle
              ? Math.sin(now / 1600 + seed) * H * 0.004
              : talk
                ? Math.sin(now / 320 + seed) * H * 0.01
                : 0
      const sway = reduced
        ? 0
        : idle
          ? Math.sin(now / 1600 + seed) * H * 0.004
          : walk
            ? Math.sin(now / 250 + seed) * H * 0.004
            : 0
      const shake = reduced ? 0 : error ? Math.sin(now / 70 + seed) * H * 0.02 : 0
      const bx = anchor.x + sway + shake
      const feetY = anchor.y
      const targetH = H * 1.12
      const scale = targetH / sprite.bbox.h
      const drawW = sprite.canvas.width * scale
      const drawH = sprite.canvas.height * scale
      const dx = bx - (sprite.bbox.x + sprite.bbox.w / 2) * scale
      const dy = feetY - (sprite.bbox.y + sprite.bbox.h) * scale + bob
      context.save()
      context.fillStyle = 'rgba(0,0,0,0.38)'
      context.beginPath()
      if (typeof context.ellipse === 'function') {
        context.ellipse(bx, feetY + H * 0.006, sprite.bbox.w * scale * 0.42, H * 0.018, 0, 0, Math.PI * 2)
      } else {
        context.arc(bx, feetY + H * 0.006, H * 0.02, 0, Math.PI * 2)
      }
      context.fill()
      context.restore()
      context.save()
      context.globalAlpha = idle ? 0.92 : walk ? 0.98 : 1
      // The light scheme inverts the whole panel; invert the sprite locally
      // first so the character keeps its original palette after the panel filter.
      const restoreFilter = context.filter || 'none'
      if (activeScheme === 'light') context.filter = 'invert(1) hue-rotate(180deg)'
      // breathing / step squash and horizontal mirror for the walking pose
      context.translate(bx, feetY)
      context.scale(options.flip ? -1 : 1, 1 + breath + (walk && !reduced ? Math.sin(now / 140 + seed) * 0.01 : 0))
      context.translate(-bx, -feetY)
      context.drawImage(sprite.canvas, dx, dy, drawW, drawH)
      context.filter = restoreFilter
      context.restore()
      if (walk && !reduced) {
        // little floor puffs behind the steps
        const step = Math.sin(now / 140 + seed)
        context.save()
        context.globalAlpha = 0.3
        context.fillStyle = 'rgba(170,170,170,1)'
        context.beginPath()
        if (typeof context.ellipse === 'function') {
          context.ellipse(bx - step * H * 0.06, feetY + H * 0.004, H * 0.032, H * 0.008, 0, 0, Math.PI * 2)
        } else {
          context.arc(bx - step * H * 0.06, feetY + H * 0.004, H * 0.02, 0, Math.PI * 2)
        }
        context.fill()
        context.restore()
      }
      if (busy && !reduced) {
        for (let spark = 0; spark < 3; spark++) {
          const phase = ((now / 900) + spark / 3 + seed * 0.19) % 1
          context.fillStyle = 'rgba(255,255,255,' + ((1 - phase) * 0.6).toFixed(2) + ')'
          context.fillRect(
            bx - H * 0.08 + spark * H * 0.05,
            dy - H * 0.03 - phase * H * 0.07,
            Math.max(1.2, H * 0.008),
            Math.max(1.2, H * 0.008),
          )
        }
      }
      if (idle) {
        context.fillStyle = 'rgba(170,170,190,0.9)'
        context.font = Math.max(7, Math.round(9 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'left'
        const drift = reduced ? 0.15 : (now / 1900 + seed) % 1
        context.fillText('z', dx + drawW * 0.86, dy + drawH * 0.18 - drift * 6)
        context.fillText('z', dx + drawW * 1.02, dy + drawH * 0.1 - drift * 8)
      }
      if (error) {
        const flash = reduced ? 0.85 : 0.45 + 0.55 * Math.abs(Math.sin(now / 230))
        context.fillStyle = 'rgba(255,85,85,' + flash.toFixed(2) + ')'
        context.font = '600 ' + Math.max(9, Math.round(13 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText('!', bx, dy - H * 0.02)
      }
    }

    /**
     * Chat bubble shared by a visiting pair. Delegation pairs get a yellow
     * `DELEGATE`/`↳` marker, ordinary visits cycle through small talk glyphs.
     */
    function drawChatBubbles(context, now, visitorAnchor, visitorHeight, targetAnchor, targetHeight, delegation, seed, alpha, lift) {
      if (!(alpha > 0)) return
      const glyphs = delegation ? ['DELEGATE', '↳', 'DELEGATE', '…'] : ['…', '♪', '?', '!', '…']
      const step = Math.floor(now / 420 + seed) % glyphs.length
      const text = glyphs[step]
      const midX = (visitorAnchor.x + targetAnchor.x) / 2
      const topY =
        Math.min(visitorAnchor.y - visitorHeight * 1.04, targetAnchor.y - targetHeight * 1.04) +
        Math.sin(now / 380 + seed) * 2 -
        (lift || 0)
      context.save()
      context.globalAlpha = alpha
      context.font = '600 ' + (delegation ? 8 : 10) + 'px "JetBrains Mono", ui-monospace, monospace'
      context.textAlign = 'center'
      context.textBaseline = 'alphabetic'
      const w = Math.max(20, context.measureText(text).width + 8)
      const h = 14
      const bx = midX - w / 2
      context.fillStyle = 'rgba(8,8,8,0.92)'
      context.fillRect(bx, topY, w, h)
      context.strokeStyle = delegation ? 'rgba(255,255,85,0.9)' : 'rgba(85,255,255,0.85)'
      context.lineWidth = 1
      context.strokeRect(bx + 0.5, topY + 0.5, w - 1, h - 1)
      context.fillStyle = delegation ? 'rgba(255,255,85,1)' : 'rgba(85,255,255,1)'
      context.fillText(text, midX, topY + h - 4)
      // tail dots toward the speakers
      context.fillStyle = delegation ? 'rgba(255,255,85,0.6)' : 'rgba(85,255,255,0.6)'
      context.fillRect(midX - 1, topY + h, 2, 2)
      context.fillRect(midX - 0.5, topY + h + 3, 1, 1)
      context.restore()
    }

    function drawAgentGirlArt(context, now, anchor, height, color, mode, seed, u, opts) {
      const reduced = Boolean(opts && opts.reduced)
      const H = height
      const busy = mode === 'busy'
      const idle = mode === 'idle'
      const error = mode === 'error'
      const walk = mode === 'walk'
      const bob = reduced
        ? 0
        : walk
          ? Math.abs(Math.sin(now / 140 + seed)) * H * 0.02
          : busy
            ? Math.sin(now / 300 + seed) * H * 0.01
            : idle
              ? Math.sin(now / 1600 + seed) * H * 0.005
              : mode === 'talk'
                ? Math.sin(now / 320 + seed) * H * 0.01
                : 0
      const sway = reduced
        ? 0
        : walk
          ? Math.sin(now / 250 + seed) * H * 0.007
          : idle
            ? Math.sin(now / 1600 + seed) * H * 0.007
            : 0
      const bx = anchor.x + sway
      const feetY = anchor.y

      const rgb = (hex) => {
        const h = String(hex || '#55ffff').replace('#', '')
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
      }
      const mixTo = (hex, target, t) => {
        const a = rgb(hex)
        const b = rgb(target)
        const m = (i) => Math.round(a[i] + (b[i] - a[i]) * t)
        return 'rgb(' + m(0) + ',' + m(1) + ',' + m(2) + ')'
      }
      const rgba = (hex, alpha) => {
        const c = rgb(hex)
        return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')'
      }
      const hair = color || '#55ffff'
      const hairDark = mixTo(hair, '#0b1230', 0.5)
      const hairMid = mixTo(hair, '#000000', 0.22)
      const hairLight = mixTo(hair, '#ffffff', 0.5)
      const skin = '#f7e9de'
      const skinShade = '#e8d2c6'
      const navy = '#1b2340'
      const navyDark = '#121831'
      const navyLight = '#2b3759'
      const lace = '#f5f6fa'
      const laceShade = '#dbe0ec'
      const gold = '#d9b466'

      const rr = (x, y, w, h, r) => {
        const k = Math.min(r, w / 2, h / 2)
        context.beginPath()
        context.moveTo(x + k, y)
        context.lineTo(x + w - k, y)
        context.quadraticCurveTo(x + w, y, x + w, y + k)
        context.lineTo(x + w, y + h - k)
        context.quadraticCurveTo(x + w, y + h, x + w - k, y + h)
        context.lineTo(x + k, y + h)
        context.quadraticCurveTo(x, y + h, x, y + h - k)
        context.lineTo(x, y + k)
        context.quadraticCurveTo(x, y, x + k, y)
        context.closePath()
      }
      const ell = (x, y, rx, ry) => {
        context.save()
        context.translate(x, y)
        context.scale(1, Math.max(0.02, ry / rx))
        context.beginPath()
        context.arc(0, 0, rx, 0, Math.PI * 2)
        context.restore()
      }
      const line = (x1, y1, x2, y2, stroke, width) => {
        context.strokeStyle = stroke
        context.lineWidth = Math.max(0.6, width)
        context.beginPath()
        context.moveTo(x1, y1)
        context.lineTo(x2, y2)
        context.stroke()
      }

      const R = H * 0.245
      const headCy = feetY - H * 0.665 + bob
      const shoulderY = headCy + R * 0.98
      const waist = feetY - H * 0.3
      const hem = feetY - H * 0.175
      const bodyHalf = R * 0.78
      const ink = 'rgba(10,12,24,0.6)'

      context.save()
      context.lineCap = 'round'
      context.lineJoin = 'round'

      // shadow
      ell(bx, feetY + H * 0.012, H * 0.2, H * 0.026)
      context.fillStyle = 'rgba(0,0,0,0.42)'
      context.fill()

      // ---- whale tail behind the skirt ----
      context.beginPath()
      context.moveTo(bx + H * 0.05, feetY - H * 0.27 + bob)
      context.bezierCurveTo(bx + H * 0.17, feetY - H * 0.3 + bob, bx + H * 0.2, feetY - H * 0.36 + bob, bx + H * 0.16, feetY - H * 0.42 + bob)
      context.quadraticCurveTo(bx + H * 0.26, feetY - H * 0.43 + bob, bx + H * 0.32, feetY - H * 0.5 + bob)
      context.quadraticCurveTo(bx + H * 0.24, feetY - H * 0.41 + bob, bx + H * 0.31, feetY - H * 0.35 + bob)
      context.quadraticCurveTo(bx + H * 0.2, feetY - H * 0.33 + bob, bx + H * 0.15, feetY - H * 0.24 + bob)
      context.quadraticCurveTo(bx + H * 0.09, feetY - H * 0.23 + bob, bx + H * 0.05, feetY - H * 0.27 + bob)
      context.closePath()
      context.fillStyle = hairMid
      context.fill()
      context.strokeStyle = ink
      context.lineWidth = Math.max(0.8, H * 0.006)
      context.stroke()
      // lighter belly strip on the tail
      context.strokeStyle = rgba(hairLight, 0.55)
      context.lineWidth = Math.max(0.8, H * 0.008)
      context.beginPath()
      context.moveTo(bx + H * 0.09, feetY - H * 0.28 + bob)
      context.quadraticCurveTo(bx + H * 0.17, feetY - H * 0.31 + bob, bx + H * 0.22, feetY - H * 0.38 + bob)
      context.stroke()

      // ---- long back hair (behind everything) ----
      context.beginPath()
      context.moveTo(bx - R * 1.16, headCy + R * 0.2)
      context.bezierCurveTo(bx - R * 1.6, headCy + R * 1.5, bx - R * 1.35, hem + H * 0.06, bx - R * 0.9, hem + H * 0.075)
      context.quadraticCurveTo(bx - R * 0.45, hem + H * 0.02, bx, hem + H * 0.03)
      context.quadraticCurveTo(bx + R * 0.45, hem + H * 0.02, bx + R * 0.9, hem + H * 0.075)
      context.bezierCurveTo(bx + R * 1.35, hem + H * 0.06, bx + R * 1.6, headCy + R * 1.5, bx + R * 1.16, headCy + R * 0.2)
      context.quadraticCurveTo(bx + R * 1.12, headCy - R * 1.05, bx, headCy - R * 1.06)
      context.quadraticCurveTo(bx - R * 1.12, headCy - R * 1.05, bx - R * 1.16, headCy + R * 0.2)
      context.closePath()
      context.fillStyle = hairDark
      context.fill()
      context.strokeStyle = ink
      context.lineWidth = Math.max(0.7, H * 0.006)
      context.stroke()
      // wavy strand hints on the back hair
      context.strokeStyle = rgba(hairMid, 0.55)
      context.lineWidth = Math.max(1, H * 0.02)
      for (const side of [-1, 1]) {
        context.beginPath()
        context.moveTo(bx + side * R * 1.0, headCy + R * 0.3)
        context.bezierCurveTo(bx + side * R * 1.45, headCy + R * 1.1, bx + side * R * 1.05, hem + H * 0.02, bx + side * R * 0.8, hem + H * 0.05)
        context.stroke()
      }

      // ---- legs + socks + shoes ----
      line(bx - H * 0.045, hem + H * 0.005, bx - H * 0.05, feetY - H * 0.05, skin, H * 0.03)
      line(bx + H * 0.045, hem + H * 0.005, bx + H * 0.05, feetY - H * 0.05, skin, H * 0.03)
      for (const side of [-1, 1]) {
        rr(bx + side * H * 0.05 - H * 0.032, feetY - H * 0.085, H * 0.064, H * 0.045, H * 0.012)
        context.fillStyle = lace
        context.fill()
        rr(bx + side * H * 0.052 - H * 0.04, feetY - H * 0.048, H * 0.08, H * 0.042, H * 0.018)
        context.fillStyle = navyDark
        context.fill()
        context.strokeStyle = navyLight
        context.lineWidth = Math.max(0.6, H * 0.006)
        context.stroke()
        line(bx + side * H * 0.052 - H * 0.036, feetY - H * 0.032, bx + side * H * 0.052 + H * 0.034, feetY - H * 0.032, laceShade, H * 0.007)
      }

      // ---- skirt ----
      context.beginPath()
      context.moveTo(bx - bodyHalf * 0.82, waist)
      context.lineTo(bx + bodyHalf * 0.82, waist)
      context.bezierCurveTo(bx + bodyHalf * 1.5, waist + H * 0.04, bx + bodyHalf * 1.7, hem, bx + bodyHalf * 1.72, hem + H * 0.02)
      context.quadraticCurveTo(bx, hem + H * 0.07, bx - bodyHalf * 1.72, hem + H * 0.02)
      context.bezierCurveTo(bx - bodyHalf * 1.7, hem, bx - bodyHalf * 1.5, waist + H * 0.04, bx - bodyHalf * 0.82, waist)
      context.closePath()
      context.fillStyle = navy
      context.fill()
      context.strokeStyle = ink
      context.lineWidth = Math.max(0.8, H * 0.007)
      context.stroke()
      // white frilled underskirt
      context.beginPath()
      context.moveTo(bx - bodyHalf * 1.66, hem + H * 0.016)
      for (let frill = 0; frill < 8; frill++) {
        const t0 = frill / 8
        const t1 = (frill + 0.5) / 8
        const t2 = (frill + 1) / 8
        const x0 = bx - bodyHalf * 1.66 + bodyHalf * 3.32 * t0
        const x1 = bx - bodyHalf * 1.66 + bodyHalf * 3.32 * t1
        const x2 = bx - bodyHalf * 1.66 + bodyHalf * 3.32 * t2
        context.quadraticCurveTo(x1, hem + H * 0.055, x2, hem + H * 0.016)
        void x0
      }
      context.quadraticCurveTo(bx, hem + H * 0.08, bx - bodyHalf * 1.66, hem + H * 0.016)
      context.closePath()
      context.fillStyle = lace
      context.fill()
      // gold embroidery
      context.strokeStyle = gold
      context.lineWidth = Math.max(0.7, H * 0.007)
      context.beginPath()
      context.moveTo(bx - bodyHalf * 1.5, hem + H * 0.004)
      context.quadraticCurveTo(bx, hem + H * 0.045, bx + bodyHalf * 1.52, hem + H * 0.004)
      context.stroke()

      // ---- bodice ----
      context.beginPath()
      context.moveTo(bx - bodyHalf, shoulderY)
      context.lineTo(bx + bodyHalf, shoulderY)
      context.quadraticCurveTo(bx + bodyHalf * 0.9, waist - H * 0.02, bx + bodyHalf * 0.82, waist)
      context.lineTo(bx - bodyHalf * 0.82, waist)
      context.quadraticCurveTo(bx - bodyHalf * 0.9, waist - H * 0.02, bx - bodyHalf, shoulderY)
      context.closePath()
      context.fillStyle = navy
      context.fill()
      context.strokeStyle = ink
      context.lineWidth = Math.max(0.8, H * 0.006)
      context.stroke()

      // waist belt
      rr(bx - bodyHalf * 0.9, waist - H * 0.03, bodyHalf * 1.8, H * 0.032, H * 0.012)
      context.fillStyle = navyDark
      context.fill()
      context.strokeStyle = gold
      context.lineWidth = Math.max(0.6, H * 0.005)
      context.stroke()
      context.fillStyle = gold
      context.beginPath()
      context.arc(bx, waist - H * 0.014, Math.max(0.9, H * 0.009), 0, Math.PI * 2)
      context.fill()

      // ---- apron (bib + skirt panel) ----
      context.beginPath()
      context.moveTo(bx - R * 0.3, shoulderY + H * 0.012)
      context.quadraticCurveTo(bx, shoulderY - H * 0.006, bx + R * 0.3, shoulderY + H * 0.012)
      context.lineTo(bx + R * 0.27, waist - H * 0.006)
      context.quadraticCurveTo(bx, waist + H * 0.012, bx - R * 0.27, waist - H * 0.006)
      context.closePath()
      context.fillStyle = lace
      context.fill()
      context.strokeStyle = rgba(laceShade, 0.9)
      context.lineWidth = Math.max(0.5, H * 0.005)
      context.stroke()
      // apron straps
      line(bx - R * 0.26, shoulderY + H * 0.006, bx - R * 0.34, shoulderY - H * 0.01, lace, H * 0.018)
      line(bx + R * 0.26, shoulderY + H * 0.006, bx + R * 0.34, shoulderY - H * 0.01, lace, H * 0.018)
      // skirt apron with scalloped hem
      context.beginPath()
      context.moveTo(bx - bodyHalf * 0.98, waist + H * 0.006)
      context.quadraticCurveTo(bx, waist + H * 0.02, bx + bodyHalf * 0.98, waist + H * 0.006)
      context.lineTo(bx + bodyHalf * 0.98, hem + H * 0.004)
      for (let frill = 0; frill < 6; frill++) {
        const x0 = bx + bodyHalf * 0.98 - (bodyHalf * 1.96 * (frill + 1)) / 6
        const x1 = bx + bodyHalf * 0.98 - (bodyHalf * 1.96 * (frill + 0.5)) / 6
        context.quadraticCurveTo(x1, hem + H * 0.05, x0, hem + H * 0.004)
      }
      context.closePath()
      context.fillStyle = lace
      context.fill()
      context.strokeStyle = rgba(laceShade, 0.85)
      context.lineWidth = Math.max(0.5, H * 0.005)
      context.stroke()
      // whale badge on apron
      const badgeY = (waist + hem) / 2 + H * 0.012
      context.fillStyle = mixTo(hair, '#2a4a8a', 0.6)
      context.beginPath()
      context.moveTo(bx - bodyHalf * 0.32, badgeY)
      context.quadraticCurveTo(bx - bodyHalf * 0.05, badgeY - R * 0.16, bx + bodyHalf * 0.3, badgeY - R * 0.05)
      context.quadraticCurveTo(bx + bodyHalf * 0.52, badgeY - R * 0.16, bx + bodyHalf * 0.6, badgeY - R * 0.02)
      context.quadraticCurveTo(bx + bodyHalf * 0.42, badgeY + R * 0.04, bx + bodyHalf * 0.46, badgeY + R * 0.14)
      context.quadraticCurveTo(bx + bodyHalf * 0.05, badgeY + R * 0.14, bx - bodyHalf * 0.32, badgeY + R * 0.04)
      context.closePath()
      context.fill()
      context.fillStyle = lace
      context.beginPath()
      context.arc(bx + bodyHalf * 0.02, badgeY + R * 0.01, Math.max(0.6, H * 0.005), 0, Math.PI * 2)
      context.fill()

      // ---- chest ribbon bow ----
      context.fillStyle = navyLight
      context.beginPath()
      context.moveTo(bx, shoulderY + R * 0.16)
      context.quadraticCurveTo(bx - R * 0.36, shoulderY + R * 0.02, bx - R * 0.34, shoulderY + R * 0.26)
      context.quadraticCurveTo(bx - R * 0.16, shoulderY + R * 0.3, bx, shoulderY + R * 0.16)
      context.quadraticCurveTo(bx + R * 0.36, shoulderY + R * 0.02, bx + R * 0.34, shoulderY + R * 0.26)
      context.quadraticCurveTo(bx + R * 0.16, shoulderY + R * 0.3, bx, shoulderY + R * 0.16)
      context.closePath()
      context.fill()
      context.fillStyle = gold
      context.beginPath()
      context.arc(bx, shoulderY + R * 0.2, Math.max(0.9, H * 0.008), 0, Math.PI * 2)
      context.fill()

      // ---- arms: navy sleeves, white cuffs, small hands ----
      const hand = (side) => {
        if (busy) {
          const tap = Math.sin(now / 140 + seed + side) * H * 0.01
          return { x: bx + side * R * 1.05, y: waist + H * 0.015 + tap }
        }
        if (error) return { x: bx + side * R * 1.2, y: shoulderY + R * 0.35 }
        return { x: bx + side * R * 1.0, y: hem - H * 0.03 }
      }
      for (const side of [-1, 1]) {
        const sx = bx + side * bodyHalf * 0.9
        const handPoint = hand(side)
        line(sx, shoulderY + R * 0.05, handPoint.x, handPoint.y, navy, H * 0.034)
        // puffed sleeve
        ell(sx, shoulderY + R * 0.02, R * 0.3, R * 0.26)
        context.fillStyle = navyLight
        context.fill()
        // white cuff
        const cuff = { x: handPoint.x - side * H * 0.012, y: handPoint.y - H * 0.012 }
        ell(cuff.x, cuff.y, H * 0.02, H * 0.016)
        context.fillStyle = lace
        context.fill()
        // hand
        ell(handPoint.x, handPoint.y, H * 0.018, H * 0.016)
        context.fillStyle = mixTo(lace, skin, 0.2)
        context.fill()
      }

      // ---- ruffled white collar over the shoulders ----
      context.beginPath()
      context.moveTo(bx - bodyHalf * 1.05, shoulderY + R * 0.02)
      context.quadraticCurveTo(bx - R * 0.6, shoulderY - R * 0.3, bx, shoulderY - R * 0.14)
      context.quadraticCurveTo(bx + R * 0.6, shoulderY - R * 0.3, bx + bodyHalf * 1.05, shoulderY + R * 0.02)
      for (let frill = 0; frill < 6; frill++) {
        const t0 = 1 - frill / 6
        const t1 = 1 - (frill + 0.5) / 6
        const x0 = bx - bodyHalf * 1.05 + bodyHalf * 2.1 * t0
        const x1 = bx - bodyHalf * 1.05 + bodyHalf * 2.1 * t1
        const x2 = bx - bodyHalf * 1.05 + bodyHalf * 2.1 * (1 - (frill + 1) / 6)
        context.quadraticCurveTo(x1, shoulderY + R * 0.34, x2, shoulderY + R * 0.16)
        void x0
      }
      context.closePath()
      context.fillStyle = lace
      context.fill()
      context.strokeStyle = rgba(laceShade, 0.8)
      context.lineWidth = Math.max(0.5, H * 0.004)
      context.stroke()

      // ---- head ----
      ell(bx, headCy, R * 0.92, R * 1.0)
      context.fillStyle = skin
      context.fill()

      // side hair in front of the shoulders
      for (const side of [-1, 1]) {
        context.beginPath()
        context.moveTo(bx + side * R * 0.98, headCy - R * 0.5)
        context.bezierCurveTo(bx + side * R * 1.34, headCy + R * 0.55, bx + side * R * 1.28, shoulderY + R * 0.6, bx + side * R * 1.02, hem - H * 0.01)
        context.quadraticCurveTo(bx + side * R * 0.86, hem - H * 0.03, bx + side * R * 0.78, hem - H * 0.06)
        context.bezierCurveTo(bx + side * R * 0.9, shoulderY + R * 0.4, bx + side * R * 0.78, headCy + R * 0.45, bx + side * R * 0.66, headCy + R * 0.05)
        context.closePath()
        context.fillStyle = hair
        context.fill()
        context.strokeStyle = ink
        context.lineWidth = Math.max(0.7, H * 0.005)
        context.stroke()
        // highlight
        context.strokeStyle = rgba(hairLight, 0.7)
        context.lineWidth = Math.max(0.8, H * 0.008)
        context.beginPath()
        context.moveTo(bx + side * R * 0.86, headCy + R * 0.2)
        context.quadraticCurveTo(bx + side * R * 1.06, shoulderY + R * 0.4, bx + side * R * 0.95, hem - H * 0.03)
        context.stroke()
      }

      // bangs: centre part, swept sides, tips above the eyes
      for (const side of [-1, 1]) {
        context.beginPath()
        context.moveTo(bx + side * R * 0.04, headCy - R * 1.02)
        context.quadraticCurveTo(bx + side * R * 0.7, headCy - R * 1.06, bx + side * R * 0.98, headCy - R * 0.3)
        context.quadraticCurveTo(bx + side * R * 0.88, headCy - R * 0.08, bx + side * R * 0.74, headCy - R * 0.22)
        context.quadraticCurveTo(bx + side * R * 0.62, headCy - R * 0.5, bx + side * R * 0.4, headCy - R * 0.44)
        context.quadraticCurveTo(bx + side * R * 0.3, headCy - R * 0.64, bx + side * R * 0.14, headCy - R * 0.5)
        context.closePath()
        context.fillStyle = side < 0 ? hairMid : hair
        context.fill()
        context.strokeStyle = ink
        context.lineWidth = Math.max(0.7, H * 0.004)
        context.stroke()
      }
      // centre strand covering the parting
      context.beginPath()
      context.moveTo(bx - R * 0.2, headCy - R * 1.04)
      context.lineTo(bx + R * 0.2, headCy - R * 1.04)
      context.quadraticCurveTo(bx + R * 0.13, headCy - R * 0.62, bx, headCy - R * 0.36)
      context.quadraticCurveTo(bx - R * 0.13, headCy - R * 0.62, bx - R * 0.2, headCy - R * 1.04)
      context.closePath()
      context.fillStyle = hair
      context.fill()
      context.strokeStyle = 'rgba(10,12,24,0.25)'
      context.lineWidth = Math.max(0.5, H * 0.003)
      context.stroke()
      // ahoge
      context.strokeStyle = hair
      context.lineWidth = Math.max(1.3, H * 0.02)
      context.beginPath()
      context.moveTo(bx - R * 0.03, headCy - R * 1.0)
      context.quadraticCurveTo(bx + R * 0.24, headCy - R * 1.42, bx + R * 0.48, headCy - R * 1.2)
      context.stroke()
      // hair shine
      context.strokeStyle = 'rgba(255,255,255,0.4)'
      context.lineWidth = Math.max(0.8, H * 0.007)
      context.beginPath()
      context.arc(bx - R * 0.14, headCy - R * 0.62, R * 0.56, Math.PI * 1.18, Math.PI * 1.6)
      context.stroke()

      // ---- lace headdress: a low frilled crown ----
      context.beginPath()
      context.arc(bx, headCy - R * 0.12, R * 0.92, Math.PI * 1.02, Math.PI * 1.98)
      context.strokeStyle = lace
      context.lineWidth = Math.max(3, H * 0.05)
      context.stroke()
      context.beginPath()
      context.arc(bx, headCy - R * 0.12, R * 1.0, Math.PI * 1.04, Math.PI * 1.96)
      context.strokeStyle = rgba(laceShade, 0.9)
      context.lineWidth = Math.max(0.8, H * 0.007)
      context.stroke()
      for (let frill = 0; frill < 11; frill++) {
        const angle = Math.PI * 1.05 + frill * Math.PI * 0.09
        const fx = bx + Math.cos(angle) * R * 0.98
        const fy = headCy - R * 0.12 + Math.sin(angle) * R * 0.98
        context.beginPath()
        context.arc(fx, fy, Math.max(1, H * 0.016), 0, Math.PI * 2)
        context.fillStyle = lace
        context.fill()
      }
      // small bow on the right of the crown
      const bowX = bx + R * 0.8
      const bowY = headCy - R * 0.5
      context.fillStyle = mixTo(hair, '#ffffff', 0.3)
      context.beginPath()
      context.moveTo(bowX, bowY)
      context.lineTo(bowX + R * 0.22, bowY - R * 0.15)
      context.lineTo(bowX + R * 0.2, bowY + R * 0.12)
      context.closePath()
      context.fill()
      context.beginPath()
      context.moveTo(bowX, bowY)
      context.lineTo(bowX - R * 0.18, bowY - R * 0.17)
      context.lineTo(bowX - R * 0.16, bowY + R * 0.1)
      context.closePath()
      context.fill()
      context.beginPath()
      context.arc(bowX, bowY, Math.max(1.1, H * 0.016), 0, Math.PI * 2)
      context.fill()

      // ---- whale-fin ears: rounded pale flukes on both sides ----
      for (const side of [-1, 1]) {
        const fx = bx + side * R * 0.94
        const fy = headCy + R * 0.16
        context.beginPath()
        context.moveTo(fx, fy + R * 0.26)
        context.bezierCurveTo(fx + side * R * 0.24, fy + R * 0.14, fx + side * R * 0.5, fy + R * 0.02, fx + side * R * 0.56, fy - R * 0.14)
        context.bezierCurveTo(fx + side * R * 0.74, fy - R * 0.34, fx + side * R * 0.66, fy - R * 0.02, fx + side * R * 0.5, fy + R * 0.08)
        context.bezierCurveTo(fx + side * R * 0.62, fy + R * 0.2, fx + side * R * 0.44, fy + R * 0.32, fx + side * R * 0.3, fy + R * 0.28)
        context.bezierCurveTo(fx + side * R * 0.2, fy + R * 0.3, fx + side * R * 0.08, fy + R * 0.3, fx, fy + R * 0.26)
        context.closePath()
        const finGrad = context.createLinearGradient(fx, fy - R * 0.3, fx + side * R * 0.5, fy + R * 0.3)
        finGrad.addColorStop(0, mixTo(lace, hair, 0.45))
        finGrad.addColorStop(1, mixTo(lace, hair, 0.1))
        context.fillStyle = finGrad
        context.fill()
        context.strokeStyle = ink
        context.lineWidth = Math.max(0.8, H * 0.005)
        context.stroke()
        context.strokeStyle = rgba(hairLight, 0.85)
        context.lineWidth = Math.max(0.8, H * 0.007)
        context.beginPath()
        context.moveTo(fx + side * R * 0.14, fy + R * 0.16)
        context.quadraticCurveTo(fx + side * R * 0.42, fy + R * 0.02, fx + side * R * 0.5, fy - R * 0.18)
        context.stroke()
      }

      // ---- face: big eyes, brows, blush, mouth ----
      const eyeY = headCy + R * 0.26
      const eyeGap = R * 0.42
      const eyeW = R * 0.46
      const eyeH = R * 0.56
      for (const side of [-1, 1]) {
        const ex = bx + side * eyeGap
        if (idle) {
          context.strokeStyle = 'rgba(30,36,60,0.95)'
          context.lineWidth = Math.max(1.4, H * 0.016)
          context.beginPath()
          context.moveTo(ex - eyeW * 0.42, eyeY)
          context.quadraticCurveTo(ex, eyeY - eyeH * 0.35, ex + eyeW * 0.42, eyeY)
          context.stroke()
        } else if (error) {
          context.strokeStyle = 'rgba(255,85,85,0.98)'
          context.lineWidth = Math.max(1.5, H * 0.018)
          context.beginPath()
          context.moveTo(ex - eyeW * 0.4, eyeY - eyeH * 0.3)
          context.lineTo(ex + eyeW * 0.4, eyeY + eyeH * 0.25)
          context.moveTo(ex + eyeW * 0.4, eyeY - eyeH * 0.3)
          context.lineTo(ex - eyeW * 0.4, eyeY + eyeH * 0.25)
          context.stroke()
        } else {
          ell(ex, eyeY, eyeW * 0.5, eyeH * 0.5)
          context.fillStyle = '#ffffff'
          context.fill()
          ell(ex, eyeY + eyeH * 0.04, eyeW * 0.44, eyeH * 0.46)
          const irisGrad = context.createLinearGradient(0, eyeY - eyeH * 0.42, 0, eyeY + eyeH * 0.5)
          irisGrad.addColorStop(0, mixTo(hair, '#0a1430', 0.55))
          irisGrad.addColorStop(0.55, mixTo(hair, '#4a6fd0', 0.55))
          irisGrad.addColorStop(1, mixTo(hair, '#ffffff', 0.45))
          context.fillStyle = irisGrad
          context.fill()
          ell(ex, eyeY + eyeH * 0.06, eyeW * 0.2, eyeH * 0.3)
          context.fillStyle = 'rgba(8,12,26,0.94)'
          context.fill()
          ell(ex - eyeW * 0.16, eyeY - eyeH * 0.18, eyeW * 0.15, eyeH * 0.17)
          context.fillStyle = 'rgba(255,255,255,0.98)'
          context.fill()
          ell(ex + eyeW * 0.14, eyeY + eyeH * 0.2, eyeW * 0.08, eyeH * 0.09)
          context.fillStyle = 'rgba(255,255,255,0.85)'
          context.fill()
          context.strokeStyle = 'rgba(16,22,44,0.92)'
          context.lineWidth = Math.max(1.2, H * 0.013)
          context.beginPath()
          context.moveTo(ex - eyeW * 0.5, eyeY - eyeH * 0.18)
          context.quadraticCurveTo(ex, eyeY - eyeH * 0.6, ex + eyeW * 0.5, eyeY - eyeH * 0.18)
          context.stroke()
        }
        context.strokeStyle = 'rgba(24,30,52,0.5)'
        context.lineWidth = Math.max(0.7, H * 0.006)
        context.beginPath()
        context.moveTo(ex - eyeW * 0.3, eyeY - eyeH * 0.62)
        context.quadraticCurveTo(ex, eyeY - eyeH * 0.74, ex + eyeW * 0.3, eyeY - eyeH * 0.6)
        context.stroke()
        ell(ex + side * R * 0.14, eyeY + eyeH * 0.4, R * 0.15, R * 0.07)
        context.fillStyle = 'rgba(255,150,170,0.32)'
        context.fill()
      }
      if (!error) {
        context.strokeStyle = 'rgba(130,80,80,0.8)'
        context.lineWidth = Math.max(0.8, H * 0.007)
        context.beginPath()
        context.moveTo(bx - H * 0.016, headCy + R * 0.74)
        context.quadraticCurveTo(bx, headCy + R * 0.81, bx + H * 0.016, headCy + R * 0.74)
        context.stroke()
      }

      // ---- state extras ----
      if (busy) {
        for (let spark = 0; spark < 3; spark++) {
          const phase = ((now / 900) + spark / 3 + seed * 0.19) % 1
          context.fillStyle = rgba(mixTo(hair, '#ffffff', 0.35), (1 - phase) * 0.8)
          context.fillRect(bx - H * 0.14 + spark * H * 0.06, headCy - R * 1.3 - phase * H * 0.09, Math.max(1.2, H * 0.008), Math.max(1.2, H * 0.008))
        }
      }
      if (idle) {
        context.fillStyle = 'rgba(150,150,170,0.85)'
        context.font = Math.max(7, Math.round(9 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'left'
        const drift = (now / 1900 + seed) % 1
        context.fillText('z', bx + R * 1.3, headCy - R * 0.5 - drift * 6)
        context.fillText('z', bx + R * 1.7, headCy - R * 1.05 - drift * 8)
      }
      if (error) {
        const flash = 0.45 + 0.55 * Math.abs(Math.sin(now / 230))
        context.fillStyle = 'rgba(255,85,85,' + flash.toFixed(2) + ')'
        context.font = '600 ' + Math.max(9, Math.round(13 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText('!', bx, headCy - R * 1.4)
      }

      context.restore()
    }

    function startStage(canvas, readState, onPick) {
      const context = canvas.getContext('2d')
      if (!context) return () => {}
      const reduceMotion = (() => {
        try {
          return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        } catch (err) {
          return false
        }
      })()
      let raf = 0
      let width = 0
      let height = 0
      let dpr = 1
      let wasHidden = false
      let resizeObserver = null
      // Social visits can run concurrently (up to three): each visitor keeps her
      // own walk/chat timeline and occupancy is tracked per visit.
      let officeVisits = []
      let officeNextVisitAt = 0
      const history = []
      let lastSample = 0
      let lastWave = 0
      let angle = 0
      let hitAreas = []
      let gridLayer = null
      let gridLayerKey = ''
      // Unit-radius gradients reused every frame; per-draw glow is a scale transform,
      // which keeps the 60fps loop free of per-frame gradient allocation.
      const unitGradient = (stops) => {
        const gradient = context.createRadialGradient(0, 0, 0, 0, 0, 1)
        for (const stop of stops) gradient.addColorStop(stop[0], stop[1])
        return gradient
      }
      const glows = {
        reactorHot: unitGradient([
          [0, 'rgba(85,255,255,0.58)'],
          [0.45, 'rgba(255,85,255,0.22)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        reactorIdle: unitGradient([
          [0, 'rgba(85,255,255,0.3)'],
          [0.45, 'rgba(255,85,255,0.1)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        nodeCyan: unitGradient([
          [0, 'rgba(85,255,255,0.22)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        nodeDim: unitGradient([
          [0, 'rgba(85,85,85,0.1)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
        host: unitGradient([
          [0, 'rgba(255,85,255,0.26)'],
          [1, 'rgba(0,0,0,0)'],
        ]),
      }

      // Measure from the canvas box itself (CSS is 100% × 100%), never from
      // window.innerWidth: CINEMA, focus mode and host layout changes can resize
      // the container without a window resize. While the canvas is display:none
      // the rect is 0×0 — keep the previous backing store instead of clamping to 1×1.
      function measure() {
        const rect = canvas.getBoundingClientRect()
        const cssWidth = Math.floor(rect.width)
        const cssHeight = Math.floor(rect.height)
        if (cssWidth <= 0 || cssHeight <= 0) return false
        const nextDpr = Math.min(2, window.devicePixelRatio || 1)
        const backingWidth = Math.floor(cssWidth * nextDpr)
        const backingHeight = Math.floor(cssHeight * nextDpr)
        width = cssWidth
        height = cssHeight
        dpr = nextDpr
        if (canvas.width !== backingWidth) canvas.width = backingWidth
        if (canvas.height !== backingHeight) canvas.height = backingHeight
        return true
      }

      function draw() {
        raf = window.requestAnimationFrame(draw)
        const state = readState()
        const now = performance.now()
        const dt = lastSample === 0 ? 16 : Math.min(120, now - lastSample)
        lastSample = now
        if (!reduceMotion) angle += dt * 0.00035 * (1 + Math.min(6, state.totals.tps) * 0.12)
        if (width === 0 || height === 0) {
          if (!measure()) return
        }
        if (state.hidden !== wasHidden) {
          wasHidden = state.hidden
          if (!state.hidden) measure()
        }
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.clearRect(0, 0, width, height)
        if (state.hidden) {
          hitAreas = []
          return
        }
        if (state.mode === 'net') {
          drawNetwork(state, now)
          return
        }
        hitAreas = []

        const focused = state.focused
        const agents = state.agents
        const hudRow = state.hud ? Math.min(250, Math.max(150, height * 0.3)) + 10 : 0
        const heroW = width
        const heroH = Math.max(140, height - hudRow)
        const cx = heroW / 2
        const cy = heroH / 2
        const radius = Math.max(46, Math.min(heroW * 0.45, heroH * 0.44))

        if (state.mode === 'office') {
          drawOffice(state, now, heroW, heroH)
        } else {
        // aggregate radar reactor (kept as its own view)
        // static grid layer: rings and spokes are rendered once per geometry change
        const paintGrid = (target) => {
          target.strokeStyle = 'rgba(85,255,255,0.10)'
          target.lineWidth = 1
          for (let ring = 1; ring <= 3; ring++) {
            target.beginPath()
            target.arc(cx, cy, (radius * ring) / 3, 0, Math.PI * 2)
            target.stroke()
          }
          target.strokeStyle = 'rgba(85,255,255,0.055)'
          for (let spoke = 0; spoke < 12; spoke++) {
            const spokeAngle = (spoke / 12) * Math.PI * 2
            target.beginPath()
            target.moveTo(cx + Math.cos(spokeAngle) * radius * 0.10, cy + Math.sin(spokeAngle) * radius * 0.10)
            target.lineTo(cx + Math.cos(spokeAngle) * radius, cy + Math.sin(spokeAngle) * radius)
            target.stroke()
          }
          target.strokeStyle = 'rgba(85,255,255,0.14)'
          target.beginPath()
          target.arc(cx, cy, radius * 1.12, 0, Math.PI * 2)
          target.stroke()
        }
        const canCacheGrid = typeof document !== 'undefined' && document && typeof document.createElement === 'function'
        const gridKey = width + 'x' + height + ':' + Math.round(cx) + ':' + Math.round(cy) + ':' + Math.round(radius) + ':' + dpr
        if (canCacheGrid && (!gridLayer || gridLayerKey !== gridKey)) {
          gridLayer = document.createElement('canvas')
          gridLayer.width = Math.max(1, Math.floor(width * dpr))
          gridLayer.height = Math.max(1, Math.floor(height * dpr))
          const grid = gridLayer.getContext('2d')
          if (grid) {
            grid.setTransform(dpr, 0, 0, dpr, 0, 0)
            grid.clearRect(0, 0, width, height)
            paintGrid(grid)
          }
          gridLayerKey = gridKey
        }
        if (canCacheGrid && gridLayer) {
          context.drawImage(gridLayer, 0, 0, width, height)
        } else {
          context.save()
          paintGrid(context)
          context.restore()
        }

        // rotating tick ring (the only moving part of the grid)
        context.save()
        context.strokeStyle = 'rgba(85,255,255,0.28)'
        context.lineWidth = 1.5
        for (let tick = 0; tick < 36; tick++) {
          const tickAngle = (tick / 36) * Math.PI * 2 + angle
          const long = tick % 3 === 0
          context.beginPath()
          context.moveTo(cx + Math.cos(tickAngle) * radius * 1.02, cy + Math.sin(tickAngle) * radius * 1.02)
          context.lineTo(cx + Math.cos(tickAngle) * radius * (long ? 1.09 : 1.05), cy + Math.sin(tickAngle) * radius * (long ? 1.09 : 1.05))
          context.stroke()
        }
        context.restore()

        // core reactor
        const pulse = 0.5 + 0.5 * Math.sin(now / 620)
        const load = Math.min(1, state.totals.tps / 48)
        const coreR = radius * (0.16 + load * 0.05 + pulse * 0.012)
        const glowR = coreR * 2.6
        context.save()
        context.translate(cx, cy)
        context.scale(glowR, glowR)
        context.fillStyle = load > 0.04 ? glows.reactorHot : glows.reactorIdle
        context.beginPath()
        context.arc(0, 0, 1, 0, Math.PI * 2)
        context.fill()
        context.restore()
        context.strokeStyle = 'rgba(85,255,255,0.85)'
        context.lineWidth = 1.6
        context.beginPath()
        context.arc(cx, cy, coreR, 0, Math.PI * 2)
        context.stroke()
        context.strokeStyle = 'rgba(255,85,255,0.75)'
        context.lineWidth = 2.2
        context.beginPath()
        context.arc(cx, cy, coreR * 0.62, angle * 2.4, angle * 2.4 + Math.PI * 1.15)
        context.stroke()
        context.strokeStyle = 'rgba(85,255,255,0.55)'
        context.lineWidth = 1
        context.beginPath()
        context.arc(cx, cy, coreR * 0.34, -angle * 3.6, -angle * 3.6 + Math.PI * 1.5)
        context.stroke()

        // central readout
        context.save()
        context.textAlign = 'center'
        context.fillStyle = 'rgba(255,255,255,0.92)'
        context.font = '600 ' + Math.round(clamp(radius * 0.16, 15, 30)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.fillText((state.totals.tpsDisplay || state.totals.tps).toFixed(1), cx, cy - coreR * 1.45)
        context.fillStyle = 'rgba(85,85,85,0.9)'
        context.font = '9px "JetBrains Mono", ui-monospace, monospace'
        context.fillText('EST TOKENS / SEC · AGGREGATE', cx, cy - coreR * 1.45 + 13)
        context.restore()

        if (agents.length === 0) {
          const breathe = 0.4 + 0.4 * Math.abs(Math.sin(now / 900))
          context.save()
          context.textAlign = 'center'
          context.fillStyle = 'rgba(85,255,255,' + breathe.toFixed(2) + ')'
          context.font = '600 12px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('— STANDBY · AWAITING UNIT TELEMETRY —', cx, cy + coreR * 2.3)
          context.fillStyle = 'rgba(85,85,85,0.95)'
          context.font = '9px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('the next working unit lights up here automatically', cx, cy + coreR * 2.3 + 18)
          context.restore()
        }

        // per-agent arcs: angular share by throughput
        const total = agents.reduce((sum, a) => sum + Math.max(0.4, a.tps), 0)
        let start = -Math.PI / 2
        const arcR = radius * 0.72
        for (const agent of agents) {
          const share = Math.max(0.4, agent.tps) / Math.max(1, total)
          const span = share * Math.PI * 2 * 0.92
          const color = STATE_COLOR[agent.state] || STATE_COLOR.sync
          const dim = focused && focused !== agent.id
          context.save()
          context.globalAlpha = dim ? 0.18 : 0.9
          context.strokeStyle = color
          context.lineWidth = agent.id === focused ? 7 : 4
          context.shadowColor = color
          context.shadowBlur = agent.id === focused ? 18 : 8
          context.beginPath()
          context.arc(cx, cy, arcR, start, start + span)
          context.stroke()
          context.restore()
          // arc annotation: identity tag + live tokens/s on the arc midpoint
          if (agents.length <= 4 && span > 0.22) {
            const midAngle = start + span / 2
            const labelRadius = arcR - 15
            const labelX = cx + Math.cos(midAngle) * labelRadius
            const labelY = cy + Math.sin(midAngle) * labelRadius
            context.save()
            context.globalAlpha = dim ? 0.22 : 0.95
            context.textAlign = 'center'
            context.textBaseline = 'middle'
            context.fillStyle = agent.color || color
            context.font = '8px "JetBrains Mono", ui-monospace, monospace'
            context.fillText(agent.tag + '  ' + agent.displayTps.toFixed(1), labelX, labelY)
            context.restore()
          }
          start += span + 0.035
        }

        // agent orbs on the outer ring with trails (per-agent identity color)
        const orbR = radius * 0.93
        agents.forEach((agent, index) => {
          const baseAngle = -Math.PI / 2 + (index / Math.max(1, agents.length)) * Math.PI * 2
          const a = baseAngle + (reduceMotion ? 0 : Math.sin(now / 3200 + index) * 0.05)
          const x = cx + Math.cos(a) * orbR
          const y = cy + Math.sin(a) * orbR
          const color = agent.color || STATE_COLOR[agent.state] || STATE_COLOR.sync
          const dim = focused && focused !== agent.id
          context.save()
          context.globalAlpha = dim ? 0.2 : 1
          for (let t = 3; t >= 1; t--) {
            const ta = a - t * 0.05
            context.beginPath()
            context.arc(cx + Math.cos(ta) * orbR, cy + Math.sin(ta) * orbR, 2.4 - t * 0.4, 0, Math.PI * 2)
            context.fillStyle = color
            context.globalAlpha = (dim ? 0.2 : 1) * (0.10 * (4 - t))
            context.fill()
          }
          context.globalAlpha = dim ? 0.25 : 1
          context.shadowColor = color
          context.shadowBlur = 14
          context.beginPath()
          const size = agent.id === focused ? 6.5 : 4.6
          for (let corner = 0; corner < 6; corner++) {
            const ca = (corner / 6) * Math.PI * 2 + Math.PI / 6
            const px = x + Math.cos(ca) * size
            const py = y + Math.sin(ca) * size
            if (corner === 0) context.moveTo(px, py)
            else context.lineTo(px, py)
          }
          context.closePath()
          context.fillStyle = color
          context.fill()
          context.shadowBlur = 0
          context.fillStyle = dim ? 'rgba(170,170,170,0.5)' : 'rgba(255,255,255,0.86)'
          context.font = '9px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = x > cx ? 'left' : 'right'
          const label = agent.tag + ' ' + (agent.name || '').slice(0, 14)
          context.fillText(label, x + (x > cx ? 10 : -10), y + 3)
          context.restore()
        })

        }

        // (throughput chart moved into the bottom readout row)
      }

      /**
       * Office floor: one isometric-ish desk per live agent. Everything on a desk is
       * real telemetry — the monitor draws that unit's own mini chart, the lamp and
       * screen frame carry its state, the desk bar is its context pressure, and the
       * wall displays aggregate throughput / tool load.
       */
    // whale-girl agent mascot, drawn after the reference sheet:
    // long hair + lace headdress + whale-fin ears + whale tail + navy maid dress with a whale apron.
      function drawOffice(state, now, areaW, areaH) {
        const agents = state.agents || []
        const totals = state.totals || {}
        const history = state.history || []
        const toolStats = state.toolStats || []
        const DESK_COLS = 4
        const DESK_ROWS = 2
        const TOTAL_DESKS = DESK_COLS * DESK_ROWS

        // shallow isometric (2.5D): rows run horizontally, depth recedes up-right
        const pitchX = 2.2
        const pitchY = 3.4
        const deskW = 1.7
        const deskD = 1.15
        const deskTopZ = 0.6
        const deskThick = 0.12
        const wallH = 3.1
        const minX = -0.95
        const maxX = pitchX * (DESK_COLS - 1) + deskW + 0.95
        const minY = -0.95
        const maxY = pitchY * (DESK_ROWS - 1) + deskD + 0.95
        const depthX = 0.34
        const depthY = 0.86

        const iso0 = (x, y, z) => ({ x: x - y * depthX, y: y * depthY - z })
        let minPX = Infinity
        let maxPX = -Infinity
        let minPY = Infinity
        let maxPY = -Infinity
        for (const [px, py] of [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
        ]) {
          for (const pz of [0, wallH + 0.3]) {
            const point = iso0(px, py, pz)
            if (point.x < minPX) minPX = point.x
            if (point.x > maxPX) maxPX = point.x
            if (point.y < minPY) minPY = point.y
            if (point.y > maxPY) maxPY = point.y
          }
        }
        const spanX = Math.max(1, maxPX - minPX)
        const spanY = Math.max(1, maxPY - minPY)
        const s = Math.max(12, Math.min((areaW - 22) / spanX, (areaH - 18) / spanY))
        const originX = (areaW - spanX * s) / 2 - minPX * s
        const originY = areaH - 8 - maxPY * s
        const iso = (x, y, z) => ({ x: originX + (x - y * depthX) * s, y: originY + (y * depthY - z) * s })
        const u = clamp(areaW / 470, 0.8, 2.2)

        // Light scheme: the whole panel is inverted by CSS, so light-mode inks are
        // chosen as pre-filter values that invert into a paper-light office instead
        // of a white-on-white blur.
        const themed = (dark, light) => (activeScheme === 'light' ? light : dark)
        const wallInk = themed('rgba(11,11,11,0.99)', 'rgba(30,30,30,0.99)')
        const wallTrim = themed('rgba(20,20,20,0.99)', 'rgba(42,42,42,0.99)')
        const floorInk = themed('rgba(4,4,4,1)', 'rgba(17,17,17,1)')
        const topInk = themed('rgba(27,27,27,1)', 'rgba(56,56,56,1)')
        const topEdge = themed('rgba(48,48,48,1)', 'rgba(118,118,118,1)')
        const frontInk = themed('rgba(13,13,13,1)', 'rgba(46,46,46,1)')
        const sideInk = themed('rgba(9,9,9,1)', 'rgba(66,66,66,1)')
        const legInk = themed('rgba(19,19,19,1)', 'rgba(54,54,54,1)')
        const chairInk = themed('rgba(15,15,15,1)', 'rgba(60,60,60,1)')
        const panelInk = themed('rgba(2,2,2,0.98)', 'rgba(32,32,32,0.98)')

        const quad = (points, fill, stroke) => {
          context.beginPath()
          context.moveTo(points[0].x, points[0].y)
          for (let index = 1; index < points.length; index++) context.lineTo(points[index].x, points[index].y)
          context.closePath()
          if (fill) {
            context.fillStyle = fill
            context.fill()
          }
          if (stroke) {
            context.strokeStyle = stroke
            context.lineWidth = 1
            context.stroke()
          }
        }
        const solid = (x, y, w, d, z0, z1, top, front, side, edge) => {
          quad([iso(x, y, z1), iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x, y + d, z1)], top, edge)
          quad([iso(x, y + d, z0), iso(x + w, y + d, z0), iso(x + w, y + d, z1), iso(x, y + d, z1)], front, edge)
          quad([iso(x + w, y, z0), iso(x + w, y + d, z0), iso(x + w, y + d, z1), iso(x + w, y, z1)], side, edge)
        }
        const ellipsePath = (ex, ey, rx, ry) => {
          context.save()
          context.translate(ex, ey)
          context.scale(1, Math.max(0.02, ry / rx))
          context.beginPath()
          context.arc(0, 0, rx, 0, Math.PI * 2)
          context.restore()
        }

        // backdrop: in the light scheme the inverted scene would be pure white,
        // so a slightly darker pre-filter ink gives the room a paper-grey card
        // and keeps the near-white furniture readable.
        context.save()
        context.fillStyle = activeScheme === 'light' ? 'rgba(21,21,21,1)' : 'rgba(0,0,0,1)'
        context.fillRect(0, 0, areaW, areaH)
        // extend the wall upward when the stage is taller than the room
        const wallTopScreen = originY + minPY * s
        if (wallTopScreen > 0) {
          const extGrad = context.createLinearGradient(0, 0, 0, wallTopScreen)
          extGrad.addColorStop(0, activeScheme === 'light' ? 'rgba(23,23,23,1)' : 'rgba(8,8,8,1)')
          extGrad.addColorStop(1, activeScheme === 'light' ? 'rgba(27,27,27,1)' : 'rgba(11,11,11,1)')
          context.fillStyle = extGrad
          context.fillRect(0, 0, areaW, wallTopScreen + 1)
          context.strokeStyle = 'rgba(85,255,255,0.08)'
          context.lineWidth = 1
          for (let seam = 1; seam * 104 < areaW + 104; seam++) {
            const sx = seam * 104
            context.beginPath()
            context.moveTo(sx, 0)
            context.lineTo(sx, wallTopScreen)
            context.stroke()
          }
          const topGlow = context.createLinearGradient(0, 0, 0, 6)
          topGlow.addColorStop(0, 'rgba(255,255,85,0.26)')
          topGlow.addColorStop(1, 'rgba(255,255,85,0)')
          context.fillStyle = topGlow
          context.fillRect(0, 0, areaW, 6)
          // upper-wall dressing so the extra height does not read as empty
          const upper = wallTopScreen
          if (upper > 90) {
            context.fillStyle = 'rgba(6,6,6,0.9)'
            for (let board = 0; board < Math.floor(upper / 150); board++) {
              const by = 26 + board * 150
              if (by + 90 > upper - 14) break
              const bw = Math.min(150, areaW * 0.16)
              context.fillRect(areaW * 0.06, by, bw, 82)
              context.strokeStyle = 'rgba(85,255,255,0.22)'
              context.lineWidth = 1
              context.strokeRect(areaW * 0.06 + 0.5, by + 0.5, bw - 1, 81)
              context.strokeStyle = 'rgba(85,255,255,0.12)'
              for (let line = 1; line <= 3; line++) {
                context.beginPath()
                context.moveTo(areaW * 0.06 + 8, by + (82 * line) / 4)
                context.lineTo(areaW * 0.06 + bw - 8, by + (82 * line) / 4)
                context.stroke()
              }
              context.fillStyle = 'rgba(255,255,85,0.45)'
              context.fillRect(areaW * 0.06 + 8, by + 8, 14, 2)
              context.fillStyle = 'rgba(85,85,85,0.5)'
              context.font = '7px "JetBrains Mono", ui-monospace, monospace'
              context.textAlign = 'left'
              context.fillText('UNIT TELEMETRY / SHELF ' + (board + 1), areaW * 0.06 + 8, by + 76)
            }
            // long light bars + a ghost wordmark higher up
            for (let bar = 0; bar < 3; bar++) {
              const by = 40 + bar * 64
              if (by > upper - 30) break
              const barGrad = context.createLinearGradient(areaW * 0.28, by, areaW * 0.94, by)
              barGrad.addColorStop(0, 'rgba(85,255,255,0)')
              barGrad.addColorStop(0.5, 'rgba(85,255,255,0.35)')
              barGrad.addColorStop(1, 'rgba(85,255,255,0)')
              context.strokeStyle = barGrad
              context.lineWidth = 2
              context.beginPath()
              context.moveTo(areaW * 0.28, by)
              context.lineTo(areaW * 0.94, by)
              context.stroke()
            }
            context.fillStyle = 'rgba(85,255,255,0.06)'
            context.font = '600 ' + Math.max(28, Math.round(areaW * 0.09)) + 'px "JetBrains Mono", ui-monospace, monospace'
            context.textAlign = 'center'
            context.fillText('FLOOR 07', areaW / 2, Math.min(upper - 40, upper * 0.72))
          }
        }

        // back wall + side wall
        quad(
          [iso(minX, minY, 0), iso(maxX, minY, 0), iso(maxX, minY, wallH), iso(minX, minY, wallH)],
          wallInk,
          'rgba(255,255,85,0.26)',
        )
        quad(
          [iso(minX, minY, 0), iso(minX, maxY, 0), iso(minX, maxY, wallH), iso(minX, minY, wallH)],
          'rgba(7,7,7,0.99)',
          'rgba(255,255,85,0.2)',
        )
        context.save()
        context.strokeStyle = 'rgba(85,255,255,0.1)'
        context.lineWidth = 1
        for (let gx = Math.ceil(minX) + 1; gx < maxX; gx += 1.5) {
          const a = iso(gx, minY, 0)
          const b = iso(gx, minY, wallH)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        for (let gz = 0.7; gz < wallH; gz += 0.7) {
          const a = iso(minX, minY, gz)
          const b = iso(maxX, minY, gz)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        quad([iso(minX, minY, 1.9), iso(maxX, minY, 1.9), iso(maxX, minY, 2.04), iso(minX, minY, 2.04)], wallTrim, 'rgba(255,255,85,0.2)')
        const baseA = iso(minX, minY, 0.04)
        const baseB = iso(maxX, minY, 0.04)
        const baseGrad = context.createLinearGradient(baseA.x, baseA.y, baseB.x, baseB.y)
        baseGrad.addColorStop(0, 'rgba(255,255,85,0.05)')
        baseGrad.addColorStop(0.45, 'rgba(255,255,85,0.34)')
        baseGrad.addColorStop(1, 'rgba(255,255,85,0.06)')
        context.strokeStyle = baseGrad
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(baseA.x, baseA.y)
        context.lineTo(baseB.x, baseB.y)
        context.stroke()
        // window on the back wall: night skyline
        const winA = iso(minX + 0.8, minY, 1.0)
        const winB = iso(minX + 3.6, minY, 2.0)
        quad([winA, { x: winB.x, y: winA.y }, winB, { x: winA.x, y: winB.y }], 'rgba(0,0,70,0.5)', 'rgba(85,85,255,0.55)')
        const winW = winB.x - winA.x
        const winH = winA.y - winB.y
        context.save()
        context.beginPath()
        for (let tower = 0; tower < 9; tower++) {
          const tw = winW / 9
          const th = winH * (0.22 + 0.55 * Math.abs(Math.sin(tower * 1.7)))
          context.fillStyle = 'rgba(85,85,255,0.15)'
          context.fillRect(winA.x + tower * tw + 1, winA.y - th, Math.max(1, tw - 2), th)
          context.fillStyle = 'rgba(255,255,85,0.55)'
          for (let light = 0; light < 4; light++) {
            if ((tower + light * 2) % 3 === 0) continue
            context.fillRect(winA.x + tower * tw + 2, winA.y - th + 3 + light * (th / 5), 1.5, 1.5)
          }
        }
        context.strokeStyle = 'rgba(85,85,255,0.5)'
        context.lineWidth = 1
        for (let mullion = 1; mullion <= 2; mullion++) {
          const mx = winA.x + (winW * mullion) / 3
          context.beginPath()
          context.moveTo(mx, winA.y)
          context.lineTo(mx, winB.y)
          context.stroke()
        }
        context.fillStyle = 'rgba(85,255,255,0.5)'
        context.font = Math.max(6, Math.round(s * 0.1)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText('SECTOR 07 · NIGHT SHIFT', winA.x + winW / 2, winA.y + 11)
        context.restore()

        // signage / emblem / clock
        const signAnchor = iso(minX + 0.5, minY, wallH - 0.3)
        context.save()
        context.textAlign = 'left'
        context.textBaseline = 'alphabetic'
        context.fillStyle = 'rgba(85,255,255,0.95)'
        context.font = '600 ' + Math.max(10, Math.round(s * 0.2)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.fillText('AGENT DECK // FLOOR 07', signAnchor.x, signAnchor.y)
        context.fillStyle = 'rgba(125,125,125,0.95)'
        context.font = Math.max(7, Math.round(s * 0.12)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.fillText(
          'UNITS ' + String(totals.desks || 0).padStart(2, '0') + ' / ' + TOTAL_DESKS +
            (totals.overflow > 0 ? ' +' + totals.overflow + ' STBY' : '') +
            '   ·   ' + (totals.tpsDisplay !== undefined ? totals.tpsDisplay : totals.tps || 0).toFixed(1) + ' EST T/S' +
            '   ·   TOOLS ' + (totals.tools || 0) +
            '   ·   ERR ' + (totals.errors || 0),
          signAnchor.x,
          signAnchor.y + Math.round(s * 0.2),
        )
        const emblem = iso(minX + 0.5, minY, wallH - 1.0)
        const er = s * 0.19
        context.strokeStyle = 'rgba(85,255,255,0.55)'
        context.lineWidth = 1.2
        context.beginPath()
        for (let corner = 0; corner < 6; corner++) {
          const angle = (corner / 6) * Math.PI * 2 - Math.PI / 2
          const px = emblem.x + Math.cos(angle) * er
          const py = emblem.y + Math.sin(angle) * er
          if (corner === 0) context.moveTo(px, py)
          else context.lineTo(px, py)
        }
        context.closePath()
        context.stroke()
        const clockAnchor = iso(maxX - 1.4, minY, wallH - 0.75)
        const clockR = Math.max(9, s * 0.22)
        context.beginPath()
        context.arc(clockAnchor.x, clockAnchor.y, clockR, 0, Math.PI * 2)
        context.fillStyle = 'rgba(0,0,0,0.9)'
        context.fill()
        context.strokeStyle = 'rgba(85,255,255,0.55)'
        context.stroke()
        for (let hour = 0; hour < 12; hour++) {
          const angle = (hour / 12) * Math.PI * 2 - Math.PI / 2
          const inner = hour % 3 === 0 ? 0.62 : 0.78
          context.beginPath()
          context.moveTo(clockAnchor.x + Math.cos(angle) * clockR * inner, clockAnchor.y + Math.sin(angle) * clockR * inner)
          context.lineTo(clockAnchor.x + Math.cos(angle) * clockR * 0.9, clockAnchor.y + Math.sin(angle) * clockR * 0.9)
          context.strokeStyle = hour % 3 === 0 ? 'rgba(85,255,255,0.7)' : 'rgba(85,255,255,0.3)'
          context.stroke()
        }
        const stampNow = new Date()
        const hourAngle = ((stampNow.getHours() % 12) / 12) * Math.PI * 2 - Math.PI / 2
        const minuteAngle = (stampNow.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2
        context.strokeStyle = 'rgba(255,255,255,0.85)'
        context.lineWidth = 1.6
        context.beginPath()
        context.moveTo(clockAnchor.x, clockAnchor.y)
        context.lineTo(clockAnchor.x + Math.cos(hourAngle) * clockR * 0.45, clockAnchor.y + Math.sin(hourAngle) * clockR * 0.45)
        context.stroke()
        context.strokeStyle = 'rgba(255,255,85,0.9)'
        context.lineWidth = 1.2
        context.beginPath()
        context.moveTo(clockAnchor.x, clockAnchor.y)
        context.lineTo(clockAnchor.x + Math.cos(minuteAngle) * clockR * 0.72, clockAnchor.y + Math.sin(minuteAngle) * clockR * 0.72)
        context.stroke()
        context.fillStyle = 'rgba(85,255,255,0.9)'
        context.beginPath()
        context.arc(clockAnchor.x, clockAnchor.y, 1.8, 0, Math.PI * 2)
        context.fill()
        context.restore()

        // wall data panels
        const wallPanel = (worldX, label, values, kind, color) => {
          const anchor = iso(worldX, minY, wallH - 0.5)
          const pw = Math.max(52, s * 1.45)
          const ph = Math.max(28, s * 0.78)
          context.save()
          context.fillStyle = panelInk
          context.fillRect(anchor.x, anchor.y - ph, pw, ph)
          context.strokeStyle = 'rgba(85,255,255,0.36)'
          context.lineWidth = 1
          context.strokeRect(anchor.x + 0.5, anchor.y - ph + 0.5, pw - 1, ph - 1)
          context.fillStyle = 'rgba(85,255,255,0.8)'
          context.font = Math.max(6, Math.round(s * 0.1)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = 'left'
          context.fillText(label, anchor.x + 4, anchor.y - ph + 9)
          const series = values && values.length > 1 ? values : [0, 0]
          const peak = Math.max(1, ...series)
          const innerX = anchor.x + 4
          const innerY = anchor.y - ph + 12
          const innerW = pw - 8
          const innerH = ph - 16
          if (kind === 'line') {
            context.strokeStyle = hexA(color, 0.85)
            context.beginPath()
            for (let index = 0; index < series.length; index++) {
              const px = innerX + (index / (series.length - 1)) * innerW
              const py = innerY + innerH - (series[index] / peak) * innerH
              if (index === 0) context.moveTo(px, py)
              else context.lineTo(px, py)
            }
            context.stroke()
          } else {
            const barW = innerW / Math.max(1, series.length)
            for (let index = 0; index < series.length; index++) {
              const barH = Math.max(1, Math.round((series[index] / peak) * innerH))
              context.fillStyle = hexA(color, 0.5 + 0.45 * (series[index] / peak))
              context.fillRect(innerX + index * barW + 1, innerY + innerH - barH, Math.max(1, barW - 2), barH)
            }
          }
          context.restore()
        }
        wallPanel(maxX - 4.6, 'THROUGHPUT', history, 'line', '#55ffff')
        wallPanel(maxX - 2.9, 'TOOL LOAD', toolStats.slice(0, 8).map((stat) => stat.calls), 'bars', '#55ff55')

        // floor + grid
        quad([iso(minX, minY, 0), iso(maxX, minY, 0), iso(maxX, maxY, 0), iso(minX, maxY, 0)], floorInk, 'rgba(255,255,85,0.2)')
        context.save()
        for (let gx = Math.ceil(minX); gx <= maxX; gx++) {
          context.strokeStyle = gx % 2 === 0 ? 'rgba(85,255,255,0.10)' : 'rgba(85,255,255,0.05)'
          const a = iso(gx, minY, 0)
          const b = iso(gx, maxY, 0)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        for (let gy = Math.ceil(minY); gy <= maxY; gy++) {
          context.strokeStyle = gy % 2 === 0 ? 'rgba(85,255,255,0.09)' : 'rgba(85,255,255,0.045)'
          const a = iso(minX, gy, 0)
          const b = iso(maxX, gy, 0)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        context.restore()

        // foreground floor: continue the room to the bottom edge
        const floorEdgeY = iso(minX, maxY, 0).y
        if (floorEdgeY < areaH) {
          const fgGrad = context.createLinearGradient(0, floorEdgeY, 0, areaH)
          fgGrad.addColorStop(0, 'rgba(5,5,5,1)')
          fgGrad.addColorStop(1, 'rgba(2,2,2,1)')
          context.fillStyle = fgGrad
          context.fillRect(0, floorEdgeY, areaW, areaH - floorEdgeY)
          context.save()
          context.strokeStyle = 'rgba(85,255,255,0.07)'
          context.lineWidth = 1
          for (let line = 1; line <= 6; line++) {
            const ly = floorEdgeY + ((areaH - floorEdgeY) * line) / 6
            context.beginPath()
            context.moveTo(0, ly)
            context.lineTo(areaW, ly)
            context.stroke()
          }
          context.strokeStyle = 'rgba(255,255,85,0.16)'
          context.lineWidth = 2
          for (let seg = 0; seg < 24; seg++) {
            if (seg % 2 === 1) continue
            context.beginPath()
            context.moveTo((areaW * seg) / 24, areaH - 12)
            context.lineTo((areaW * (seg + 1)) / 24, areaH - 12)
            context.stroke()
          }
          context.restore()
        }

        // occupancy: front row first
        const slots = []
        for (let col = 0; col < DESK_COLS; col++) slots.push({ row: DESK_ROWS - 1, col })
        for (let col = 0; col < DESK_COLS; col++) slots.push({ row: 0, col })
        const slotAgent = new Map()
        for (const agent of agents) {
          const seat = agent.deskSlot
          if (!Number.isInteger(seat) || seat < 0 || seat >= TOTAL_DESKS) continue
          const slot = slots[seat]
          slotAgent.set(slot.row * DESK_COLS + slot.col, agent)
        }
        const spotBySlot = []
        for (let slot = 0; slot < TOTAL_DESKS; slot++) {
          const row = Math.floor(slot / DESK_COLS)
          const col = slot % DESK_COLS
          const wx = col * pitchX + deskW * 0.9
          const wy = row * pitchY + deskD + 0.06
          spotBySlot.push({
            slot,
            agent: slotAgent.get(slot) || null,
            worldX: wx,
            worldY: wy,
            anchor: iso(wx, wy, 0),
            height: Math.max(36, s * 1.45),
          })
        }

        // --- social visits -------------------------------------------------
        // A visitor walks from her own desk to a seated colleague, chats, then
        // walks back. Delegation (parent/child) pairs are preferred: the running
        // child reports to the parent when possible. Per-visit timings scale with
        // walking distance and chat duration varies so simultaneous talks drift.
        const seatedAll = spotBySlot.filter((spot) => spot.agent)
        const runningAll = seatedAll.filter((spot) => spot.agent.state === 'run')
        const currentById = new Map(seatedAll.map((spot) => [spot.agent.id, spot]))
        // Several visitors can share the floor: visits are staggered, and a unit
        // never takes part in two visits at once (neither as visitor nor target).
        const MAX_VISITS = Math.max(1, Math.min(3, Math.floor(seatedAll.length / 2) || 1))
        if (officeNextVisitAt === 0) officeNextVisitAt = now + 2500 + Math.random() * 3000
        officeVisits = officeVisits.filter((visit) => {
          const fromSpot = currentById.get(visit.fromId)
          const toSpot = currentById.get(visit.toId)
          if (!fromSpot || !toSpot) return false
          // refresh seat geometry every frame: a resize or a re-seated unit must
          // move the trail/bubble, and a deleted participant ends the visit.
          visit.fromSpot = fromSpot
          visit.toSpot = toSpot
          visit.bubbleLift = (toSpot.slot % 2) * 9
          return now - visit.start <= visit.travelMs * 2 + visit.chatMs
        })
        const busyIds = new Set()
        for (const visit of officeVisits) {
          busyIds.add(visit.fromId)
          busyIds.add(visit.toId)
        }
        if (!reduceMotion && officeVisits.length >= MAX_VISITS && now >= officeNextVisitAt) {
          officeNextVisitAt = now + 1200 + Math.random() * 1800
        }
        if (
          !reduceMotion &&
          officeVisits.length < MAX_VISITS &&
          now >= officeNextVisitAt &&
          seatedAll.length >= 2 &&
          runningAll.length >= 1
        ) {
          const byId = currentById
          const edges = (state.topology && state.topology.edges) || []
          const pairs = []
          const activeSpots = []
          for (const visit of officeVisits) activeSpots.push(visit.fromSpot, visit.toSpot)
          const tooClose = (spot) =>
            activeSpots.some((other) => {
              const colGap = Math.abs((spot.slot % DESK_COLS) - (other.slot % DESK_COLS))
              const rowGap = Math.abs(Math.floor(spot.slot / DESK_COLS) - Math.floor(other.slot / DESK_COLS))
              return colGap + rowGap < 2
            })
          for (const edge of edges) {
            const parent = byId.get(edge.from)
            const child = byId.get(edge.to)
            if (!parent || !child || parent.slot === child.slot) continue
            if (busyIds.has(parent.agent.id) || busyIds.has(child.agent.id)) continue
            if (tooClose(parent) || tooClose(child)) continue
            if (parent.agent.state !== 'run' && child.agent.state !== 'run') continue
            pairs.push({ parent, child, delegation: true, weight: 3 })
          }
          if (pairs.length === 0) {
            for (const a of runningAll) {
              if (busyIds.has(a.agent.id) || tooClose(a)) continue
              for (const b of seatedAll) {
                if (a.slot === b.slot || busyIds.has(b.agent.id) || tooClose(b)) continue
                if (b.agent.state === 'run' || Math.random() < 0.3) {
                  pairs.push({ from: a, to: b, delegation: false, weight: 1 })
                }
              }
            }
          }
          let picked = null
          if (pairs.length > 0) {
            const totalWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0)
            let roll = Math.random() * totalWeight
            for (const pair of pairs) {
              roll -= pair.weight
              if (roll <= 0) {
                picked = pair
                break
              }
            }
            if (!picked) picked = pairs[pairs.length - 1]
          }
          let fromSpot = null
          let toSpot = null
          if (picked && picked.delegation) {
            fromSpot = picked.child.agent.state === 'run' ? picked.child : picked.parent
            toSpot = picked.child.agent.state === 'run' ? picked.parent : picked.child
          } else if (picked) {
            fromSpot = picked.from
            toSpot = picked.to
          }
          if (fromSpot && toSpot) {
            const visitDistance = Math.hypot(toSpot.worldX - fromSpot.worldX, toSpot.worldY - fromSpot.worldY)
            officeVisits.push({
              fromId: fromSpot.agent.id,
              toId: toSpot.agent.id,
              fromSpot,
              toSpot,
              delegation: Boolean(picked && picked.delegation),
              seed: Math.random() * 10,
              start: now,
              travelMs: clamp(1200 + visitDistance * 170, 1200, 3000),
              chatMs: 2800 + Math.random() * 1800,
              bubbleLift: (toSpot.slot % 2) * 9,
              arcSign: Math.random() < 0.5 ? -1 : 1,
              phase: '',
              pos: null,
              flip: false,
              alpha: 0,
            })
            officeNextVisitAt = now + 1600 + Math.random() * 2400
          } else {
            officeNextVisitAt = now + 2500 + Math.random() * 2500
          }
        }

        // advance every active visit once per frame; the desk pass uses the chat
        // targets and the visitor pass uses `pos`/`phase`. Walking paths curve
        // slightly so visitors do not slide straight through desk rows.
        for (const visit of officeVisits) {
          const elapsed = now - visit.start
          const from = visit.fromSpot
          const to = visit.toSpot
          const side = to.slot % DESK_COLS < DESK_COLS / 2 ? 1 : -1
          const chatX = to.worldX + side * 1.25
          const chatY = to.worldY + 0.3
          const walkSegment = (ax, ay, bx, by, t) => {
            const dx = bx - ax
            const dy = by - ay
            const length = Math.hypot(dx, dy) || 1
            const ease = t * t * (3 - 2 * t)
            const arc = Math.sin(Math.PI * t) * 0.45 * visit.arcSign
            return [ax + dx * ease - (dy / length) * arc, ay + dy * ease + (dx / length) * arc]
          }
          let wx = from.worldX
          let wy = from.worldY
          visit.alpha = 0
          if (elapsed < visit.travelMs) {
            ;[wx, wy] = walkSegment(from.worldX, from.worldY, chatX, chatY, elapsed / visit.travelMs)
            visit.phase = 'walk'
          } else if (elapsed < visit.travelMs + visit.chatMs) {
            wx = chatX
            wy = chatY
            visit.phase = 'chat'
            visit.alpha = Math.min(
              1,
              (elapsed - visit.travelMs) / 220,
              (visit.travelMs + visit.chatMs - elapsed) / 220,
            )
          } else {
            const t = (elapsed - visit.travelMs - visit.chatMs) / visit.travelMs
            ;[wx, wy] = walkSegment(chatX, chatY, from.worldX, from.worldY, t)
            visit.phase = 'walk'
          }
          visit.pos = iso(wx, wy, 0)
          visit.worldY = wy
          // face the direction of the current leg; the side sheet faces left, so it
          // is mirrored when the current target lies to the right.
          if (visit.phase === 'chat') visit.flip = to.worldX > chatX
          else if (elapsed < visit.travelMs) visit.flip = chatX > from.worldX
          else visit.flip = from.worldX > chatX
        }
        const visitingIds = new Set(officeVisits.map((visit) => visit.fromId))
        const chatTargets = new Map()
        for (const visit of officeVisits) if (visit.phase === 'chat') chatTargets.set(visit.toId, visit)

        const desks = []
        for (let slot = 0; slot < TOTAL_DESKS; slot++) {
          const row = Math.floor(slot / DESK_COLS)
          const col = slot % DESK_COLS
          desks.push({ slot, x: col * pitchX, y: row * pitchY, agent: slotAgent.get(slot) || null })
        }
        desks.sort((a, b) => a.y - b.y || a.x - b.x)
        hitAreas = []

        const drawDeskBatch = (batch) => {
          for (const desk of batch) {
          const { x, y, agent } = desk
          const vacant = !agent
          const color = vacant ? '#555555' : agent.color || '#55ffff'
          const state = vacant ? 'vacant' : agent.state
          const chatVisit = vacant ? null : chatTargets.get(agent.id)
          const baseMode = vacant ? 'vacant' : state === 'err' ? 'error' : state === 'wait' ? 'idle' : state === 'run' ? 'busy' : 'idle'
          const mode = vacant
            ? 'vacant'
            : visitingIds.has(agent.id)
              ? 'away'
              : chatVisit && state !== 'err'
                ? 'talk'
                : baseMode
          const edge = hexA(color, vacant ? 0.15 : 0.55)

          // chair behind the desk
          solid(x + deskW * 0.3, y - 0.5, deskW * 0.4, 0.34, 0, 0.46, themed('rgba(20,20,20,1)', 'rgba(54,54,54,1)'), chairInk, themed('rgba(11,11,11,1)', 'rgba(64,64,64,1)'), hexA(color, 0.2))
          solid(x + deskW * 0.3, y - 0.56, deskW * 0.4, 0.08, 0.46, 0.92, themed('rgba(22,22,22,1)', 'rgba(50,50,50,1)'), chairInk, themed('rgba(12,12,12,1)', 'rgba(62,62,62,1)'), hexA(color, 0.3))

          // desk legs
          for (const [legX, legY] of [
            [x + 0.06, y + 0.06],
            [x + deskW - 0.06, y + 0.06],
            [x + 0.06, y + deskD - 0.06],
            [x + deskW - 0.06, y + deskD - 0.06],
          ]) {
            solid(legX - 0.035, legY - 0.035, 0.07, 0.07, 0, deskTopZ, themed('rgba(24,24,24,1)', 'rgba(48,48,48,1)'), legInk, themed('rgba(14,14,14,1)', 'rgba(58,58,58,1)'), hexA(color, 0.18))
          }
          // modesty panel
          quad(
            [iso(x + 0.08, y + deskD, 0.12), iso(x + deskW - 0.08, y + deskD, 0.12), iso(x + deskW - 0.08, y + deskD, deskTopZ - 0.02), iso(x + 0.08, y + deskD, deskTopZ - 0.02)],
            themed('rgba(10,10,10,1)', 'rgba(36,36,36,1)'),
            'rgba(85,255,255,0.12)',
          )
          // desk top slab
          solid(x, y, deskW, deskD, deskTopZ, deskTopZ + deskThick, topInk, frontInk, sideInk, edge)
          const bevelA = iso(x, y + deskD, deskTopZ + deskThick)
          const bevelB = iso(x + deskW, y + deskD, deskTopZ + deskThick)
          context.strokeStyle = topEdge
          context.lineWidth = 1
          context.beginPath()
          context.moveTo(bevelA.x, bevelA.y)
          context.lineTo(bevelB.x, bevelB.y)
          context.stroke()

          // keyboard
          const keyTop = deskTopZ + deskThick
          quad(
            [iso(x + deskW * 0.24, y + deskD * 0.58, keyTop), iso(x + deskW * 0.76, y + deskD * 0.58, keyTop), iso(x + deskW * 0.76, y + deskD * 0.84, keyTop), iso(x + deskW * 0.24, y + deskD * 0.84, keyTop)],
            themed('rgba(12,12,12,1)', 'rgba(42,42,42,1)'),
            hexA(color, vacant ? 0.18 : 0.4),
          )

          // monitor
          const monitorBase = iso(x + deskW * 0.5, y + deskD * 0.42, keyTop)
          const screenW = Math.max(34, s * 1.0)
          const screenH = Math.max(24, s * 0.6)
          const bezel = Math.max(2, s * 0.028)
          quad(
            [iso(x + deskW * 0.42, y + deskD * 0.34, keyTop), iso(x + deskW * 0.58, y + deskD * 0.34, keyTop), iso(x + deskW * 0.58, y + deskD * 0.46, keyTop), iso(x + deskW * 0.42, y + deskD * 0.46, keyTop)],
            'rgba(28,28,28,1)',
            'rgba(85,255,255,0.25)',
          )
          context.fillStyle = 'rgba(26,26,26,1)'
          context.fillRect(monitorBase.x - Math.max(1.5, s * 0.025), monitorBase.y - s * 0.3, Math.max(3, s * 0.05), s * 0.3)
          const screenX = monitorBase.x - screenW / 2
          const screenY = monitorBase.y - s * 0.3 - screenH
          context.fillStyle = 'rgba(8,8,8,1)'
          context.fillRect(screenX - bezel, screenY - bezel, screenW + bezel * 2, screenH + bezel * 2)
          context.strokeStyle = vacant ? 'rgba(85,85,85,0.4)' : hexA(color, 0.85)
          context.lineWidth = 1.2
          context.strokeRect(screenX - bezel + 0.5, screenY - bezel + 0.5, screenW + bezel * 2 - 1, screenH + bezel * 2 - 1)
          context.fillStyle = 'rgba(1,1,1,1)'
          context.fillRect(screenX, screenY, screenW, screenH)

          if (!vacant) {
            const innerX = screenX + 2
            const innerY = screenY + 2
            const innerW = screenW - 4
            const innerH = screenH - 4
            const kind = desk.slot % 3
            if (mode !== 'idle') {
              context.fillStyle = hexA(color, 0.06)
              context.fillRect(screenX, screenY, screenW, screenH)
              if (kind === 0) {
                const series = (agent.tpsHistory || []).slice(-24)
                const values = series.length > 1 ? series : [0, 0]
                const peak = Math.max(1, ...values)
                context.strokeStyle = hexA(color, 0.95)
                context.lineWidth = 1.2
                context.shadowColor = hexA(color, 0.8)
                context.shadowBlur = 6
                context.beginPath()
                for (let point = 0; point < values.length; point++) {
                  const px2 = innerX + (point / (values.length - 1)) * innerW
                  const py2 = innerY + innerH - 1 - (values[point] / peak) * (innerH - 2)
                  if (point === 0) context.moveTo(px2, py2)
                  else context.lineTo(px2, py2)
                }
                context.stroke()
                context.shadowBlur = 0
              } else if (kind === 1) {
                const bins = new Array(10).fill(0)
                const stamp = Date.now()
                for (const entry of agent.toolLog || []) {
                  const age = stamp - entry.t
                  if (age < 0 || age > TIMELINE_WINDOW) continue
                  const binIndex = clamp(9 - Math.floor(age / (TIMELINE_WINDOW / 10)), 0, 9)
                  bins[binIndex] += 1
                }
                const peak = Math.max(1, ...bins)
                const barW = innerW / bins.length
                for (let bar = 0; bar < bins.length; bar++) {
                  const barH = Math.max(1, Math.round((bins[bar] / peak) * (innerH - 2)))
                  context.fillStyle = hexA(color, 0.9)
                  context.fillRect(innerX + bar * barW + 0.5, innerY + innerH - 1 - barH, Math.max(1, barW - 1.5), barH)
                }
              } else {
                // queue view: always four slots so a short log never fills the screen
                const toolRows = (agent.tools || []).slice(-4)
                while (toolRows.length < 4) toolRows.unshift({ ms: 0, state: 'ok' })
                const rowH = innerH / 4
                for (let row = 0; row < toolRows.length; row++) {
                  const ms = toolRows[row].ms || 0
                  const width2 = Math.max(3, Math.min(1, ms / 1200) * innerW)
                  context.fillStyle = toolRows[row].state === 'err' ? 'rgba(255,85,85,0.95)' : hexA(color, ms === 0 ? 0.25 : 0.85)
                  context.fillRect(innerX, innerY + row * rowH + 1, width2, Math.max(1, rowH - 2))
                }
              }
            } else {
              context.strokeStyle = 'rgba(85,85,85,0.7)'
              context.beginPath()
              context.moveTo(innerX + 2, innerY + innerH * 0.68)
              context.lineTo(innerX + innerW - 2, innerY + innerH * 0.68)
              context.stroke()
            }
            if (mode === 'error') {
              const flash = 0.5 + 0.5 * Math.abs(Math.sin(now / 240))
              context.strokeStyle = 'rgba(255,85,85,' + flash.toFixed(2) + ')'
              context.lineWidth = 1.6
              context.strokeRect(screenX - bezel - 1.5, screenY - bezel - 1.5, screenW + bezel * 2 + 3, screenH + bezel * 2 + 3)
            }
          } else {
            context.strokeStyle = 'rgba(85,85,85,0.35)'
            context.beginPath()
            context.moveTo(screenX + 3, screenY + screenH * 0.6)
            context.lineTo(screenX + screenW - 3, screenY + screenH * 0.6)
            context.stroke()
          }

          // agent robot standing on the floor beside the desk
          if (!vacant && mode !== 'away') {
            const robotAnchor = iso(x + deskW * 0.9, y + deskD + 0.06, 0)
            drawAgentGirl(
              context,
              now,
              robotAnchor,
              Math.max(36, s * 1.45),
              color,
              mode,
              desk.slot,
              u,
              mode === 'talk' && chatVisit && chatVisit.pos
                ? { flip: chatVisit.pos.x < robotAnchor.x, reduced: reduceMotion }
                : { reduced: reduceMotion },
            )
          } else if (vacant) {
            solid(x + deskW * 0.74, y + deskD * 0.24, 0.24, 0.24, keyTop, keyTop + 0.2, 'rgba(18,18,18,1)', 'rgba(10,10,10,1)', 'rgba(14,14,14,1)', 'rgba(85,255,255,0.14)')
          }

          // desk props
          if (!vacant) {
            const mug = iso(x + deskW * 0.16, y + deskD * 0.3, keyTop)
            context.fillStyle = 'rgba(30,30,30,1)'
            context.fillRect(mug.x - s * 0.05, mug.y - s * 0.13, s * 0.1, s * 0.13)
            context.strokeStyle = hexA(color, 0.5)
            context.lineWidth = 1
            context.strokeRect(mug.x - s * 0.05, mug.y - s * 0.13, s * 0.1, s * 0.13)
            if (mode === 'idle') {
              context.strokeStyle = 'rgba(255,255,85,0.5)'
              context.beginPath()
              context.moveTo(mug.x, mug.y - s * 0.15)
              context.quadraticCurveTo(mug.x + s * 0.04, mug.y - s * 0.25, mug.x, mug.y - s * 0.35)
              context.stroke()
            }
          }

          // state lamp
          const lamp = iso(x + deskW - 0.14, y + deskD - 0.08, keyTop + 0.05)
          context.fillStyle = STATE_COLOR[state] || '#555555'
          context.shadowColor = context.fillStyle
          context.shadowBlur = state === 'run' ? 10 : 4
          context.fillRect(lamp.x - 2, lamp.y - 2, 4, 4)
          context.shadowBlur = 0

          // nameplate
          const plate = iso(x + deskW * 0.5, y + deskD + 0.34, 0)
          const labelSize = clamp(Math.round(s * 0.15), 8, 12)
          context.save()
          context.textAlign = 'center'
          context.textBaseline = 'alphabetic'
          if (vacant) {
            context.fillStyle = 'rgba(85,85,85,0.42)'
            context.font = Math.max(7, labelSize - 2) + 'px "JetBrains Mono", ui-monospace, monospace'
            context.fillText('VACANT', plate.x, plate.y)
          } else {
            const topText = agent.tag + '  ' + shownTps(agent).toFixed(1)
            const stateWord =
              mode === 'busy'
                ? 'WORKING'
                : mode === 'talk'
                  ? 'CHATTING'
                  : mode === 'away'
                    ? 'VISITING'
                    : mode === 'error'
                      ? 'ERROR'
                      : state === 'wait'
                        ? 'IDLE'
                        : 'STANDBY'
            const plateW = Math.max(36, topText.length * labelSize * 0.62 + 8)
            context.fillStyle = 'rgba(0,0,0,0.88)'
            context.fillRect(plate.x - plateW / 2, plate.y - labelSize - 3, plateW, labelSize + 7)
            context.strokeStyle = hexA(color, 0.5)
            context.lineWidth = 1
            context.strokeRect(plate.x - plateW / 2, plate.y - labelSize - 3, plateW, labelSize + 7)
            context.fillStyle = hexA(color, 1)
            context.font = '600 ' + labelSize + 'px "JetBrains Mono", ui-monospace, monospace'
            context.fillText(topText, plate.x, plate.y)
            context.fillStyle = STATE_COLOR[state] || '#aaaaaa'
            context.font = Math.max(6, labelSize - 4) + 'px "JetBrains Mono", ui-monospace, monospace'
            context.fillText(stateWord, plate.x, plate.y + labelSize - 1)
          }
          context.restore()

          if (!vacant) hitAreas.push({ id: agent.id, x: screenX - 8, y: screenY - 8, w: screenW + 16, h: screenH + 30 })
          }
        }

        // Social visits: draw every walking/talking visitor in the same depth layer
        // as the desk rows. Someone crossing the middle aisle is drawn between the
        // back and front rows so the foreground desks can occlude her; a visitor
        // chatting in front of a front-row desk is drawn after that desk.
        const drawVisitor = (visit) => {
          if (!visit.pos || !visit.phase) return
          const visitor = visit.fromSpot
          drawAgentGirl(
            context,
            now,
            visit.pos,
            visitor.height,
            visitor.agent.color,
            visit.phase === 'chat' ? 'talk' : 'walk',
            visit.seed,
            u,
            { flip: visit.flip, reduced: reduceMotion },
          )
          if (visit.phase === 'chat') {
            drawChatBubbles(
              context,
              now,
              visit.pos,
              visitor.height,
              visit.toSpot.anchor,
              visit.toSpot.height,
              visit.delegation,
              visit.seed,
              visit.alpha,
              visit.bubbleLift,
            )
          }
        }
        drawDeskBatch(desks.filter((desk) => desk.slot < DESK_COLS))
        for (const visit of officeVisits) if (visit.worldY < pitchY) drawVisitor(visit)
        drawDeskBatch(desks.filter((desk) => desk.slot >= DESK_COLS))
        for (const visit of officeVisits) if (visit.worldY >= pitchY) drawVisitor(visit)

        // foreground plants
        const drawPlant = (worldX, worldY, size) => {
          const base = iso(worldX, worldY, 0)
          const potW = s * size * 0.3
          context.save()
          context.fillStyle = 'rgba(14,14,14,1)'
          context.fillRect(base.x - potW / 2, base.y - potW * 0.9, potW, potW * 0.9)
          context.strokeStyle = 'rgba(85,255,85,0.7)'
          context.lineWidth = 1
          context.strokeRect(base.x - potW / 2, base.y - potW * 0.9, potW, potW * 0.9)
          for (let leaf = 0; leaf < 6; leaf++) {
            const angle = -Math.PI / 2 + (leaf - 2.5) * 0.38
            context.beginPath()
            context.moveTo(base.x, base.y - potW * 0.9)
            context.lineTo(base.x + Math.cos(angle) * s * size * 0.8, base.y - potW * 0.9 + Math.sin(angle) * s * size * 0.8)
            context.strokeStyle = leaf % 2 === 0 ? 'rgba(85,255,85,0.8)' : 'rgba(85,255,85,0.45)'
            context.stroke()
          }
          context.restore()
        }
        drawPlant(maxX - 0.5, maxY - 0.35, 1.0)
        drawPlant(minX + 0.7, maxY - 0.5, 0.8)

        if (agents.length === 0) {
          // idle sign on the foreground floor, clear of the desks
          context.save()
          context.textAlign = 'center'
          context.fillStyle = 'rgba(85,255,255,0.55)'
          context.font = '600 ' + Math.max(10, Math.round(areaW * 0.018)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('FLOOR IDLE · AWAITING UNITS', areaW / 2, areaH - 26)
          context.restore()
        }
      }

      /** Constellation view: delegation topology with message particles along every edge. */
      function drawNetwork(state, now) {
        const topology = state.topology || { nodes: [], edges: [] }
        const nodes = topology.nodes || []
        if (nodes.length === 0) {
          context.save()
          context.fillStyle = 'rgba(170,170,170,0.9)'
          context.font = '11px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = 'center'
          context.fillText('NO ACTIVE UNITS — CONSTELLATION STANDBY', width / 2, height / 2)
          context.restore()
          hitAreas = []
          return
        }
        const byId = new Map()
        for (const node of nodes) byId.set(node.id, node)
        const depthOf = (node) => {
          let depth = 0
          let cursor = node.parentId
          let guard = 0
          while (cursor && byId.has(cursor) && guard++ < 12) {
            depth += 1
            cursor = byId.get(cursor).parentId
          }
          return depth
        }
        const depths = new Map()
        let maxDepth = 0
        for (const node of nodes) {
          const depth = depthOf(node) + 1
          depths.set(node.id, depth)
          if (depth > maxDepth) maxDepth = depth
        }
        const children = new Map()
        const roots = []
        for (const node of nodes) {
          if (node.parentId && byId.has(node.parentId)) {
            if (!children.has(node.parentId)) children.set(node.parentId, [])
            children.get(node.parentId).push(node)
          } else {
            roots.push(node)
          }
        }
        let leafCursor = 0
        const slotOf = new Map()
        const visiting = new Set()
        const assignSlot = (node) => {
          if (slotOf.has(node.id)) return slotOf.get(node.id)
          if (visiting.has(node.id)) return 0
          visiting.add(node.id)
          const kids = children.get(node.id) || []
          let slot
          if (kids.length === 0) {
            slot = leafCursor++
          } else {
            const slots = kids.map(assignSlot)
            let sum = 0
            for (const value of slots) sum += value
            slot = sum / slots.length
          }
          visiting.delete(node.id)
          slotOf.set(node.id, slot)
          return slot
        }
        for (const root of roots) assignSlot(root)
        const padX = Math.max(72, width * 0.15)
        const padY = Math.max(58, height * 0.18)
        const stepX = maxDepth > 0 ? (width - padX * 2) / maxDepth : 0
        const span = height - padY * 2
        const leafCount = Math.max(1, leafCursor)
        const positions = new Map()
        for (const node of nodes) {
          const depth = depths.get(node.id) || 1
          const slot = slotOf.get(node.id)
          positions.set(node.id, {
            x: padX + depth * stepX,
            y: leafCount > 1 && slot !== undefined ? padY + (slot / (leafCount - 1)) * span : height / 2,
            depth,
          })
        }
        positions.set('__host', { x: padX, y: height / 2, depth: 0 })
        context.save()
        const paintEdge = (from, to, active, tps, label, labelColor) => {
          context.strokeStyle = active ? 'rgba(85,255,255,0.3)' : 'rgba(85,85,85,0.16)'
          context.lineWidth = active ? 1.4 : 1
          context.beginPath()
          context.moveTo(from.x, from.y)
          context.lineTo(to.x, to.y)
          context.stroke()
          const speed = 0.18 + Math.min(1.4, (tps || 0) / 40)
          const particles = active ? 3 : 1
          for (let index = 0; index < particles; index++) {
            const progress = (now * 0.00022 * speed + index / particles) % 1
            context.beginPath()
            context.arc(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress, active ? 2.2 : 1.4, 0, Math.PI * 2)
            context.fillStyle = active ? 'rgba(85,255,255,0.85)' : 'rgba(85,85,85,0.35)'
            context.shadowColor = 'rgba(85,255,255,0.9)'
            context.shadowBlur = active ? 10 : 0
            context.fill()
            context.shadowBlur = 0
          }
          // message pill on the edge (structural: parent delegates, child reports back)
          if (label) {
            const distance = Math.hypot(to.x - from.x, to.y - from.y)
            if (distance > 96) {
              const midX = (from.x + to.x) / 2
              const midY = (from.y + to.y) / 2
              context.save()
              context.font = '7px "JetBrains Mono", ui-monospace, monospace'
              const width = context.measureText(label).width + 10
              context.fillStyle = 'rgba(0,0,0,0.88)'
              context.fillRect(midX - width / 2, midY - 6, width, 12)
              context.strokeStyle = labelColor || 'rgba(85,255,255,0.5)'
              context.lineWidth = 1
              context.strokeRect(midX - width / 2 + 0.5, midY - 5.5, width - 1, 11)
              context.fillStyle = labelColor || 'rgba(85,255,255,0.9)'
              context.textAlign = 'center'
              context.textBaseline = 'middle'
              context.fillText(label, midX, midY + 0.5)
              context.restore()
            }
          }
        }
        for (const edge of topology.edges) {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          const toNode = byId.get(edge.to)
          if (!from || !to) continue
          paintEdge(from, to, Boolean(toNode && toNode.running), toNode ? toNode.tps || 0 : 0, 'delegate', toNode ? toNode.color : undefined)
        }
        const hostPosition = positions.get('__host')
        if (hostPosition) {
          for (const node of nodes) {
            const position = positions.get(node.id)
            if (!position || position.depth !== 1) continue
            paintEdge(hostPosition, position, node.running, node.tps || 0, 'session', node.color)
          }
        }
        context.restore()
        if (hostPosition) {
          context.save()
          context.translate(hostPosition.x, hostPosition.y)
          const core = 10 + Math.min(6, (state.totals.tps || 0) / 30)
          context.save()
          context.scale(core * 3.6, core * 3.6)
          context.fillStyle = glows.host
          context.beginPath()
          context.arc(0, 0, 1, 0, Math.PI * 2)
          context.fill()
          context.restore()
          context.strokeStyle = '#ff55ff'
          context.lineWidth = 1.8
          context.shadowColor = 'rgba(255,85,255,0.9)'
          context.shadowBlur = 14
          context.beginPath()
          context.arc(0, 0, core, 0, Math.PI * 2)
          context.stroke()
          context.shadowBlur = 0
          context.strokeStyle = 'rgba(85,255,255,0.8)'
          context.lineWidth = 1
          context.beginPath()
          context.arc(0, 0, core * 0.55, 0, Math.PI * 2)
          context.stroke()
          context.fillStyle = 'rgba(255,255,255,0.92)'
          context.font = '8px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = 'center'
          context.fillText('HOST', 0, -core - 8)
          context.restore()
        }
        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
          const node = nodes[nodeIndex]
          const position = positions.get(node.id)
          if (!position) continue
          const color = node.color || (node.running ? STATE_COLOR[node.state] || STATE_COLOR.sync : '#555555')
          const size = 6.5 + Math.min(9, (node.tps || 0) / 9)
          const pulse = node.running ? 0.6 + 0.4 * Math.sin(now / 430 + position.x * 0.05) : 0.42
          context.save()
          context.translate(position.x, position.y)
          context.save()
          context.scale(size * 3.4, size * 3.4)
          context.fillStyle = node.running ? glows.nodeCyan : glows.nodeDim
          context.beginPath()
          context.arc(0, 0, 1, 0, Math.PI * 2)
          context.fill()
          context.restore()
          context.globalAlpha = pulse
          context.strokeStyle = color
          context.lineWidth = 1.6
          context.shadowColor = color
          context.shadowBlur = node.running ? 14 : 0
          context.beginPath()
          for (let corner = 0; corner < 6; corner++) {
            const a = (corner / 6) * Math.PI * 2 + Math.PI / 6
            const px = Math.cos(a) * size
            const py = Math.sin(a) * size
            if (corner === 0) context.moveTo(px, py)
            else context.lineTo(px, py)
          }
          context.closePath()
          context.stroke()
          context.shadowBlur = 0
          context.globalAlpha = 1
          const above = nodeIndex % 2 === 0
          context.textAlign = 'center'
          const labelY = above ? -size - 9 : size + 15
          context.fillStyle = 'rgba(255,255,255,0.92)'
          context.font = '600 10px "JetBrains Mono", ui-monospace, monospace'
          context.fillText((node.tag || '·') + ' ' + String(node.name || '').slice(0, 18), 0, labelY)
          if (node.running && node.tps > 0) {
            context.fillStyle = 'rgba(85,255,255,0.75)'
            context.font = '8px "JetBrains Mono", ui-monospace, monospace'
            context.fillText((node.displayTps !== undefined ? node.displayTps : node.tps).toFixed(1) + ' EST T/S', 0, labelY + (above ? -10 : 10))
          }
          context.restore()
        }
        hitAreas = []
        for (const node of nodes) {
          const position = positions.get(node.id)
          if (position && node.running) hitAreas.push({ id: node.id, x: position.x, y: position.y })
        }
        context.save()
        context.fillStyle = 'rgba(85,85,85,0.9)'
        context.font = '8px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'left'
        context.fillText('DELEGATION TOPOLOGY · NODES ' + nodes.length + ' · EDGES ' + topology.edges.length + ' · CLICK A NODE TO FOCUS', 10, height - 12)
        context.restore()
      }

      function onResize() {
        // Window resize also covers devicePixelRatio changes (monitor switches);
        // layout-only changes are covered by the ResizeObserver below.
        measure()
      }
      const onCanvasClick = (event) => {
        const state = readState()
        if (!state || state.hidden) return
        if (state.mode !== 'net' && state.mode !== 'office' && state.mode !== 'radar') return
        const rect = canvas.getBoundingClientRect()
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        let best = null
        let bestDistance = 32 * 32
        for (const area of hitAreas) {
          if (area.w !== undefined) {
            // office desks are hit-tested as rectangles
            if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) {
              best = area.id
              break
            }
            continue
          }
          const dx = area.x - x
          const dy = area.y - y
          const distance = dx * dx + dy * dy
          if (distance < bestDistance) {
            bestDistance = distance
            best = area.id
          }
        }
        if (best && typeof onPick === 'function') onPick(best)
      }

      function observeStageSize() {
        if (typeof ResizeObserver === 'undefined') return
        try {
          resizeObserver = new ResizeObserver(() => {
            // The canvas box is the layout truth; 0×0 (display:none) is ignored
            // so hiding the canvas while focused never shrinks the backing store.
            measure()
          })
          resizeObserver.observe(canvas)
        } catch (err) {
          resizeObserver = null
        }
      }

      measure()
      observeStageSize()
      canvas.addEventListener('click', onCanvasClick)
      raf = window.requestAnimationFrame(draw)
      window.addEventListener('resize', onResize)
      return () => {
        window.cancelAnimationFrame(raf)
        window.removeEventListener('resize', onResize)
        canvas.removeEventListener('click', onCanvasClick)
        if (resizeObserver) {
          try {
            resizeObserver.disconnect()
          } catch (err) {
            /* ignore */
          }
          resizeObserver = null
        }
      }
    }
    //#endregion

    //#region components
    function WatchtowerIcon({ size, active }) {
      const edge = size || 20
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.78 },
        },
        h('path', {
          d: 'M12 2.4 20.9 7.4v9.2L12 21.6 3.1 16.6V7.4Z',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          opacity: 0.9,
        }),
        h('circle', { cx: 12, cy: 12, r: 3.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 12, cy: 12, r: 1.15, fill: 'currentColor' }),
        h('path', {
          d: 'M12 5.4v2.6M12 16v2.6M5.4 12h2.6M16 12h2.6',
          stroke: 'currentColor',
          strokeWidth: 1.1,
          opacity: 0.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function WatchtowerPage(props) {
      const rootRef = useRef(null)
      const monitor = props.monitor
      const theme = props.theme
      const [scheme, setScheme] = useState(() =>
        themeSchemeOf(theme && typeof theme.getSnapshot === 'function' ? theme.getSnapshot() : null),
      )
      activeScheme = scheme
      useEffect(() => {
        if (!theme || typeof theme.subscribe !== 'function') return undefined
        return theme.subscribe((snapshot) => setScheme(themeSchemeOf(snapshot)))
      }, [theme])
      const openRef = useRef(props.openSession)
      openRef.current = props.openSession
      const navRef = useRef(props.openConversation)
      navRef.current = props.openConversation
      const focusRef = useRef(null)
      const modeRef = useRef('office')
      const cinemaRef = useRef(false)
      const stageStateRef = useRef({
        agents: [],
        totals: { tps: 0 },
        focused: null,
        mode: 'office',
        hidden: false,
        topology: { nodes: [], edges: [] },
      })
      const lastRevRef = useRef(-1)

      useEffect(() => {
        const root = rootRef.current
        if (!root || !monitor) return undefined
        const canvas = root.querySelector('#nxt-canvas')
        if (!canvas) return undefined
        const $ = (id) => root.querySelector('#' + id)
        const refs = {
          count: $('nxt-c-count'),
          tps: $('nxt-c-tps'),
          alerts: $('nxt-c-alerts'),
          alertChip: $('nxt-c-alertchip'),
          tools: $('nxt-c-tools'),
          ctxBar: $('nxt-c-ctxbar'),
          ctxValue: $('nxt-c-ctx'),
          planBar: $('nxt-c-planbar'),
          planValue: $('nxt-c-plan'),
          clock: $('nxt-c-localtime'),
          wall: $('nxt-wall'),
          wallHint: $('nxt-wallhint'),
          rail: $('nxt-rail'),
          ticker: $('nxt-ticker'),
          stage: $('nxt-stage'),
          analyze: $('nxt-analyze'),
          hudTL: $('nxt-shud-tl'),
          hudTR: $('nxt-shud-tr'),
          hudBL: $('nxt-shud-bl'),
          hudBR: $('nxt-shud-br'),
          stageTitle: $('nxt-stage-title'),
          stageSub: $('nxt-stage-sub'),
          stageTag: $('nxt-stage-tag'),
          tray: $('nxt-standby-tray'),
        }

        const readView = () => {
          try {
            return monitor.getSnapshot()
          } catch (err) {
            return {
              agents: [],
              totals: { tps: 0, tpsDisplay: 0, count: 0, tin: 0, tout: 0, tools: 0, errors: 0, turns: 0 },
              alerts: [],
              log: [],
              history: [],
              toolBins: [],
              toolStats: [],
              recentCalls: [],
              filesAgg: [],
              models: [],
              plan: { done: 0, total: 0 },
              phaseMix: { think: 0, act: 0, out: 0, wait: 0 },
              rev: -1,
            }
          }
        }

        // Rewriting innerHTML at 10Hz would reset scroll position of the card wall;
        // only touch the DOM when the markup actually changed and keep the offset.
        const setHtml = (element, html) => {
          if (!element || element.__wtHtml === html) return
          element.__wtHtml = html
          const top = element.scrollTop
          element.innerHTML = html
          if (element.scrollTop !== top) element.scrollTop = top
        }

        const paint = () => {
          const view = readView()
          if (!view) return
          if (refs.clock) refs.clock.textContent = fmtClock(new Date())
          if (refs.count) refs.count.textContent = String(view.totals.count)
          if (refs.tps) refs.tps.textContent = (view.totals.tpsDisplay || view.totals.tps).toFixed(1)
          if (refs.alerts) refs.alerts.textContent = String(view.alerts.length)
          if (refs.tools) refs.tools.textContent = String(view.totals.tools)
          // aggregate context budget: only units with a known window contribute
          let ctxWindowSum = 0
          let ctxTokenSum = 0
          for (const agent of view.agents) {
            if (agent.cw > 0) {
              ctxWindowSum += agent.cw
              ctxTokenSum += agent.ctxTokens
            }
          }
          if (refs.ctxBar && refs.ctxBar.style) {
            const pct = ctxWindowSum > 0 ? clamp(Math.round((ctxTokenSum / ctxWindowSum) * 100), 0, 100) : 0
            refs.ctxBar.style.width = pct + '%'
            if (refs.ctxValue) refs.ctxValue.textContent = ctxWindowSum > 0 ? pct + '%' : fmtNum(view.totals.ctxTokens || 0)
          }
          const plan = view.plan || { done: 0, total: 0 }
          if (refs.planBar && refs.planBar.style) {
            refs.planBar.style.width = (plan.total > 0 ? Math.round((plan.done / plan.total) * 100) : 0) + '%'
            if (refs.planValue) refs.planValue.textContent = plan.total > 0 ? plan.done + '/' + plan.total : '—'
          }
          if (refs.alertChip) {
            const bad = view.alerts.length > 0 || view.totals.errors > 0
            refs.alertChip.className = 'nxt-chip' + (bad ? ' nxt-bad' : '')
          }
          const liveAgents = view.agents.filter((agent) => !agent.held)
          setHtml(
            refs.wall,
            liveAgents.length > 0
              ? liveAgents.slice(0, MAX_CARDS).map((agent) => cardHtml(agent, focusRef.current)).join('')
              : standbyHtml(),
          )
          if (refs.wallHint) {
            refs.wallHint.textContent =
              liveAgents.length > MAX_CARDS ? 'LIVE FEED +' + (liveAgents.length - MAX_CARDS) : 'LIVE FEED · ' + liveAgents.length
          }
          setHtml(refs.rail, railHtml(view))
          setHtml(refs.ticker, tickerHtml(view))
          const focusedAgent = view.agents.find((agent) => agent.id === focusRef.current)
          if (!focusedAgent && focusRef.current) focusRef.current = null
          const mode = modeRef.current
          const stageWidth = refs.stage && typeof refs.stage.clientWidth === 'number' ? refs.stage.clientWidth : 0
          // the bottom readout row needs room for four panels; below that the office gets full height
          const hudOn = !focusedAgent && mode !== 'net' && stageWidth >= 420
          if (refs.stage) refs.stage.classList.toggle('nxt-analyze-on', Boolean(focusedAgent))
          if (refs.stage) refs.stage.classList.toggle('nxt-net-on', !focusedAgent && mode === 'net')
          if (refs.stage) refs.stage.classList.toggle('nxt-hud-off', !hudOn)
          root.classList.toggle('nxt-focus-on', Boolean(focusedAgent))
          setHtml(refs.analyze, focusedAgent ? analyzeHtml(focusedAgent) : '')
          if (!focusedAgent) {
            const hud = stageHudHtml(view)
            setHtml(refs.hudTL, hud.tl)
            setHtml(refs.hudTR, hud.tr)
            setHtml(refs.hudBL, hud.bl)
            setHtml(refs.hudBR, hud.br)
          }
          if (refs.stageTitle) {
            refs.stageTitle.textContent = focusedAgent
              ? 'UNIT DISSECTION // ' + focusedAgent.tag
              : mode === 'net'
                ? 'AGENT CONSTELLATION'
                : mode === 'radar'
                  ? 'RADAR // AGGREGATE THROUGHPUT'
                  : 'OFFICE FLOOR // LIVE DESKS'
          }
          if (refs.stageSub) {
            refs.stageSub.textContent = focusedAgent
              ? (focusedAgent.name || '').toUpperCase()
              : mode === 'net'
                ? 'TOPOLOGY // LIVE UNITS'
                : mode === 'radar'
                  ? 'GLOBAL // ALL UNITS · REACTOR'
                  : 'ROOM 07 · ' + (view.totals.desks || 0) + ' SEATED' +
                    (view.totals.overflow > 0 ? ' +' + view.totals.overflow + ' STANDBY' : '') +
                    ' · DESK SCREENS = UNIT CHARTS'
          }
          if (refs.stageTag) {
            refs.stageTag.textContent = focusedAgent
              ? 'FOCUS ' + focusedAgent.tag + ' · [ESC] RELEASE'
              : 'SCAN ' + new Date().toISOString().slice(11, 19) + 'Z · CLICK A DESK TO FOCUS · [1-8] FOCUS · [M] MODE · [C] CINEMA'
          }
          const standbyAgents = view.agents.filter((agent) => agent.deskSlot < 0)
          if (refs.tray) {
            const visibleStandby = standbyAgents.slice(0, 5)
            setHtml(
              refs.tray,
              standbyAgents.length > 0
                ? '<div class="nxt-standby-h">STANDBY +' + standbyAgents.length + '</div>' +
                  visibleStandby
                    .map(
                      (agent) =>
                        '<button type="button" class="nxt-stby-row" data-id="' + esc(agent.id) + '" title="' +
                        esc((agent.name || '') + '\nCLICK: FOCUS') + '">' +
                        '<b>STBY</b><i style="color:' + esc(agent.color) + '">' + esc(agent.tag) + '</i>' +
                        '<span>' + esc(agent.name || '') + '</span></button>',
                    )
                    .join('') +
                  (standbyAgents.length > visibleStandby.length
                    ? '<div class="nxt-standby-h">+' + (standbyAgents.length - visibleStandby.length) + ' MORE</div>'
                    : '')
                : '',
            )
            refs.tray.hidden = standbyAgents.length === 0 || Boolean(focusedAgent) || mode !== 'office'
          }
          for (const button of root.querySelectorAll('[data-mode]')) {
            button.setAttribute('data-active', button.getAttribute('data-mode') === mode ? '1' : '0')
          }
          const cinemaButton = root.querySelector('[data-cinema]')
          if (cinemaButton) cinemaButton.setAttribute('data-active', cinemaRef.current ? '1' : '0')
          stageStateRef.current = {
            agents: view.agents,
            totals: view.totals,
            focused: focusRef.current,
            mode,
            hud: hudOn,
            hidden: Boolean(focusedAgent),
            topology: view.topology || { nodes: [], edges: [] },
            toolBins: view.toolBins || [],
            history: view.history || [],
            toolStats: view.toolStats || [],
          }
        }

        paint()
        const stopStage = startStage(canvas, () => stageStateRef.current, (id) => {
          focusRef.current = id
          paint()
        })

        const onStore = () => {
          const view = readView()
          if (!view || view.rev === lastRevRef.current) return
          lastRevRef.current = view.rev
          paint()
        }
        const unsubscribe = monitor.subscribe(onStore)
        const clockTimer = window.setInterval(() => {
          if (refs.clock) refs.clock.textContent = fmtClock(new Date())
        }, 1000)

        const openSession = (id) => {
          if (!id) return
          try {
            const workspace = openRef.current
            if (typeof workspace === 'function') workspace(id)
          } catch (err) {
            console.error('[watchtower] open session failed', err)
          }
        }

        const setCinema = (on) => {
          cinemaRef.current = on
          root.classList.toggle('nxt-cinema', on)
          paint()
        }

        const onRootClick = (event) => {
          const target = event.target
          if (!target || !target.closest) return
          const modeButton = target.closest('[data-mode]')
          if (modeButton) {
            const picked = modeButton.getAttribute('data-mode')
            modeRef.current = picked === 'net' ? 'net' : picked === 'radar' ? 'radar' : 'office'
            paint()
            return
          }
          if (target.closest('[data-cinema]')) {
            setCinema(!cinemaRef.current)
            return
          }
          if (target.closest('[data-focus-release]')) {
            focusRef.current = null
            paint()
            return
          }
          const nav = target.closest('[data-nav]')
          if (nav) {
            const destination = nav.getAttribute('data-nav')
            if (destination === 'conversation' && typeof navRef.current === 'function') navRef.current()
            return
          }
          // The card header has an explicit open-session button; focusing stays a
          // single click and never has to fight the double-click window.
          const openButton = target.closest('[data-open]')
          if (openButton) {
            openSession(openButton.getAttribute('data-open'))
            return
          }
          const card = target.closest('[data-id]')
          if (!card) return
          const id = card.getAttribute('data-id')
          if (!id) return
          focusRef.current = focusRef.current === id ? null : id
          paint()
        }

        const onKeyDown = (event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
          if (event.key === 'Escape') {
            if (focusRef.current) {
              event.preventDefault()
              focusRef.current = null
              paint()
              return
            }
            if (cinemaRef.current) {
              event.preventDefault()
              setCinema(false)
            }
            return
          }
          const slot = Number.parseInt(event.key, 10)
          if (slot >= 1 && slot <= DESK_COUNT) {
            const view = readView()
            const agent = view && view.agents ? view.agents.find((item) => item.deskSlot === slot - 1) : undefined
            if (agent) {
              event.preventDefault()
              focusRef.current = agent.id
              paint()
            }
            return
          }
          if (event.key === 'c' || event.key === 'C') {
            event.preventDefault()
            setCinema(!cinemaRef.current)
            return
          }
          if (event.key === 'm' || event.key === 'M') {
            event.preventDefault()
            modeRef.current = modeRef.current === 'office' ? 'radar' : modeRef.current === 'radar' ? 'net' : 'office'
            paint()
          }
        }
        root.addEventListener('click', onRootClick)
        document.addEventListener('keydown', onKeyDown)

        return () => {
          stopStage()
          unsubscribe()
          window.clearInterval(clockTimer)
          root.removeEventListener('click', onRootClick)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [monitor])

      return h('div', {
        className: 'nxt-root' + (scheme === 'light' ? ' nxt-light' : ''),
        ref: rootRef,
        dangerouslySetInnerHTML: { __html: '<style>' + CSS + '</style>' + SHELL },
      })
    }
    //#endregion

    //#region plugin
    const inject = ['slots', 'locale', 'sessions', 'theme']

    const LAUNCHER_CSS = `
.nxt-launcher{
  position:fixed; top:46px; right:8px; z-index:2147483000; width:20px; height:20px; display:grid; place-items:center;
  padding:0; border:1px solid rgba(85,255,255,0.32); background:rgba(0,0,0,0.9); color:#55ffff;
  cursor:pointer; box-shadow:0 0 8px rgba(85,255,255,0.2); transition:box-shadow .2s, border-color .2s, opacity .2s;
  border-radius:0; opacity:.55;
}
.nxt-launcher:hover{border-color:rgba(255,85,255,0.75); box-shadow:0 0 16px rgba(255,85,255,0.4); color:#55ffff; opacity:1}
.nxt-launcher.nxt-light{filter:invert(1) hue-rotate(180deg); opacity:.9}
`

    function WatchtowerLauncher(props) {
      const panelInfo = props.usePanelInfo ? props.usePanelInfo((snapshot) => snapshot) : null
      const theme = props.theme
      const [scheme, setScheme] = useState(() =>
        themeSchemeOf(theme && typeof theme.getSnapshot === 'function' ? theme.getSnapshot() : null),
      )
      useEffect(() => {
        if (!theme || typeof theme.subscribe !== 'function') return undefined
        return theme.subscribe((snapshot) => setScheme(themeSchemeOf(snapshot)))
      }, [theme])
      const alreadyOpen = Boolean(panelInfo && panelInfo.activePanelId === PANEL_ID)
      if (alreadyOpen) return null
      return h(
        React.Fragment,
        null,
        h('style', { key: 'st' }, LAUNCHER_CSS),
        h(
          'button',
          {
            key: 'launcher',
            type: 'button',
            className: 'nxt-launcher' + (scheme === 'light' ? ' nxt-light' : ''),
            title: 'Agent Deck // NX-07 agent telemetry',
            'aria-label': 'Open Agent Deck',
            onClick: () => {
              if (typeof props.openPanel === 'function') props.openPanel()
            },
          },
          h(WatchtowerIcon, { size: 13, active: true }),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'watchtower: dictionaries')
      const t = ctx.locale.bind(NS)
      const monitor = createMonitor(ctx)
      // Host theme: `ui-theme` resolves light | dark | system into the snapshot's
      // active.colorScheme; `theme/change` publishes later flips.
      const theme = {
        getSnapshot: () => ctx.theme.getTheme(),
        subscribe: (listener) => ctx.on('theme/change', listener),
      }
      activeScheme = themeSchemeOf(theme.getSnapshot())

      ctx.effect(() => {
        const timer = window.setInterval(() => monitor.flush(), FLUSH_MS)
        return () => {
          window.clearInterval(timer)
          monitor.dispose()
        }
      }, 'watchtower: telemetry flush')

      const openSession = (sessionId) => {
        try {
          const workspace = ctx.get ? ctx.get('uiWorkspace') : undefined
          if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
        } catch (err) {
          console.error('[watchtower] open session failed', err)
        }
      }

      const openConversation = () => {
        try {
          const layout = ctx.get ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('conversation')
        } catch (err) {
          console.error('[watchtower] back to conversation failed', err)
        }
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ monitor, theme, openSession, openConversation }),
          },
          WatchtowerPage,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => t('panel'),
            locale: NS,
          },
          WatchtowerIcon,
        ),
      )

      const openPanel = () => {
        try {
          const layout = ctx.get ? ctx.get('layout') : undefined
          if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
        } catch (err) {
          console.error('[watchtower] open panel failed', err)
        }
      }

      // Shells that replace the stock sidebar never render `sidebar.panellist`;
      // this frame-wide launcher keeps the console reachable there.
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'watchtower.launcher',
            locale: NS,
            inject: () => ({ openPanel, theme }),
          },
          WatchtowerLauncher,
        ),
      )
    }
    //#endregion

    return { inject, apply }
  },
})
