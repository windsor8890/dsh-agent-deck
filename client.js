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
    const MAX_CARDS = 6
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
        tokens: { in: 0, out: 0, cache: 0, reasoning: 0 },
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
      const log = []
      const listeners = new Set()
      let view = {
        rev: 0,
        ts: Date.now(),
        agents: [],
        totals: { count: 0, tps: 0, tpsDisplay: 0, tin: 0, tout: 0, tools: 0, errors: 0, turns: 0 },
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
        const ctxTokens = inputTokens + fold.tokens.cache
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
          tokens: { in: inputTokens, out: outputTokens, cache: fold.tokens.cache, reasoning: fold.tokens.reasoning },
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

      function rebuild() {
        const agents = []
        for (const rec of records.values()) agents.push(toAgent(rec))
        agents.sort((a, b) => {
          const rank = (s) => (s === 'run' ? 0 : s === 'wait' ? 1 : s === 'err' ? 2 : 3)
          if (rank(a.state) !== rank(b.state)) return rank(a.state) - rank(b.state)
          return b.activity - a.activity
        })
        const totals = { count: agents.length, tps: 0, tin: 0, tout: 0, tools: 0, errors: 0, turns: 0 }
        const alerts = []
        let planDone = 0
        let planTotal = 0
        for (const a of agents) {
          totals.tps += a.tps
          totals.tin += a.ctxTokens
          totals.tout += a.tokens.out
          totals.tools += a.calls
          totals.errors += a.errors
          totals.turns += a.turn
          planDone += a.todoDone
          planTotal += a.todoTotal
          if (a.state === 'err') alerts.push({ level: 'err', text: a.name + ' — ' + (a.error || 'turn failed') })
          if (a.state === 'wait' && a.error) alerts.push({ level: 'warn', text: a.name + ' — ' + a.error })
        }
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
.nxt-stage.nxt-analyze-on .nxt-analyze{display:grid}
.nxt-stage.nxt-analyze-on canvas{display:none}
.nxt-stage.nxt-analyze-on .nxt-legend{display:none}
.nxt-stage.nxt-analyze-on .nxt-stage-tag{display:none}
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
      <span class="nxt-chip">THRUPUT <b id="nxt-c-tps">0.0</b><i>t/s</i></span>
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
        esc(agent.name + (agent.cwd ? '\n' + agent.cwd : '')) +
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
        '</span></div>' +
        '<div class="nxt-cmeta"><span class="nxt-leader"><span>MODEL</span><i></i><b>' +
        esc(agent.model || '—') +
        '</b></span><span>' +
        ctxMeta +
        '</span></div>' +
        '<div class="nxt-cspark"><span class="nxt-cspark-num" style="color:' +
        esc(agent.color) +
        '">' +
        shownTps(agent).toFixed(1) +
        '</span><span class="nxt-cspark-unit">t/s</span>' +
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
        '<div class="nxt-kvrow"><span>CACHE</span><b>' + fmtNum(agent.tokens.cache) + '</b></div>' +
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
        '<div class="nxt-kvrow"><span>NOW</span><b>' + shownTps(agent).toFixed(1) + ' t/s</b></div>' +
        '<div class="nxt-kvrow"><span>PEAK</span><b>' + peak.toFixed(1) + ' t/s</b></div>' +
        '</div>'
      return widgetFrame('THRUPUT TRACE', 'T/S', body)
    }

    function analyzeHtml(agent) {
      return contextWidget(agent) + taskWidget(agent) + matrixWidget(agent) + timelineWidget(agent) + filesWidget(agent) + tpsWidget(agent)
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
        '<div class="nxt-shud-h"><span>AGGREGATE · THROUGHPUT</span><span>' + stamp + '</span></div>' +
        '<div class="nxt-shud-grid">' +
        kvRow('ACTIVE', totals.count || 0) +
        kvRow('TURNS', totals.turns || 0) +
        kvRow('TOOLS', totals.tools || 0) +
        kvRow('ERRORS', totals.errors || 0) +
        kvRow('TOK IN', fmtNum(totals.tin || 0)) +
        kvRow('TOK OUT', fmtNum(totals.tout || 0)) +
        '</div>' +
        '<div class="nxt-shud-spark">' + sparkMarkup(series, '#55ffff', 34) + '</div>' +
        '<div class="nxt-shud-line"><span class="t">NOW</span><span class="nm">' +
        (totals.tpsDisplay || totals.tps || 0).toFixed(1) + ' T/S</span>' +
        '<span class="ms">PEAK ' + peak.toFixed(1) + '</span></div>'
      const units =
        view.agents
          .slice(0, 8)
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
      const tr = '<div class="nxt-shud-h"><span>UNITS</span><span>' + view.agents.length + ' / ' + MAX_CARDS + ' DESKS</span></div>' + units
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
          '<div class="nxt-kv"><span>ERRORS</span><b class="' + (totals.errors > 0 ? 'hot' : '') + '">' + totals.errors + '</b></div>',
      )

      const thruput =
        railBlock('THRUPUT', nowTps.toFixed(1) + ' t/s', ratioSpark(history)) +
        railBlock(
          'LIVE',
          '60s',
          '<div class="nxt-kv"><span>NOW</span><b>' + nowTps.toFixed(1) + '</b></div>' +
            '<div class="nxt-kv"><span>PEAK</span><b>' + peakTps.toFixed(1) + '</b></div>' +
            '<div class="nxt-kv"><span>SAMPLES</span><b>' + history.length + '</b></div>',
        )

      const unitRows = view.agents.length
        ? view.agents
            .slice(0, 8)
            .map(
              (a, index) =>
                '<div class="nxt-unit-row"><span class="nxt-ut" style="color:' + esc(a.color) + '">' + esc(a.tag) + '</span>' +
                '<span class="nxt-us" style="color:' + (STATE_COLOR[a.state] || STATE_COLOR.sync) + '">' + stateLabel(a.state) + '</span>' +
                '<span class="nxt-un">' + esc(a.name || '') + '</span>' +
                '<span class="nxt-unit-viz">' + unitViz(a, index) + '</span>' +
                '<span class="nxt-uv">' + shownTps(a).toFixed(1) + '</span></div>',
            )
            .join('')
        : '<div class="nxt-unit-row"><span class="nxt-un nxt-dim">no units</span></div>'
      const units = railBlock('UNITS', String(totals.count), unitRows)

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
          codeLine('window_ms', '60000', '# live window') +
          codeLine('think_cap', String(THINK_CAP), '# chars') +
          codeLine('out_cap', String(OUT_CAP), '# chars') +
          codeLine('tool_rows', String(MAX_TOOLS), '# per card') +
          codeLine('cards', String(MAX_CARDS), '# max units') +
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
        global + thruput + units + ctx + toolMixBlock + latencyBlock + phase + filesBlock + modelsBlock + configBlock + alerts + logBlock + system
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
        ' t/s · TOK ' +
        fmtNum(totals.tin) +
        '/' +
        fmtNum(totals.tout) +
        '</span>'
      )
    }
    //#endregion

    //#region canvas stage
    // reference sprites: four poses of the same whale-girl sheet. Backgrounds are
    // keyed to transparency once, blue pixels (hair, tail, fins) are recoloured per
    // agent, and the content bounding box keeps every pose aligned on the floor.
    const GIRL_SPRITE_SRC = {
      front: 'data:image/png;base64,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',
      side: 'data:image/png;base64,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',
      stand: 'data:image/png;base64,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',
      happy: 'data:image/png;base64,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',
      rest: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAADHCAIAAAARXM+YAAAQAElEQVR4Aez8B4AlRbU/jlfqcPvmO3dy3pnNOZPjkpakgEoSVFREsiBBARUQAQERkCA5K0iOkuPCLrCZzTs5z9ycOlXV//Sgvvf9v+/3/fTJsOFtbXV33e7qU6fO56Sq3l1SVlG/q+7EEiBoV9mpJbAL4J0aXoR2AbwL4J1cAjv59HZZ8C6Ad3IJ7OTT22XBuwDeKSXwv2ZSuyx4J4d6F8C7AN7JJbCTT2+XBe8CeCeXwE4+vV0WvAvgnVwCO/n0dlnw/y6Ad/LZ/i+c3i4L3slB3wXwLoB3cgns5NPbZcG7AN7JJbCTT2+XBe8CeCeXwE4+vV0WPArwznvaBfDOi+3ozHYBPCqGnfe0C+CdF9vRme0CeFQMO+9pF8A7L7ajM9sF8KgYdt7TzgIwlhJL75/SYYz+VhHcgYrwzovePzGzHRtgwI8rjghKXONT6ip948cFx88It8wNNc80Wlu1cZW0zi+jUqiuBPj/CXHsfF3+e4C36/ly6giVBionVzccUl9zbEPD1+rKD62u2qeqdveqhn3qag9rrP1GU+PxdU1HBmpaZEhKIrfr+YwNczsmwIq0jIJe3tQ8+aTahsP94VZFCVIMc5FSCun5ZvDWlDJVUUL+UGtD4zfiVbvxkPhfiDEIZWw0Z4yoYiR0wX1aZc2hDc1HaYEoRg7FmJC/TQQuWP4t6mKBCALY4eqWV+0WjDYiBaG/PUT/SwrZsebJ/S4NB6ur9o/4xrlOtmj3JQsbR5KrRkaWDw8tT6U2ZLNdVjEjXeEVyRHYs1fhQGFjhlQo2PeONeV/k9sdCWCpCuHH5cYCxN3e9FttnU92dzw13PNmcsuS1Oal6a2fDre/29v1Qlv74719r9lWGiECHhsjhDEYPmDsI6ofE7iB/veUHQdgLG3FiqNpmeLG7v6XzXQbTdhkSJIEIg4CL4xcjgocJyUesTODn7d1PJ5KbkRYwYQRwhzbElwQSRH/3wOuN1PinXaEw1VchGjG3VzMdmklleYUJBCYqMCcE0sPs8bxNbNnTpo3e2pLa40qGUqbfYOv9ncvy6aG8qlBu5DH3K6uiIybVFdWGyIQyCUQlDvC1P8tHncQgDEiFNOAFDmLlhhCGP5wzSVRd5/951526QX33377w/fce8/dd/3xrjvvvOXWyrqoP8Yaa4NOZo1dygmXM0INYl590cUP3vnHR+6654Zrrj766IOVSsl1C6GdGeYdBGCJSImxQY04FCEEeTJW0YL9pj/9h0eeuP+Jc844Z7899hrf2FhbUVFdVdnSPO6CU8974/HXlj659PbfXB3UmKYauVxm74Utu8+d01RZMWN8y4nHHnffHXe//fBfD198oBKif8u8MKiNdyC085QdA2AAQCo8GvePn90UqjSQxn2GctDcg2bNnYO4Le0Sli4RnAiHcRPb9kF771tfU00UWl5ZpVBk5hOzW7Qzf/itYCigaD6m6FhIxyqOm9Ry+F6LDZ8qFeEvV1um14UqfZJyuRNtiewAAAvBo5XG9759wm2/u/GuG2498dhvHH3UYbf89rrdps1imDJFpUyViEKWjMACEcrni+lUxrUdKeXKtR05057YGDzn9G/W19czxhD5Aj1BhSDcCfmC559+5ry500869pt/uP73t/z2huOOW+yrpJIKtFOU7Rtgihxizpo38c93P3TlpZftN3/BpLq6M7/93V+ec8kRBxwyuWW8XSiAJUrBM+lCX29aagYxIrkSL5iOFgwMDg2/9dYHJx89+4IffL06FqdYuKbVtrFvuD8pLJtInhpJThg3/rsnf/e2q3533o/OmTF1xsEHHHLTNTf//mfXNtSXSy813+FB3o4BxtIXYqd996QnH35i5qzpDEmGMZUiHDCk67olk2A82D8ClsodO5srtLX1rV695dXXP3rutY+fef2T627+8423Px8pa0DY99QLH/zpqTdef/X95cvX9XQNYEjYmJoruYP9qdrmOkpIIGBEomGGMXFthVtHHr7497+9Yc6ekwm4hh08BSPbr4rq/HunnvyTH/8kGPRDVkVVDWs6ZjrT9GLJSSRyhZL96Yqtjz+75LYH37jmtueu+eNzZ1x6+4VX3vfg80tf/GjzE68sf+eTjo/XDT34zNIX3l/74IsfX/ibx86/6qEbH3z12rtefviZj599adnISE4gMtw/Amk2dl1pW5i7FGE47zZ3/k2/vH7fA3dnvu1YRP8EeNsl9xjBplXrzMbvn/CdsqCfOhYCI7UsC8KqojCfz8H4r68vu+a2J2557LXrbn/6D/c+89Z7H7V3dQ4PDeZzKUiprFyKan7iC0lMHbPAuUtUQzB/1qYd/SOvvPXBb2555Lf3vnTjA6/9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',
    }
    const girlPoseData = {}
    const girlVariants = new Map()
    let girlSpritesLoading = false
    function keyGirlPose(img) {
      try {
        const cv = document.createElement('canvas')
        cv.width = img.width
        cv.height = img.height
        const g = cv.getContext('2d')
        g.drawImage(img, 0, 0)
        const imageData = g.getImageData(0, 0, cv.width, cv.height)
        const px = imageData.data
        const bgR = px[0]
        const bgG = px[1]
        const bgB = px[2]
        let minX = cv.width
        let minY = cv.height
        let maxX = 0
        let maxY = 0
        for (let i = 0; i < px.length; i += 4) {
          const d = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB)
          if (d < 52) {
            px[i + 3] = 0
            continue
          }
          if (px[i + 3] < 16) continue
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
    function ensureGirlSprites() {
      // retry any pose that is not decoded yet; each pose is loaded at most once
      // at a time so a missing image never blocks the others forever
      for (const pose of Object.keys(GIRL_SPRITE_SRC)) {
        if (girlPoseData[pose] || girlLoadingPoses.has(pose)) continue
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
            } catch (err) {
              // ignore a broken decode; the pose stays missing
            }
            finish()
          }
          img.onerror = finish
          img.src = GIRL_SPRITE_SRC[pose]
        } catch (err) {
          finish()
          return
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
      // state -> reference pose (set by the operator):
      // busy uses the arms-up pose, idle the closed-eye one, error the plain front pose
      if (mode === 'busy') return 'stand'
      if (mode === 'idle') return 'happy'
      if (mode === 'error') return 'rest'
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
    function drawAgentGirl(context, now, anchor, height, color, mode, seed, u) {
      const sprite = girlSpriteFor(mode, color)
      if (!sprite) {
        drawAgentGirlArt(context, now, anchor, height, color, mode, seed, u)
        return
      }
      const busy = mode === 'busy'
      const idle = mode === 'idle'
      const error = mode === 'error'
      const H = height
      const bob = busy ? Math.sin(now / 300 + seed) * H * 0.008 : idle ? Math.sin(now / 1600 + seed) * H * 0.004 : 0
      const sway = idle ? Math.sin(now / 1600 + seed) * H * 0.004 : 0
      const bx = anchor.x + sway
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
      context.globalAlpha = idle ? 0.92 : 1
      context.drawImage(sprite.canvas, dx, dy, drawW, drawH)
      context.restore()
      if (busy) {
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
        const drift = (now / 1900 + seed) % 1
        context.fillText('z', dx + drawW * 0.86, dy + drawH * 0.18 - drift * 6)
        context.fillText('z', dx + drawW * 1.02, dy + drawH * 0.1 - drift * 8)
      }
      if (error) {
        const flash = 0.45 + 0.55 * Math.abs(Math.sin(now / 230))
        context.fillStyle = 'rgba(255,85,85,' + flash.toFixed(2) + ')'
        context.font = '600 ' + Math.max(9, Math.round(13 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText('!', bx, dy - H * 0.02)
      }
    }

    function drawAgentGirlArt(context, now, anchor, height, color, mode, seed, u) {
      const H = height
      const busy = mode === 'busy'
      const idle = mode === 'idle'
      const error = mode === 'error'
      const bob = busy ? Math.sin(now / 300 + seed) * H * 0.01 : idle ? Math.sin(now / 1600 + seed) * H * 0.005 : 0
      const sway = idle ? Math.sin(now / 1600 + seed) * H * 0.007 : 0
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

      function resize() {
        const rect = canvas.getBoundingClientRect()
        dpr = Math.min(2, window.devicePixelRatio || 1)
        width = Math.max(1, Math.floor(rect.width))
        height = Math.max(1, Math.floor(rect.height))
        canvas.width = Math.floor(width * dpr)
        canvas.height = Math.floor(height * dpr)
      }

      function draw() {
        raf = window.requestAnimationFrame(draw)
        const state = readState()
        const now = performance.now()
        const dt = lastSample === 0 ? 16 : Math.min(120, now - lastSample)
        lastSample = now
        if (!reduceMotion) angle += dt * 0.00035 * (1 + Math.min(6, state.totals.tps) * 0.12)
        if (width === 0 || height === 0) resize()
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
        context.fillText('TOKENS / SEC · AGGREGATE', cx, cy - coreR * 1.45 + 13)
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
        const DESK_COLS = 3
        const DESK_ROWS = 2
        const TOTAL_DESKS = DESK_COLS * DESK_ROWS

        // shallow isometric (2.5D): rows run horizontally, depth recedes up-right
        const pitchX = 2.6
        const pitchY = 3.4
        const deskW = 1.8
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

        const wallInk = 'rgba(11,11,11,0.99)'
        const wallTrim = 'rgba(20,20,20,0.99)'
        const floorInk = 'rgba(4,4,4,1)'
        const topInk = 'rgba(27,27,27,1)'
        const topEdge = 'rgba(48,48,48,1)'
        const frontInk = 'rgba(13,13,13,1)'
        const sideInk = 'rgba(9,9,9,1)'
        const legInk = 'rgba(19,19,19,1)'
        const chairInk = 'rgba(15,15,15,1)'
        const panelInk = 'rgba(2,2,2,0.98)'

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

        // backdrop
        context.save()
        context.fillStyle = 'rgba(0,0,0,1)'
        context.fillRect(0, 0, areaW, areaH)
        // extend the wall upward when the stage is taller than the room
        const wallTopScreen = originY + minPY * s
        if (wallTopScreen > 0) {
          const extGrad = context.createLinearGradient(0, 0, 0, wallTopScreen)
          extGrad.addColorStop(0, 'rgba(8,8,8,1)')
          extGrad.addColorStop(1, 'rgba(11,11,11,1)')
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
          'UNITS ' + String(totals.count || 0).padStart(2, '0') + ' / ' + TOTAL_DESKS +
            '   ·   ' + (totals.tpsDisplay !== undefined ? totals.tpsDisplay : totals.tps || 0).toFixed(1) + ' T/S' +
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
        agents.slice(0, TOTAL_DESKS).forEach((agent, index) => {
          const slot = slots[index]
          slotAgent.set(slot.row * DESK_COLS + slot.col, agent)
        })

        const desks = []
        for (let slot = 0; slot < TOTAL_DESKS; slot++) {
          const row = Math.floor(slot / DESK_COLS)
          const col = slot % DESK_COLS
          desks.push({ slot, x: col * pitchX, y: row * pitchY, agent: slotAgent.get(slot) || null })
        }
        desks.sort((a, b) => a.y - b.y || a.x - b.x)
        hitAreas = []

        for (const desk of desks) {
          const { x, y, agent } = desk
          const vacant = !agent
          const color = vacant ? '#555555' : agent.color || '#55ffff'
          const state = vacant ? 'vacant' : agent.state
          const mode = vacant ? 'vacant' : state === 'err' ? 'error' : state === 'wait' ? 'idle' : state === 'run' ? 'busy' : 'idle'
          const edge = hexA(color, vacant ? 0.15 : 0.55)

          // chair behind the desk
          solid(x + deskW * 0.3, y - 0.5, deskW * 0.4, 0.34, 0, 0.46, 'rgba(20,20,20,1)', chairInk, 'rgba(11,11,11,1)', hexA(color, 0.2))
          solid(x + deskW * 0.3, y - 0.56, deskW * 0.4, 0.08, 0.46, 0.92, 'rgba(22,22,22,1)', chairInk, 'rgba(12,12,12,1)', hexA(color, 0.3))

          // desk legs
          for (const [legX, legY] of [
            [x + 0.06, y + 0.06],
            [x + deskW - 0.06, y + 0.06],
            [x + 0.06, y + deskD - 0.06],
            [x + deskW - 0.06, y + deskD - 0.06],
          ]) {
            solid(legX - 0.035, legY - 0.035, 0.07, 0.07, 0, deskTopZ, 'rgba(24,24,24,1)', legInk, 'rgba(14,14,14,1)', hexA(color, 0.18))
          }
          // modesty panel
          quad(
            [iso(x + 0.08, y + deskD, 0.12), iso(x + deskW - 0.08, y + deskD, 0.12), iso(x + deskW - 0.08, y + deskD, deskTopZ - 0.02), iso(x + 0.08, y + deskD, deskTopZ - 0.02)],
            'rgba(10,10,10,1)',
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
            'rgba(12,12,12,1)',
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
          if (!vacant) {
            const robotAnchor = iso(x + deskW * 0.9, y + deskD + 0.06, 0)
            drawAgentGirl(context, now, robotAnchor, Math.max(36, s * 1.45), color, mode, desk.slot, u)
          } else {
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
            const stateWord = mode === 'busy' ? 'WORKING' : mode === 'error' ? 'ERROR' : state === 'wait' ? 'IDLE' : 'STANDBY'
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
            context.fillText((node.displayTps !== undefined ? node.displayTps : node.tps).toFixed(1) + ' T/S', 0, labelY + (above ? -10 : 10))
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
        width = 0
        resize()
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

      resize()
      canvas.addEventListener('click', onCanvasClick)
      raf = window.requestAnimationFrame(draw)
      window.addEventListener('resize', onResize)
      return () => {
        window.cancelAnimationFrame(raf)
        window.removeEventListener('resize', onResize)
        canvas.removeEventListener('click', onCanvasClick)
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
            if (refs.ctxValue) refs.ctxValue.textContent = ctxWindowSum > 0 ? pct + '%' : fmtNum(view.totals.tin)
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
                  : 'ROOM 07 · ' + view.agents.length + ' ACTIVE · DESK SCREENS = UNIT CHARTS'
          }
          if (refs.stageTag) {
            refs.stageTag.textContent = focusedAgent
              ? 'FOCUS ' + focusedAgent.tag + ' · [ESC] RELEASE'
              : 'SCAN ' + new Date().toISOString().slice(11, 19) + 'Z · CLICK A DESK TO FOCUS · [1-8] FOCUS · [M] MODE · [C] CINEMA'
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
          const nav = target.closest('[data-nav]')
          if (nav) {
            const destination = nav.getAttribute('data-nav')
            if (destination === 'conversation' && typeof navRef.current === 'function') navRef.current()
            return
          }
          const card = target.closest('[data-id]')
          if (!card) return
          const id = card.getAttribute('data-id')
          if (!id) return
          if (event.detail === 2) {
            openSession(id)
            return
          }
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
          if (slot >= 1 && slot <= 8) {
            const view = readView()
            const agent = view && view.agents ? view.agents[slot - 1] : undefined
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
        className: 'nxt-root',
        ref: rootRef,
        dangerouslySetInnerHTML: { __html: '<style>' + CSS + '</style>' + SHELL },
      })
    }
    //#endregion

    //#region plugin
    const inject = ['slots', 'locale', 'sessions']

    const LAUNCHER_CSS = `
.nxt-launcher{
  position:fixed; top:46px; right:8px; z-index:2147483000; width:20px; height:20px; display:grid; place-items:center;
  padding:0; border:1px solid rgba(85,255,255,0.32); background:rgba(0,0,0,0.9); color:#55ffff;
  cursor:pointer; box-shadow:0 0 8px rgba(85,255,255,0.2); transition:box-shadow .2s, border-color .2s, opacity .2s;
  border-radius:0; opacity:.55;
}
.nxt-launcher:hover{border-color:rgba(255,85,255,0.75); box-shadow:0 0 16px rgba(255,85,255,0.4); color:#55ffff; opacity:1}
`

    function WatchtowerLauncher(props) {
      const panelInfo = props.usePanelInfo ? props.usePanelInfo((snapshot) => snapshot) : null
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
            className: 'nxt-launcher',
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
      if (typeof document !== "undefined") ensureGirlSprites()
      const monitor = createMonitor(ctx)

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
            inject: () => ({ monitor, openSession, openConversation }),
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
            inject: () => ({ openPanel }),
          },
          WatchtowerLauncher,
        ),
      )
    }
    //#endregion

    return { inject, apply }
  },
})
