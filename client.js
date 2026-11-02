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
          state: agentState(rec),
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
          else records.get(id).row = row
        }
        for (const id of Array.from(records.keys())) {
          if (!wanted.has(id)) detach(id)
        }
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
  --nxt-ink:#aaaaaa; --nxt-ink2:#ffffff; --nxt-dim:#aaaaaa; --nxt-mute:#555555;
  --nxt-line:rgba(85,255,255,0.2);
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
  color:var(--nxt-dim); border:1px solid rgba(85,255,255,0.16); background:rgba(10,10,10,0.7); text-transform:uppercase; white-space:nowrap}
.nxt-chip b{color:var(--nxt-ink2); font-weight:600; font-variant-numeric:tabular-nums}
.nxt-chip i{font-style:normal; color:var(--nxt-dim); font-size:8px}
.nxt-chip.nxt-live{color:var(--nxt-cy); border-color:rgba(85,255,255,0.42)}
.nxt-dot{width:6px; height:6px; border-radius:50%; background:var(--nxt-cy); box-shadow:0 0 8px var(--nxt-cy); animation:nxt-pulse 1.6s ease-in-out infinite}
.nxt-chip.nxt-bad{color:var(--nxt-rd); border-color:rgba(255,85,85,0.5)}
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
.nxt-panel::before,.nxt-panel::after{content:""; position:absolute; width:11px; height:11px; pointer-events:none; opacity:.75}
.nxt-panel::before{top:-1px; left:-1px; border-top:2px solid var(--nxt-cy); border-left:2px solid var(--nxt-cy)}
.nxt-panel::after{bottom:-1px; right:-1px; border-bottom:2px solid var(--nxt-mg); border-right:2px solid var(--nxt-mg)}
.nxt-phead{display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 9px 5px;
  border-bottom:1px solid rgba(85,255,255,0.1); font-size:9px; letter-spacing:.22em; color:var(--nxt-cy); text-transform:uppercase}
.nxt-phead>span:first-child{flex:none}
.nxt-phint{color:var(--nxt-dim); letter-spacing:.16em; font-size:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; text-align:right}

.nxt-wall{overflow:auto; padding:8px; display:flex; flex-direction:column; gap:8px; min-height:0; flex:1 1 auto; scrollbar-width:thin}
.nxt-wall::-webkit-scrollbar{width:6px}
.nxt-wall::-webkit-scrollbar-thumb{background:rgba(85,255,255,0.25)}
.nxt-card{position:relative; border:1px solid rgba(85,255,255,0.18); background:linear-gradient(180deg, rgba(10,10,10,0.94), rgba(0,0,0,0.94));
  padding:7px 8px 6px; cursor:pointer; transition:border-color .18s, transform .18s, box-shadow .18s; border-left-width:2px;
  display:flex; flex-direction:column; flex:1 1 auto; min-height:158px; overflow:hidden}
.nxt-card:hover{border-color:rgba(85,255,255,0.42); box-shadow:0 0 18px rgba(85,255,255,0.1)}
.nxt-card[data-state="run"]{border-left-color:var(--nxt-cy); box-shadow:inset 2px 0 12px -6px var(--nxt-cy)}
.nxt-card[data-state="wait"]{border-left-color:var(--nxt-am)}
.nxt-card[data-state="err"]{border-left-color:var(--nxt-rd); animation:nxt-alarm 2.2s ease-in-out infinite}
.nxt-card[data-state="sync"]{border-left-color:var(--nxt-dim)}
.nxt-card[data-focused="1"]{border-color:var(--nxt-mg); box-shadow:0 0 22px rgba(255,85,255,0.18)}
.nxt-chead{display:flex; align-items:center; gap:7px; min-width:0; flex:none}
.nxt-cidx{font-size:9px; color:var(--nxt-mg); letter-spacing:.1em; flex:none}
.nxt-cname{font-size:12px; font-weight:600; color:#ffffff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-cstate{font-size:8px; letter-spacing:.18em; padding:1px 5px; border:1px solid currentColor; flex:none}
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
.nxt-sec{margin-top:5px; padding-top:4px; border-top:1px dashed rgba(85,255,255,0.1);
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
.nxt-cfoot{display:flex; gap:8px; margin-top:5px; padding-top:4px; border-top:1px solid rgba(85,255,255,0.08);
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
  background:rgba(0,0,0,0.78); border:1px solid rgba(85,255,255,0.18);
  font-size:9px; color:#aaaaaa; font-variant-numeric:tabular-nums; line-height:1.45}
.nxt-shud::before{content:""; position:absolute; top:-1px; left:-1px; width:8px; height:8px; border-top:1px solid #55ffff; border-left:1px solid #55ffff}
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
.nxt-chipsinline b{font-weight:600; font-size:7px; letter-spacing:.12em; color:#55ffff;
  border:1px solid rgba(85,255,255,0.35); padding:1px 4px; white-space:nowrap}
.nxt-chip .nxt-bar-wide{width:54px; height:5px; vertical-align:middle;
  background:repeating-linear-gradient(45deg, rgba(85,85,85,0.55) 0 2px, rgba(0,0,0,0.25) 2px 4px)}
.nxt-leader{display:flex; align-items:baseline; gap:6px; flex:1; min-width:0; overflow:hidden}
.nxt-leader>span{flex:none; color:#555555; font-size:7px; letter-spacing:.16em}
.nxt-leader>i{flex:1; min-width:8px; border-bottom:1px dotted rgba(85,255,255,0.28); transform:translateY(-2px)}
.nxt-leader>b{flex:none; max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aaaaaa; font-weight:500}

.nxt-ticker{display:flex; align-items:center; gap:14px; padding:4px 12px; border-top:1px solid var(--nxt-line);
  font-size:9px; color:#aaaaaa; letter-spacing:.08em; overflow:hidden; white-space:nowrap; background:rgba(0,0,0,0.9)}
.nxt-ticker .nxt-tk{flex:none; color:var(--nxt-cy); letter-spacing:.22em; font-size:8px}
.nxt-ticker .nxt-tv{overflow:hidden; text-overflow:ellipsis}
.nxt-ticker .nxt-ts{margin-left:auto; color:#555555; font-variant-numeric:tabular-nums; flex:none}

.nxt-scan,.nxt-vig{position:absolute; inset:0; pointer-events:none; z-index:6}
.nxt-scan{background:repeating-linear-gradient(180deg, rgba(85,255,255,.055) 0 1px, transparent 1px 3px); opacity:.55; mix-blend-mode:screen}
.nxt-vig{background:radial-gradient(125% 95% at 50% 42%, transparent 44%, rgba(0,0,0,.6) 100%)}
.nxt-sweep{position:absolute; left:0; right:0; height:110px; z-index:5; pointer-events:none;
  background:linear-gradient(180deg, transparent, rgba(85,255,255,0.05) 55%, rgba(85,255,255,0.12) 88%, transparent);
  animation:nxt-sweep 7.5s linear infinite}

@keyframes nxt-pulse{0%,100%{opacity:1; transform:scale(1)}50%{opacity:.35; transform:scale(.72)}}
@keyframes nxt-dot{0%,80%,100%{opacity:.2; transform:translateY(0)}40%{opacity:1; transform:translateY(-1px)}}
@keyframes nxt-blink{0%,100%{opacity:1}50%{opacity:.25}}
@keyframes nxt-alarm{0%,100%{box-shadow:inset 2px 0 12px -6px var(--nxt-rd)}50%{box-shadow:inset 2px 0 22px -4px rgba(255,85,85,0.9)}}
@keyframes nxt-sweep{0%{top:-24%}100%{top:104%}}
@keyframes nxt-glitch{
  0%,88%,100%{transform:none; text-shadow:none}
  89%{transform:translateX(1px); text-shadow:1px 0 var(--nxt-mg), -1px 0 var(--nxt-cy)}
  91%{transform:translateX(-1px); text-shadow:-1px 0 var(--nxt-mg), 1px 0 var(--nxt-cy)}
  93%{transform:none; text-shadow:none}
}
@media (prefers-reduced-motion: reduce){
  .nxt-root .nxt-title,.nxt-root .nxt-dot,.nxt-root .nxt-sweep,.nxt-root .nxt-alert,.nxt-root .nxt-card[data-state="err"]{animation:none}
}
.nxt-modes{display:flex; gap:4px; margin-left:8px; flex:none}
.nxt-mode{font:600 8px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.14em; padding:3px 6px; cursor:pointer;
  border:1px solid rgba(85,255,255,0.22); background:rgba(10,10,10,0.7); color:#aaaaaa; border-radius:0; text-transform:uppercase}
.nxt-mode:hover{color:#55ffff; border-color:rgba(85,255,255,0.5)}
.nxt-mode[data-active="1"]{color:#000000; background:#55ffff; border-color:#55ffff; box-shadow:none}
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
  border:1px solid rgba(85,255,255,0.14); background:linear-gradient(180deg, rgba(10,10,10,0.78), rgba(0,0,0,0.82)); padding:6px 7px}
.nxt-aw::before{content:""; position:absolute; top:-1px; left:-1px; width:9px; height:9px; border-top:2px solid var(--nxt-cy); border-left:2px solid var(--nxt-cy); opacity:.8}
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
  <div class="nxt-sweep"></div>
  <div class="nxt-scan"></div>
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
      const tr = '<div class="nxt-shud-h"><span>UNITS</span><span>' + view.agents.length + ' / 8 DESKS</span></div>' + units
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
    // reference sprite: the whale-girl sheet is keyed to transparency once, then
    // recoloured per agent by shifting only the blue hues (hair, tail, fins) and
    // leaving skin, lace and the navy dress untouched.
    const GIRL_SPRITE_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAADHCAIAAAARXM+YAAAQAElEQVR4Aez8B4AlRbU/jlfqcPvmO3dy3pnNOZPjkpakgEoSVFREsiBBARUQAQERkCA5K0iOkuPCLrCZzTs5z9ycOlXV//Sgvvf9v+/3/fTJsOFtbXV33e7qU6fO56Sq3l1SVlG/q+7EEiBoV9mpJbAL4J0aXoR2AbwL4J1cAjv59HZZ8C6Ad3IJ7OTT22XBuwDeKSXwv2ZSuyx4J4d6F8C7AN7JJbCTT2+XBe8CeCeXwE4+vV0WvAvgnVwCO/n0dlnw/y6Ad/LZ/i+c3i4L3slB3wXwLoB3cgns5NPbZcG7AN7JJbCTT2+XBe8CeCeXwE4+vV0WPArwznvaBfDOi+3ozHYBPCqGnfe0C+CdF9vRme0CeFQMO+9pF8A7L7ajM9sF8KgYdt7TzgIwlhJL75/SYYz+VhHcgYrwzovePzGzHRtgwI8rjghKXONT6ip948cFx88It8wNNc80Wlu1cZW0zi+jUqiuBPj/CXHsfF3+e4C36/ly6giVBionVzccUl9zbEPD1+rKD62u2qeqdveqhn3qag9rrP1GU+PxdU1HBmpaZEhKIrfr+YwNczsmwIq0jIJe3tQ8+aTahsP94VZFCVIMc5FSCun5ZvDWlDJVUUL+UGtD4zfiVbvxkPhfiDEIZWw0Z4yoYiR0wX1aZc2hDc1HaYEoRg7FmJC/TQQuWP4t6mKBCALY4eqWV+0WjDYiBaG/PUT/SwrZsebJ/S4NB6ur9o/4xrlOtmj3JQsbR5KrRkaWDw8tT6U2ZLNdVjEjXeEVyRHYs1fhQGFjhlQo2PeONeV/k9sdCWCpCuHH5cYCxN3e9FttnU92dzw13PNmcsuS1Oal6a2fDre/29v1Qlv74719r9lWGiECHhsjhDEYPmDsI6ofE7iB/veUHQdgLG3FiqNpmeLG7v6XzXQbTdhkSJIEIg4CL4xcjgocJyUesTODn7d1PJ5KbkRYwYQRwhzbElwQSRH/3wOuN1PinXaEw1VchGjG3VzMdmklleYUJBCYqMCcE0sPs8bxNbNnTpo3e2pLa40qGUqbfYOv9ncvy6aG8qlBu5DH3K6uiIybVFdWGyIQyCUQlDvC1P8tHncQgDEiFNOAFDmLlhhCGP5wzSVRd5/951526QX33377w/fce8/dd/3xrjvvvOXWyrqoP8Yaa4NOZo1dygmXM0INYl590cUP3vnHR+6654Zrrj766IOVSsl1C6GdGeYdBGCJSImxQY04FCEEeTJW0YL9pj/9h0eeuP+Jc844Z7899hrf2FhbUVFdVdnSPO6CU8974/HXlj659PbfXB3UmKYauVxm74Utu8+d01RZMWN8y4nHHnffHXe//fBfD198oBKif8u8MKiNdyC085QdA2AAQCo8GvePn90UqjSQxn2GctDcg2bNnYO4Le0Sli4RnAiHcRPb9kF771tfU00UWl5ZpVBk5hOzW7Qzf/itYCigaD6m6FhIxyqOm9Ry+F6LDZ8qFeEvV1um14UqfZJyuRNtiewAAAvBo5XG9759wm2/u/GuG2498dhvHH3UYbf89rrdps1imDJFpUyViEKWjMACEcrni+lUxrUdKeXKtR05057YGDzn9G/W19czxhD5Aj1BhSDcCfmC559+5ry500869pt/uP73t/z2huOOW+yrpJIKtFOU7Rtgihxizpo38c93P3TlpZftN3/BpLq6M7/93V+ec8kRBxwyuWW8XSiAJUrBM+lCX29aagYxIrkSL5iOFgwMDg2/9dYHJx89+4IffL06FqdYuKbVtrFvuD8pLJtInhpJThg3/rsnf/e2q3533o/OmTF1xsEHHHLTNTf//mfXNtSXSy813+FB3o4BxtIXYqd996QnH35i5qzpDEmGMZUiHDCk67olk2A82D8ClsodO5srtLX1rV695dXXP3rutY+fef2T627+8423Px8pa0DY99QLH/zpqTdef/X95cvX9XQNYEjYmJoruYP9qdrmOkpIIGBEomGGMXFthVtHHr7497+9Yc6ekwm4hh08BSPbr4rq/HunnvyTH/8kGPRDVkVVDWs6ZjrT9GLJSSRyhZL96Yqtjz+75LYH37jmtueu+eNzZ1x6+4VX3vfg80tf/GjzE68sf+eTjo/XDT34zNIX3l/74IsfX/ibx86/6qEbH3z12rtefviZj599adnISE4gMtw/Amk2dl1pW5i7FGE47zZ3/k2/vH7fA3dnvu1YRP8EeNsl9xjBplXrzMbvn/CdsqCfOhYCI7UsC8KqojCfz8H4r68vu+a2J2557LXrbn/6D/c+89Z7H7V3dQ4PDeZzKUiprFyKan7iC0lMHbPAuUtUQzB/1qYd/SOvvPXBb2555Lf3vnTjA6/9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'
    let girlBaseData = null
    let girlSpriteLoading = false
    const girlVariants = new Map()
    function ensureGirlSprite() {
      if (girlBaseData || girlSpriteLoading) return
      girlSpriteLoading = true
      let img = null
      try {
        img = new Image()
      } catch (err) {
        return
      }
      img.onload = function () {
        try {
          const cv = document.createElement('canvas')
          cv.width = img.width
          cv.height = img.height
          const g = cv.getContext('2d')
          g.drawImage(img, 0, 0)
          const data = g.getImageData(0, 0, cv.width, cv.height)
          const px = data.data
          const bgR = px[0]
          const bgG = px[1]
          const bgB = px[2]
          for (let i = 0; i < px.length; i += 4) {
            const d = Math.abs(px[i] - bgR) + Math.abs(px[i + 1] - bgG) + Math.abs(px[i + 2] - bgB)
            if (d < 52) px[i + 3] = 0
          }
          girlBaseData = { width: cv.width, height: cv.height, data: px }
        } catch (err) {
          girlBaseData = null
        }
      }
      img.onerror = function () {
        girlBaseData = null
      }
      img.src = GIRL_SPRITE_SRC
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
      const r = parseInt(h.slice(0, 2), 16)
      const g = parseInt(h.slice(2, 4), 16)
      const b = parseInt(h.slice(4, 6), 16)
      return rgbToHsl(r, g, b)[0]
    }
    function girlSpriteFor(color) {
      ensureGirlSprite()
      if (!girlBaseData) return null
      const targetHue = girlHue(color)
      const key = Math.round(targetHue)
      const cached = girlVariants.get(key)
      if (cached) return cached
      const cv = document.createElement('canvas')
      cv.width = girlBaseData.width
      cv.height = girlBaseData.height
      const g = cv.getContext('2d')
      const copy = new Uint8ClampedArray(girlBaseData.data)
      const px = copy
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue
        const r = px[i]
        const gg = px[i + 1]
        const b = px[i + 2]
        const hsl = rgbToHsl(r, gg, b)
        // only the blue parts of the sheet (hair, tail, fin tips) take the agent hue
        if (hsl[0] >= 168 && hsl[0] <= 285 && hsl[1] > 0.16 && hsl[2] > 0.28) {
          const out = hslToRgb(targetHue, Math.min(1, hsl[1] * 1.15), hsl[2])
          px[i] = out[0]
          px[i + 1] = out[1]
          px[i + 2] = out[2]
        }
      }
      g.putImageData(new ImageData(copy, girlBaseData.width, girlBaseData.height), 0, 0)
      girlVariants.set(key, cv)
      return cv
    }
    function drawAgentGirl(context, now, anchor, height, color, mode, seed, u) {
      const sprite = girlSpriteFor(color)
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
      const spriteH = H * 1.2
      const spriteW = spriteH * (sprite.width / sprite.height)
      const x = bx - spriteW / 2
      const y = feetY - spriteH
      context.save()
      context.fillStyle = 'rgba(0,0,0,0.38)'
      context.beginPath()
      if (typeof context.ellipse === 'function') {
        context.ellipse(bx, feetY + H * 0.006, spriteW * 0.32, H * 0.018, 0, 0, Math.PI * 2)
      } else {
        context.arc(bx, feetY + H * 0.006, H * 0.02, 0, Math.PI * 2)
      }
      context.fill()
      context.restore()
      context.save()
      context.globalAlpha = idle ? 0.9 : 1
      context.drawImage(sprite, x, y + bob, spriteW, spriteH)
      context.restore()
      if (busy) {
        for (let spark = 0; spark < 3; spark++) {
          const phase = ((now / 900) + spark / 3 + seed * 0.19) % 1
          context.fillStyle = 'rgba(255,255,255,' + ((1 - phase) * 0.6).toFixed(2) + ')'
          context.fillRect(
            bx - H * 0.1 + spark * H * 0.055,
            y - H * 0.04 - phase * H * 0.08,
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
        context.fillText('z', x + spriteW * 0.92, y + spriteH * 0.2 - drift * 6)
        context.fillText('z', x + spriteW * 1.08, y + spriteH * 0.12 - drift * 8)
      }
      if (error) {
        const flash = 0.45 + 0.55 * Math.abs(Math.sin(now / 230))
        context.fillStyle = 'rgba(255,85,85,' + flash.toFixed(2) + ')'
        context.font = '600 ' + Math.max(9, Math.round(13 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText('!', bx, y - H * 0.01)
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
          topGlow.addColorStop(0, 'rgba(85,255,255,0.3)')
          topGlow.addColorStop(1, 'rgba(85,255,255,0)')
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
          'rgba(85,255,255,0.2)',
        )
        quad(
          [iso(minX, minY, 0), iso(minX, maxY, 0), iso(minX, maxY, wallH), iso(minX, minY, wallH)],
          'rgba(7,7,7,0.99)',
          'rgba(85,255,255,0.16)',
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
        quad([iso(minX, minY, 1.9), iso(maxX, minY, 1.9), iso(maxX, minY, 2.04), iso(minX, minY, 2.04)], wallTrim, 'rgba(85,255,255,0.16)')
        const baseA = iso(minX, minY, 0.04)
        const baseB = iso(maxX, minY, 0.04)
        const baseGrad = context.createLinearGradient(baseA.x, baseA.y, baseB.x, baseB.y)
        baseGrad.addColorStop(0, 'rgba(85,255,255,0.05)')
        baseGrad.addColorStop(0.45, 'rgba(85,255,255,0.36)')
        baseGrad.addColorStop(1, 'rgba(85,255,255,0.06)')
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
        quad([iso(minX, minY, 0), iso(maxX, minY, 0), iso(maxX, maxY, 0), iso(minX, maxY, 0)], floorInk, 'rgba(85,255,255,0.16)')
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
          setHtml(
            refs.wall,
            view.agents.length > 0
              ? view.agents.slice(0, MAX_CARDS).map((agent) => cardHtml(agent, focusRef.current)).join('')
              : standbyHtml(),
          )
          if (refs.wallHint) {
            refs.wallHint.textContent =
              view.agents.length > MAX_CARDS ? 'LIVE FEED +' + (view.agents.length - MAX_CARDS) : 'LIVE FEED · ' + view.agents.length
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
      if (typeof document !== "undefined") ensureGirlSprite()
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
