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
    // Owner-tunable behaviours persisted per browser. Visits and desk actions are
    // cosmetic; changing them never writes anything back to the Host.
    const PREFS_KEY = 'agent-deck:prefs:v1'
    const DEFAULT_PREFS = { visits: true, visitPace: 'chill', maxVisitors: 2, actions: true, cinemaSkin: 'cozy' }
    const VISIT_PACE_MULT = { chill: 1.5, normal: 1, lively: 0.65 }
    function normalizePrefs(parsed) {
      const value = parsed && typeof parsed === 'object' ? parsed : {}
      return {
        visits: value.visits !== false,
        visitPace: value.visitPace === 'normal' || value.visitPace === 'lively' ? value.visitPace : 'chill',
        maxVisitors: value.maxVisitors === 1 ? 1 : 2,
        actions: value.actions !== false,
        cinemaSkin: value.cinemaSkin === 'cold' ? 'cold' : 'cozy',
      }
    }
    function visitPaceFor(prefs) {
      return VISIT_PACE_MULT[(prefs && prefs.visitPace) || 'chill'] || 1
    }
    function visitLimitFor(seatedCount, prefs, reduced) {
      if (reduced || !prefs || prefs.visits === false) return 0
      const cap = prefs.maxVisitors === 1 ? 1 : 2
      return Math.max(1, Math.min(cap, Math.floor(seatedCount / 2) || 1))
    }
    function waitActionFor(agent, prefs, now, reduced) {
      if (reduced || !prefs || prefs.actions === false || !agent || agent.held || agent.state !== 'wait') return ''
      if (agent.pending) return 'slack'
      const slot = Number.isInteger(agent.deskSlot) && agent.deskSlot >= 0 ? agent.deskSlot : 0
      return Math.floor(now / 24000 + slot) % 2 === 0 ? 'slack' : 'game'
    }
    function loadPrefs() {
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        if (!raw) return { ...DEFAULT_PREFS }
        return normalizePrefs(JSON.parse(raw))
      } catch (err) {
        return { ...DEFAULT_PREFS }
      }
    }
    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
      } catch (err) {
        /* private mode / storage disabled: keep the in-memory value */
      }
    }

    const DICT = {
      zh: {
        panel: '作战室',
        title: '作战室',
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
        panel: 'Agent Deck',
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
    function markPhase(f, kind, at, attemptId) {
      const time = at || Date.now()
      const last = f.phases[f.phases.length - 1]
      if (last && last.kind === kind && last.attemptId === attemptId) {
        last.until = time
        return
      }
      f.phases.push({ t: time, kind, until: time, attemptId })
      if (f.phases.length > MAX_PHASES) f.phases.splice(0, f.phases.length - MAX_PHASES)
    }

    function logTool(f, id, name, at) {
      f.toolLog.push({ id, t: at || Date.now(), name: String(name || 'tool'), state: 'run' })
      if (f.toolLog.length > MAX_TOOLLOG) f.toolLog.splice(0, f.toolLog.length - MAX_TOOLLOG)
    }

    function settleLastTool(f, id, state, elapsed) {
      for (let i = f.toolLog.length - 1; i >= 0; i--) {
        const entry = f.toolLog[i]
        if (entry.id === id && entry.state === 'run') {
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
        // Identity survives the display cap; released at the next turn boundary.
        toolById: new Map(),
        runningTools: 0,
        attempts: new Map(),
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

    function bumpChars(f, text, at, attemptId) {
      if (!text) return
      const now = at || Date.now()
      f.chars.push({ t: now, n: text.length, attemptId })
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
      if (row.id && f.toolById.has(row.id)) return f.toolById.get(row.id)
      if (row.id) f.toolById.set(row.id, row)
      f.tools.push(row)
      f.calls += 1
      if (row.state === 'run') f.runningTools += 1
      if (f.tools.length > MAX_TOOLS) {
        const running = f.tools.filter((t) => t.state === 'run').slice(-MAX_TOOLS)
        const keepDone = Math.max(0, MAX_TOOLS - running.length)
        const done = keepDone > 0 ? f.tools.filter((t) => t.state !== 'run').slice(-keepDone) : []
        f.tools = done.concat(running).sort((a, b) => (a.at || 0) - (b.at || 0))
      }
      return row
    }

    function applyChunk(f, chunk, at, attemptId) {
      if (!chunk || typeof chunk !== 'object') return
      switch (chunk.type) {
        case 'reasoning-delta':
          f.pendingThink += chunk.text || ''
          if (f.pendingThink.length > THINK_CAP * 3) f.pendingThink = f.pendingThink.slice(-THINK_CAP * 3)
          f.think = tail(f.pendingThink, THINK_CAP)
          bumpChars(f, chunk.text, at, attemptId)
          markPhase(f, 'think', at, attemptId)
          break
        case 'text-delta':
          f.pendingText += chunk.text || ''
          if (f.pendingText.length > OUT_CAP * 3) f.pendingText = f.pendingText.slice(-OUT_CAP * 3)
          f.out = tail(f.pendingText, OUT_CAP)
          bumpChars(f, chunk.text, at, attemptId)
          markPhase(f, 'out', at, attemptId)
          break
        case 'tool-call-delta': {
          let row = chunk.id ? f.toolById.get(chunk.id) : undefined
          markPhase(f, 'act', at, attemptId)
          if (!row) {
            row = { id: chunk.id || 'live-' + f.calls, name: chunk.name || 'tool', arg: '', state: 'run', at: at || Date.now() }
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
            const row = f.toolById.get(block.id)
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
          f.toolById.clear()
          f.runningTools = 0
          f.attempts.clear()
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
              let row = f.toolById.get(block.id)
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
          const row = pushTool(f, {
            id: data.callId,
            name: data.name || 'tool',
            arg: argPreview(data.name, data.arguments),
            state: 'run',
            at,
          })
          // Execution begins at tool/call, after any streamed declaration.
          row.at = at
          row.name = data.name || row.name
          row.arg = argPreview(row.name, data.arguments)
          logTool(f, data.callId, data.name || 'tool', at)
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
          const row = f.toolById.get(message.toolCallId)
          const failed = Boolean(data.error || message.isError)
          const elapsed = row && row.at ? Math.max(0, (event.time || Date.now()) - row.at) : 0
          if (row) {
            if (row.state === 'run') f.runningTools = Math.max(0, f.runningTools - 1)
            row.state = failed ? 'err' : 'ok'
            row.ms = elapsed
            settleLastTool(f, row.id, failed ? 'err' : 'ok', elapsed)
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
          for (const row of f.toolById.values()) {
            if (row.state === 'run') {
              row.state = 'stopped'
              settleLastTool(f, row.id, 'stopped')
            }
          }
          f.runningTools = 0
          markPhase(f, 'wait', event.time || Date.now())
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
        // Settlement may retire failed/abandoned rows without a durable message,
        // or retire a successful stream only after its message and step/end.
        // Reconcile against the authoritative window only at this boundary.
        const entries = window.entries || []
        const attempt = f.attempts.get(change.attemptId)
        const committed = attempt && entries.some((entry) => entry.type !== 'transient' && entry.event &&
          entry.event.type === 'assistant/message' && entry.event.data.interrupted !== true &&
          entry.event.data.turn === attempt.turn && entry.event.data.step === attempt.step)
        const keep = (row) => row.attemptId !== change.attemptId || committed
        const chars = f.chars.filter(keep)
        // A rejected interval becomes wait, so the preceding accepted phase
        // cannot expand across time spent on a discarded attempt.
        const phases = f.phases.map((phase) => keep(phase) ? phase : { t: phase.t, until: phase.until, kind: 'wait' })
        resetFold(f)
        for (const entry of entries) applyEntry(f, entry)
        // Durable messages cannot reconstruct real streaming rates or phase
        // timing. Preserve accepted samples, dropping rejected attempt samples.
        f.chars = chars
        f.phases = phases
        if (change.entry && change.entry.event.type === 'assistant/message') {
          markPhase(f, 'out', change.entry.event.time)
        }
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
        if (data.attemptId !== undefined && !f.attempts.has(data.attemptId)) {
          f.attempts.set(data.attemptId, { turn: data.turn, step: data.step })
        }
        applyChunk(f, data.chunk, entry.event.time, data.attemptId)
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
        if (fold.runningTools > 0) return 'run'
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
          pending: Boolean(pendingOf(rec.id)),
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
          const rec = records.get(agent.id)
          const activeUntil = rec && rec.idleSince ? Math.min(now, rec.idleSince) : now
          for (let index = 0; index < phases.length; index++) {
            const from = Math.max(windowStart, phases[index].t)
            const until = index + 1 < phases.length ? phases[index + 1].t : now
            const to = Math.min(activeUntil, until)
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
        // Every tracked lane contributes a full trailing minute, including idle
        // time. Concurrent agents therefore share agent-time rather than each
        // consuming the same single wall-clock minute.
        const observedMs = agents.length * TIMELINE_WINDOW
        phaseMs.wait = Math.max(0, observedMs - phaseMs.think - phaseMs.act - phaseMs.out)
        const shares = ['think', 'act', 'out', 'wait'].map((kind) => {
          const exact = observedMs > 0 ? (phaseMs[kind] / observedMs) * 100 : kind === 'wait' ? 100 : 0
          return { kind, pct: Math.floor(exact), remainder: exact - Math.floor(exact) }
        })
        // Largest remainders keep the total at 100 without clipping later kinds.
        let remaining = 100 - shares.reduce((sum, share) => sum + share.pct, 0)
        for (const share of shares.slice().sort((a, b) => b.remainder - a.remainder)) {
          if (remaining-- > 0) share.pct += 1
        }
        const phaseMix = {}
        for (const share of shares) phaseMix[share.kind] = share.pct
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
          phaseMix,
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
          if (!rec.idleSince) {
            rec.idleSince = Date.now()
            // Preserve the hold interval if this Session resumes in the same
            // phase; otherwise adjacent phase deltas would bridge the gap.
            markPhase(rec.fold, 'wait', rec.idleSince)
          }
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
          // Retains must expire even while no panel is reading or subscribed.
          // Run cleanup before the notification/rebuild fast paths below.
          expireIdle()
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
  grid-template-columns:minmax(0,1fr) minmax(210px,22%);
  grid-template-rows:minmax(0,1fr) minmax(130px,20%);
  grid-template-areas:"stage rail" "wall wall";}
.nxt-panel{position:relative; min-height:0; min-width:0; display:flex; flex-direction:column;
  border:1px solid var(--nxt-line);
  background:linear-gradient(180deg, rgba(10,10,10,0.82), rgba(0,0,0,0.88));
  box-shadow:inset 0 0 34px rgba(85,255,255,0.045);}
.nxt-stagepanel{grid-area:stage}
.nxt-railpanel{grid-area:rail}
.nxt-wallpanel{grid-area:wall}
.nxt-phead{display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 9px 5px;
  border-bottom:1px solid rgba(255,255,85,0.08); font-size:9px; letter-spacing:.22em; color:var(--nxt-cy); text-transform:uppercase}
.nxt-phead>span:first-child{flex:none}
.nxt-phint{color:var(--nxt-dim); letter-spacing:.16em; font-size:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; text-align:right}

.nxt-wall{overflow:auto; padding:8px; display:flex; flex-direction:column; gap:8px; min-height:0; flex:1 1 auto; scrollbar-width:thin}
.nxt-wallpanel .nxt-wall{flex-direction:row; overflow-x:auto; overflow-y:hidden; align-items:stretch}
.nxt-wall .nxt-card{flex:0 0 clamp(260px, 24vw, 340px); min-width:260px; min-height:0}
.nxt-wallpanel .nxt-wall .nxt-card{height:auto; min-height:0}
.nxt-film[data-filtered="1"]{opacity:.32}
.nxt-cfilm{display:flex; flex-direction:column; gap:3px; flex:1 1 auto; min-height:0; margin-top:4px; overflow:hidden}
.nxt-cfrow{display:flex; align-items:baseline; gap:6px; min-width:0; white-space:nowrap; overflow:hidden; font-size:9px; line-height:1.4}
.nxt-cflbl{flex:none; font-size:7px; letter-spacing:.14em; color:#55ffff}
.nxt-cfval{min-width:0; overflow:hidden; text-overflow:ellipsis; color:#aaaaaa}
.nxt-film-summary{flex:1 0 280px; min-width:0; display:flex; flex-direction:column; justify-content:center; gap:7px; padding:9px 11px;
  border-left-color:rgba(255,255,85,0.45)}
.nxt-summary-grid{display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:4px}
.nxt-summary-kv{display:flex; flex-direction:column; gap:1px; min-width:0; padding:3px 5px; border:1px solid rgba(85,255,255,0.12); background:rgba(10,10,10,0.4)}
.nxt-summary-kv span{font-size:7px; letter-spacing:.12em; color:#555555; white-space:nowrap}
.nxt-summary-kv b{font-size:12px; color:#55ffff; font-weight:600; font-variant-numeric:tabular-nums}
.nxt-summary-kv b.hot{color:#ff5555}
.nxt-summary-note{display:flex; align-items:center; gap:6px; min-width:0; flex-wrap:wrap; font-size:8px; color:#555555}
.nxt-summary-note b{color:#ffffff; font-weight:600; margin-right:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:38%}
.nxt-summary-bar{height:3px; background:rgba(85,255,255,0.08); overflow:hidden}
.nxt-summary-bar i{display:block; height:100%; background:linear-gradient(90deg,#55ffff,#ffff55)}
.nxt-wall::-webkit-scrollbar{width:6px; height:6px}
.nxt-wall::-webkit-scrollbar-thumb{background:rgba(85,255,255,0.25)}
.nxt-card{position:relative; border:0; border-left:2px solid rgba(255,255,255,0.14); background:linear-gradient(180deg, rgba(10,10,10,0.94), rgba(0,0,0,0.94));
  padding:7px 8px 6px; cursor:pointer; transition:border-color .18s, transform .18s, box-shadow .18s; border-left-width:2px;
  display:flex; flex-direction:column; flex:1 1 auto; min-height:158px; overflow:hidden}
.nxt-card:hover{border-left-color:var(--nxt-frame); background:rgba(16,17,20,0.98)}
.nxt-card[data-hover="1"]{border-left-color:var(--nxt-frame); box-shadow:inset 0 0 18px -8px var(--nxt-frame); background:rgba(16,17,20,0.98)}
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
.nxt-card-spark-canvas{width:100%; height:18px; display:block}

.nxt-bar{display:inline-block; width:46px; height:4px; background:rgba(85,255,255,0.14); position:relative; overflow:hidden; vertical-align:middle}

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
.nxt-resident{cursor:default; border-left-color:rgba(255,255,85,0.45)}
.nxt-resident:hover{border-left-color:rgba(255,255,85,0.45); background:linear-gradient(180deg, rgba(10,10,10,0.94), rgba(0,0,0,0.94))}
.nxt-resident-term{flex:1 1 0; min-height:96px; display:flex; flex-direction:column; gap:4px; margin:8px 0 2px; padding:8px;
  overflow:hidden; background:rgba(0,0,0,0.55); border:1px solid rgba(85,255,255,0.18);
  font:10px/1.6 "JetBrains Mono","Cascadia Mono",Consolas,monospace; color:#aaaaaa}
.nxt-resident-line{display:flex; gap:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.nxt-resident-key{flex:0 0 52px; color:#555555}
.nxt-resident-val{color:#55ffff; overflow:hidden; text-overflow:ellipsis}
.nxt-resident-prompt{color:#55ffff}
.nxt-resident-cursor{display:inline-block; margin-left:2px; color:#ffff55; animation:nxt-blink 1.1s steps(2,end) infinite}
.nxt-resident-term-hint{margin-top:auto; color:#555555; font-size:8px; letter-spacing:.12em}
.nxt-resident-hint{font-size:8px; color:#555555; text-align:center; padding-top:3px; flex:none}
.nxt-resident .nxt-standby{padding:8px 4px 2px}
.nxt-resident .nxt-standby b{font-size:9px; letter-spacing:.2em}
.nxt-resident .nxt-standby span{font-size:8px}

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
.nxt-stage-hud{position:absolute; left:10px; right:10px; bottom:10px; height:clamp(96px, 18%, 140px);
  display:flex; flex-direction:row; gap:8px; pointer-events:none; z-index:4}
.nxt-analyze-on .nxt-stage-hud{display:none}
.nxt-net-on .nxt-stage-hud{display:none}
.nxt-hud-off .nxt-stage-hud{display:none}
.nxt-shud[data-pos="tr"]{display:none}
.nxt-shud{position:relative; flex:1 1 0; min-width:0; min-height:0; overflow:hidden; padding:5px 7px;
  background:rgba(0,0,0,0.78); border:0;
  font-size:8.5px; color:#aaaaaa; font-variant-numeric:tabular-nums; line-height:1.4}
.nxt-shud-h{display:flex; justify-content:space-between; gap:10px; font-size:8px; letter-spacing:.2em; color:#55ffff; margin-bottom:4px}
.nxt-shud-spark{margin-top:6px; height:34px; overflow:hidden}
.nxt-shud-spark svg{width:100%; height:34px; display:block}
.nxt-chart-canvas{width:100%; height:100%; display:block}
.nxt-inline-bar-canvas{display:block; width:100%; height:100%}
.nxt-inline-bar{display:inline-block; width:46px; height:4px; background:rgba(85,255,255,0.14); vertical-align:middle; overflow:hidden}
.nxt-unit-viz-canvas{display:block; width:100%; height:100%}
.nxt-phase>canvas{display:block; width:100%; height:100%}
.nxt-rail-chart{height:30px; margin-top:3px}
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



.nxt-unit-row{display:flex; align-items:center; gap:6px; font-size:9px; white-space:nowrap; overflow:hidden; margin-top:2px}
.nxt-unit-row .nxt-ut{color:#ff55ff; flex:none}
.nxt-unit-row .nxt-us{flex:none; width:28px; font-size:8px; letter-spacing:.08em}
.nxt-unit-row .nxt-un{color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; flex:1}
.nxt-unit-row .nxt-uv{color:#ffffff; flex:none; font-variant-numeric:tabular-nums}
.nxt-unit-viz{width:46px; height:12px; flex:none; overflow:hidden; opacity:.9}
.nxt-mini{display:flex; align-items:center; gap:6px; font-size:9px; white-space:nowrap; margin-top:2px}
.nxt-mini .nxt-mn{color:#aaaaaa; flex:none; width:58px; overflow:hidden; text-overflow:ellipsis}
.nxt-mini .nxt-mbar{flex:1; height:3px; background:rgba(85,255,255,0.14); overflow:hidden}


.nxt-mini .nxt-mv{color:#ffffff; flex:none; width:30px; text-align:right; font-variant-numeric:tabular-nums}
.nxt-phase{display:flex; height:6px; margin-top:4px; overflow:hidden; background:rgba(85,255,255,0.08)}

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
.nxt-leader{display:flex; align-items:baseline; gap:6px; flex:1; min-width:0; overflow:hidden}
.nxt-leader>span{flex:none; color:#555555; font-size:7px; letter-spacing:.16em}
.nxt-leader>i{flex:1; min-width:8px; border-bottom:1px dotted rgba(255,255,85,0.26); transform:translateY(-2px)}
.nxt-leader>b{flex:none; max-width:62%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#aaaaaa; font-weight:500}

.nxt-ticker{display:flex; align-items:center; gap:14px; padding:4px 12px; border-top:1px solid var(--nxt-line);
  font-size:9px; color:#aaaaaa; letter-spacing:.08em; overflow:hidden; white-space:nowrap; background:rgba(0,0,0,0.9)}
.nxt-ticker .nxt-tk{flex:none; color:var(--nxt-cy); letter-spacing:.22em; font-size:8px}
.nxt-ticker .nxt-tv{overflow:hidden; text-overflow:ellipsis}
.nxt-ticker .nxt-ts{margin-left:auto; color:#555555; font-variant-numeric:tabular-nums; flex:none}
.nxt-feed{display:flex; align-items:center; gap:12px; min-width:0; flex:1; overflow:hidden}
.nxt-feed-i{display:inline-flex; align-items:center; gap:5px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:none; max-width:46%; color:#aaaaaa}
.nxt-feed-i i{display:inline-block; width:4px; height:4px; flex:none; background:currentColor}
.nxt-feed-i[data-k="err"]{color:#ff5555}
.nxt-feed-i[data-k="wait"]{color:#ffff55}
.nxt-feed-i[data-k="done"]{color:#55ff55}
.nxt-feed-i[data-k="unit"]{color:#ff55ff}
.nxt-feed-i[data-k="sys"]{color:#55ffff}
.nxt-feed-i[data-k="none"]{color:#555555}

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

/* Battle bar: always-visible state summary above the stage. */
.nxt-battlebar{display:flex; align-items:center; gap:5px; padding:4px 9px; flex:none;
  border-bottom:1px solid rgba(85,255,255,0.10); background:rgba(0,0,0,0.58); overflow:hidden; white-space:nowrap}
.nxt-battle{display:inline-flex; align-items:center; gap:5px; padding:2px 6px; flex:none;
  border:1px solid rgba(85,255,255,0.14); background:rgba(8,10,12,0.72);
  font:600 8px/1.1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.10em; color:var(--nxt-dim)}
.nxt-battle b{font-size:11px; line-height:1; color:#ffffff; font-weight:600; font-variant-numeric:tabular-nums}
.nxt-battle i{font-style:normal; width:5px; height:5px; display:inline-block; background:currentColor; box-shadow:0 0 5px currentColor}
.nxt-battle[data-k="active"]{color:#55ffff}
.nxt-battle[data-k="wait"]{color:#ffff55}
.nxt-battle[data-k="err"]{color:#ff5555}
.nxt-battle[data-k="err"][data-hot="1"]{animation:nxt-blink 1.6s steps(2,end) infinite}
.nxt-battle[data-k="sync"]{color:#8a8a8a}
.nxt-battle[data-k="desks"]{color:#55ff55; margin-left:auto}
.nxt-cinema .nxt-battlebar{padding:7px 14px; gap:9px}
.nxt-cinema .nxt-battle{font-size:10px; padding:4px 9px; gap:7px}
.nxt-cinema .nxt-battle b{font-size:15px}
.nxt-cinema .nxt-battle i{width:7px; height:7px}

/* Agent strip: compact roster when the card wall can only show 4 units. */
.nxt-agentstrip{display:flex; gap:3px; padding:4px 7px; flex:none; overflow-x:auto; scrollbar-width:thin;
  border-bottom:1px solid rgba(85,255,255,0.08); background:rgba(0,0,0,0.42)}
.nxt-agentstrip[hidden]{display:none}
.nxt-astrip{display:inline-flex; align-items:center; gap:4px; flex:none; padding:2px 5px; cursor:pointer;
  border:1px solid rgba(255,255,255,0.12); background:rgba(10,10,10,0.72); color:#aaaaaa; border-radius:0;
  font:600 8px/1.2 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.06em; white-space:nowrap}
.nxt-astrip:hover,.nxt-astrip[data-hover="1"]{border-color:var(--nxt-frame); color:#ffffff}
.nxt-astrip i{font-style:normal; color:var(--nxt-dim)}
.nxt-astrip[data-state="run"] i{color:#55ffff}
.nxt-astrip[data-state="wait"] i{color:#ffff55}
.nxt-astrip[data-state="err"] i{color:#ff5555}
.nxt-astrip[data-state="sync"] i{color:#8a8a8a}
.nxt-astrip b{color:#ffffff; font-weight:600}
.nxt-astrip span{color:#777777; font-size:7px}
.nxt-cinema .nxt-agentstrip{padding:6px 14px; gap:5px}
.nxt-cinema .nxt-astrip{font-size:10px; padding:3px 8px}
.nxt-cinema .nxt-cinema-hint{display:block}

/* Clickable state legend. */
.nxt-legend{display:none; position:absolute; left:10px; top:8px; z-index:8; align-items:center; gap:4px}
.nxt-legend[data-show="1"]{display:flex}
.nxt-legend-t{font-size:7px; letter-spacing:.18em; color:#555555; margin-right:2px}
.nxt-legend button{cursor:pointer; padding:2px 5px; border:1px solid rgba(255,255,255,0.16); background:rgba(0,0,0,0.72);
  color:#aaaaaa; border-radius:0; font:600 7px/1.1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.08em}
.nxt-legend button:hover{border-color:var(--nxt-frame); color:#ffffff}
.nxt-legend button[data-active="1"]{color:#000000; background:#ffff55; border-color:#ffff55}
.nxt-legend button i{display:inline-block; width:5px; height:5px; margin-right:3px; background:currentColor}
.nxt-legend button[data-legend="run"] i{background:#55ffff}
.nxt-legend button[data-legend="wait"] i{background:#ffff55}
.nxt-legend button[data-legend="sync"] i{background:#8a8a8a}
.nxt-legend button[data-legend="err"] i{background:#ff5555}
.nxt-cinema .nxt-legend{top:12px; left:14px; gap:6px}
.nxt-cinema .nxt-legend button{font-size:9px; padding:3px 7px}

/* Optional cold briefing skin for CINEMA/video capture. */
.nxt-root.nxt-cinema.nxt-cold{
  --nxt-cy:#9ffcff; --nxt-frame:#b8ffe8; --nxt-mg:#ff4f8b; --nxt-am:#ffd166; --nxt-line:rgba(120,255,220,0.15);
  background:
    radial-gradient(110% 80% at 50% -10%, rgba(80,255,220,0.10), transparent 60%),
    radial-gradient(90% 60% at 100% 110%, rgba(255,79,139,0.10), transparent 60%),
    #01070a;
}
.nxt-root.nxt-cinema.nxt-cold .nxt-panel{border-color:rgba(120,255,220,0.20)}
.nxt-root.nxt-cinema.nxt-cold .nxt-battlebar{background:rgba(0,10,12,0.82)}
.nxt-root.nxt-cinema.nxt-cold .nxt-stage::after{content:""; position:absolute; inset:0; pointer-events:none; z-index:7;
  background:repeating-linear-gradient(0deg, rgba(0,18,20,0.18) 0 1px, transparent 1px 4px); opacity:.45}
.nxt-root.nxt-cinema.nxt-cold .nxt-vig{
  background:radial-gradient(120% 92% at 50% 42%, transparent 42%, rgba(0,8,10,.72) 100%);
}

.nxt-cinema .nxt-wallpanel,.nxt-cinema .nxt-railpanel{display:none}
.nxt-cinema .nxt-body{grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); grid-template-areas:"stage"}

/* Right rail: persistent attention queue + collapsible detail groups. */
.nxt-attn{display:flex; flex-direction:column; gap:3px; margin-bottom:7px; padding:6px 7px;
  border:1px solid rgba(255,255,255,0.14); background:rgba(10,10,10,0.55)}
.nxt-attn-h{display:flex; align-items:center; justify-content:space-between; margin-bottom:2px;
  font-size:8px; letter-spacing:.18em; color:#ffff55}
.nxt-attn-h span:last-child{color:#555555; letter-spacing:.06em}
.nxt-attn-ok{border-color:rgba(85,255,255,0.16)}
.nxt-attn-ok b{font-size:9px; letter-spacing:.18em; color:#55ff55}
.nxt-attn-row{display:flex; align-items:center; gap:5px; width:100%; min-width:0; padding:3px 4px; cursor:pointer;
  border:1px solid rgba(255,255,255,0.10); background:rgba(0,0,0,0.3); text-align:left;
  font:600 8px/1.2 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.05em}
.nxt-attn-row:hover{border-color:var(--nxt-frame)}
.nxt-attn-tag{flex:none; max-width:62px; overflow:hidden; text-overflow:ellipsis}
.nxt-attn-state{flex:none; font-size:7px; color:#ffff55}
.nxt-attn-row[data-state="err"] .nxt-attn-state{color:#ff5555}
.nxt-attn-name{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; color:#aaaaaa}
.nxt-group{margin-bottom:7px; border:1px solid rgba(85,255,255,0.10); background:rgba(0,0,0,0.28)}
.nxt-group-h{display:flex; align-items:center; justify-content:space-between; width:100%; cursor:pointer; padding:5px 7px;
  border:0; background:transparent; text-align:left; font:600 8px/1.2 "JetBrains Mono",Consolas,monospace; letter-spacing:.16em; color:#55ffff}
.nxt-group-h:hover{background:rgba(85,255,255,0.06)}
.nxt-group-h span:last-child{color:#555555; letter-spacing:.08em}
.nxt-group[data-open="1"] .nxt-group-h{border-bottom:1px solid rgba(85,255,255,0.12)}
.nxt-group[data-open="0"] .nxt-group-body{display:none}
.nxt-group .nxt-block{margin:5px 6px}
.nxt-dimmed{opacity:.3}

.nxt-analyze{display:none; position:absolute; inset:0; padding:8px; gap:8px; overflow:auto; align-content:start;
  grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:24px repeat(2,minmax(150px,max-content)) max-content;
  grid-auto-rows:minmax(150px,max-content)}
.nxt-analyze-close{grid-column:1/-1; justify-self:end; position:sticky; top:0; z-index:6; min-width:84px; min-height:24px; padding:6px 10px; cursor:pointer;
  font:600 8px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.12em; text-transform:uppercase;
  color:#000000; background:#ffff55; border:1px solid #ffff55; border-radius:0}
.nxt-analyze-close:focus-visible{outline:1px solid #ffffff; outline-offset:1px}
.nxt-analyze-close:hover{background:#ffffff; border-color:#ffffff}
.nxt-analyze .nxt-analyze-detail{min-height:180px; overflow:visible; justify-content:flex-start}
.nxt-analyze-text{margin:0; flex:none; font:11px/1.6 "JetBrains Mono","Cascadia Mono",Consolas,monospace;
  white-space:pre-wrap; overflow-wrap:anywhere; color:#aaaaaa}
.nxt-analyze-detail[data-channel="think"] .nxt-analyze-text{color:#55ffff}
.nxt-analyze-detail[data-channel="out"] .nxt-analyze-text{color:#55ff55}
.nxt-analyze-detail .nxt-tool{display:grid; grid-template-columns:9px minmax(0,1fr) auto; white-space:normal; overflow:visible; flex:none;
  padding:5px 0; border-bottom:1px solid rgba(85,255,255,0.12)}
.nxt-analyze-detail .nxt-tool .nxt-tn{max-width:none; overflow:visible; overflow-wrap:anywhere}
.nxt-analyze-detail .nxt-tool .nxt-ta{grid-column:2/-1; grid-row:2; overflow:visible; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.6}
.nxt-analyze-detail .nxt-tool .nxt-tm{grid-column:3; grid-row:1}
.nxt-prefs{display:none; position:absolute; top:36px; right:8px; z-index:9; width:242px; padding:8px;
  flex-direction:column; gap:7px; background:rgba(0,0,0,0.94); border:1px solid rgba(85,255,255,0.4);
  box-shadow:0 0 18px rgba(0,0,0,0.55); font:8px/1.3 "JetBrains Mono","Cascadia Mono",Consolas,monospace; color:#aaaaaa}
.nxt-prefs[data-open="1"]{display:flex}
.nxt-prefs-h{display:flex; align-items:center; justify-content:space-between; color:var(--nxt-cy); letter-spacing:.14em}
.nxt-prefs-x{cursor:pointer; color:#aaaaaa; background:transparent; border:0; font:600 12px/1 "JetBrains Mono",monospace; padding:0 2px}
.nxt-prefs-x:hover{color:#ffff55}
.nxt-pref-row{display:flex; align-items:center; justify-content:space-between; gap:8px}
.nxt-pref-seg{display:flex; gap:3px; flex:none}
.nxt-pref-btn{cursor:pointer; padding:3px 5px; border:1px solid rgba(85,255,255,0.22); background:rgba(10,10,10,0.7);
  color:#aaaaaa; font:600 8px/1 "JetBrains Mono","Cascadia Mono",Consolas,monospace; letter-spacing:.08em; border-radius:0}
.nxt-pref-btn:hover{color:#ffff55; border-color:rgba(255,255,85,0.5)}
.nxt-pref-btn[data-active="1"]{color:#000000; background:#ffff55; border-color:#ffff55}
.nxt-pref-note{color:rgba(170,170,170,0.7); line-height:1.5; border-top:1px solid rgba(85,255,255,0.12); padding-top:6px}
.nxt-stage.nxt-analyze-on .nxt-analyze{display:grid}
.nxt-stage.nxt-analyze-on > canvas{display:none}
.nxt-stage.nxt-analyze-on .nxt-legend{display:none}
.nxt-stage.nxt-analyze-on .nxt-stage-tag{display:none}
.nxt-stage.nxt-analyze-on .nxt-standby-tray{display:none}
.nxt-stage.nxt-net-on .nxt-legend{display:none}
.nxt-focus-on .nxt-wallpanel,.nxt-focus-on .nxt-railpanel{display:none}
.nxt-focus-on .nxt-body{grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr); grid-template-areas:"stage"}
.nxt-aw{position:relative; display:flex; flex-direction:column; gap:4px; min-height:0; min-width:0; overflow:hidden;
  border:0; background:linear-gradient(180deg, rgba(10,10,10,0.78), rgba(0,0,0,0.82)); padding:6px 7px}
.nxt-aw-h{display:flex; align-items:center; justify-content:space-between; font-size:8px; letter-spacing:.2em; color:#55ffff; text-transform:uppercase; flex:none}
.nxt-aw-h b{color:var(--nxt-cy); font-weight:600; letter-spacing:.08em}
.nxt-aw-body{flex:1; min-height:0; display:flex; flex-direction:column; gap:3px; overflow:hidden; justify-content:center}
/* the ring sizes itself to the body: a fixed 112px canvas plus the kv rows used to
   overflow a short card, and the centered overflow clipped the top/bottom of the
   ring instead of scaling it */
.nxt-ring-canvas{width:100%; flex:1 1 0; min-height:0; max-height:112px; display:block}





.nxt-kvrow{display:flex; justify-content:space-between; gap:6px; font-size:9px; color:#aaaaaa; font-variant-numeric:tabular-nums; flex:none}
.nxt-kvrow span{color:#55ffff; letter-spacing:.12em; font-size:8px}
.nxt-kvrow b{color:#aaaaaa; font-weight:600}
.nxt-heat{display:flex; flex-direction:column; gap:3px; flex:1; min-height:0; justify-content:center}
.nxt-heat-row{display:flex; align-items:center; gap:5px; min-height:11px}
.nxt-heat-name{width:56px; flex:none; color:#aaaaaa; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:8px}
.nxt-matrix-canvas{flex:1; height:11px; display:block}
.nxt-lanes{display:flex; flex-direction:column; gap:4px; justify-content:center; flex:1; min-height:0}
.nxt-lane{display:flex; align-items:center; gap:5px; height:15px}
.nxt-lane-name{width:34px; flex:none; font-size:7px; letter-spacing:.1em; color:#55ffff}
.nxt-lane-track{position:relative; flex:1; height:9px; background:rgba(85,255,255,0.07); overflow:hidden}
.nxt-lane-canvas{display:block; width:100%; height:100%}

.nxt-files{display:flex; flex-direction:column; gap:3px; flex:1; min-height:0; overflow:hidden; justify-content:center}
.nxt-file{display:flex; align-items:center; gap:6px; font-size:9px; color:#aaaaaa; white-space:nowrap}
.nxt-file .nxt-fpath{flex:1; overflow:hidden; text-overflow:ellipsis; color:#aaaaaa}
.nxt-file .nxt-fbar{width:48px; height:4px; background:rgba(255,85,255,0.16); flex:none; overflow:hidden}

.nxt-file .nxt-frw{width:38px; text-align:right; font-size:8px; color:#555555; flex:none}
.nxt-analyze-tps-canvas{width:100%; flex:1; min-height:48px; display:block}


.nxt-todo{display:flex; align-items:center; gap:5px; font-size:9px; color:#aaaaaa; white-space:nowrap; overflow:hidden; flex:none}
.nxt-todo i{flex:none; font-style:normal; width:9px; text-align:center}
.nxt-todo[data-done="1"]{color:#555555; text-decoration:line-through}
.nxt-todo[data-done="1"] i{color:var(--nxt-gr)}
.nxt-todo[data-done="0"] i{color:#55ffff}

@media (max-width: 1180px){
  .nxt-body{grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(130px,20%); grid-template-areas:"stage" "wall"}
  .nxt-railpanel{display:none}
}
@media (max-width: 820px){
  .nxt-body{grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(120px,20%); grid-template-areas:"stage" "wall"}
  .nxt-wall .nxt-card{flex-basis:220px}
  .nxt-analyze{grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-rows:24px}
}
@media (max-width: 540px){
  .nxt-analyze{grid-template-columns:minmax(0,1fr)}
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
          <button type="button" class="nxt-mode" data-prefs="1" title="Office preferences">PREFS</button>
        </div>
      </div>
      <div class="nxt-battlebar" id="nxt-battlebar"></div>
      <div class="nxt-agentstrip" id="nxt-agentstrip" hidden></div>
      <div class="nxt-stage" id="nxt-stage">
        <canvas id="nxt-canvas"></canvas>
        <div class="nxt-analyze" id="nxt-analyze"></div>
        <div class="nxt-prefs" id="nxt-prefs" data-open="0"></div>
        <div class="nxt-stage-hud" id="nxt-stage-hud">
          <div class="nxt-shud" data-pos="tl" id="nxt-shud-tl"></div>
          <div class="nxt-shud" data-pos="tr" id="nxt-shud-tr"></div>
          <div class="nxt-shud" data-pos="bl" id="nxt-shud-bl"></div>
          <div class="nxt-shud" data-pos="br" id="nxt-shud-br"></div>
        </div>
        <div class="nxt-stage-tag" id="nxt-stage-tag"></div>
        <div class="nxt-standby-tray" id="nxt-standby-tray" hidden></div>
        <div class="nxt-legend" id="nxt-legend"></div>
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

    const STATE_LEGEND = [
      ['run', 'RUN'],
      ['wait', 'WAIT'],
      ['sync', 'SYNC'],
      ['err', 'ERR'],
    ]

    function battleHtml(view) {
      const agents = ((view && view.agents) || []).filter((agent) => !agent.held)
      const count = (state) => agents.filter((agent) => agent.state === state).length
      const active = agents.length
      const waiting = count('wait')
      const errors = count('err')
      const sync = count('sync')
      const desks = (view && view.totals && view.totals.desks) || 0
      const standby = (view && view.totals && view.totals.overflow) || 0
      const tps = view && view.totals ? view.totals.tpsDisplay !== undefined ? view.totals.tpsDisplay : view.totals.tps : 0
      return (
        '<span class="nxt-battle" data-k="active" title="Live units"><i></i>ACTIVE <b>' + active + '</b></span>' +
        '<span class="nxt-battle" data-k="wait" title="Waiting for a human or idle wait"><i></i>WAITING <b>' + waiting + '</b></span>' +
        '<span class="nxt-battle" data-k="err" data-hot="' + (errors > 0 ? '1' : '0') + '" title="Units currently in error"><i></i>ERRORS <b>' + errors + '</b></span>' +
        '<span class="nxt-battle" data-k="sync" title="Settling units"><i></i>SYNC <b>' + sync + '</b></span>' +
        '<span class="nxt-battle" data-k="tps" title="Estimated aggregate tokens/s"><i></i>TPS <b>' + (Number.isFinite(tps) ? tps : 0).toFixed(1) + '</b></span>' +
        '<span class="nxt-battle" data-k="desks" title="Seated units and standby overflow"><i></i>DESKS <b>' + desks + '/8</b>' +
        (standby > 0 ? ' <b style="color:#ffff55">+' + standby + '</b>' : '') + '</span>'
      )
    }

    function agentStripHtml(agents, focus, hover) {
      return agents
        .map(
          (agent) =>
            '<button type="button" class="nxt-astrip" data-id="' + esc(agent.id) + '" data-state="' + esc(agent.state) + '"' +
            (hover === agent.id ? ' data-hover="1"' : '') +
            ' title="' + esc((agent.name || agent.id) + '\nCLICK: FOCUS') + '">' +
            '<i style="color:' + esc(agent.color) + '">' + esc(agent.tag) + '</i>' +
            '<b>' + esc(agent.name || agent.id) + '</b><span>' + stateLabel(agent.state) + ' · ' + shownTps(agent).toFixed(1) + '</span></button>',
        )
        .join('')
    }

    function legendHtml(active) {
      return (
        '<span class="nxt-legend-t">FILTER</span>' +
        STATE_LEGEND.map(
          ([state, label]) =>
            '<button type="button" data-legend="' + state + '" data-active="' + (active === state ? '1' : '0') + '"><i></i>' + label + '</button>',
        ).join('') +
        '<button type="button" data-legend="all" data-active="' + (active ? '0' : '1') + '">ALL</button>'
      )
    }

    /** Eased readout with a fallback for fixtures/older snapshots. */
    function shownTps(agent) {
      const value = agent && (agent.displayTps !== undefined ? agent.displayTps : agent.tps)
      return Number.isFinite(value) ? value : 0
    }

    /** Per-unit mini visualization: 0 = sparkline, 1 = tool bars, 2 = call queue. */
    function unitViz(agent, index) {
      const kind = index % 3
      return (
        '<canvas class="nxt-unit-viz-canvas" data-viz-id="' + esc(agent.id) +
        '" data-viz-kind="' + kind + '" data-viz-color="' + esc(agent.color || '#55ffff') +
        '" aria-hidden="true"></canvas>'
      )
    }

    function cardHtml(agent, focused, hovered, filtered) {
      const currentTool = agent.tools.length > 0 ? agent.tools[agent.tools.length - 1] : null
      const ctxMeta =
        agent.ctx >= 0
          ? 'CTX <span class="nxt-inline-bar"><canvas class="nxt-inline-bar-canvas" data-bar="ctxpct" data-agent-id="' +
            esc(agent.id) + '" data-value="' + agent.ctx + '" aria-hidden="true"></canvas></span> ' + agent.ctx + '%'
          : 'CTX ' + fmtNum(agent.ctxTokens) + ' tok'
      return (
        '<div class="nxt-card nxt-film" data-state="' +
        esc(agent.state) +
        '" data-id="' +
        esc(agent.id) +
        '"' +
        (focused === agent.id ? ' data-focused="1"' : '') +
        (hovered === agent.id ? ' data-hover="1"' : '') +
        (filtered && filtered !== agent.state ? ' data-filtered="1"' : '') +
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
        '<canvas class="nxt-card-spark-canvas" data-spark-id="' + esc(agent.id) + '" data-spark-color="' + esc(agent.color) + '" aria-hidden="true"></canvas>' +
        '</span></div>' +
        '<div class="nxt-cfilm">' +
        '<div class="nxt-cfrow"><span class="nxt-cflbl">ACT</span><span class="nxt-cfval">' +
        esc(currentTool ? currentTool.name + (currentTool.arg ? ' · ' + currentTool.arg : '') : 'waiting') +
        '</span></div>' +
        '<div class="nxt-cfrow"><span class="nxt-cflbl">THINK</span><span class="nxt-cfval">' +
        esc(agent.think ? tail(agent.think, 180) : '— no reasoning channel —') +
        '</span></div>' +
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

    function roomSummaryHtml(view) {
      const live = ((view && view.agents) || []).filter((agent) => !agent.held)
      const totals = (view && view.totals) || {}
      const waiting = live.filter((agent) => agent.state === 'wait').length
      const errors = live.filter((agent) => agent.state === 'err').length
      const seated = live.filter((agent) => agent.deskSlot >= 0).length
      const standby = live.filter((agent) => agent.deskSlot < 0).length
      const lastCall = (view.recentCalls || [])[0]
      return (
        '<div class="nxt-card nxt-film-summary">' +
        '<div class="nxt-chead"><span class="nxt-cidx">ROOM</span><span class="nxt-cname">07 / SUMMARY</span><span class="nxt-cstate">' +
        (errors > 0 ? 'ATTENTION' : waiting > 0 ? 'WAITING' : 'CLEAR') + '</span></div>' +
        '<div class="nxt-summary-grid">' +
        '<div class="nxt-summary-kv"><span>SEATED</span><b>' + seated + '/8</b></div>' +
        '<div class="nxt-summary-kv"><span>STANDBY</span><b>' + standby + '</b></div>' +
        '<div class="nxt-summary-kv"><span>WAITING</span><b>' + waiting + '</b></div>' +
        '<div class="nxt-summary-kv"><span>ERRORS</span><b class="' + (errors > 0 ? 'hot' : '') + '">' + errors + '</b></div>' +
        '<div class="nxt-summary-kv"><span>TPS</span><b>' + (totals.tpsDisplay !== undefined ? totals.tpsDisplay : totals.tps || 0).toFixed(1) + '</b></div>' +
        '</div>' +
        '<div class="nxt-summary-note">' +
        '<span>SUPERVISOR</span><b>' + (live.length > 1 ? 'ASSIGNED' : 'RESIDENT') + '</b>' +
        '<span>LAST</span><b>' + esc(lastCall ? lastCall.name + ' · ' + fmtMs(lastCall.ms) : 'no calls yet') + '</b>' +
        '</div>' +
        '<div class="nxt-summary-bar"><i style="width:' + Math.min(100, Math.max(2, Math.round((live.length / 8) * 100))) + '%"></i></div>' +
        '</div>'
      )
    }

    function standbyHtml(view, prefs) {
      const agents = (view && view.agents) || []
      const held = agents.filter((agent) => agent.held).length
      const seated = (view && view.totals && view.totals.desks) || 0
      const visitMode = prefs && prefs.visits === false ? 'off' : (prefs && prefs.visitPace) || 'chill'
      const visitMax = prefs && prefs.maxVisitors === 1 ? 1 : 2
      const actions = prefs && prefs.actions === false ? 'off' : 'on'
      const theme = activeScheme === 'light' ? 'light' : 'dark'
      return (
        '<div class="nxt-card nxt-resident" data-state="wait" title="Resident whale-girl — no active sessions">' +
        '<div class="nxt-chead"><span class="nxt-cidx">#00</span><span class="nxt-cname">WHALE-GIRL</span>' +
        '<span class="nxt-cstate">IDLE</span></div>' +
        '<div class="nxt-cmeta"><span class="nxt-leader"><span>MODEL</span><i></i><b>resident</b></span><span>NO SESSION</span></div>' +
        '<div class="nxt-resident-term">' +
        '<div class="nxt-resident-line nxt-resident-prompt">$ watchtower --standby</div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">host</span><span class="nxt-resident-val">DSH · connected</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">theme</span><span class="nxt-resident-val">' + theme + ' · host</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">sessions</span><span class="nxt-resident-val">0 live · ' + held + ' held</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">desks</span><span class="nxt-resident-val">' + seated + '/8 seated</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">visits</span><span class="nxt-resident-val">' + visitMode + ' · max ' + visitMax + '</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">actions</span><span class="nxt-resident-val">' + actions + '</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">mode</span><span class="nxt-resident-val">read-only</span></div>' +
        '<div class="nxt-resident-line"><span class="nxt-resident-key">watch</span><span class="nxt-resident-val">awaiting a session<span class="nxt-resident-cursor">_</span></span></div>' +
        '<div class="nxt-resident-term-hint">NO SESSION TELEMETRY</div>' +
        '</div>' +
        '<div class="nxt-resident-hint">resident standby · host idle</div>' +
        '</div>' +
        '<div class="nxt-standby"><b>NO ACTIVE SESSIONS</b>' +
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
      return (
        '<canvas class="nxt-ring-canvas" data-ring-pct="' + clamp(pct, 0, 100) +
        '" data-ring-value="' + esc(legend.value) + '" data-ring-sub="' + esc(legend.sub) +
        '" data-ring-hot="' + (hot ? '1' : '0') + '" aria-hidden="true"></canvas>'
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
          return (
            '<div class="nxt-heat-row"><span class="nxt-heat-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
            '<canvas class="nxt-matrix-canvas" data-matrix-values="' + row.join(',') + '" data-matrix-max="' + max +
            '" aria-hidden="true"></canvas></div>'
          )
        })
        .join('')
      return widgetFrame('TOOL MATRIX', '60s', '<div class="nxt-heat">' + cells + '</div>')
    }

    function timelineWidget(agent) {
      const now = Date.now()
      const start = now - TIMELINE_WINDOW
      const phases = agent.phases || []
      const colors = { think: '#55ffff', act: '#ff55ff', out: '#55ff55' }
      const segments = { think: [], act: [], out: [] }
      for (let index = 0; index < phases.length; index++) {
        const phase = phases[index]
        const from = Math.max(start, phase.t)
        const until = index + 1 < phases.length ? phases[index + 1].t : now
        const to = Math.min(now, until)
        if (to <= from) continue
        if (!Object.prototype.hasOwnProperty.call(segments, phase.kind)) continue
        const bucket = phase.kind
        const left = ((from - start) / TIMELINE_WINDOW) * 100
        const width = Math.max(0.5, ((to - from) / TIMELINE_WINDOW) * 100)
        segments[bucket].push([left, width, colors[bucket]])
      }
      const lanes = [['think', 'THINK'], ['act', 'ACT'], ['out', 'OUT']]
        .map(
          ([kind, label]) =>
            '<div class="nxt-lane"><span class="nxt-lane-name">' + label + '</span><div class="nxt-lane-track">' +
            '<canvas class="nxt-lane-canvas" data-lane-segments="' + esc(encodeURIComponent(JSON.stringify(segments[kind]))) +
            '" aria-hidden="true"></canvas></div></div>',
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
            '<span class="nxt-fbar"><canvas class="nxt-inline-bar-canvas" data-bar="file" data-value="' + (file.w * 3 + file.r) + '" aria-hidden="true"></canvas></span>' +
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
        '<canvas class="nxt-analyze-tps-canvas" data-analyze-tps-id="' + esc(agent.id) + '" aria-hidden="true"></canvas>' +
        '<div class="nxt-kvrow"><span>NOW</span><b>' + shownTps(agent).toFixed(1) + ' est t/s</b></div>' +
        '<div class="nxt-kvrow"><span>PEAK</span><b>' + peak.toFixed(1) + ' est t/s</b></div>' +
        '</div>'
      return widgetFrame('THRUPUT TRACE', 'EST T/S', body)
    }

    function analyzeHtml(agent) {
      // Keep a single scroll surface: the page's setHtml preserves its offset
      // during telemetry refreshes, including when the detail text grows.
      const detail = (channel, label, content) =>
        '<section class="nxt-aw nxt-analyze-detail" data-channel="' + channel + '">' +
        '<div class="nxt-aw-h"><span>' + label + '</span><b>DETAIL</b></div>' + content + '</section>'
      return (
        '<button type="button" class="nxt-analyze-close" data-focus-release="1" title="Release focus (Esc)">× RELEASE</button>' +
        contextWidget(agent) + taskWidget(agent) + matrixWidget(agent) + timelineWidget(agent) + filesWidget(agent) + tpsWidget(agent) +
        detail('think', 'THINK', '<pre class="nxt-analyze-text">' + esc(agent.think || '— no reasoning channel —') + '</pre>') +
        detail('act', 'ACT', agent.tools && agent.tools.length
          ? agent.tools.map(toolHtml).join('')
          : '<p class="nxt-analyze-text">no tool calls yet</p>') +
        detail('out', 'OUT', '<pre class="nxt-analyze-text">' + esc(agent.out || '— no output yet —') + '</pre>')
      )
    }

    function prefsSegment(key, value, options) {
      return (
        '<div class="nxt-pref-seg">' +
        options
          .map(
            ([optionValue, label]) =>
              '<button type="button" class="nxt-pref-btn" data-pref="' + key + '" data-pref-val="' + optionValue + '"' +
              (String(value) === String(optionValue) ? ' data-active="1"' : '') + '>' + label + '</button>',
          )
          .join('') +
        '</div>'
      )
    }
    function prefsHtml(prefs) {
      const row = (label, control) =>
        '<div class="nxt-pref-row"><span>' + label + '</span>' + control + '</div>'
      return (
        '<div class="nxt-prefs-h"><span>OFFICE PREFS</span>' +
        '<button type="button" class="nxt-prefs-x" data-prefs-close="1" title="Close settings">×</button></div>' +
        row('VISITS', prefsSegment('visits', prefs.visits ? 1 : 0, [[1, 'ON'], [0, 'OFF']])) +
        row('VISIT PACE', prefsSegment('visitPace', prefs.visitPace, [['chill', 'CHILL'], ['normal', 'NORMAL'], ['lively', 'LIVELY']])) +
        row('MAX VISITORS', prefsSegment('maxVisitors', prefs.maxVisitors, [[1, '1'], [2, '2']])) +
        row('DESK ACTIONS', prefsSegment('actions', prefs.actions ? 1 : 0, [[1, 'ON'], [0, 'OFF']])) +
        row('CINEMA SKIN', prefsSegment('cinemaSkin', prefs.cinemaSkin || 'cozy', [['cozy', 'COZY'], ['cold', 'COLD']])) +
        '<div class="nxt-pref-note">Visits and desk actions are cosmetic and never write to the Host. CINEMA COLD is a briefing-only skin. Saved locally in this browser; theme follows DSH appearance.</div>'
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
        '<div class="nxt-shud-spark"><canvas id="nxt-hud-spark" class="nxt-chart-canvas" aria-hidden="true"></canvas></div>' +
        '<div class="nxt-shud-line"><span class="t">NOW</span><span class="nm">' +
        (totals.tpsDisplay || totals.tps || 0).toFixed(1) + ' EST T/S</span>' +
        '<span class="ms">PEAK ' + peak.toFixed(1) + '</span></div>'
      const seats = view.agents.filter((agent) => agent.deskSlot >= 0).sort((a, b) => a.deskSlot - b.deskSlot)
      const standby = view.agents.filter((agent) => agent.deskSlot < 0)
      const units =
        seats
          .slice(0, 4)
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
      const toolStats = (view.toolStats || []).slice(0, 3)
      const maxTool = toolStats.length > 0 ? Math.max(1, toolStats[0].calls) : 1
      const tools =
        toolStats
          .map(
            (stat) =>
              '<div class="nxt-mini"><span class="nxt-mn">' + esc(stat.name) + '</span>' +
              '<span class="nxt-mbar"><canvas class="nxt-inline-bar-canvas" data-bar="tool" data-tool="' +
              esc(stat.name) + '" data-value="' + stat.calls + '" data-err="' + (stat.errs > 0 ? '1' : '0') + '" aria-hidden="true"></canvas></span>' +
              '<span class="nxt-mv">' + stat.calls + '</span></div>',
          )
          .join('') || '<div class="nxt-mini"><span class="nxt-mn">no calls</span></div>'
      const bl =
        '<div class="nxt-shud-h"><span>TOOL MIX · 60s</span><span>' + (totals.tools || 0) + '</span></div>' + tools +
        '<div class="nxt-shud-legend"><span><i style="background:#55ffff"></i>RUN</span><span><i style="background:#ffff55"></i>WAIT</span>' +
        '<span><i style="background:#ff5555"></i>ERR</span><span><i style="background:#555555"></i>SYNC</span></div>'
      const calls = (view.recentCalls || []).slice(0, 3)
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
      return { tl, tr: '', bl, br }
    }

    function railBlock(title, hint, body) {
      return '<div class="nxt-block"><div class="nxt-bh"><span>' + title + '</span><span>' + hint + '</span></div>' + body + '</div>'
    }

    function railHtml(view, filter, open) {
      const totals = view.totals
      const liveAgents = (view.agents || []).filter((agent) => !agent.held)
      const attentionAgents = liveAgents.filter((agent) => agent.state === 'wait' || agent.state === 'err')
      const attention = attentionAgents.length
        ? '<div class="nxt-attn"><div class="nxt-attn-h"><span>ATTENTION</span><span>' + attentionAgents.length + '</span></div>' +
          attentionAgents
            .slice(0, 4)
            .map(
              (agent) =>
                '<button type="button" class="nxt-attn-row" data-id="' + esc(agent.id) + '" data-state="' + esc(agent.state) + '">' +
                '<span class="nxt-attn-tag" style="color:' + esc(agent.color) + '">' + esc(agent.tag) + '</span>' +
                '<span class="nxt-attn-state">' + (agent.state === 'err' ? 'ERR' : agent.pending ? 'INPUT' : 'WAIT') + '</span>' +
                '<span class="nxt-attn-name">' + esc(agent.name || agent.id) + '</span></button>',
            )
            .join('') +
          '</div>'
        : '<div class="nxt-attn nxt-attn-ok"><div class="nxt-attn-h"><span>ATTENTION</span><span>0</span></div><b>ALL CLEAR</b></div>'
      const dimClass = (agent) => (filter && agent.state !== filter ? ' nxt-dimmed' : '')
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
        railBlock('THRUPUT', nowTps.toFixed(1) + ' est t/s', '<div class="nxt-rail-chart"><canvas id="nxt-rail-spark" class="nxt-chart-canvas" aria-hidden="true"></canvas></div>') +
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
                '<div class="nxt-unit-row' + dimClass(a) + '"><span class="nxt-ut" style="color:' + esc(a.color) + '">' + esc(a.tag) + '</span>' +
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

      const load = view.agents.length
        ? view.agents
            .map((a) => {
              return (
                '<div class="nxt-load"><span class="nxt-lname">' + esc(a.tag + ' ' + a.name) +
                '</span><span class="nxt-bar"><canvas class="nxt-inline-bar-canvas" data-bar="ctxload" data-agent-id="' +
                esc(a.id) + '" data-value="' + a.ctxTokens + '" aria-hidden="true"></canvas></span><span>' + fmtNum(a.ctxTokens) + '</span></div>'
              )
            })
            .join('')
        : '<div class="nxt-load"><span class="nxt-lname nxt-dim">no load</span></div>'
      const ctx = railBlock('CONTEXT LOAD', 'CTX', load)

      const toolStats = (view.toolStats || []).slice(0, 6)
      const toolMix = toolStats.length
        ? toolStats
            .map(
              (stat) =>
                '<div class="nxt-mini"><span class="nxt-mn">' + esc(stat.name) + '</span>' +
                '<span class="nxt-mbar"><canvas class="nxt-inline-bar-canvas" data-bar="tool" data-tool="' +
                esc(stat.name) + '" data-value="' + stat.calls + '" data-err="' + (stat.errs > 0 ? '1' : '0') + '" aria-hidden="true"></canvas></span>' +
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
                '<span class="nxt-mbar"><canvas class="nxt-inline-bar-canvas" data-bar="latency" data-tool="' +
                esc(stat.name) + '" data-value="' + avg + '" aria-hidden="true"></canvas></span>' +
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
        '<div class="nxt-phase"><canvas data-bar="phase" data-think="' + mix.think + '" data-act="' + mix.act + '" data-out="' + mix.out + '" data-wait="' + mix.wait + '" aria-hidden="true"></canvas></div>' +
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
                '</span><span class="nxt-fbar"><canvas class="nxt-inline-bar-canvas" data-bar="file" data-value="' + (file.w * 3 + file.r) + '" aria-hidden="true"></canvas></span><span class="nxt-frw">' + (file.w > 0 ? file.w + 'w' : '') + (file.r > 0 ? ' ' + file.r + 'r' : '') + '</span></div>',
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
          codeLine('visits', '1-2', '# prefs') +
          codeLine('actions', 'waiting', '# phone/game') +
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

      const groupBox = (key, title, hint, body) => {
        const openGroup = Boolean(open && open[key])
        return '<div class="nxt-group" data-open="' + (openGroup ? '1' : '0') + '">' +
          '<button type="button" class="nxt-group-h" data-rail-group="' + key + '"><span>' + title + '</span><span>' + hint + '</span></button>' +
          '<div class="nxt-group-body">' + (openGroup ? body : '') + '</div></div>'
      }
      return (
        attention +
        groupBox('runtime', 'RUNTIME', 'LIVE', global + thruput + units + standby + ctx + toolMixBlock) +
        groupBox('system', 'SYSTEM', 'DETAIL', latencyBlock + phase + filesBlock + modelsBlock + configBlock + alerts + logBlock + system)
      )
    }

    function tickerHtml(view) {
      const agents = ((view && view.agents) || [])
      const live = agents.filter((agent) => !agent.held)
      const errors = live.filter((agent) => agent.state === 'err')
      const waits = live.filter((agent) => agent.state === 'wait')
      const held = agents.filter((agent) => agent.held)
      const last = view.log[view.log.length - 1]
      const feed = []
      const push = (kind, text) => {
        const value = String(text || '').trim()
        if (value && !feed.some((item) => item.kind === kind && item.text === value)) feed.push({ kind, text: value })
      }
      const labelOf = (agent) => agent.tag + ' ' + (agent.name || agent.id)
      if ((view.alerts || []).length > 0) {
        const alert = view.alerts[0]
        push(alert.level === 'warn' ? 'wait' : 'err', 'ALERT ' + alert.text)
      }
      for (const agent of errors.slice(0, 2)) push('err', 'ERR ' + labelOf(agent))
      for (const agent of waits.slice(0, 2)) push('wait', 'WAIT ' + labelOf(agent) + (agent.pending ? ' · needs input' : ''))
      for (const agent of held.slice(0, 1)) push('done', 'DONE ' + labelOf(agent))
      if (last) push(last.kind, String(last.kind).toUpperCase() + ' ' + last.text)
      const items = feed.slice(0, 3)
      return (
        '<span class="nxt-tk">FEED</span><span class="nxt-tv nxt-feed">' +
        (items.length > 0
          ? items
              .map(
                (item) =>
                  '<span class="nxt-feed-i" data-k="' + esc(item.kind) + '" title="' + esc(item.text) + '">' +
                  '<i></i>' + esc(item.text) + '</span>',
              )
              .join('')
          : '<span class="nxt-feed-i" data-k="none">AWAITING TELEMETRY</span>') +
        '</span><span class="nxt-ts">AGENTS ' +
        view.totals.count +
        ' · Σ ' +
        (view.totals.tpsDisplay !== undefined ? view.totals.tpsDisplay : view.totals.tps).toFixed(1) +
        ' est t/s · TOK ' +
        fmtNum(view.totals.tin) +
        '/' +
        fmtNum(view.totals.tout) +
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
    const GIRL_FRONT_SRC = 'data:image/webp;base64,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'
    const GIRL_HAPPY_SRC = 'data:image/webp;base64,UklGRupWAABXRUJQVlA4WAoAAAAQAAAAowAA7wAAQUxQSJcOAAABwIbt/zm52T6f3yxi27bt1LbtNrVtt6mN4LbN6GlTt0nvpAp2Y9tOdvf3/bzY2Zn/zvx//+dtREwA8pwkKjfr0rlrKwAgkTTpADTtfMUjD00vXVj62RMPntgMIBMFCRSOffTjZYdU9fZv7u0IuARBoM2VH66XJKta8vPuaQomBRKpEz8vk8zMVLV5yf95PMhEQGD4BxskM2VrZlp1NhIBkTppoWSmSL1Wn+0YPqLBxE0yU9Rei3uBoXNo8GaFvKrR25T6ZNiIBm+Vy1SdpgPnIWxEg7cqZKpe078agwEjar1eIVN12cZBcEE7e49M1aZ9F4DhIrrOl6n6vd4DGS4+bKaceB8IFtHtJ+XI5EokGaRHvHLSKh4DSQCgY2CIrj/KcsG0dTgLgDYDigoAkEFxGLUjV/acCbSa+HXpH39zfb9igAwI8VCZKSdN8y8Y/pQqly///bXNAYbkecsRSQd2HTRv3ks69Mn5DgyGw7jtshwxVWnmpS2vd0AwiaYzckZmlqayl/7agQwEiEsPyXIkS+81ASmSDAIb/1b5aXqtASqT8Qei/XUfyfJAtv93Q8fef1QTgCFAvan5IWnTFr/t40tSYNwRza6efUD5aabKO97oBhdvDr3+c0T5aybz0szucHHm0OsjyedPWvOa1R2ML6LnR/KmvDfN6gHGFdHrY5ni0DSpCIwnosbP5RUPtuvq+Dpui1k8yDSnPVwcEQUfyhQXtvsYxpJj6o/ysaFd4+AYQ0D3uXGy56x6DoydVIM+/5UpPitKvniiAxgzqVu+LFHsTusCFycsvG2XZPFi3mtaVzA+iFN3qMIUt+Y1rR0YF0SdP8orhs10f5ycvtMsjuTtu25gPBC1fi9TLJuOXAQXF42+NB9X5ZfEBuvNVnxdEBvosUAWV/5eMBaItv8wU0yb5nUB4+EhxbjZ5Fpk/hFdf5TFmLYfjxiAe9ibYtz0q1pgvhFNv5SPt23HxsGp22VxJtOjLt+IWr+TKda9ZjcC86330rgzbTk2/24ot5iT6VEir4lav5Up5r0+aQTmEZ3rvSz+TFuOd47MGwDXl5sCeAvyluCZD/d9XkGY9tiz97YG8+OUjVq9VcF8xOUD0fCf8gqkWYXmtQHzoccqM7MwSKalnfNkhUzBNJV2ypOVYVny/5jugSntmB/914Zlec/8uKs8LEduzo+XZAqo6el8cHg+NI/D5RyBV0PzHMDcIjDw1TWhWf1YI4A5ROCEBQrvkelHAS5XCDR9Zq3MQmPS6sfrwTEnCJwwq1ym8JpX+bu9AVdtJNDs2bWSKcgm/XBxHZDVQgfgpFkV8gq1mQ6814cAGREdATdw4hrJFHCTlj7fjwDJ7EgAzY5+cbnkFXYzaenz/VIAyGyAFiMvn7lLMlPwzaTSn1/esxDZpoY+P3v7QclMidBMOrz4N8+2BjMgTlolSWZKjOYl6b0aYCZDf1K5mRKl+Qq9VkhkSFx+WF5JQ3N6ICOw7lMbZT5JmDRnCIgsC46ep2R5eNYwEFkSGPT+4gOWEMwOzr6mOYjsiaKu/5K3JGBef2kJEFESGPatZGZhMzPp64FwRLQkBn64QZKFzCSte7cfiOiJwvFPPfu1zMy8t9CY997rp+eeHFMAojoJAMeuUnoLiZlX5Q3XAgBRvSRd0egPVmxa9M77WxXYrR9OfPWZ0UUkiZws7jWgm3MTVu4PyN5Nsy9KIacdAJCpDm/KAmF6rU8LgCRzB6QjUH/Y3wMyOQVH5H7/Rz/domCaSjqRyHliwFvz9+44GI5FbZEHlduNHfaOLBSbjskXAMGQ6cF8cRy3MSCTisl8IIs+kCkYG8chPzBmQzhkmlRE5h5Rc7JMAdl4LHKPLHr8gCmgpk9bIpVjdDhmi4IiK3uuBlxOERg+V6bAHnypCxxzx6HW3SUK8dyRAHOERKeJh2XhMdP/zqgJ5gSBUXMkU4hNu1/qDLL6iHp3l0imMJs0dyzA6iJG/vGwTME2qeSeemD1OIz5QTKF3Kt8Yj2yOogxP8ibwu5V9hDI6IjRP8gr+F7LxyE6osG/5ZUAveb3BiNLPXzIWxKQ6TmHiB36LpNXIvRW2gcuErLgOTMlQ1P51VGh9gz5hCDT72uAEf03OXjNrBPZ9ORg+mONqGr+JTGYyq8DESlx2QGzZOC1oj9cVI1nyicDlT9VQERMHLNIlgTMv92AkSGFyw7Lwmc6eD4QmQPvLUsCkl98Y20wIrR7fKtMyXDv73uAERCFJ81UYjRpRm9kT7ibt8ksKchMC28syC518055JUmv3TeCmTncsFNeybJCJf3ATIjei+WVNL39sR5YFdFxmnklTtOeszJKPSlTAjX9tR6Zjmj2tflEYnvORgan75QlEZn+Whes4naZEqm371umI+r8PrFoXouqWn4vn1TmVwEUvS1LPMQFB2SJxPRuEdIT7b43n0TMDl0EpgML31Yy0eyWmWDQj/LJw2v9sSCqJsb+KJ80TGXPpJgJiKPXyVcySwjmVfZyPWROFly9SDIzJUSTyl6uA2YGEOO+qpC0dYNPBKqYe1s9EFkT7W7/ZvUvx126TxY80/I72gFEhATa9KyD0bsSgNfM2nBEpCRAd9q+BGC29y46RE1HvmGm8HuVDoaLCg6tv5FPAPL6vCsYFdw9R8ySgJlerBEVC67fJlP4zcts19lgRmQ6h/GbZEqIpi96gJkArES0/o+8EmD5jOllMtNVcFUxNXgU0t3pzcJnOnB840/kdfiSDIjzVyw73RFEu7nySgL7TsSEI6afuoLpHPrOkxZ0gyPuKDPzlgAOnMLTDkg/L64Kxe+pwg5eCoeOc+WVAE0rB+PM/bbtBBDp6z+8z8zrfThccFjaPm1tAni1kKcd0NSaTEc3a68kr/80Ro1J5jW14e/Nh81s5RDg9CP/6AACAB0gmWTaOgr1P5GVXYjfKnDSqwWpTr/5W3sQAAjUH+9NlXaMQc2pZkfO4zlrZEGr+GyQ6/jAHa1BACBqnPbnbaqcBheX2+HzgGsOm4XLtOskoLAxQAAgOk/crfRp2H66Dp1L1+gXCph0+P8eG9cQcADgMGKOZJZJCsdu1nlwaPFrBX7Hvy+oDwIOI+bJTOnTOBaf9uc3WxcWoMWvfMjMpAPvNgKJYfPlVbXXRy1AAHVPufqarsSIrbJwSebl328M1v2DvDKagkoEGratTTaZFjbJzL9UhLsPmGViNpEEABIAidfkwyav9YPb/yRThqadx8JVAkmQxb+SBU7Sf/9YZsrskxZgGpB0GLs+CWRtegEEQLTpAwC9PlYSNMvMtHZUFQ0eOrtTl1EfyZJAtqa3CojKxMn/W71ivfnkYVo7HFUVjvvYlEDNjtxZwHSVm13zwrPPfCtLGPpnUxBVE5UnycssOZimdwORKekwdIVMiXJGFxCZk4WvyuS37k8Of+sBh2zQZ5m8lhx3x35ZIjBrBiJbhxHbZfYs6v8rEZhJICIYtM60agDxaBIw6fA2Inui9q9lC9oC9yUBlX15w3BESQyZqwXtgMHLZYEzfT2hNSImjtuyrCPoXgqdaWYXgC4asPi02Y8Ukd0/kYXMtPN0OKIae4wtBvBA2Ly+bUGiGh0A9r38KzML2vzmqBbQofaHJkkWLtOf61YTAPZ6fMGRQ2VKb+Ex021wyMFe55594WyzSgE27ToTrD4SACbITKoorwiO1zfNcwGgS7nun6lCR14684VDsrCYXkgROUqctVO2/0SccCAwpt2nweUKWOvMT3TkDDd6g1UyC4XX1y3AnAHQ+el5p6LmB/KmcJrZcykihx3Qsw3Q6Z+St5ULKsyCoKV9kFMgABCdfrNbuqdfqbxZNZjFg9n+ex2R4wRA1Dn9T7tvxXlrJJlFFpde/6yHnEtLoM4Zg4ljnvp8m6I1r/KSknJ5s3wz7TsXRH6SSN/0xHue3CDLykw2qXPnSaa8N9v/WE0ib0kCJICupRGobOW7TYAm76zeuOxIfnn9vS7yqEqm3C0Vpqz/fX2vWiBRs+/R/T+T5ZHXnCEg8t+5B5WNmSYAIEAAuDePzGvOYBAxSNwVxU0uRQAgU7hWsuzMcsKkOUPgEIepY2dmJdP9INKzxkORSFZ95rVvcn84xCDR7HOZsls8GkxDXLJZpqzLN+yTmVWLmbT5oWIQ8Vhw9Q5ZdjYhgxN3ZGdaedy1KyWZRWYmVXx0VCGIeCRa/hTFou4Z1JhkEZS2weCXSw9I5s2yMjOTyr68uTVAxMb4zdl5fd+8ChD3KYLv2hOpbpdM3yZJ3lum3kvSri9vbgOQiI9Of/dZWcXUOlUQRTeulWX1SgEdgCZjnvzZwoPK9tC2LyYe3wogEaNEv+WyzEyLe4CokqmHIrgPBEkAqW6Xvj91wc5t2ytv27niV5NuGNoGAIlYJVv9KJ+Z15wmmThcbbJsHgUBgI4A4HqOHpl+VP8iAKAjYta5tj9l97/mmV2XjWnvxc5VAkCSyJx0RBy3juDbZtW0sAUyJukyJBHLgwZ3XZjdvFaZXZXdulsv6pVJ/BPNP139yT5ladpzbibE0zJlW6aptcCAdF2h7M10G1wVxIDSCEzLugal0xKriOLmDBxO3xGBtxXdgtJ1mSyKGzMgm3wtn5VpeViuP+izk+l5oir0LZFl5wNzi6I0lfQG0xC1f2emCFd1DUq7X83Zl53MnnZIzwl7FcH+bx+rHRDA1ehdIstOJb1BAETvEpmyNS3pSwSVaLMoApk9m0Kam71FUdIeDAvbR+I1rxUIou6fZYqiU2jQbmE0i9ulab1APpKOgQFqTonC9ElTEEDxe7II7Oe1Q+Nwt/dRPAICcLglAqvQgyBC84Bklo33d8Klud18FmZSxU3BIcZ/sVWyLKV7q7hT5i1jqWLuHc0QXtf0mKlblOXWXw4GARCj53hl7ufe0R6BLj72wcdnly6qcsr9xxej6g43PPVJ6aL0pZ88dUN7gAwRHQC07NK5S/paAFgVgFZdOnep3LlLSwAk8hgAVlA4ICxIAACQoQCdASqkAPAAPhkIg0EhBjcrdQQAYS0IjwoABlmm9/O/yZ706yHX/x9/I35Hai/VP6/+gf3x/0vyw6QOqvKa5k/2P9w/Hn5wf6T/pexT9Nf+P3Av1D/3/9x/z/wS/5Hqn/dv1E/03/Cftn7xn/B/ab3P/2r/VftH/h/kA/nX+E/9Htdf9H2HP289gL+e/6L/x+uf+3fwY/17/c/uB8BH9F/vn/g/Pj5AP/b6gH/Y9QDsFv51+Fvt47p/mn5Aftr6n/ifyL9P/tX7Af2T/m/6L4Vf5Hv6eifvX+t/wvqT/F/rv9p/uv7Lf3L/z/7z5F/zX5VecPwN/lfyf/Mj7Bfxf+Sf13+y/sd/a//N/s/o59m/x/5LeOFr/+L/2f5T/AL60fNf7z/eP8r/pP7h+5fsjfyX5ke6/5n/ZP9r+VP0A/x7+Xf3b+1/tX/dv/l8/f5v/b+Ml9o/0n+k/y37T/QD/I/6D/iP7//mv9v/of/1/xfxP/hv9//lP9L/y/9N/+veP+a/3P/Y/4b/R/87/G////zfoH/HP5l/gP7b/kv9r/ef/3/v/ul9ff7Pf9b3Mv1e+7z983Qn8uBOHRuMVFx113k4CGqE5yrjLVIC2TiJDCyXt5GjxCMhHNmlIqlkQuP/N2veCK1malO9PgAx4Tjof23J40ZkE/8ayJvkq2sOF1k8vxdDXVZQSP3Ff5U+dAekg7TPcTYn5XJ+bQBvCYoEEAm45vETH4/65rInY5SRfka0tPYRDyehHahoDTWQALpZpQcqXdhIaUPjIs3bDpF+sVE54wLXkUM35E4k3QBnmsqIamVXMR1/zPSpdSmFtKCvqV4KWhlI3mAbBeOT5Vr170aumzllIbJFRrcbE7lRuT1D3Y4x2DZZkDA+9sVCS17f9/KT4BpcrOFLh2JJysjdAQqYBzlGnYSy7m0BYkiuaKkEgR9q2aJmwjidfE4Sv/yvKZUKArmqiVBdaqCSLvjmzD+J2nIicPShM2OtIPTK90cb6MqW7acZdFYyzeVrGeuGtwKYxZQfkWTMOfzEa5Uf+XBoz469SD9dSpg3xkFseZf8SKDAUFxi9WsSN4uHsCGtQWck06yihS6NoupaGV1kXk2zrcp9fahmI/pGLPgjn+/MH34rVOYNi52+wJd+Z3Kpu5Q5ZFXk+lTeawBKLUpKZ89KmR5Xtvk3KP9jH10vnzdKu15h05uUbQ4Y2hg1YduZ28iZvT+agJdwqymsWLnHNeABbdR3zqMIo2xlqWIBfSoDuIbJgQWetw7zOURswVXMZjfbSI7AsyeU/oamDIHt1iWJ5rCmHTVZp9nerOlrD3SLhWDBShwCZWNlnxeJukm1jonKKXi162EW55Kzd+vMr+myFcdHixlYHyDw3/Iq+P1G8oFYBhwvna67FKbljYhvjSpTk9hs0rL4WnvPhs0vF0+lt4EYQdEFZL57d+exmAZIVdweuuareSL8WfayAVX7gX59Mmxwd/86Lt/0Cx/l4OYirvmiTjLi3KVq4z/+jGlW9CoeAjk3NF/onA9KMuvnkubYmI+QjHlfAD1nrWmX6wW0KAQW8wQ1UfOhxpmwj0yiKhiJTyer7MKoQxYn2vetDUGL91V/2JXVlk5BGtEl2Vme8H+EF7lRrXf+asZmxg11xKH/FoSfuDLYynOkdDoaSw3sxqcd8mnVMKgR8e+leeop3OUJqmGaBB0aEsPMv7MYvPr6mn9AmjGcXpnfc61RUIN5UAD+/JnKIwJ42QQK7CmAd/C2Z8RmvitV70Zygl82GRCrK5NtHucNp6ZbAim1DX4EZzhHYadViYiMeWBaPVcKSasoYUGj2yGohOPM4qkyTmLozcf4+weTJOGKsrrBAzFfUkfarWLhMsgTJlf8xaBWWY6PpvOCxF+5wpdNMG01dgqR+xSMKR3+wGXz9omWpk1v6ciKjgUnVnASP+Kg/hM4KHuPc7cj5JDfCvM64m+Cau6I1UAPWD8jAXkKM7g0zi7oqpIAp0zdIpnGJSqeb5eDU2ytDyahDiwaKRuHlyirsCv7i6YneorQfdP+DFULz5KKj/+GE0nUZO9Ym89DhLrdgqkvv0cIdzG4UpOZxvf1q7fv/SDSMaEa7NvBgTQ9sdCYwRkA+m2i6ujho6YMMwBFLgQmdnCvCBydTXXEHgO4wBhQKIy0uiZrSLE/QJN6ig87/4vte9YsgCvUOC5ek9l9tH7hzvlXtPMleOd58L9LjzkaH+Si9RTFms7oj/2Rnt9k4PeN/jbT/q1mX1dWWEZqJGkeqXNxGe3glg3oNSqIDett33xB7LVSD7g9HCaEPfLj4e27sRM0DoG2EZ/hP7DiMBRDwBROIYdmdptl/tiz+6hAA05WcHOz+f8D/e1Ek9BzEtX2MzsBkS/CF0e436vdd608KJl/ls/sc3cVSgGb2t/ClOdwJdnNWn+/N/kUZIrLB5+CgCXGxdJiA0wt121bWqMDSgNf86CwIN+6gYXQA7UUUzbTGwAfpK/ZJPvOfn61PPOoyUji+Ux4fSTqBeZKYK5gR4U/pQM7HPsF7RPwGo8CZJdJOcNlY89lK9M4YgFL7aKUzHVZtwuWkfjccq8Pqgg0pSC+DOFtp9U/kkDnPSWmVePBVKRrjP8j1W0QQFL7oReq0PA+xvKP+Yt1QFBVUbqXooh9Uok/vlBXm3373efpNinBK2zX9/+npRv2zGiIpcYDqPazgQCeaX0XkjHlTJdFTk+6DODTz5+rdlgiJ322lDUQQlZ3rPdZfpwZFNasSrFhO2a59qKLR7oRO3JqlHZan+uYnmLE9yEnX195sbThXGJA0At5sdRrJUvI3nMkjViTrdMwohh3xubGm/YGDdPx0SN54XgrXnCHJQ2TIQPFelAMEKMTvX2UMwhhFOhVtb12pjzweBztN9KlvkdYqppYjTmCOfhVf72wWZWq0L25WdXVg5O6KLE+T5reHOOnLQPy+Asdr68228AGroTMRMlPavANkGdABU3ZkSXTOX8nQ50Z6ruWe1SoWIkGSgiBdpjBnC4PVlex61BeDXG6DKQ2IHmvnOjd+uZXQRIXoJcP5KNL+1U26Wmry2SXX+4pNZoYnOBrVAz6lCbqH/8vTp7A4y76HOMXZ5m1SvYqN+qXkPOuAmt0VdcjygYfz2TGi+J0Wxb7UGvc3+Y/zQPhh+Phn0D1pac8r7N4rC6ghgueYJgwrQDwT9lCb3x5R+rZOD346t5pgbU9RqkpA1RqUaG+hP/93lRcAJe2WOohWrVuiTzfBvOTkDrihAp+kzgzpvpZEY64Gpc7vqzmPSdWH9yGkkxXS2Ja6pfF+W4OTecIbDGMHfxSF1XqHBDoHOP3/W9AOnbcSo2+ZbbK7VwS2gPzs8PWwAaP8X1Ozx0XZAaplbxuKS/HqMYUjAef72JZnazaf/oP5IY2LNUvWxfKtplXGMe2bDEu4aALSkI1hB1AsOJ9EEiEKvHw/5Vizaudh0VaBfQQJ9O8Yu/LjsHKEpcyirrVUIS3g1kD/2Y45qqvUS270WogVDiAonnI5Vzp/1XAHNLpbKflF2YTld9BoFzHMwoo0hUaISS8hObD/0o5fTQ/zpkfx5qJXpI5vhTbQELOCrI3fDpnC8+C1cAkjhT5pVt5KsMXfUEFehsLiaqyliy0o7hZBUamsHhq4Eqk7yM58Q64uyKYtBvzba4ucTxi8k5L4+23WitBl+3Bigiet/oFEnaUmgKbpCE4+bG322jQC9G+0sW5R+/o5QU8i/S8iy2AkAJr8s4TsfcMXgAa6k3VJ70S/GtyzWsDZBg3zlM3Gnt91U05TSI16tyCXWwUAdTtjSemRba5sbSi+1AkFVnxJJTotclN/aohsoLAicjmCcY0qptBeMcLNnWedFEI+ItuqIKOBg4C089VJrMWOfxFYmoDAOiWTGXnfR9aibdNOaaUXted+hEyGeX4iVKN8PZ5P1p/5UqrjUfgk3n/Nd552eiztG/4cCcZR2mtSr4PTf9M2SZDPtCBG8z2AwFDTNcTjfNw3n/mJWKc8/IYwxl0Qs/QrxmQWpSDnDu9lzrWt7morzi+FqR8aIKaKoiehf4htxJjqaLC1GdLul0WZy8geUSeZHJDPg2xuZDK1tKWejKWZaSICwiG/8mQOu0/UOt3oiM3i3gkksmbReZ4JYvTVnVZ+VMwR9K1IL3umc6yYPCyh12c+XB+FJQNkLWLiFv9xGUjZLf0U/zVODB02QCoGXsjzXqZPzbwznRuJtIbadQdvccNJavgFc2FKP2k/2iFaz2ZCkoUgDhcj4GYxhXLZUuN3yoOG2PITnwcCAcJkYVqjLrH4cUMx6OmaS3nHx+5Sn74mIgjfGrZMHDv+shJbiJOE5fydYsgsnsJDKBQskhRfRMqYB+F0NI0gGJ/9D6BbulELRp4220u+r9wgBW1R91niwwOkGq4n6kxUOH4E38YZ2DfazXsazGhajFKWC3uBOSvKyt0+YYHb/XsBBwfRc6EDY/a7rxKqq9I0H9ZYad2+bAIsYmUcxC+fwzsCDwswUhNHip5homw3r87xOIOeIDrZvB7s3E+F/OG7rC84Qyoznr1iWoAJTXsVLDSZC5DQNRivM9XJPL4Iq4bT03RFdS8BiTa6jcXY+pp4Mw0Dvjhh4QvjMWBTsQaF2rxV3R7KMsTsRuXdJoXelCYSHZCyYg6LwPLl744VONUc4J1R1qyaQR0k6ugePtflu1Pjfp5ZJuaO4e4U8OTQNycLIE8GJro7s2QRQv9KxgtPXYOl3/KqEpVYRTtu/MzpNSXzyXXGrq3Spf8IoUiHsbPBWqpPqJaJqzCHmeqTq3uHNF5xH+CBq6rp/g3kO4xgg1eHyLzEhBLGoEnLRvDOxw9YHxzPmH50punS0ETw/BMSYqr3+XdBYKRFbh80jDNAtRWJ6x4GmWckIdeJN0wUbc+0rcPa6961skzwiGlSwstbd8MiopURVyZLY20BQPzKVUupoo+vfdFmsuKVi+loql9VBtAb0xoVHdXBYKgORsXjKTtVOejhwSc80FV1lYfJMYweA94D5/o3q8CXgtZ90/pGLPqpES+wzYLc6glp4aADqDkICsrpfKsS3t/8L80FLj8hjI1bKMHgvPrCMfm+nEqNEcajkGidhCUfP4KnzHI0zWGjl6V81R0YhvSNFst2/lXzi+VpJwy5+13ZnzCpepZIZcazS7l5RdUO5wS8FOr+VeOccWV6r6sWv4tNIR+1+dQ6eUbp2O39k8v07wS100c+Z0S13jPenjyB3Hzs3Xk+VTqw2aiWt/CCR8ffgmS634poN3c3TvRpkTnvRJNA0Cbiqng+62nBO1f2n2FfsTwSXu333pGiv0OQrSpfCeWJUpy37QMbylN7gzSrfOJZPm3TD0txIjBJSAIS/ns/8X+sXjHdmp/aoMyGdYC1ctaYAosEW85iR1mta8ZvASkXDmAnAu8LK/uQrjQ8uzn8CGhFmmJ+PFWfKsOCFQNGCGQ0yATOwbuAvXC8aWNPZXcYtEnuzB2i8k80CvIeQldQwX/U9fvXA5no0DpX1+4AqJqmWs+T7z6bk//g9gmd2AJIcgLUgypYEB0eemj3iTUv5P1O5JLAmbeU1jZUq3DUG85TH/n4pV7fyh/9C67r+SJadXRQXZhXb9EIlJH4S/fPa86aQIRXpLAG52i3IAD5t+gEbzKW/fX3NjK2dm0pti3m05euzbDu3rCUdmyJpUOkeEy0TLD+M+g3ujEgPzJnH0gPGioKQLkQFqhlcNZDZiwvzsDwoBJP+NamXn/kt8RzBqvS9ILM+KZudXAtFb2PnYLqPJX9GEz91wg/Pc3vakOvlUFs3mhBBaMD5dokA9YiRfEH56Z/rVS4YvSMe2XCjMM67mOi3+5X4ENZ3wIW3pltjxEniSiBh+DYa12ITiLSyvSgTcFcZw7h4LfsoHHVpz+4lypG40rfOpDbZvcP4OGeCydNVaTIUle2crR1dMdx5Yt/RfhDnKGO4A50yFhe+zPeWHYomhqgO9wNDnUaM7vvQQiKsifKq/jOC2q6V6TZHBwAMs5RXrHEuOFmDleo3Khf/ya7yyhwgpNvym/AYkSupWkKXjipIWNn0lxgo4uSNU0npl6dW7Ka9mbPx/pGKqP+zcWYbuyseBeD+PIfOlooq1KK3sMVihjC7AjIVFUeowy9K1vgMhrqysxxBm+DHbpDalCblAyq0noAEtPSSZyGEstvYxgnZlywhRDjatGxcReTfLADFilxRM508+YiID4SEtfb2wZ3I19dGLt3L0TAPke7/rDn/VqQZXqlPQn04rdC8J3k4lpYLUF7/deyYCfHAAj00UsaTMe3ZXsJJ7Hfkpr8uOs+JQIDyRGuKuTtb1c8mGghuatYiXBpq/ba6AB6ulqS9Uu5BBPO7US01yzXY9GNxUfDl39zVdbO9InkmNPKw5AVXyKm+d+BjhGUphoVYNjwvfKp0x6yC7X7U1TMBHGzxuPhfTLVD7AWuC7A+e6selPKVUkNAfsz1M4DDaTHgYTYymxc/rgV/B18VC2XRjLcHrDdb5zZWCZ3qzWmuCKudbUrt7CloU3CxMlyXBETq2W+1G+FHXBoeY81XrTVGVW/Na2GTTnRnV3M0jCY37GJSMiJPseDuLm0IsF9hb4gpzICctq1ai3uyhpGmQ5uNXUucJr9iLH+sowlB6RuKEHgH3gOHGokf81pvxumui3NyoeUVxuWCKjgOGkYRacj8oDGPQuDlPVMMi8Ccuj13cDMJs8BDn9W+BiRXpFEOPAXh9I3//gnJ1m5dsrsTSPNEkiirWtEpVZ644p6mOp2ElMpXj9ucjg2Z1gwp/4/+C1/2uaD6k+uAfL+gcu9GTeZulbLfHXdeqiySH91DdcDAJ6YaRvOfUuCNUKB2yNdIRHQ5RagyCcl8qTbv+8mUKWSAo7MOVx+x6Nt6nnASi/nUl29Cepoi4pxbA2dYIXhQ3O4ow81+u31A1wwWEBz6xVf4yRbCv7Hx36k290Y79qKMHdG5tJkLIkz8f5d0Gmq2F7LIbV+BmL1naeLCnPKtPLhtV66F8r33rdeueTQv6Stuq2vIRH6rmBTAw+0Scdp6q6kwtc/bgL3f8EBiJJhdsSeYOca4Wds53kN7F5ls1NaPDiYEz6ItX/FYbSzaE2IryW2MWW9U4vbOExK4pbChklC/WGvzNUwnroN5869FO0D86T/cWbZFPC9ubf+jxqP4blMSE0Jp/GW4otSCkg+H3UgwmA/Zo3oEvVlnOWK308socFSWlG3KJ9JUUXgRIWqWwbGp5gceChREudlrVawV4pvzKZoo+XGX57tj3YF0Rdwk9yLBj5U52O9qTc/whfPXslls1FZm3RSjHNWOMlS3+oVkM7K7EgacfePSIrJcFwJSsoTG0HX9SciP4rWLHO/CAyZ0vcttmFeJLQDP8FjUj9cSmK50wkbDEVGNHQLDzaCnMYVzI802SQ2Ckn6C2yoOj0cEln+rHHIRHmpVBiTMocFXoPIveBv5RDLQWLFoDeHqjdeMhZqiDF3D1O2u77ypOIrh/a9rAQHVDl6CJZ7SuYWzW9DUQBkv7T2RNskEw1uS6GSMwsRY9UTuKFayZvisNLPFkzb3c8TtjBkwXT/RIeADKBGjTstQdn1DY9jkhB7AZozs94EyICWenVKj+hOx9iXG1kTH9wNN8+pp7K7be0v68GLL51I+fl/ueHiTtH8h4Jw8HRTtqAKTDRTc5gJxeiebrVP3NvmuYOZRTA760R1z5w8KmUrPShfohjARG6MbgG40RZF5nsfk3iAgkjB68gsJF9LRhdDBmDy3cuFRmKZSXFu/2Z3tTyYfJf2WylsD1ZttMQp9qM7YvsCd2ENm3NoxIrAyGz3wmuI3IugYVFnayKitoA1wLEEP1G/xJG698Ot09pwt1gOhNVaujamPWTMw2nxp1LP4YNA7RLC2vQILihOa1XSOw1STcpIfx9Z0ZZVrI5eMVZpHKnXmQAo545V4USdVYtaeB0adZOXOPDS+MY+LNmARjvQGV9o+tnjOXIgc0IeE7nJhEHaqhCCFPb6sEESp6kUrE/utEIae2tWhcS7lJvzFUIbN4pzlBQXoY+FrBalWb7EKdsHjixjW3wYDSrCjc9eqiPPVdyxFM5YUPtR7vZyufRq9p70rRWwmSvTKrlXUlx+/ENXAp3CSAJ6pe/zy//HjSMKj0HGdeBeZuYdmIY6XLCsgDQyGgdnLHPQczY/iNVXD+04jw4Oc+rxBjUT8YjkRf1EmYXX4DyBCflCRKErCFKzkuE8rOhbcPkPSkYbXyxoAqIh1qlZ5CHw2loKtHGUlYjOzn++6R3OoRqpuOJ9fTjveaiKqVCY1zkL12PxeOTFXeMeomm854W0IsvkSjMfS5z3Sxarr94LtW99nd6xc3G3N2r7xumjpR50Y50/RMf2COGD7nT3nSoFfPYHb34mT/vfjLSdwrkRsMKSXHM72JN5O2kS6INakGg860Wtz6SJHq17F5d4CJwfGTObJlpLhiYoJSq9AFtKALfuAqRk8MFM63cz8DN6uYacYx6RMOu3WtmJqVjWmTqZoBo7/xNvFXlb9fNZKwuW5GcaVtQwDWskb32ZM4iZpqEnrZ4iNbTMeuICOba2Ui3qtkc3Ag/4Ryoi/GtemWt/VfKaX2QL1s1+Xevfmhwy9icvFIn4PIMxqRcpeW4E5dG6cZkOR3lj7/qNiECej3CT2qiVrgjP7HDtGWSxGib+Ur8y+O8MFhikx1/Fa5BBiXmoMZ+UAINdHyPexva7cBHRJq8jNSrC1oCG4U/00eF+0GBG2wcudcx5r8mWp4lLUJrC3TnNOmCE6M6GH7m3FVrmFlssuIcyttVNezzM5DiieEEpbax9Kpqu+ndkBuZRu5RqBDqiHbm+ZfKe2ceWRW/7NS87CdC1pn3q2ajM1/Dr+D6070o1P9y5psJ0b5n8K8ev4N4tT2RvFp1VvpUU2LfgQYPGsmFbaxGvkZLs40RPum6P57BG32zMZggwPxAwt1kdWHEW9cCU4ow/K+IgIPPbak+BS/2fIGoaGlakWrJAomongoYjDCQKRRGs77Au8J4vmaT11k/ooAe1PqHnn3KyrDY4vDVTIBVPsWzvCqaDUQnLJCDPNE3/UVBMyVCXlVaK2qWEjnuWygsSgKOmHs5/u5GSMvofOCNJSPWX0LLye/WMhKyfCprPsBdPW8DQ58S4wb5Rkuk51pYVf5+/WSrJPKWfjn43hqQzoH+9g0MrHBYjglkb93e5m+kEznC4MWMyBZX3hLlM/Gs3//MTZJ01WQHlFhWnxNmWibakLgh7PognGFtmLmBPirIh0ydD0m5u61vjNdMSsiIHjPO0XHnjbbYz5fCUohz3xcjKT6Ru5Sxa4wocECMQ5ZNIl1qwI6agjvCRf5ys0y7c82RZUBO7hHtbYEm6AgsFYVKIHFXS8ubq9bHnA8WHo54kqBHB0u3Dv3zF0+INEZNklIyPJIEKvx3YgWLVEdc51auBkYc+M+mD37Op5roD/nO3MWU+xsURrZxKtLHt/ZlhZwmjIRJx/03Z62NpVtmXRF5FE1QMcIVdNCwc6SnZuHuZ2vfLLpM7LmvI6cP/Tc8/H40Tpp9et4kPPVfqgQe+CUra2t9zZQ0X7/F6PMlB4Qnb34SXVFPD+IN3JEIOOtyd+PeZ2dozZUUZCujTdZaf1FX63asCWIW4fPstgewccN3vzlQvVC3mm0s5HE0896o4RYWSskpnYIgHWs4Je4GUBm3azMILQTCPWa3z+kKvQDi7u5qADl6EpCHzel4aHREYkwX1JCR+lql6R+HfbQj7BFj4JhPyxjBdlNR4YDizArR8a0dHK638ipoq2OyABk2E44eH+uzD8TIdAyNnvig8e9XlcF6i4gPc1loD+rjqffVrMV5CHW6LOOMf2Ncq7oOO+a/KUTnLwRXaJDROSk2XysLwVNwdROYR/ZFOZ2QruBY4OIpN0/rqUIBl7FpHlGQyAW+htkuVxAEEwWxv4Y+IUKa1XSRaPEVCVNS32gULfhGVdlrNC9aZy/LxoMe2Ub4pWlzMubDMhlK86Nxququsahw//gcJctbTLcE8QNoJZwGv0G/D1VciDpTHHfMI5xs+14PYc7y9NQkCAhaLvpALYmDDL5xsQucsYpB2MTHA8MMG6N3U3jgl7H95JA88jPopfQPOtSv2TkBCjIUYC8qL0/CzFqaqFIdwcMSfdp+X9x5mgeN7APnsUEmTa3Lnl9aYLf205LdBS52Ei0j2xF7T3cWAZWCU28UVy45v8MITu/EsZXoWRQi/YaL7zv5HxTQ6NxuGyQjTHbmhVdG0ohl2/XtGxY59hA2oEjQxRDRkKwbucJxO5MzFQsE0F7zUc4TL3Ayta9GyK/BDfAqLlD29JXkzBpoVyArfiR/rD90uYUkP94oVqofyn5hWumHobTOx5/GmULMbdWWsNXUxyRvXVLl4AVVX6HFcTWAoRzpue4uFFcd2Ja7hG0zz3dAOlkfaT7Lps3bYUka81/i2Q5xvvza7RCcnIk0PFABdWC8UM95yKWpTBckbIsIRmf0DRQQnHfJX5tici29JVDzb3J8Ea/DLw/hKOM4gbpisZ4dS50LufYG5cO8B9yiKEvT3Zgz10snJTXJl27Pph5XvRX6zhA8VugxUTWCtkc09Sh7U9ZVecKSWDUwZGS5Av08AvOsp4xdmCiz03LD/P/wQuRSpsG/myIl+wIQNMvarzqELghh7oa7wiL+UdobOApAJR33LpRzehe1Ees0B6qXvz/9pcdEXBNhm6cW+01Z/rPfgM1r8F4ZVTmSdSUM/U/heEd/4WT1EtHp+Jw5mnP/ByiJMjCaUryvacPQRPOL5Db5frRSu66zUduIupu3MhAfSK9frsIIGnq6AyluArMALOBLNoTk02Oaff4pmL5iIigTMnnOUTKLW69jLeeOUZ/YIji8JLindf+hQ8Vxu6MgiQn6ogbitIG7nk4n8EWkTbSrxKfQtSTJYZ9lKR5AKRHJpJ9DZVWOQ/didB1S1ABImr0q3Qb8h7c7ECv0mZNd5Pp2DuIgZ/SWOBcMzr1wEe3KeoI79dzWUnZKaURvoQcm2enOqAiCZczPZ21lAd15ifBkLyGJS4pLx1H8J3sl8WAif7SPcR9CVXRzAqXyRJtwJcF5mm3FxRdM2Za0RBSFoL0uWaKfbN+ZPzwf6SKRAC0hKOrhoK6XxSaTgGPv6WUuIj2wq3EjkjVisntNllqjf9n3Llc1NTlXUKvIm+63eqbq7GIwhjXOKffpIAt7I76xw6J0HfjOFMmNCnNiiZvGlNxN+HazAP4eRB74RlmLdrkDxiZqhufh8iwdgiedUQ2wQ5rxk4elCRSJ3xDKpSREDPKOTYSB4gRTda+03PvwefdHtkPdfrMuZ7Hx7ywLeOyMmIRL2m6DyaHjFScQTKdTUxGNDQ5uUVA+nHA6W+bs7M73e8CLatVB7QdmsQVwYYgPLX6dj5Tkx3F1s55fpiIn82nEtqU7Su/eHkMHz+NcY4xwxIwZya95Ze0am+dJASw93gLtCoO4BueTlzV7rPg67shAP01maCuAuozgX1pSeXyIs2++Xvwzemm3nBh0SMy3md7uqrA2hGbS+RQhKjQ0ePvElB1RB/RgzKBd2hOLovh8YJ0idMkcgXJ8Kyl6U0mXG0mjojPuhIs5fJ987a4x0Q/0kN1WH6EOU7Et1zbWe5sal2rCNOQ7wFjVMJgzR0tFHUy7EBwy8M5xntpd+wAIyZjq/dK5iULN4GywW1p2RcgOUbgbHXgxrk3BnnOXETiQZ1hENq7hx9Jqir6pPMikXMcguqbX4EJqrGTD1BZSCjnslKYLi68yxOetAPgm1+T5llgKvFlnBlLFuYu5CUT4MIZJUDxKUKZUnIYt0Uluwwq1ECWD1ennLLoGHi2rfz6Af50KMGT12jCUi1MpS5e+ZokuuGgUvXgOzXJvBVqO3q/muey+bRHkZTnyTZLeYfYgclqeLZzYZI7KNPkWCbdRpDYvC1wUEP7XDh1UEO47gwGiNJ3SQLMRo7v6+74dfbO+6/b/DB9d5Jv3tm1gJMnBm0FaVWsBg5nza63WIIppNbqYGJzLEXrqXk6nNRsYuvKERqH00A5xsW8BEaGJgMLHsUTPB0OQo/Dj87dSbko+RHoT2Dh8m2UIHjbZY1i/1H2NrO9BLNot5kQ/mhqSEK5qxrine8X/n0loOCIllX6MMREEaRx1o3RTbLt0zdZD9xi+qbNi/w+aLww8KylY9ZnSczUgCyNOUpcZbA7Q24kohPAynuViDhpBe8n3XBhiBdSOa8oNFvfFDda5bPSrcIkGDkZCOx4HhLpUjdGYnG9LOx+H28DXdduWcNhrExyJDF3o1ew20NBTEusWb8qMEXnmYUsXW3GaW9rCtGlkgiIQivt7Oq8aFikqk8rLdoyfKqxjv4SKvchccILPOpzTmFw9EmE4ssv7RWGYi6UQVa5wJUNBArngRf374FToyjq4Tmi0MP1bI55o0b8o9MdyUSwZg6P0e/JuRQ6tTXM0uktFzjYkvUU2rMsajwsvfVP1GLU/P28JLdRgcbuTG2D1aZD0UccXksotNoVYQXj+kOSd4jAb19LsY5/Pd6R97Nk9IHPp9Xdc939Z6lzs8+zzIjRFuVUQLqbXIUN+AwrD5hBbTD/j4yk244uQr0ZiTEC+vwgDatK8m5O8VrSRDatFOPFIJeN+FCgZPndt2oc585CQ4UyuxwMMEvEyM+QU58LVim2xJQ6yjr6oHIHfwnzID81+t6cqeyg0X0PwR08fDxZ97SYHi3VVASowqv5PHHM6fUPGqzEtpU9LuLX3RipjWxmc1oBs3j6BQig5SeaZVrJe3HhIcBkcsqjrtiGJPwq47cyhMfspUp7KZ+cIloTLz1aRvoSw+3VZzLxvwMVIZuMeAY8s2/Yeeel7jQXNcfolYVEbHZitag750aH3yTjmtF9SEK4+RcH++Y4YSmc76l8CBMZFr40uSigM/YYPn13xS0lLcG6UOBvb/nUX/lDUBERU9ibaFk6VMJdp6/mQk00JhIVfUT5bLaG7wa24U7RwVm0oeoJRklVw3LF6eMKqTWSO7jf+adEc2iaIFjQ221uPHJXEjq0XxeATUG6hCpPx+JepG3+FIDqkI1bV4NQO0GdgL/oyMnjbKWxFgqy1BrVr7rtTmFAjB/H6RJFEgcvxGcjl1QCjZBMQiSTykR56S+JaNoH/pIGAd4CS06J1/ZjIkobFQF6zy6P+50MS1HWz7Ky9byrAUAOurlGmmh1j2DWMIp9T0TqwZI1ea1/sx86T+wNgPtTZg9bleXF/pfxscziSKXEo/iIWLcOCqLXBj8xPKSxQY8fQecXfpSxPYw1LlVCea77B8fyrqRYJNKia5DuzaWfcB4jGTeD3FK/TosHuPv/MgYZGFPknlQUAQFjnGZQvImtTkwavIHGDvJVXtR0ou783YzJIbGzutIF2TsrlqidHiOFisGN+IVPKkFKTlryTxGgzqZBxHWmQ5RTG9fkb66jzb7wERTpK1fBGXMH/VdF9LNVA4t/R35Q4J37Hni1ao6yrAq/M3lL0XXLpQ7xMtZocXbns32pjsmYLVWXGT2tevtE+HWdzd1JwmNVan4orhjtIDVeMP+Cbex6icqzLz8c90L16yx7BPdu8r8epnqk31dO0HLMmtlSVtFIJkwsWxuPFvTTVBZUWYBDZw3ipUcQuBfGWb+b2qU4V/e4C7Ru3RRWJSt496HWalve8A93RLQ11PoHlfv12N/5jJSR61pUKBmlQKrYRsxGJKAnNlFoD/zTCFoHLjQ3ugKioi1OGnk8Sb/7bP4zbEZxL0GJ/bAuGpkJKw8eHvQAqopYyfzREZjVhy3ZcjUcTz1hSxjr1Qe5qx3FrjcrK3ujYIMb7J+Z/cuAT66YmVc9jSs1V/2NqR/EXkd7RDYutX+bBChJnFQ6mU9GCcfxlq535wggk2DAadWKYWiODKfk4cgxPI6MWNknVxHAVUhI6jAr/4kuLZJlebDHarkiU3T82ifWEcbAT3C7bNprTMWrSl7H4tbf35X8lKFTAqBDzog3h8Xa2grgZw50cpkGzVYr5njs0jIbPtydIMXgy0r2ZFp/YpTFKX3qkrX0DR8+/8axJArC6amDmLRDPZo90bFCJXt4h1ycgFXTcnUo3I2Z9q/Gtx8YOEq6KJOsmEZVmb5FdQQzMIZtt52JzJzKOVWbueT5tSmCbIHdBiJpeEALmS1cFxd5nciP6o3sJoj3alhT18AK3f96CIUNj60UHNkNq9CdhVjZlB0+K1LLa8tuw8zlafUDxqFojT9JPQ3VAy/57jamgCH6ARXnFWp38bUA6FSNq2AMAW+dvnwZ3ffn4JJM+HPEzljAGdWtwXZlzzzswSnRx8UxJh+EkKBqS3KLsJ4CCJHWhhmyyU8WOzDv3qxVlaoD8hLdd5761FMEl7Nw+b5tcpi6H6gy/JSyi/DGUumAKwum8mAtu+YHwvZA7WJqM2giS8fcSqTeT4yG7xlvdituWLCg4aO8qtPCbT/k/w7OcdlmjrAhALs70o9mgeozT4EbtqSBN9ZxMqROUMyQ7bxzNDRMHfMzYsHde2eh+PbpDh76xktb2ilG2qjQMuF+lepr51fzl+zQuML7+3JQPSwRPW39PqpXfr5GSturXc+12V6pfZ2VEaVGQBIqy0NgUWIXGGyTv9CDjP+oQLOmnLg9+hdNeMFiHSihId9BIm7ESwOt0cxbil49soTEzfup05DUx/I4NNolv11RARGhB7Ie9NKW9OJw1pznQVdb/+lSVz1nBbti3Np2+TKIB3OntgvFnJh5vkV3tPXLHqeM0o2DjzXma1DomnrJOJ+IJ3ckU05eUaKBlEBGCNd0uARrZtpAJ/VFpYu34oGNGqISFBsswPlhcUCK7NT+EfnwSqB02C4BBYI/w4vdVAo3nK89rc/bOrkoKoapkr8Nu31vOPf83kjBafqat9t0tc2GeaEQGdU+315mtuG9M5L3ws1yUed3O85cYdA6fb2dMCQBRhcWa3HBgrz8XV1i81lMCfeTuupI1kTMfW12UAJ32/M1oDLyovEZx4io4AKc+Qs/vkOgTlCl6DK3UFcHMbsgKomtU7kjqc+EbfMel21GqPRETDApc0TaQDLr1xGgCHPcD9FdZOhuqOq8bauaHXoZ7alV49Rkg0eJC4RpqLO5Xj5K3kPwCWrc0un/29NxnSsU1uuMVKqGOE55HBYFg3qKswbe3KNgC3I+IzDbKL5wqeBXrdVsV5Mst1CYdmXh2upH4ByZ8fnTQ0/CPn0vacgEJUeWGX+kO59/3tA4h+DQjlXxB6/pThsPhOXFMYt48rTDSetr+8ryStLQd7k12cHZOiZ8KM3irgrlALQsgRUs6q6eFk8m8fkum/5h8vD/ZvgqnlqPZz+5/l8gf0zRrdAQ5c8MuYRMgMOOEhLhdhJATBu+ID5dX5rJ/V6D7mLcCRHRMC1bh4PTTKJUDNaCuUTSbG0kErdMiIyFzdGfTm3fvpj38oIrjAxw/NcAfmOsjBXNWnzcYpR+kE3x0qIpwKQya83xYuVfhs5cKKAsVf/WrKi+F4b7stHQiiRFhCXgiTEmi4qdOOwsH5WSUJrX1FbH9YIIpRSQ3c3pn6iibbLH00RTGptR//jHesNFD794FmoyUx369PuK9uaTtS2JAc344cPWKxHiGoRC7hHrrX558MfxitXVMJwAytYK/eFLx1+Rl2YdWy+8Psn3h+DaOq6ZcwYAIIRQvMxCoprTicpvhiBWmyKTvT3gSWoaC49HQJhqsliomkHhByOpkXhLiokMYExwz7JSxTZM4KxTp4bFYYctj00oCugKeQYYBBVliXVHfyBWWwsBIVHVQlkqxvDJhN+aaAVWv8h7mNgELexyyPrl7i78KoX5s82mNPnUZ8MMOqP6UzKcz5GjnTtO5Ja+2k6H6lxjt5Lzrv1osXJTF7sOQ5r5lYwRmwdNDjtw4fviZ3AQxkwx4szBzK3dtBWkDmYLqROl1HskdBVACqlNJ6AZ2BLWH+D/TrY2EfNse9bkojxbp2SS10FNb3kBbCsg5Dn6UA+Xujj0gTgbXbhuW2kaWhuUtp6954Ib2N4jlekmmDvGvcNN/TCgPgmwS0MNhh1IjBXFW/OkgvVY2TdbH5mePu2HvWQf7FM8mXTV30joVny6eAaMFpoGTVVR4m1mDqFB5Kd8XKAHZbpi5SUMg1tXK0VaT/gi66Hjk9r+YNa1KNZGryy+KFmDYNf72zoB0i+vYzdBtxglGLd1bo0QkZr6VogY/BRwK2jFaNO/MePll4wJa60f8nLgcl5X2wehhmy0UrfxFR8CGQJJ4mYPwzFO0m4ShWwPl04rKNlB8wx7s6NzUJWkePdH2a33IYswRBL614hDxQL0X5wyuoXHSHpEgKcIL/MMbL/qtdRYP2S7Ntkbm1mBR/NnqUBl/lXJQT/1fH/kX9qVXhplWsIoaODk/DRjn1yRZ8x//S4Ga5+Mj7LvgUe230g+FO8L71zIdkQ7oF789CRHOdGCsgtL3zT7ToMRGTpWiL5KxcgBm2QlQYjZ/UHF6lLp5Juxi2CSiYF6p1OvU6ojEGk2p6Z6HTI+vsFGWA6FkWBM56Tm7YYj2i4/lS0cAhP5A6LjV9mrI35wlCyfyXnIyfhcz8vipdWjDherVioG2dhiD8Jk+7FayeduNyEUX0qq/yVZTpVn+IErKuIuXhgGvuEq+Wr9kkD5YjC0Z4mRug2oHr3OZZDW5y5J+hTtNInG+EAaeKba19Tzdubbc1ZNcaWP13fJa0is/LOZJdNYgaydBqywt6eE6qMblkd/UFFsrjWYpbDjGqsMuGswdxP+z/pPnA55Te/hL0bda8epgfJVS5ehwjgJiMlN0DVzgYUJ6kVosmleH9RcxXOWvh+/fnSgpbztNLEoApFWc530wd6K6v8GrfdZDqmcrBXZxSTt1HhQdtGhibJ7qo3qCY3/4M5c7y8EC8l7c2SH5ayyUVELI8JsHAFtMYlJ8pexo8nsYREY4bTQmcXa+g+qur9TyRPTTREbL1GT0t51D1i4oHYEflR5Rw5Xr8eKF9zSOUGEkxcuZ+lFx+qSr62Z2tQNJiTV5/AVheuI5YjjA5cY4FRsFrMpXWu87lg+SucvpCzBzwH/zu8g5G/vD2VIY5cEHQSJlx9ILafOuV1ti+QSPmIdhfHAswVKr0afJkvUTCKmLKqncirGxG5hbbu00V+75ZUkhfvoSyQks22hHzRiAyOZLqs/Ndr193x1GzUOISxGPe2QGhTVUM9tLAEA8F9bt6snVwpNkIWpWFkqHC2KTBx8EUvX4YXGKh5cYWY00Ja+XwQph2zMmJyc7i+reAtGUpcF0DrE2pedqj10vburT5s88XR3ExpKOsB+n/fzWhPhKKA5lgELAns3AmeNr1ySgZiOptRwcEMudvc4i0VfxWf19Ja/kkiAqWez8dooHVO4c12zSqZnWU9as5yUyLkcXG5Bi/Lc6etRzsEIYW26Vdu5Vlt/UrPwNb0Fk7FtXDKm+t7MsYQu38pJSR2jwBggRmv9ljfPXaLpTKzUeyFF4nTxaSEw9P1GE7NOq+EFfLwgRI3IW6bz7uzHcUXFmxkUT/OLNeIz2oABTNWB34PsTy3hzBBtwYZs+ciDu8kVQ0JkFvwdFhgweOFphBNtz9DJmyTtj1r1GDYc8Sp9WTLp3sth6qGiEPpMSvgiB7Gs4UtFNWDAvCMgLvmBz1jE94Kaytz9k0wZ/ZKTTxGq3LRX+jogAWuDSJfpnPHwW4QZfCGA7TwqoJteEv87LCTA9okxuytdJPXrbulS2Y+9dhVEMckZaC2ZhjyTzfPiAF79+EUhycOmg56K4jUx74GqFzE1nnK4qgz4UaDfOA31hNIfkqoF5UletGSaQcNDfWyIsmwzYxuxOCYhKBulsto5/Ve1YMAJTMn1a6TNG4V/bST0LGlP0cjl9xa1TdknhC1cpVIhIoLRIEtXYdvZibCMFDqlqwlejP3hq+eHe2msMMuw1//62CHyFJJ5ckAcsDf7QE1NJQMmEn0JDl82sSC7v5cR4znRZzDafpGHzgeZvysczmn25LpalB26POAzAaUAHlWnstVVw94Jgnu7LrdfOAmoU76T4rlRkJGiX+ZeEZqX8EdEdsTNxZSFS3joEIrn/7brogTimw2nzDLYX4ZBKhxf80jeDs8dyy7KX/bj+Zh/aKz1cTB4PmtysmCN6sfh1gqNj9KhpRmQOtEMRV1f1hHc7TKuPQ19Sz1hzvO7/z5FJ+K4CElki1C2eO5FkFfdqX/EnE/ulNVyTytFzZVbxD8LBWNVtCsAP6yep0JfgCXld7L3FsrDnRHOW7ms+n6Ghk3DUL+as8766g8J0cQVjzKjMdadY6z1oKTIw8OvcYdFPyZiFTX9ZEll7jGEJb/2oUihTQ9L21sbTsp/LTM9DHE9P2yXX+HmtNqoQZkzWfyNQm7j3QIlh5jOTygf07o+/jcxm043k1Ej+lNwUcFvnPWtahRS1r1vuaCvz+oa3QXBZTeHVLgTsUNqR5zpEDwWnLr5hJRvKKB2ZypJ5TASKHsn163n/pwJd7zrhidmChyU0r7+5iAZSLYrprVeyji+FeRPLKmjNxM/G176l1EKoIJmm8CamZu6Ne6mt/tpRVpGqqKw8EQd27TuVGS0Hfxd5DKMj4w1/XMZXFlIGi315dPi4ZvJoa2CxGKR61b3ND2ePHgGncYnSxtewLwKBQlaExP3gsJPZT0H3Mbw82uxXvYPX4N719BbpyzjcHNnwhFvtGkSXiwAVnyFHYFD49JfkTEMTLJn7BvETcwT0D5Vy/ASucxyL0Pzr/NE4yoV7d6vBuETFHkI4W/Rglu8vwtjhTd8gOHO838tuKEU1m3RIVtl6dQ7J1UzOrM238MX5yKF3Nx2sSWCq3aCs1tijPSA1RmvFJqkYttJUK3r4cNH3RswwSYbkeUXe5vWkHUthvXGmtImauEK01T2qwjEdcBCdpNVqFgYy5dzlM+8Nru1GccHM0I/ypV7rY0qALfKv0mnW0Pp/bK/ZeTr6hJtQ18AOKPk2GZlge/u1764hWrbhJEIZTow6N15pELWzOFx89Q8/vWNqtqHFWy2WGUCED6td/kNNhbkZPy9qmzXjdjwLSuenFLMRjU10JUOviCrj2I84+qdWiJ6Xdx5yMkip3mpZuNNeI+JVA0oi9RbYOYvYgRxl6slAPsysezS/2Hj2GCMYiuYGf+5geRfFYguM1lkHDwqKQWk7fwL47t0XEy984MH6oybH8b6d4DRrwMf+cbgckbZTMq0MJaPm3VxJ9x/LLHjlo+Fgn7d/Rhjf/pNeCi9tfUe3RoxT/jaMVdDk/4vjCsHx/Q1UAMAX66QX9msMSykRXT0c6cF3czCW7KoDw4n4mAcVlLi35AGwJCalW+Ll/iKb7yGgI0RGj+rGlH1D7Kbk8tvmJ2FYcxW3Ab0eVL4t8KxeY0su7SMDBEpiPRt7tjI7eeHa2KfMkcpS4WJkV7xb+1jtq4/yTTki4y3JjbQeZSovflsUZadcCEQiTDl8WShYQ+qBCSenyP2+28yk3PR6Ybyb4PbpyafdG+6DaMiu4B3vdUJsx1BYxGDW/+YPUb2IzCjkD9oPzfUoeiFK352IelDx1IFDGS+Azxz1bXBiVoOhYJsoxgK2Jxn1ApafVZ3qXdmn9OrW/ohu9L69yzZk/oqZFwgaGpC2ezcktXHBS0vmIVqZ1NCtx2PM0oLlADsJs4CcvM7BeZtOg2ufm3Z/9MIwGTMPBki/282TTMEfuR9RhyCg0xv8Z67yDL0Fbou2tUgfn1JIPUlFdAGqpR0mQH4DCtARAA3VI+OY2Tt4el1wW6Gt1XyOWHMvONvrxXvNfpBrWN7SEUtX9aDm/28RkQHhFl+URppEcSJWbSH0NpM9VPpuDDxEwpkwTLBwxM8nbKzCxzHKC/lJwPuuEC/nKtCJTDRhkndTEJGkRqqwu6OKZ9ymlurNmebKqrT2FsCDVs/qqhgYOfcIp+2oo3oyOJ6VVjoc/B76l68GGyREagMvYmgWppwgyvH/maZ9JwLtrFHrq/Suz3Zg3DL8WSrZMqZOgVhFHwmpSeQkoJyj4Bxgiml5oXpOLeyxvVPqRxEMPor3xr84eDbLVCwZqS3aOBBolYe+nk7uNz86ON2rkqtTvhd4iPkvjZYcc4lKZrEDSC63I6BOTB8eOvb1awBV10eFyUbnsXuDQEI8WhnlBTyPfzOiSERxufSN3wEscRQUMyPzvbGS52mjVe3t3LKdMjmRG/U98gvaJoxCbSlF6flKYWaL7tYMeM8n7/FmEhgKD+pUkoE3DmayVO2/MxrRw2qy3iKU2ypLSk+PEkn9AfDaqVo4D4lYNWVUQ5tjY+gNlzndHKf8r103Np381CVnmgyldlblRWijGxO654qePZZZazCeytcbbsix0TSVRaFYnLDGE2/9rPAyvrgwg6aLF30SYk6paZBZMyOyJZ/b5Ci0tgStZd6KriAakz+Gqfnj1KirqhQZ4FQMTBGWl4PX+IaSM3cEY/4qgh8GFpFrSfcJc3oNrv5ZzjA43E700LEZzZf3UIj5SYMhmmYWl1PSPIaz+CJJn562WDcGsM4iDIhhLGrMUNBqVCsxQzJVEwoiwI8joa5Y7YHbfcxvnifqIp24zaH0PS8LPYM1ri/ufnVMhaF/pHGcjF+zbZjj579tt1Y3Dz4XCwxLNmCzIPByW7H4OT2/z5/49bBpV6aurzTZn4mS5KWVM8Btb4xa6S9X47aeUVUvNwS15GH4HncVmBA3KEhgem3Ci4OR/Wkf1zSzUioVa5B6JU9RjuxMJzbsARjAGgoAVVLx0jNtTTJ1yKeOLXbZdM7HjbviS9sW/H2Q2rWkh6WLN8qVsqlSVHUliDjILn5g3y7FPHhDymUfW+37vb49aHDy5ZOfRAlyR18Pp87SLMNXbz5hCgvQy7konJ5w6FVspmky233/VEB8fLFi0PEvWhY4aaf0onDE5iQeqYwsUoH8aRgfYSBXupvL097pji8puFizovyS3zMtyRZB8CIBngWID/+ZJo1w49+IUDmiAGMNacy5JFj/EO5QBlzmYI4K9xfrTG51zGk2XqFPiV2+DHyqSqBo+ywmXWL2fkpUlzsFhUOyAOu6Fed68lOcAQ+1EkIuAzZGck/dBKadFc4lLVS/fjtCEUnI9cFehZPHhD8AIHkJDTSeKl6kYiQsAY83gUaf/UFN6q0ys46OeTJVHEtzxfvdjo1ysidGizZ+Ct/ucn5l/axdxrDG7qropn8EGGkzKNu5TktYLwQ3Ih3t75WzFK1dwdf3G++laR9pkJqpamyOME0xH22YnPRj3aYPNUo0vB38rfx6/4GisAmU1VX1Vp79dR49PS2ST2M/Y5Jo0UNjZAGdRFgOgJChnCtl/XJgflcW3ATnGseP1Pe3UIU7lflognOvOpNhkdS/jkETEg3CAYFqKUkv2xatSoRIJkBbTQ7FDBZbmfkQr2GwVmHWf/FJb7IwcNFGArDEaBcWsaMcmzgnOVDiTLQyPorJvNmGQe5DAmo7kNRnV6YHj5vbQXkhqxa91vk74jHl5y/0etboZ1se3WbCRskc989uHGPDLTgZgzPJ/wfmfdT8WRffClXvLmVL3xf186GHXlajLbAkWEQ8QmcSHDLqV/BA6ozj2ZRyEfw0WMJuiBZ9+K05RaxAccjTPk2+nbX7S2oDfRj9DG+F63fT/z4UQK9hGyiobHABwGNYq7lEIBV51pEw3XhHmtJ1/Haz/9c1Ydq8SDl1foWCIESX4RGdcQlTgW9pInFCP3tmr/sqi+DE2w4ZOFj8Qriz9OFxBSTmR/F17pDe/PeZZm6JpS8Ip1dHKivESC/+uPhIEH7QrXL9uAjNf/fsfdW5O3UQ/DA1wycMdGlI6Y0Yv4SPSpTMmC8Aa2wqdQIRlJBfEgK8x4Cg4LhsUgzsngwRcwhJq/T/v54qQbnhP8TsIkpH9T2Yc75LpzxmsPfmmnFWlYfJ5AjRuttgZ83PUF+WdUXkdBL4HcHAQtc/2fZDp2uM2wbtP7Y3AI/xeZb+pcChcneDU2QP9TgjcXCqY7X5VkJOYrtnklZTNPJKIiV4M4/BFbom3KHIav6Wh2K268WlV3EtacfWfH0K+Ss6oKSDdoXLeDATAStZABhckgx5GrFJwYQgRZ5k9ZBBU5oo4DFDz93xn0I2fNMGSX1WPi9RRC/brhxZkg3vGHzASG9U5nev/yFYxKadEzCKSkOjuaB53VaBEtmOETFkV2GaxoBOD3x5kqcZv/1FyP6xs/PxzzaIDDw6/o0b25EyBjb45/kMqW0LjgHRh+sJ3U0eyD2cdQchzr75sm34Z38iGJsfgeteJzwqB3nh4sJvHeLRamVCxK8AbJeNlkwkkyDb/Q8lq1bYSPSUoZaJx3IXYVnyZSONGzLf4gc4GbVzwl198eSLr0pyChKyZNntIYf40+/Yf5vG6tjuP0rH5t0wfdXrbX/3w5RVi97+/KeOvBh/H+fOF5cCk9nME+V3ZKdpYe7BYq+AiQmM+CHOVooKXVNYwrrB898DG3Di2HBUsIq3PhDhi1sOeAC08Y1xUB4LorD///4oyYqyIAAdMGMxFC+ISOj0yX+CNj13hi0qX+1ccHzYD+AE6nve8Bh9S5OzRwLMIlLN8sMs88fWqVJkddiI6C6Ozevx1YNUI9yZG62ly3EtGB43zWmI53BirHdAt36DLCYFnZdixBI69fuydUmdXFGfMNC5t480+CNzVobNJliqjYzpoDDlnSU5N6uisa7o02RuZgmu167w7FFaqy5NghHaeipF45mXRMpjOiLip5m50NvuimWo9R/MlygZDcQTUy3NcrO0PBEshhseHZvBw+tx64RJh7MzaXe7q53gl9cLezMTnPCQfIikD/oI/2j0Mx+jHjYFoAIEC2LaT0TFcekjZ/U7Y4KtkTo65xLQIzls6drW/pTzsxY32fmmQZirUzVJsc2cxqmAPxD503MoVxuWkg0P+LmKcMTHVF7ghgZLvtLp5VXbEY6pMPi/DONr80BIGX7Fe6bX22BB8vY9JCpvoz3rx24HoGvf8kZ7Utu4ScC+MO5tEpSTUwPPURIpFacYqs2apDk+xyrLWIPRivlo9TOCTDkuIR0F7BA41fwKsJG6yZoOecRSqW0b0cpZN/NOTYhIMgWO6Ultodu0IozLNawuv+WQg6RHmbasbKyz7rOaHYCPkPqL8u2JJXqUrRmOkPKLiIWKpmOcGudFFLgN3nTpNhZW9F0bQdYYX+1jl/Co/ry7Z8xxZPj5cZ79rNR3hX99CPUmj1THY9ym++RbVfHkELfxr03ZRcxaQ8QGN1r+FDUaAHOI3x2dTzLGl4SGyjWV7lFun6fSHmDyNb56p6KL3mKOWnhPWpL3MXyDoX29td5vfRKjnxEav3vz3jEY5zEaeJiE/8A+XnJdAeuCFlkiyRueFhyC+zDSVgnhTAGSIubjISS3/tzfVTcIVK05K1Ik7lm3sjya3lI45dTHmUfimoK9eT/Q/7pPxROmgljNghYLFV7h197oDbpoOyOSxDDWSP+Yd+1VTdDDqBxe1ouHjnIGa4CCvgFXRde76rHTNkyLpqfYTZzaxx1nYSZRAsV+MPqxmQmTjDO+/Ayqwnu7wPoSLMOOL18cUjthAjKhIoTN2s7mfAVw8UO+vgAIOb6uB6vgcIB7okie6iwfSXUeWNmTD8c/FqXjFiCnVOe9PXgXr05xA3Ej/jCK87Fg6VLEr2gmLJPqs7GBv+QEDHfjkhp5NXYajLCmmjpeP4kW7bSXX7iSd5OIQA/6y/5J7NR5H+VVlhImbTCQAAHOMpINmj+N31GOdSEutl9xHiSzbrOiMa22Q/VWxL7OcSFlS6uOxCVn8JCzBHq4A8NI+ywfayzjeSCas/doYsmN2V1cBWB0pZ0GFdRGMtO+s+hS8T16Pi3VWK3e+Yer3dJ7z84ipHn2C20X+05H9fLCHt+Bg/GOZxfYbrHXYkvnqUr+ZGMzhWJE2FqSQSQK7fWhdVQoMArPDc4fh250j4NvEFXT3CETkFebACmdNPnWT3HF9ShMLY9ZLOl00lm09NNpziIE8tMn4RhY/B/pzJiOT3ktZeHqOQgA5Im1bhgnPPtpvZBtCUYHRHlhCoTDnRjCeHKNyJMbPvqyZeqwViniI2KOrLEm0CmDe3VqSdZG/zyv06L8qlve3E6XF29JBQu4T6T2OVYALintG2Wu+xxBShfC2WjYwoGj6SuYJcGCmc7AUotATgbpI1gpey0hY1n18j4ofhspPKn7b8m3q9Ot9TFqrcJaw/PZiKhhXzHFSeq6oCg9l90SY7vg2Twy4NWQ6qmCSjhTayFBU4Ng1OOBwlLpNm7lT1ungaYNA/B5SPvMi2mMHLjNSm2TvNYTNJZB99C0DWPZhO+GTKCMxDGf/SFyfNsQAuqI3vN3Jfyw+6xwck7yamngXwwGLEgBWoHXGsbYG+8Ca5EP6+x3bdz1kPM9Qt4oS2q4mcEo3B81/XwlGzpZt+OYGM6bVccO6ld9Q2lEIjeMdSvBbU+APKYEJXnYds4/dG8rIEwEhKrgBliQxJsbgxU3AJzROqvxenqPIS8IO/Kk+/RhupCo5TXz3cjzBXzbsAAAAAAAAA=='
    const GIRL_STAND_SRC = 'data:image/webp;base64,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'
    const GIRL_SIDE_SRC = 'data:image/webp;base64,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'
    const GIRL_REST_SRC = 'data:image/webp;base64,UklGRlZTAABXRUJQVlA4WAoAAAAQAAAAtAAA7wAAQUxQSJMPAAAB8IZt27G5+f/t+zkOqxh1m9pmard5gtq2m6dWHgTFYztNjTi1bZtx0n6SmclE95z7/mLuuXld1/J5GRETgIQmAdRvuFHergAYiKxLAmvtfdUfPvwk7z9HH9wbAJltCPQ795kFLvSnl8cc3AQwyxD9znl+la1CbS/+30FNIDNLwO7PrrKjXKgke/HEoQAzCrH7O7bkoiX7m6t6g5mE2O0dRzm/JMWOkq1o/as3QgYhdn/H0Xml6EIlWdK/eiNkDqLX047uKNluXbhw2u/++MffTfp+qW1J8r97g1kDtbeslDrIXv7BX0busNPaANBl60MmvNJsS9K/eoPZgthttmXb0c2PjNw4AABJAsDAg2e2W5L+3pPMGFdbefzJyB4AGAJBgoEE+v98vh3dNhKZglhzlmXbq6bsCwQSBTOgZu8nregpPclMsd7HjrZW3b0mSBRPYtMXHNU6EtnixGWW5alrIqCkrMGInxQ9dW0wA5AkgIArLcnfDEUAGEIIZGFAqB/v6PnbI6QdAwGAQAhXdGi/EYHoPLAwYuNnrdZjwXQjADR26dIAMuAiS/6/A2vJwPWGDR+5T486gCwExCWK/iPIFCOAvgef+cCMmffvDtTt+a8Oq1+dPAzY/dUVK3Pznvr7qA0AFsQdv7H/DqQYEXYY92Jzu20/t263Y7+2nPeb84+Y6vwr37pyMMjATtDnDccbQKQ2sd2Er207xhhXPjXzJ+dXdG6l1THK9swhAEB2AOom+KMhKUYc8omtKLlT5bNly/kV5QfX2vzIjQB2CDhf14FIa+KQLx3lzmOUC5RcoNQy7aOV71y9AfLWjf3zWunEQNbw4C8dXcnx3QubgMBeZ/QCkcJE3nvc7oqNkuRlp6IGqKkFkb4Eeu035qzdTvlSqpy87X66J/r2AEIKETjiiSVeuWSFK16af8JBj0y/eiOAaUP0/9VcW67O2Nxi673LuoHpQhz5lB1lSdVgW1Fefu9OYJoQI2ZbcvVKtqP95i5gepAjfnC7q1/Rb+0EpgWx9/eOTsTo+7qB6UD0fdDRyai4/HKkZMAZUUoIR99TQ6YBa7jLt04O/RMITD4C2Pa95JAnb94EMOmINTc57sOcE7Ttq/+eNwhMOBzy2HdLnLTtz+8CJhkx4gfbShZF+c2dweQiR/zgdslJq3Y/2gNMKmLjDx2dxIpt1zCx0O1vUUokR3+2FUIyEUc1W05maeXw5LrFclJ55c8SizcryYYzqXCDk+wo1CQS0evBJItj6sBE4uhcclluuaYeCUxs+L7l5JZbRzcycYiuf4hykkc3DwOT58ilTjZHP7oGmDS8w3KyS0sPQ0gWYuN3ks86O3F4XXTiy/d1BZOEGPy2lXjRL/RImqObU+HjzROGd1lOfDmeiZAgAYPfTAPLk5pCDROCDOGYlpT4fFMk6ljLqdh+96HHDE6INU6+9JDJaeHVy1fdziQgRq/MteWcop9vDVYdseZ0R6dolC5AqLqAXRdIShHLFyfC7j9Z/n+QS7LZBYmwR/qMCUiAXX5MmejX+oDVRgxrSZ33+rPqwD9ZTpl3+iBUWwhnLrdSRf7pNIDVReCw5pSxvWD8uiCrh8TgS951Gj/7swBWC4FdXohOYckLx68HshpIdD3/fVspZEf72eEBYMUR2OHfyy2ntORF47YjyIoiUX/AW7ac3tH++oI1AZKVQgIDxiyy5DSX3DbzxLUBBLJsJAkMuuiVnOW0l90264T1awGQZSEBYNBFr+ZsOf0lu+3DPx6/0Tood79197v15XZbzoaKtlu/mnXdVuXg3re/9Nl825IzoxRte+YAsERErxdsW5KzpWJOD69Rhq6T3B7l7BndfASIUhNDf3B79lD04pu7sHQgR8y2lTXs1w9sQJkPn77MGXPVD//dAWB5iDVHzWyXMoPU/qutuoJEmQn0vteKUvpJivYLAwGi/KzBHp/attJOtt32v+0RiIpkzTa//mJJm5VqkpuXzHn0wq4gKpdb7X7Sl44xRqVTjPYzh+yxc1eAqFwCwOGfuKMkpY+tp7YEABKVTAZi61/eN3HiF07jJQ9NvHIQQghE5ROorQ0HvL96VWsuPSRb/miLABBVSgLAZqecM/QRKy1sxRhzv25kQPWSJIDGB1MjLm+z7Y9Ggqhy1nDXBSkhfzji4F9Ofuwf24CoeuLn7XJKfLQ+QkNDLRKQCH9zTAvdWEMATIQN3rbSwfKHmyKQSIRhy1LD1g0kkpDsdr/ltJQ/3AQhCQKOXJIilm4iWH0B3R+ynCJeeFYgqy2g+/gVcprKi88GWF0B3cetdspGL7qsNwKrKKD7+NVWyljOPbYxEKqFRI/xqy2nruyXz+4LsCoI7PnQSsspLDk3ZbcAVkFAz2u+sOV0lj3nit4gKy2gx53R0aktOTd1U1RaQI87c45Oc9mvnFQHVhLR486c5XSXvPTCOrJyiJ535SynfvScXVE5ZO3tOcsZUH5iE7BisOP3js6E8h/qwMogau6wnBE0Z4/K6feaY0aw/KtKCRjWamWF6IkNYIWcHLOD/MGmFXNiLjtET2qqmFNidpDHgqiQ3b5XzAjyvH0qBaj9nZUZ/lJXMcROn1qZQH5tSxCVGnh+u5UFoscjVAwDTswI8vP7kawMgjs+bzkjzh6FyiTqr/jamVH+4ar+YPmI+tHLrMxg2WNRifWjlzk6Q0bPOxYsFxtHL3N0ppTnHgOWhxjZ6uiMGf10L7AcxJBXHJ01peWnlgdhrKOzp/xUX7B0xPZfSplkyd4I5bjEGWXFGWDJiJ6TLWfR6P/VgqXr/75jRplUln5vZ5b7yvNORlEcF8rR961sIi09EAGlr7vbyiR+tg9YOmLkcil7SPOHgShHr5nOHpInBJYDwI6vOmYIxagoTxoIoqzEbt85dlAmyD+pP4gyM4xe7igpGyx85Z3mt67oC6L8jTe2OSu239Jz8LCNAKL8RJcTZ61YPOaij6yUk+fuAAAkKpHA2icMI6c4pt53Q1gTiEolAHSZmgEW7Amighlq2Ou51LM8eR2wgoCA41ut9Ft1eS1ZQcTaMx2d+vLsXVE2ksxH8uaVUvpZntKHLBVJAESBAft+ZzkTrD4TJctL9Lvq+g1BAMRasxydCeVn+4ClIMLwXx0KsO9/7DtqCBDdx66QssLKM0tC8oxF/mBTYLSjvt0ZBHHSSssZUZ7YCBbDAJ65yO3xQoz52lEeAxLrPG45K0ZNW7swMgDofu5iR/mXtO3o34IBp7RlCf8ZhZAAwoDhk1sty68Mkmz58d5A18mWs2PuAhD5SaD7jhdNeLvZli1/trHdYeGOwE7fZAj5+QGdEVjzuCnf23aUO3y8Yb4FOwBnxAwR/Vd0ErDWsdOW2ZLkjvJnGxdyltWurCDPPQEkQGDLyW12lDuXH1kr3/wdgKHzbCuPlHa25x1PgmgY/qId5ULlnyPfoh2BHs/P/tvXlm05A8rzh4Gou6rZkguXb+jk5cEgT/pFOLvVitHLmtPP0U/1YuNVLY4uUm4dlSf6DwBR05fdT/rY9rfHn7PUSjvFttMxrNnRxb0/KI9XXQICAIFtbps1/TD0mOGYdo7+b/9HHV2C39Z2kBfsgACAIIG11gb57wxgz3+lRS5abhkF5nljMIj8JBDQ/7lMUFr5vcF5vOoyEAWQgfsstTKAYmnG1XWQv98aoTOArMHpKzNBSaWvtgXR4T9dwU7qNyKA/s9YzigeW0PA8k8HgMhLdPvz1f267H5fdEaNfmkT5Fk+pomdgDxp/luPfe+sGt08AgQQ/b+uIDpD3W2tzqzRzVc0EAD83k4IKJR1x02ZMS+bRDdfUYu8b+wNotimng84ZpDo5itqwTxbgCiSBM5ZZWUNyS2X14LITxRfw6EtWUPR+vjCOhD5iRIGHJgppCj7x1s3QZkDDmjODpJsfTrpqFqwbAe1ZgbZ/vGFG4c0AETZdpqtjCAvveecQ9cGQJSdqP+jozKBF5/dBAAkKpBY/zErKvXkhWcSgUSFEus95gwY/UAtAiqYGHTTK5+3p5y8+gISFU2w15BfLpPS7YftECoLBLDxl46ppj81ghUGkPW3t1rpJTcfDKIau5+xwDHFXhpQHQROnm/JktJHyp0PoiqJcPhMW05jeXr/agGIgbd+4qWf/2SljDR3TxBVG4AtRx878CY7Kl38pzpWEUgA6PP3FluSotJBfmMIiKomSXQ98d0W51UayEtPAVH9BNY9+uHZX/3rthl2lCwlmbT66jomAUig55ZDGrHjm7Ytl1xRSeDpvUEkIwMABG5yxcM/LPHSuStKItm2pKhqkp/aDERiMpAA0GOLI8cfvc0sqwT2mxOmy9Ut+ckhIJKWRN57HItr+/4fW6PvrZ8snnvvNFWL7CeHICCBGRhYf19x8n1bNoHgJjtt33Boq1UV0bkZQxCQ0ERdCbzibIAgOvZ/0bEKFL3kqj4gkgsTi5LnbBtqAIChhl2mVYFkv35KDQKSu+HQN62iZg9B6AAQtVMrTZI9989DQCKxA3b82nJRS67qhU5rD//QKkGMkkoj2Z77573qQCQ40XtWcbZzV4IdiC6PWS51lKRCJEXZudl/3rMeIBKdOG65VYy88NB8IC/MWcU1T/nP6y05d4ydyx1bXzx/+wYgEEl3Zq4EmtjQScCw1cXJ322GDYdeNunV1pacC2xt+/aRuw4dACAQSU8c+kUJ/GsQnewxtxSP9waAsN5BQy96IP/9D99xyEE7NhJgIFKQOG2FVZi86ODOiIbfqxh53j4gA9GxrnOiYyDSMWCfpcVNbOwMASNWW8V8vh4IgAyBKDCEQKRmLQ9cVkz0WBAF7P5DcV9uEgI6ZYFI2e2/LG4CCyC6TXMs5vOBSP3t++Mex6JQUMPU4uaecchmqUYe/fWDhz9tFSa/vwvYGUfMswqz1bbq6f5gahH1Dzm25VysfGdnRNN0R5dw9uap1vCo2l3C1dcUUv9XqbiobzdLt0ccVZQ8d1uEfAgYtcoqSv5u85RTdAl+PBDMR9TdJbkEy89Ot8fcXpzlsYV0meVYnOXxKQby9MUuycsDwTwBO39jFSd/vl+aAXUH3LncKm7BdgidjMiVQJ6xM9KdGFGSOdsWMGxVSW4CU42o/6+ji5tbyM9Kc3tIu7oHq+I2pN5D5RqxOpPU/kkqwbxCDlysUtyecgg4ZpliMVEz1wHzEGs+61hMjEuPSb8DVtgqPNo3gsjPcMWyGFVwtN8emHbEBpO/bnWR829ZD50T3R92sd/86qAapP86G4z67bufdP7Z6+MPQ8HEdlf//oNPOv/0f9cdhKxYu/5GnW+8LkAW0rF+w40K7A6QyQEAVlA4IJxDAABQoQCdASq1APAAPhkKg0EhBerpZwQAYSyBDgAy23q/t3YGTu7Z+N/5mfJZW37R/Y/0l+V3yy6munvpm99vmL/M/3396f9F85P936j/69/i/YB/Un/V/2//L/sT8Xn6te5r9yPUP/VP8R/4P8f7u/+7/cb3Rf2z/P/8H/Tf6T5Av5l/df+P+f/zYf8j2Jf8f/0v//7gn9I/xv/o9c/9tvgz/q3+y/bT4Cv55/c/+n+d3yAf/z1APUr/gHYc/yX8D/14+P3g59U/Gr9rvVf8T+T/rP9u/YD/Cf+P/QfH7+4eHHnv/Nehf8b+vX23+v/4D/R/2z/0f775f/wH5W+e/xt/p/UC/Ff5X/bf7T+zv94/cb61Pf/+R3YW7f5z/S+oL7AfOf8F/e/2k/sP7j+zh/deh/5n/c/9b+Tf0A/xz+T/37+tftn/ff/t/vPs/+8f7TxyvtH+59gH+T/0r/Mf3X/V/57/M//f7X/4z/ef43/Yf9b/T//j3rfm391/4P+L/zX/V/yn/1/AT+P/zX/A/2v/H/7D+6f/3/Y/eD7Cf2X/5fuV/qr8/7iHWsF21j8lQmXF/DQWK1l2P52GXQMcypQF/NSc23p9q9FOY+RFrui0mo9PitAMJ3ObUJZsw/HKMFteJnSCPT59/rZGOlnZn5pROOXCdAGrMLHx/QZjpvuunkjMx6Ggi/+gYH9t2GoGqPsZ31CHRubmQC9k2i3EKYgDm4uYWRnP51x8MtaN6vS6TzpIb5dArDrsICURuCbt7634ORD+9mOhFCy3qf6n1H44/r5IujFlwIGKd/BV9djHqzSi38mGNuT2wzC+p/T2fDVxgTfGY5Ru36KNp0JxImBuwECgxliISyLLksZsz1uJZhZtzXtT5FbrA9zYp2vzGwimq8d4t4MG7nfYNu8g5nL6h6aun0Dq83YblRtZa9vsqSaWndmVrY1I+VTFlzhZFuIJcWzXsFFEtNCXt20VeqRHt76UiU4uDhcKu/Wcq6J0R2h0Lgk/5Qc20q0/dd1+4cX/i+RHch/tVzBtPMmDPyBGlKzw2YFKav0qv9baOvCyIT1suq5+DiI2tk27Z2BpbSKWFuA9uO+UE2BmZDXMdcnbJlxUTVE2MDw49ytEJfl1tfbnEca8/w9FoMzcoVoAruUyWXeMwXc3cMcQJ4ldGF/NH0a+ufaalmm9kCczDC8U12REP3c6mHfms5M0S/UUzNWfnQDQSMaEiO72RKkdif6L8Nj9/8zawb18/32rK71eCQJRuqcrPN/nMeQuSJsxnqvtACUqt0WVoz7hYNvwlos6deey5oGHjC02ayt6GBhwaLMR8dfOj+MH0wLTuFh1sAa3GOI2GFuSOUrbPcXRr9Z1Iplma3l8fBaonhScHgeF1/Lp1rsF3fxtTFMSBOp+hIK+SMCsAqBpr+uoyYBTGGPgnwQ/KjenvVR7h3OgUwVD5/lhwjgGcA03FZYtDLMF/rAt1qFA8fupZaTekm1vHEJmQgkt9qehinb/JsqRY8HrPMfbOMOmxSCekxLq1Ndg1nKBbQqhBdq6y+9nMgkvdWoXdnnot/2B4XAZV/BLGy+AOkQSt0sXYJ7ZkbQpRrUDWFq8SZVZcZ7q9SV6Kwl8JfvEfIx5tPow63pRKO6q3fxvyLpGGj38M9i8y3O2k1lVV38erzh+SfyD1yeewP9OLLLnR9QYg9x2SDrc6+EAAg/LffZ/vfoYwUxU3EBKNwN2v+bcj6AA/vyZye5w2fEUV3CeuVLFM8pHQJMDv1OU+sDANQLQwmMYIZ5hgFT4VXrapkxOZfh++o6uMABVO57kjow2oKh2XUbNBI5nspSfn95gj3U4wwNVXYylNQXdbogSdVJBLaE0Wj0C2GOnPNLi4LmRxx08Q5dfE0ARCLOTXtY86i9tqXaP+CK61idoisMotfNu2OUqrE+fxQBoJ+ziim4TOT21/fWeZDRwgC8od/2Wp4J8MrxzIS9wyR+sTaL1pr7414WvGh37oI1OD4GCUcCd9I1WeEvOyNsGgchp5nudkpW8elG/S6dlbZE09QZwmjoKN7OZQGcStZEsBuPhNZKNNHKwlbaobAmZYaXzxpsMIy0ZFNrX7Tu7FRddPfe97QC3qbZRDk7PuUmwBsSXjKpIZwCKSUjyQY/N74NYIT1T0RxWJMvD0mU73uzOfeHbp0mo1m5ttDkJC+YVpbz1IuPQZ/rAOnNmc5aFX45q0/pcHiPw77zhdt+rgri06PB3PrKaavp+XRSmYCBbCmjQp7dAenbjiox/z7mnkGd7wJo0Z1Yg4Tp3sxGZwnvZGj/mLVTtA8X/zEWF1cMP8TfE0hO4N6NWFlGLP8H1GleSyXJwACs+fleXj4+mCeK2sMP+2WY2Iqh7fCeL0X6LN3IM4laMb3fZQo7U7ggsepX+i1ckqT5w/b3tP9DTobd9I947FL+FLt9dfA4g0pjQrXmerXfpN9PqOwfoaUnefWpiV3wYc4oB/02Rh7NJ2m9Xtbu70c4NuGmrn0oGNGna+rf2urtG1KBUFpgr3wROpJjp+Dw/i+RVG8bvSikVYDdeFM+G78WCwp/is4U3iLs0E2YkZSXWbDgrrQNZxAwA8bvFMY7WgRzBNHPvCfp5Pwaf+q/vPwsBQqFB8aTF6XveMUVVqMqpdHvtpj7FoLx/LknzMjDM+vomuYseVbN8N6kh2FEcA627wenTEqgtTazhG4dMzu6uLuyu8RB6qAMbNNK8eFXuqsLQatud+PqnqqCIBbMTjZjIBgk3N4ZAeP0DFVPrvxVdlZTqF5nETxoya+p3UldPJG11bPFcu4c1Kwne0wmqeNPhNZqA0Ww91xr15lFbozL+BQX3A9+5bWwC4fOPj3xUgGX2t/0NiXPvZdfxarEN7URNUgbOEe9GOJaD9aOXRsefMgCoRZtxmfSfvrcNYj0YCscbo97iwKNi9wZkDsNfDVjru+TjUMHPKyDNsg0fShrXHFJRAvx1l9/KB91kpSVujE954nrZI0XPzGOLHdRUAfntFnhz6ITbgJjEKy0DfhWIG7zQuWeaT1F1GslDoLW0fo+hTr4hMnMCjkIXCJJXChr87SfemwvJ2aw8ofrDaJZmTzxRXn3wqHAvY6AJIv8+X8RT9USW9bgWTRYkV6m9IEseocK8p+eLx68VF7zUi+BU+ZYEoxCAVSGkIeJ6IJgNLPEqC5QSml951LCKAQAGVWvdb0WNJ9PMW9tqNLRa+vVELRAJk1cMpqAAxJgZeBEdqt2QoLfWy2kB0JsVosJr9p3mdz9abkP42BbxZL/cPTUmmupG3GQRA8uB8iRgfC5bVWYjI4Ywafw4IsOz6QepYzDI1Ma4670MxUnpHyPh63EUULH/7Ii0Jn8xGdDkgJ2uoC99DDhFDOKN22/Hv7hG1eCBpAZFcB8SPXZMv5mslQqzO5vHK0BwpevjEec6ccZ/6ACp9zPr4C9AKA5c8iUosTNHMltfMFX9orSg3Qolr1PpXBVzM1jMfUBh3PN/uGsMA+/KXn/9hS+obi9tXin+M6jKr8vFyOzNBM32jh1xirUPndCqOqCMoZxahS6pdS+z7XZTN0xCS8cqVz2XLfg8w/p/b7oXYR29uh/shu3YKgHiQ7DmPaQCD16b9mIyi+5lE1G3FyB4gGEA9L6z5sOpX5FBIAI61eGVfJ2xQZtTje64/1TVbwqYkxkVXpcPnU3tKz8BRz5U10JiwupPazvSDm4SOE2HKIT2qjWWC4B5O0VU77y8WSIG7XisIr2xJqdC4KOPA4nbne+yamTopM+UaHEU5o82JXcdJAgzpG7Jd1ATLJdNfdtBgswajpIYA4ETLCMUMA73tXzo/vyUe/J6aHP70+5MBBPV3S5Puf8fUFdnek9vusNuFmhkAw5Eto2Q6yfwxKwhppdQT06evJSRWlgejy8jPp9O2MmXyd6VsYUTjtQhoS2KFz9EkGWMOvEw/1stQfqCnORc0/xqmagmhL+mp6+MeuSTOqBAHVGSaf/85y41KYR6UgXm9va+VM6+RTT3aFj3VMquBfRyfrYJ9kNqoNXIyRMEIruib3DdMhlLSkuS96pWVZJH17KTE9PU4BeX4Bi77tVe2r6UFM/zzTkVYvVChkx8GWsxjLR1ffZb0DeBVru5yyd4XqUfDuh/Tr8+QHkUGLhy/wmFVtDaMg3KKtrP7L0Rb5cho8b2o82xGtKQ/3bsuNpc8w4cTGX9biLMWuFKsdKubaedeWT8uB8n2BqaQfPM+n1EFqzuf47YhUgPn7cp+ybH6C9/NnQyIkdMgKr1B/0P6pyNxxx5omUUlj+m7rzaJ7jUE9V4m7mSODTuCm4PitNOadU/6ZZZiCE61dFm0eaGk5ykmHa75DVnSSyJUsTBKOqXwXM+KRqSbMeBKZBNrNt/lVmv0rriEvyxJoCQhC1fgUf1zZg5DZuJsC8GKXHTcjZH1u6wo0gdzrIFl6dlQ3OA5Lu2uFxfVXTQBM0mzaM1vs3+nQOGuM8uNXDNmnD+qsHfx9myqCVNDGbn8LKS+T5rdlBV4qIMABHDevIYAM1/LWeSOmv+AUdbk11XnXX5Cu6LRddnGIvYsXW3TtIbRdoyv54EFR92tHT/VLufw5TF2ac75kos8oFsQlwBGJw9I1JPMR+/hGnPSC/G+zfd89fh3H4l0xPU/t5/5qF/zOdRqHwREtNHklQEl1i2Odt+5nNRO2pAZaqZ5kBo+Rx77LZu+kXftHyxWLIuxHBEF283VACFmAQo4obW1i/9QEqswrQ4TP7/aYtpJd/14W5itK0+PVdWcs0XoEPZICOw4s/1551YFM84RTt8c9mYOoptckRbDR/PmFvJxFkTeMpmnD8+ECcZxZr4IySB3/cchVWVviCKYKvDklf4NC7M3y1MCYGLfRul1aVCyjdh/fxa4UZSNvzgcOHvMB3IF/zm+HuPV1/PBdesyUXLEleb/ILdyjE+t+kg2AcW0TFzOa09PnTj70E5Wy9O+ivlV4NOAMTj7NgwzccMgepHY6u877YnLthiEtTbCwhtF5cluTWHeCfjb5KZjqjh2xTBZ/965Ilhz+7suMyyOKwGZ7mByoAbvYXEjiQluKORaTVriHexkXzSxt2UYJMU84wUDaLUc8cyArWJNiMAn0WyFptWl7Y+ok2HDhpiFVmIICQeWVfX/Dd1juX+75c7zpE7JKkSIq25MLTrKkAEEBVUwpGFIOI0pfOo4li53nK7PiOOjxQ2cfmGgKT17PksojA06AJs5bXBFg805ceK3YoMxMZtOyufZSHoarUMQO4iTeTpuLZSwGTwy9IoP85yHmPjjV100VLcrMnXGR/1/0ALqfrKbXcuJaDaF3q2sfuoLqWY3pBtTC30UEhFRKZE8V6ZQBE/F9QewithlPIQJvvhP/yww7b9cg2lXT9fcMvhtwj7atSZzYaI/UsnIzR03oheQNzPw3ITkWH5RFvCRAzzhwd68g7qdhi2xqPcQVk8j6nPd/Fbd11rLTy+pKlGMsS2rjzj11UEb8ZoXie4z6J3d0asRBeRjslL3qOehRhVoxZiPy3IyKalGUkI8c8zs/FG1/PbktOa8tNd5wHdk9ZPLXizrVdmvoajlD684ar//jwqcL/f/CVKzWHoy2FHpdbyjOcE+VPlRoblfgxQlvAVaFp7lWFoDzBI8VMZT2TcVIw1UOgpbUkVB0VYOhG6wWevpUn8lw9nh49W+I1IrpUtSgZDNxKeh6zeODo9Gay+VfFJPMr41RrEQuUXyiw0lfMWIhJyxg67OYUdyunjtGRh5xbULjQqRLwJMUhsMr169DwaOR+hu/oJ0ZiHEYjSZUlLMb4fpIzJTeh1pBrf8uImrjLCXsKArPVJwxTs3SiooMqgQLkM2jkHQuj7dFgeVCAj+TGhGOWeRjJpTxDX/mSMqLOXBEaYWiax0St04c+ARtl2G9Rp48iojViyrC1v7E9ZESV00/Bv3947cDuKRvbikXsK0RjGdS+KGmtjE6wBxUL3lFEMEwexf/GqW0WYU2aWT0nRZIw0Qm+bhVDTPJbOTuE9QbImipNReAum7gGm/tJ2WiCZV4Tij+D+Wvk6nw1Ksmvg9dBmtXpOxWoq/BWEKS5aKr8e051sDOqACxG+5DTg7e6iP+WGs7TzY3GdzHt3BDpfADKKIwSsT/d8+JdfM1Mr53xlXG/ocSSt6i1QU1GgDDYvCMokOmlAjBLgI7grQMoUr1ORB9mAMsDeBC+/MlWf8kkI5Wr6sj5jzKGN9Q9r/ge5S38drThA7lmCcTRhlpnpHGqZKmaXSz+8sljQucMY8O1x3Zw3hHPpKg9yGwmW/5TWFI1ygRS192czeUcpR2lyF42TRAnaoiurOPBsieutYsDwMj7hcEg+qPN9gfc1476EHSxRtjJmyAnGlDZxN/XDZoyDRVx1bRhDUgr0ZvayKgqBDVeAT/0KWQDgVj6JOkBCfkDb9BdSg0UqvRsAnxriI+PZ1Q0SU9GI7bx8Rtu+bCDMiUZ7+rQgUTF1bmVQZY9ArsUHZ/+23oNAumGG9lwaVvrPfZ7nwH0jdqJCuJnqvBdfWUa2adguSwObx8xATD1rppICmRZbmH4GTqiHEt/xQvYwbLSXnNyDKdlYcU/yeI2YV87kx/iQOvZcP0bQCGDb/+TYJdHo3RZUv6LbdoChcmkTEoevacUb0lQXBNGrmj+Zb4hk/MUtfo2xoH7WYHAqO/xLPaesZ+43XnDw24ZBUU128wc9KuO9TxGLHeVjJJk83lnV9xdz5sz1/i1AgaI969W4z0eoip60jdqgvd6+GZ+9ZST6bFQp0+THqJixMg/006kbJsTtQCZpwoAa8YVVsQvFOfIfFojRjn+Zd840d40Al9YD53AnakWGY9c48TYrT06+8HSKQ1t7OVhNWvT6+cseWZLB4xO3W85fqc3xyzS1OfM5G96If+1KyuKZo7vWZfc8luJ4Ud5NAxUEwg638RzDRTWq3PQ/0C5cpQ9KZHP5L1/V+fFiAXeAyd/uSpVvyezcyueZig37P7WfZNEW85aLkCd6w1n9uDXVT7SwYgjrC0iZoo/8+SxOq4/z9K3Yw0QzLUR699/iPw2pPz1Pf5XxOl11BNDwLo37Ua+khztztIALJNvlL37mHt2ZF+hGAIUbsepXcWBnmVirnMZw3gwifWs1AfU91Xh1DArRkpUng5YTa24lUzOGpxM3JloCKNZTpi53mK/W1BH2s4NFgvVxW7cMtRNhaZZkQlwXsLLzury9nH5EEW+YKM+ttSJSJ/Dgz+fQMe9IqCxqvs2JCrWjzPYPKxHW1MF2PjsLom5iCLPtpEWwl9h63UYcVtcCFkJ8sTn7eoQFxNmgDka3CJX0uB+hanQa3Xg5emBcrg88uYbkk2jmGIueyCb+D8pSp+7elYg44o3AJHjL5G7lUImAC4l3g1fPjdeFjbPIBpo/Sc09GMyog+pBqYA9C4SlEEc6rF7cro+M11Owl/EmdgTJRaSrccvXvs/g563cI+8d8LBorMq2MoZk+sjcye70F4ogtR1MBs1ZfRT8+QHwqLqM4BHpYpsKZRXXJxbYV2RLUnVShBfCkTtoIuAKY+Cm3NVwdHNdk2e3JBCOnuGMRBw825z795/BeKocXXG69mzHIqx/7tkZrc2yfumxBTAOmlJ/VUROWh2hm7rmZbg1fqDA6JJIMDSmRix/efmKpklUOm5eh3m36JIzqvByKr644P2if/iZFU/pkYt/6UuqIFy12QazXELkdt2n/MsAg2sYiCZ7v7JqVPPpZAsvqJxuWno3hUAZ89gh2fWn4T+zzNTwpYDQsT+5optpNpWMr6OfQhKf8ZlSA0D18bTbrTI8rI5sWJlSOYR14iT5ZzZfuLekUHfWBHFR5RnjPJpPUyhiZhIOBLTMUIJwBUvWSGyUftd0B+INrBKevP79YlhcVa6ntgSokIABV1yxth5+MlLOFYk/xdG+aV7bB8Pe9uXbH9+OWgYdS4rc0FMKEaDHBC2NzxUq+Z07l1aqShqTl31bAeKrf67pSvLbXz+2Y/rFex9+Hw2i6RTP1lKv+gHkcOma65LvzMBGaBJpd5qzkIQw24Axzx//ooQNBa7q56hnrigxZzOB1Qv9FAxSAPAGlxORAXI5wlykz3X8JixysxsFEBgWdZSwmLw2y5lPnyjJ5/hqCe/Jp8ughv9NfuI21IOd92nSKkmtrOUok+ostdYqT9R9/J3y4+fPHOPtYVYyXf/ZHHxa3C13F8hyhEgh5Yx0ENpGnf65uAu9z8ts6N+Swz0t9QIiHINdcV2YwEdVe8YTi16dJmxUcUZqkjt6bzULWTRXrUg1LIehA23cNh2Uk09P8lsF9FH7BiH+FIPldeYCX+hycIvauvT9dp6jS8wRUNQuCDxtUkmw0hMgKYi7bXgF8ANRpqjAlluZo4OtlqgttLhquLWLYb3jkJLSFwgEf7kk8SNRgGemDSkNEUX4PDQ5OtPNOJroxAUAff5ZtP7c2fA/WGJKxbV5/wdSbh6cC4DdidMkgS63ns7aX0bqZ6xfuhu4KCEvva2FYFShVcaSMBTCpmt/p+tLUu69+LQrg43OBdn3go3l0W2/fuhD2VFv3cDXTgPuJmK67UextEfw5v/yTX04srfE7tCPpWRcZVJI9Olw377fM4vMQ6jGlwSCtmSDQ2Wzg/aweMqnqJblWEOrirwzE2ONfZi/zQr4dhHcndmXP7TdPzr7Qu08XXOPKa0h51hqAadz2sT1X6lAtAIHbiN3PEDLwqidLXGcUqH+4S0q6xqAmQpZcxHyV6o/qQ07V6vfxHFwgBOmypuQ0/Z6C83/y03naPT3EC/hHw57qQxT8S7rPsbWXIMrOBsNCPlp76ZuQuSMa6TmS4YXYxYqwBqsFgkqOAFqfT2OBs8BbMnT/ffJLaOwcmkE+3PCG360fyJ3KSjgn8tMHqrV3a7H1XPQFCZi/kVLHRj5Th9SMu8uXi0LZmuXJ8v2KQoIj8MCahiIBzzWrqeO5zdW3oAhLlRw3bpW94aDWIIatx9o5Ee6P0VIds0aDfZUboa+dZBgS9fCW9Djwhxn9epsyAbAYCthFpuQfFaymSGM8XdawS4Lpb2u2f0nr4WOmqbyn1+baBeLnpxcfb88IuU65PPOzf3fwOMou4PRz2bUC1d7Q/13PSJjr0WyKnua735PzwI8zyXmKDEvTM9v7khea4os1o2llI4R74sprpvMFIW1LBLmqloaFwv/KuNB98WU2UQtszi/LFJlss+7jevdZVbo15YNS2xvwjVgE2e9bcnZBFfyTAIn5E7DcAYuulqbp4heeRlJwOIzYQ3HcoW4KzXkVoSADrjoORX43yan4OsgBSQ3zRLfjxivHPwQfu5C8+T7bPwyJFTAuXwov/+dcRdPZOfiZ6K2ngcqvyEoiim/H8A8gFErsdDLq1lJvS8MIHgZLJ9ZHoYY/Fu1UjGFWmS9016zyf/FtXh5WZOUIT58/jsvhTzHgMM27jib8CIbpvpyXLcxYFAj9cz6Brl3p0EGFTd/jiBOAoKSpDRo0/48YcOOiSq8TY4iCY6Ui/KWQ40X1RCfSGmRQfthJwWWiYHM8hRAuMrCmZE/kas7J64jW/s3ShbZptGEoolHv2V+buWR8DT67/muDMRha+v9Ahf/5pbK35huE5zz8xr3OhK23+2aI4R/JmMuy4oxHkn511Zc/lsA/4n8sOvNLFdXR/Wi/CyYO5GwCKyWMeA5In8T4aOuD0D2u3z4MJuPWFK1scBV+qmc5snvUgQG06waXZFFFsQPQFuKLJcQdJnnayZvAat1+17xFxW7guLCLyWKuryfVCh3S6/DOF6onCVu3rFecKMJrHabcsNFFgYRKCTxC/QprnFbjF0zw4IS3tUOLKUALR8UsZRM3eVqo/L8y+SGyEM4blAIMrzVUgyb1DtOkx3qEwcIreWfjRv9NLmt2Ff/ab8+msokcqa73OHHIcuHl71CyZp+0+L6o0YNiaBYTZvwaGS/pJeUb+eX3Iy/DJuPmZ9YwxScbQvwwsOI0CJgiUlBtd+2bNvcDyiU+Bg7GWHLxwJs+CreIgQWrA9OCSdlLvoCXsQS2/SAD95AMLaGwQwkpgAj/qSpKBg8szwA765d7Yxpoka9ITqhwdbURfEHJ1VnE22hC57iRVeSsLVjE3yqJSh55BYuLhLXSkMBIq1ZlvxA+K/kx5BZy1DeVnviLs+s1VxlaJA2ufCXQ3EP6/6MbOBJSHQj1ufLM+GNHQVS55CMIZychyrJrgrcIU/i07oii3w09cyVKK15BVLuYQxlXuMgiXmmXLCgKbp1CqzObDrmJIyXv5xjnY4N7cQTPNVDnywOESogvcvMmMYaAyZQr0Mx2grZe4k2OB140eBOtS2zbEOluv/DVKMVBrfSIWRLhDdvFCLicSnq0YDz7I0KlKFQg7cPwG+le036PwfkdLEUQ0MNpAmLZ5C66xQtBS0dG5zOzFeRIBpYZxXUKNUUd+7Qbbfk62Oa2SYLVIcHboJUrAFGKT4+5Fnr4DCb6kpcTcFghMNObnD1950VPWdRLNogvBaTVy7k1wX/yhkETaLElnJJAO97AKS21D8NnI6MdOQxiZ6u7xY12AY4t0FRt8w8ejKsNZoC/ibCzdVJZWX5Q2JhPmiEW7s5/8ZRG8x8xQHND9FI1TdOF1/QW+cdENLhFS4Wy9IB0jsbSrdvQMo4avJq7aPjnqiD/7ue3rFqfE01Px80u2qb6I21C3U0E+NL7Kl9FcLqEGI2gwGZO/1xQJdojYuvhK5RtA0R9Qt0p3rr1iT0kYFOFzhiBBbpvLzQQehGQRBBvxjuORMZ0RlcDtlOGY6ELgvZekDLwDLHp+JsMGX09E0n2JrEX4ai9xx8SGuCLBr6QZvbWHVfpQj+b576IvThRWHRzVX4PEOAzIexdjN5XZU7XXzQMOFHfa4nsrtTOSSQ4aHdXzIl7FObRZ0FBIOo5djnrn6+UrigY5yVecpVNH1e096lZOpYS3FDreq8DmCd7jldNCi8tnO6T1w7Z+kgRcaUxoJd14KQQAf9u/IoFt2MxxYSC7nM4idb37M8GduRwpCL0oloaCZarwm/z3ImOfr0jRXsBzWR7XGMiBFYFKfnHMUB/PEbV6Jje+Owz9eqygvJHvPDn28jB1DnYSyY/x/4Vo3Hx4bA4yhgF39zS9qNOsg8glN2xql5dVwhBppMmcvgVNAXqLYIP8zu3ShA6oswJou+LXurASAo6o1AMJM+41I2wiThq7mRiw+4iSdH99iyruHeA0Mcgr+ZfkWyNXHYpUBLKtzm56jtzFGlx47SEpedmu5DFZ/R3SjU5343k/720YOL+3olIMDdl64oNwlXYLl8FqIjT/TS1Ks0upNuNgLzKqwl90RVjMe06xwEEl1xKWEWPaCGxBf/2iM5iN2WMNP/O6PGOX1LwvxQZEGMgV0dv2t2QneIyUbNw1a6YBADmDRIiwnjnd/+OlNKBzpsI5KmuZ7XPORYeA+uJQMJrVHE5CIT/r6CzYxaB4wFNp1NLapxVQ4xc0SG5jXEOaVmAKWdR9PNsLkehts+RHMwgv6AG91LFwk/uaW0BJnO6JBuMsCIaQHmpDpmDXGRfZ4WP1dqDVtXrnvTUGOyqZK1U/5SVSwtWEHHMuQZtQ9Jyoa+lvvR36kMfnDQqK9E81s0xajScCmB3H2/+SuG7SbLvJhvT6D6f0z+y531jSyF2ICmH+JG523Iz1f24ijeo/enQ5T0U0552c7grs4KvyLgi9MGZWkeIgRvRGN0uY9N43gQaVZd72AzqzW+z4ILChN8AtRWdRW8TIGtemeyq3wXdX2JWE++V1y5MNQ2qNpXecxFBnJZeJp8eaf+BfePAz5JQ1uU4jic4YY1EViWB0hjnuiFTqPKPR877lvgiD9p0u/2AuqXFfuxYyddOfULzSHZq9HhmmIQV/jpWXFiHvsU4grbMmZDVgcC41YR+2VPyDlfyercgCoMxb4OXWsPPYB4LaxFoxVVuyx2vZVim+TggCkeplrR+XoiiczdbYOsdhtVD29shPS/hE9IIxq+MTXWsSgI/vyTplaPP7SwAEHAlHiZ6x2TMwoI2x8Gzo7f7Y+BQ2SLgp7CdvR/+Y52I0IunGo6nfLUVcW7ZkxwFNE/MXT0fyd7Uhh5gi1HjmV5ENz62QFZJsrT5sV3myH305bjpO9PGftGxFHx/mSGB8e5KfWsj0/oF7bR3xyTGDkGIZLBcEf/dX2mslOOCZ+VhV4BB81jtMCZGr0Blpm4EAREK202A7ySArwyCXb3eBUAncu/ddrMVKNPvvyfmsyidP33k0iL5WX97jPtFUZ2OTtfY5QpN6wfxWxEvuSD7WvYpt13e+ZJYrvjQvyKs7K57k4CGbt4ovGDS53OAKEey4ar6W1QzyKxc5IVdEEY8tn8E77NcnkZ8Qs2x5/FGMFQtKetoiHBAHMFZaT/jkw6A4M1KlyJEjELodUv1fU8Bu6YBUM3LyfEF/LBH8l7LPiRyhoqJuLXA7J/tkoZJovjHVI5um5rOcmwJdpIlllTfU/WK8BpRt+7/35/QY+gM7i/ae/ZGk7yNoPNKtbdNJfkzKI5Jq+WUAu5IEIBE32aPlGzHJAOSexSe43TDsYQhRQ9nLkchmFdRIqRLz4QPSWwF1rZ4TuLGSxjcxA6C/vhu9+VLNBLJIi1geEg6wMe5QvgnapE/ZWG0nJrdhMSHv8/R0UAP2rRbItK1Ec7Cvtmpd1DrCHhBUFM8RNa2z7Sgf7mybRluA+3tFSyNQF/ebaVjc17qLEM9/fkCgMj+QLAPiYoxSVzolhV1EakxNtis2YW4GjXosygvylfNmzexK1FVJ3/QbFM0ByzRgxRkv7FjRkVcBNXHzulFO2DZAzLPJ5Qw3mN+kWbPjG+oia75jE9nEA/6i7E7tzFxEkZvUP5ybTbkZjQYLBFLPdIpPelxxJ9ty+zqXawrTq0z43X4lvuTmVANcnuEgyMNj39t+wQ9OX11MQ4UdVLB15JAcDMJ9N3BIlLdijYrKrVWtjrdjHARqIopFt7wNN069jRZ5do/GZWN4wbPRhiZ2cShJ2TQ5s8fczROrjN2K9XaxDveHc70RKFn7WZSpabLnVX3sj6P1nSxwEioq/kWgQ7BTzF46en7gdkmt2T69mjyNWx/8eeTJtKEsTZervbnwe+H8mD2qffbjej7IMnwyJAme2g0jl0qp5Pt2VQi3xcSOP+7z4Tddo+3ZGKzdPGk+33GGujtuv49/TB4qvdBFCc5oKIcwo6HYZcQ5lOhCWDPos4NEN30tHhVKZRwrrN1n53TMlsFV0tc+Nuz/ra+RRGpC1egzAX0hyqr2aX6zj7QV6Iz2VGu2OZrMIAlRea/qZ66iyIZlhTLJI4OVycIK8T0N95Jzht7lpidMasNrPWYRtK7e/uO2ufB2f29HEHx66FjWeapOn0agBB2AS+thiN7RNumGK0dFfj5N6oMpm5ZBwKGcnkSt+xWAWTNyN+hgue6hr5mno3eQTfptuXbyNatyy8msH2vR8F/hY2pAino0UXTXEWmAIQ9IeiRfIGcKRljcTkpSkcQzH/pf+bOmioBDqVl6l6m33+So+30TM884FaMA1BRSdq7SpncHc52dyJCcrkOCBQxFrCWWEzjPLThIZ5zMXsut7YSfyryiiCFFl2HUy3s55wmPCjnOWN+3zB7ug9PWCxLtJOLLetgygHiOdxMmTKKsPya4w1Vir4PwdS/tYLOs0wrmFQq6dvWs7SKgYomO2/iUpg8x7hTMzjUYVVUaMmLVT33KJO5W99JGGSWl8KF6tPqIpt3pEo2HH54ogApdm1Va/0IQhCIgqfeAq6RPSfOoepMrUOOjpKMBjTxq+FwCWIjYVJFh+z5CobIdT/A/JgZlosKrIrloBqR6BUJ5VD148uxh5Lux5egcaZQRoGCn6yFF6N6Ad30q9ZU70K4gVIm9ObsJ1VyI4wcMzMSAJAeG9hXo/SzYytCpceqECpEmjYQ8QHZRrCmiJewVES/sssqyLagJwVg3Ql2jkdJwDa5j7gEFNsFuyErU/pAfkEOFrzRiKslvKhGI2d5Y0nMNejzARx0sXI+ktYT8cN+O6Kiz7i2xo40Rqgr8yS4LlyZrPTf3czj9RldCQGhrUxElFaVs29cEMLtCg/IboQiACs4rRhFVtlQDPPJPkNhHompgfuWb2iKb7sq4yXuTKG6pQaufhv0DuwqorPeqA9t7SQ8g7Yb3D8WHvZoJBcyPmpL0dEpjHVXDTIuiCNQ4MVWGfBPsn/9nKsIekM4VrAC4paBB7SxqTyxgCEl0qaeKHPxR/jHpka2oskN/QpAUX5EiiQhzmIwOU4QmPr+x85HXsorvt8sIpIiLVbbeO8eiq+0LmIy+CQbDTNHOce2+R1z5Fqv5zgp53bvRYWsKDnz6KetRQeemjDNZuz8j2NuIVAG1v2MgVsmCHtRmimg1PAWsK8ZqEa87PGYn2U4Y5PUgVZH73RBczNxXZxehdfbDUGbr4C9PLe8LhFb5kkxjBiJVO3S8MYK+FFkr+Rxr2OT/kCeG72xBOSNmq7POmh9Mf7IBUCWEqyz6oDRD6KsSXMJoVw16Av3tPLoD76tH1rz6CzKRjUNcI736HDwOYShm4HNe08kcdRS+har/fCXF/xenx4/4RrWbMtT+dT1WKfeR71TDklxN56XBFRVzrILfTBMvmBI7QEaisIMzZdC5b91WJNGcy5Z+3RAJdsgd7g1QlZ4NREA5KmALFnhtunmyw7Ty3WdNKO2FXn3IbJRzNT3+8S1Ep6k8oYXtIm17+Aa6542FUWHrhdDw0fTX/o0hl5KNAGd2cWolekwBS4XMOg0N+Jq/6/ULHo/pAag2JwJ+k26971KkZHQ76Hn0J1WAGy/kTD+imIXeTV/5o1FbTX+630mbKrQtC9OwzE3ryCmYdQJFPjvCmdspy/Vjju/hAVL8eSmdFGysr6kBYvptmqFxRpIFP8w7O0KvSd+t1Ex2QZ8DgU6Pp7KuKbkxuPS7sfJ+h0RTArbrUIEQRGvQcXaQq1/EYxvxm0TeOTmlTKJSkmqBnzPhVMeSd9S0wC48iaLPcjT3obvmi8nmAZg53T3QftHzFd83KIOaSsgS9rTIjEfL15oatx6JkjPNQaaJe0pbqFhsH6oV+TH+x+Oq7A7sUU7eOu9pC9GhXfBc8/5SggHUeB31+pWOb7JychE7yJo63A12u3peIb8pcBRGKNgKHoEUnSd1D8T+Ouk7pKiw8LwO+ySWlrL5AOVMLwJAAFhb8bjwM2IMXnMg1rec37wugetWIzDww5YTdCYaGYDaTuAUs8f+6LxgAqAJa2l1+9TeT3S+46SJeHBe7DwauTngd2uHe4UbJ8kjPyYsIqqCQ9lXyJ4X0S2Nf0ra2NrbwbRlxZ19D9AGr4i8O1xe2367yJGZ5BQyg87KQ5wZ+TYk0W0sMy/h4e//90dTYCX3sBr05y8VyOjGHieewpY+dRjwwxBxCgW8ZLSPKR9+94gvv77iKSUzdHErJtrSO/VDymOXxtY2dQd5USyXuaG1ScS9+K58HqkdmpOht8Bg4MPc6hW+K7yGaSH0t6MLMtD5H2s7YhivmWo1jGOH315jEd8FUEoa1GIWyZF7CDgEbDC8F2V1Lv6Sty2eJniK5jqIdfDQi/QzGzZr9Q+8jmiJzOeKw7GK5+VOZHKT8hLPwbTHbpuysa6w/NHydWlKfY7ayhZSdzHKvNeEaS9mbWqoJ2N42Fl2hSWN9u+MfgCUGLIEIo9a0WoquAtlDT55G354cSA+pvsu0vGCoN6zRUsosytJwgpdyzdTXz5saz0xCgIjlObY0Is8dIA+v+1FHEqO7oDbDOHZIl1tx7j2Tq0Reej3Re2EtUBDuxXJMSQVBgsvj08c0NKkaX46J8qqUj7bV3bHkHSQHFOOFtIzc/f/OHs3y+2Sz4z1EvHRCApZBgrMKdr7aGLIGX5mh32EUee5grk5sG7WxmQBWU5jFNG/42YXDwJ94KUgNq8GtDUwuTjmT87CuUdTdMVsfUCMFtem7NxtSUyue3pXC5qBmaNrNpzRrtmpBHPIy4smmwH2/SUmI/AMhFPISQEjucGrYZjSD9G1ImJxEDkLYtCcK18VCxE8HqfKD2PxpKz1clIffugfK8gEhfW72xN3sy6j3xXiY0f3ROuroYwu5wZrGKWSuEvNGstOxmlTjbcZyDnW2i/9tg7y6QEqUkVyUEacgHlFLvHA1XH5wLbN2ASzmNWej8F6w8zAaF3Pe3xZvALApraLye8MWmctqnbf5gccOSBV/J1FRszJpUU6PnZnThO1A4I6uGJvQpFkL8RO4j2Fc1A2jEmD4XgXhNJf92SE9+C8SmkAOTYYKWirzt4DOO0fPrWW6hM8HEBXIpVWlbx/VuJ1TnScsBePHIoyJD0qdFv1wEptfW8FpiJEnOk+I22FLsYRUBq8jDN9wwp0i6QjjdySUrhePSQkshx+1Wg7XOipaS/INNXOZHjGTd/XIkbdWUySJUopYkqmE1OAvmNiah+rage9RDtrRea9r0Z76h8jhgclNAy02eOkVx86cAmcP9BzcYwTbbRwY+ScqBG58nnSP9wXHLecd2aw8zoP1ztYLgojC+8IlfNKIsUFOK+TWngykOktylFaXjZ5XX4rOM/f56pn4l5/VuKRx+dBhVE0dwAQskqBWyeoURRVF+hGu8PJX5obXOZJjPEY2hbYu5ZcMcxmRbr1TLqI954wn5oUce0W9okIDfwHF7IMJeosrYDCXx4cA6xgAlTZkcQCOQhB40FxcM9+pCf+yHMWYAfMcoIdFH0QdLrUohGlwgayiZS0XfMz2l3eQqZTxwsREUWzjEQGz0HxyGEWMhL8THWXOHjmPO+IrYhaKZewRZhKjnhFlJ2LDjqDcf1Oo8xgET+SSxdkBy2yu2FddYCeSYnXIMZgXGjOWHLI/qM4Vd/01fj73VvmhBepGk02mZ1UYPOYjmhM9cvetvjIHmv/E90ElFna6fQt5DwFZd/0xVrPkIC1J1Xm1UkYJafbzwpqvue14VeovKU0fIqdhaz2VI37dacLuWmieRzTsAP9VmdJeX0R4IEtTQLbj1cR0vG2evAgYqTW9Wh/QCGAShpqOpYey2TWBX/6asPsILXKeToMp+9QlD/i4OKRfas9GDbRNk/9LA64Ml6o/s0bi5sK1wUMYEo34uI6T61DEiq7ghHEddmAE8u7miENhYsGzYzHwaS0iNckBWpCRAETOs5ax/Ljk4JrPhyR7E1BmQnx2qs0/48RjRntupi0lY5YCobdwyc4N1N2yIyrhK1wMdMiZtlO2UKPfkpGHR1rhGSMDrZuT/hdBoRZrGTVieDgRxEOV9k0DsMJg8Zs7OalQP3ULkPEcAFKQo5OstiOjDxo5saUIAWi8oJo2yblOhYxZSDUT3MKQz+1vMkPtYbqrHfQhpRb5xS75duijOOlssDeqjF8ybCz3lPKx7XnMuU5TCw8EvSDchsImpZagA72X4lXFuh5a/hbMAZL1Ob5w4wUQfnhTA3pFfpi+8nPyzMIdbn+UiZ53ge0celo0wNX9oKxPxEA5iuWqUmcy2fEZWYhTFRxbWfwRGDAvILV9/03cPEm7mLvV0EFiVzZFLc8roGSt/gzBaKqDqs8OQN9NRG1/vdekCQjvbXtajXwbwtMT3a2Wn8BKNFqpwiRO5Fu9ZK6U+M+KfVPw8doPb2s/CaaL+U/6TJtXQH63C3WaRG21q5IMMJaAb1pzfX+F29vHERLhqLimBlxte5VytaQdwJZ79HjaI9zIN9bMze4wgJsY50saKeAXW1gKlEU9toA/HjZB4IsomWptgT/kUHxNp96XG9vMwBoYUnIwt6zYE1E3eqzQvl6gIHhTx9Ye2dtZQpHkVLWzWZPdP/MmyC/tdb1wXC+BUMixeO2iCvuuOJU04ENF17rkqwSIf2+eIJX8fZA79eV08SlEh3UIevJoxTReVluf3sJVm2JQ+V48cgJdsIlXv6izd2pP9qXTgJdYwgs7LN+iZUZ2mtYufPFauxT2tVxrb75bC5bCQoTUr5JBYa7URSX5MRa4qvByKA34RdkM1OxdFzfirOC1g0WKBfEitPVV4h5S0gewIjTqMP+/BGOaG0zl2vRqfV4oPW8HQV13whtLFDZyLUvpvFakohLvRAQENj8DAijy7UTO6+geyhP4WViC50WWha7/++7T58i6R6WO5ADcYv5GeJgpOLabw3845TZXEFTnTiZZdt2+1AyrYrGxXjb7KK+FmBLyTsRStJyTz4X8Ae4aQwBPnHFbtGAKTWwaczc9KDnsd1MkbfJ3LWl3OViCiMB3ekD+oC1/lnSrsyrLs0H3aeP8UQXZVuhc7TrOj5P4YAXWR7XeG1WLnq7iLUQ24nHZB9jCn/9Y1OCTH/7megDHC4tfuqL2zgnO2AVqK/s8BCVlW0ls5Zsd3HYLtb9SV7igZI0aFVMoubDHpsh3g4U1eYdtxXYHBC3qScz6l4IlrZE0l6Ddb3aMLTK4ySOfQUb8b8pej07fCJuQ8dMVLZ6WyOTPwGoySYtyY+lMdc6nBbxvU9xtryFXNS/YuiRtYnHvQwTq3ZTuc1OydgdVWIjiOu4ToO8cRYkoDA2qdZFagRTLQWrp+CsxR010K1eoYwR8RMWgzJtiiWyiMtQODpCIGZdw3itNgWeOucc7o2DChX+NfAQJD465cT1Qw9oKTRkLwU0VBvmOtNXGz1PqJ/nbSIpSCgpugo7B2VgOHVNH2kOgaykYxsjwiqbfssO8FO1+u+3Kmfju0K1IbOWcFJHnVeJfR1C0oTkJlGCdAYf7QgzOeJUocV3Yz+gWcpMfuAly6GJ980YIM7E/FTklMHgndS2ab65Hkx6qwPVnC2UJhBsx8mWolam5IINPu+VFisCVqnPfOf8bwjXNW6lEelHyDPejWrG/wjyxsC1aBFuhuR1Czgp/HlvEO4UiXWrFB1dMB31PB/qMZpr33+Yn8x+R88CNAzxQrTSSPwqp8qpQid4avr5y1/0agUXGQiVCenk+O1tchZeLpZ89XE7kSTBoKztQzxE69XJMp9p4LjmwHoF32HnFUfFDmMvU1Lqf4c2ecyyHqQLRm3TMvfdzW3EaOHaDiKhxm76cGe2I0ZA+GVoURv8++SGMvc9c3JI9k/n8PgRhQ8JiM0F85CISrHg+wSuBljJdTR8JZ+mj0rbaaf/I7YzW++eQqwUmGcaxcNhLO6+GkR5CduVVhVF1iaEKLAHG/r/VoPxUjT2h1mwDWmlBOVQfjoCI312yFQIYygU6/NDZrI1qQSvN0a4PdQKfkT9ZUdOSmKficAAjmgEnkK4JadcPZ8e4hXfYd28cITnWukYb52NsfePahtDIdzm42bCMmO2lBUF2SfNDv+sVx3ByBWx+Euup6NelpGukNaq82GWSfgioiJE1wyFReMwIzBHynIvsP5QtvzmbOSntIZhsaZrFIn6/8/oZ1obbPjc13Wv5XOtGdWNQphL3KOsqBBVTNUARNnMmwKp9yAeCJyTNInhixSPa8VnJOJX819sE8OKi+avcvI+aCojh5DhK4MhevdTZKyrkN3EsGDsoi35PlfMoAZ0C77PR/+OCRamFxuJJhr3s9egB300JlUcluLsdaNIe5PkYAiadHKq1Bcvy4aahSHUU3gFCnh/CJhQk5Fcg20n9HS15M/zKun0HjqsgK6fKAG+tyR+zoEIm5b0Jm44oGQ/kfe79c4czU2kKjHUbkDyZnjbobiva+cYmOswMwjA5mWE1Fd/POn5TPtnKyM8ObuKp8re0mKHu4h/qFQ4P2gtdkL52sav1pleNkWH0TrYxNaCI8339/m8f9y2BJYBde94oCHKtXuAyCs9DyrFrt1m0Hm+3DIvbB0Z1PGm67+B+tF3RxXD0jvWk+WcZCMbFJlXJTR44qUWU/kDpdWQYdvFq75h9YJ2DHhdVuO6SFIR0fZ2A3n0Fs4QScPEcNshW2zNG9WutD1nXu7B/x7Ih7uSBxMwAkavHNPOtCMxhSHAeU+5U4lexYO3qM8tBZ0+17DdolejYsxxjXgPx7Fdvn139wohhsVfjd8HoZMDAPpJ4XLAkIK144mh12bL0Ex9jIIGvEKPvLZ2nEYvEXngl5U0ihLuxaIhKnGAk4ZAFQxRRjQOOmHmOT05JHtQXI8tZqimra8wvkt/2oXZxAmXThQRFWGcqeiEno/GzWTBJz2M1KSOvG/TZFzmMIpsn+5ynEqg+x0LYOPZgvvgw65cQLi2UgdFT7BUdoV/xnRYbu/OUkpjbmGrFU3ETdlO5bMbPJE4llmTrBP6LNqiL4jp1eMXNF9V5BT/zHwh1JwQlyhxA7SPWwQWijxjR+Ghit9955KL1ekyVd8S7bKg9eY5t5VNmxmbsj+vTzZuqHnG3pwAxLd/5EbCNMYwamtDGyL+B7KhaX6tZS5jHfH4YeBNn6Sf6riIaKqdRHsffbaSkgkHkNufv6bmfMzGlLItABQuluFr/nvmOs/Ud95Epaw7ZShUbACGf+6lsmi2Kp8OAHKNC7tg61c0iqtbDRM0txkkGL9akVD2rfBZHfefYNfDsCTpaoEvPcbb/9GTaRBnu/W/A3T2DWS22unFu1QqbgNKr4qv9ifUWtOSSkI4nFUWJmgL8hGXvOgVhvsEvoUeC6qhaxVNcgx9jdFL3KU1Oz2Xa+/zAievLWo8yMiB2FibYsUXppAekeJILEKU/cdVp+iaGamNi8MuwhUQxCduzu0ZVkPPCXK/c5BIVA43w21xPvzqjjyvlBgRaCHTX7a8nes6C97Hj5eQPl2OWV6K8u+kiJdq4AhyOF2/+wYBHUoQmGjAgBpE03HbhA9Wp/Gym3LX0dJ5qbj4xEK3+fNvXrcm6x9f4uUBIupXvblkH8jzcIRZeBHEicee2H4VZN/LPilVWbxqRYlCpwcLkkS8o0H9D45tEFI+pAWnitVfqdGVV0hA7otfft9nHtOdNQxXonwxlK5f3LNqQZKIKiiIjcRWvEg/Kd5NZgaIhgGbmNJoGqx6dr5GWrsS5BIS8kHKeNXs5+BAXPD7tpX5WSAldOK869jzPEEdvXXIwiSoHScOOQj4DXNwctQWYDPXw3ZqBScasBlytzBYz9nGRUtKK47T41Bf3V7riQgAeP4G41UooBzl/CPMwcpp9uknV+VMO/JxArOFO+ifmICQtvWkQ2hjZGfQNd3u8/gvs8HDWxhOuPlwCvxGq/FBQCEHUgAAB41nInDtMmQAs19qbnnvw1X0zg4GDnVyN4zppEhyVrPQjyhIdOfGpzRt6O3ZpgQkd8kPg1qSgolN0tXeNZv0SmhZIbeGSgzjPjiOh44MEqNpz2SwZis7OY8loGyVG8hLzTJ3vkSZm3yGB+J5bgWjN65HnKSkNBZPBhoIomkG4SZZbVrhETkvj9wwjQcUlaF7UMXq2J4ZFhcTi4ugN1BVeauE96KPSNE7T47ZVkitfHAggc2Gkg0qLVuT/fvsn7lZ0cQ20VqaGGU3xSULmtBUsIaqOf8MgdlmG9nNE3FPmy/EkKIvhqS9L7BxsDvr3knmiFKgzS/N14KGxNaVXGbAXgytCBHcVz+4BtSHQ2xUHjrIcSVmNpGSE1YX4OjcQV/O/en88kK6ck8EP3Jzyu3tjkBZa/qcG1HoEI75CxlU/IUB4MxGkleNUMVMy8Dp05/UDiOHs8ehqxWNXq/VrYalm6NZ0ekLMhYnhfHvAxqSnXP+1fCzVWT27nZ/RTZqcaTM4YN1zzvS27fUj3umua9sOSv9VTEzsTQgzx+TaXvVTw65uxbsrIo6nQPy6lTKh4DgUTOQWZ6LeTqyrEmxpctGXL+4msGICP9zGZT1kZUnIljkbMUkaLJl5Jjf6AcLXlsvL8JmpYoirzBFY3WfcmKrepj5NURHr288yLniA4/kCDn/lg0di1jDgwpKeiMndSup9/FovvcKuPB7tVOg0i9ShON+hUFF6pp/HAVYlLeDOHvYFp8A71Qno4dJryaJHtFtC+Ohv4qtjVnJPvET2l5jjkngz8e0IB8GU8etdSeOLTjNUBobwuXQUcUHDc6rX7VFyI76d4BN7kz/Eh1g7WuGf+WCj+oSy/j7LC/gAMKDfOkOHUeDj9YJaMfNkT1y3ERMSMGJckvzXjWTmL9lzOomh2CSmBOIr5gpgZPHc9XM//H+v/ok3Q3e0YveluOGMITiUJ51CVbsOAtFggUOBskrZBNr9QRdAQWe4bU1hfabWaBQ1Wk/FZHRlDR3b3KHNhU3xLLiTspJLp8BAIa7vHjwliKSEiiruIxrFzSUzMg1ar/2NiRHyIC3tlMfqv5A5B+iMCx1lOTkUj6hFDIcX1KmQuAEeMI+JKeAuCt1uNrGGs6y45mVgIJEwpuctjxZVqTAtx4xDXlVvTvlKV0lJSJLRBP6xvZLm2I87Z4XVTP0U6tV8r3RXv6M1pHPBiwHBAoAtPzVbUAT90YAnV04oAAl0O5mjw2qUhqBUF0SWI7sK4l5c3nbkqb52cYIVSYz/eKsSPZNTabOfuUPLfxIfyWsrki06oAd3KTE9hLnKF/IAlcCxviw3sStkdvSamwRYDOBQyUMNNf2IWWIoOeDHcOV4dez+ywJCSn/5MvOvkfFXFTdubMV8PGZX8b3b+IIrwC1PXvN6BAhHapDq6xTy+/llxHR6NZVkIHEe4KHQlvmpJnZ+46rtBztu4WlP+qRZ6u6Thd+v9R9WxGJR0Ah23yqUKRfrSWoyZYLD69mjIpGq1BWspaUHDeQsxmp7Hj2DL7C9x8w8iAvRg6GHx/2YF1FuuYUZZTpGnYeU7rISpUdNzHaAWRxXe5YHRt87YAVmucLIOZdVAlyeGFkV84F7rf+YxrJP5p20ItdLqWIlS28MszQrq0vixNe2uU/6X3Xcas5NtNsD2JMaBBfAs0ukv4f776jWPSHJkTazp9RNVDJZqwkX8r/Hw9omOd6BM1L8UtUPDD44YdlHyv5hJ8tR2FSv4/hpcbxXPc2+hEhf7GML3RqnFORuToPdnJtb4W6VXbzBjTeTX6zCWyHssDEDvmcOcy5rjgPBMfrHJZFCm3qf5ZRbfr/cnfUdSnKXik+HtJ3phnK4PMympz9AAAAAA'
    const GIRL_SLACK_SRC = 'data:image/webp;base64,UklGRtxXAABXRUJQVlA4WAoAAAAQAAAAqwAA7wAAQUxQSPMOAAAB8EXbtmq31bb1MaZkyUw5lsNkCBnDTIU5PgFjmJmZmZmZmZk5cRwoDidPHH6O7JREjhk1x+gX2trae+0113VETAAyqgEA+q47fszYMeO3WbIBgKKgqgKd1jrlyR9a2HbeL69ftl6ASBERBZY/8L15LH/O2zsAWjwUWPHCP0laNC/hZpFccNV/oEVD0eno/5FuzvI9khNXghYKUQx7njRnBT3y05UgBUKBw6bRjSTdonnJaG3IyEn9IIVB0fMiYyRJiyzbrQ0jr5XCoOj9HN1JmpH89v5D9hg9evRee9/yGelG0m3eutBiIOjzHKOTbuSPN+zQF+33GvUaaSSN96kUApGuzzGSNPKH45sAiIaSCnTZ/1ca6Zy2ArQIKM5idNL4z0n9AFVB+xKAlV6kkc4DEAqAYsfF5nTjhyOAIOigBPR+gcbIu6HpE/nP1zS68dq+CIIKBvT/nmb8qjckeYpjaHTj5UBAx0U11GFUdOOfS7YRDSqSKkHT9240XiGi6KioomSnV9jKP5YSgaCkBk2SYhydxjcaIOioAui67I5jBjRgLxp/6AUFOq1/4NbL9AUgmh5Bw0tu5r+tDEUHRdCw2U0fTzO23Fu//F/kU33rEAa/NZ+Lp35z3wErASqpUQxsoRlPh6KDAuz60XySdHL0kF/oM397fiBOphvb/nX/WoAkJmAPc+OvS0tHBHVXLyKjudP8nxaW/ODSz8zobtHJlpMaIWlRnEwzngZFmQKINNxARmfZbpHleiRfH6AKSYjgabbyn1WlDA0QUbmE0dm+O0ta9PZIb+X9CAqopOMZLubH9ZBSomgr+MiNVTf7cQ1AAGgiFKezlfeKlBJgxWNffHQwLpzpXj06p55y9TvPj22ESBICtomRxyOgraLzPr+QfOR6ZtRZ8oM9AE2BoPfn9BNLKZpeJM0i6Z4NulmMTrtzWWgCoNh2Pk8poWh6g2Yk3ZhtI/9vU4QEQHCAvQsIBE1vMDpr0iObN4UmAIJRE7cLItL/TUbWbGTzppAEQLDkZr2huIeRNRz505KqCYACUGw317yWGHkc6iQBEJE6uY+RNW3+yQqAJgAKYNM59Joi+ef5faGSdyLoMqrfVjNqzsnPN4VIvgmw1Qd87w86a90i/zkOormmeuZ8OvMxkucAkmOKPchI81ygOe/uD8ktwZBmGvPTjW/3Fc0pkYaXaMxTb+U1EMkpHEPzXKGbnxeC5JFg6T9ozFl37oeQR4qzacxd92lbQHNI8KLH/KHxuyZIHj3GPGLkjaL5E/QoWh65L9oZmj/YN59o/KYPJGcE20+m5xKNZ+aN4vCFdOaUzxgCzRPF8H8ZmdfGmyB5InIHI3Pbffoa0PxQrD7DPb9oPDlfjqYxz/zLXiJ5Iej0msc8cy7eAiE/enxLyzMar6xXKUo0vxT50fmDvHPOHAbNByguZcw3Gs/LDal7NP/8TYXkgmLkXHre8b2QGwfQmXvv5MftHvPvw7p8EPSYTMs79zmbQnNAgvadkn80Xi95AKD3j0mY2AlSew1rrbjET0n4pKHmBPV3LPzzg/nMf+MnjTWnWHMB02j8uF5rLeB4Rrc0fNUHqrU2rtWZRre3NwFUakmx+lx6GkguvGFFIEjtCPp8RkuFkf9/SFcgaK1AcUo66EZ+sk83QILWhIg8nBDSnZx4ykAAElQlc8AbjAkhzcnmR/ZZAW1FMvdaYkgzks0PH7XOqk3IuuJUt8SQHp3k3Fnfvry/SLZ05en01JB0M5JsboJkKWCzuUki6b6YLzZIlgJG/B+diWrld6tBkN06jPyJzjQb+e3qEGRWFCOnMDLNztn3DEJAZhUY/Ssj02x8Y21AkVUJaDgx0pjmyLmbIigyKgEY/gJpTLFF47yxqBNkUxXoe840ujPFTvKLUVBkVIC+YyaRxvS6e+RXN+3RC4rMrnv7j6Q5E/33EACKzG78L+nGFMcZM2c8uyFCEGR3+C9cZEyw89yBQ1YJEGR75K+kWXrIrQBAkW3F8Mf/Ij1BO2u9CrKuwCqnvkTz5OyIgBpUAXp9SppbAQK0DsvdMZOkO9294AACDB2/+1VkJOlmloKdageKtif+j2yZwURuJ7UD0RAEA47cY8Dgi3/94X3zvDOegRoqqSi5dP8ek9lqnmvOv4dDawsaVFUBbNXCvHe+21e0tkqLKDZ79bsF+Ubj1VDJAQCCuu530XKNZmciSC5ABQ8w5puzdQfUST5g/bn0fKOzeXOI5IBo3WM05r1x6hiI1F7Afm6eezTyHIjUWsBOLXQm0JznQqSmpA47/UtnEt15LkRqSAQ7/0tjIt15LkRqRhGO/pfGZLrzPIjUSEDP60hnQt15XghSEwErfkAzJtWNByHUgmKTzxmZWvO/1odmT7HXbBrTa/yoSSRril3nMDLFkTcia4IBU2hMstuMTaGZEgkvMTLRkQ9BMqUY02qeKveWYdAMCRo+oTHZzj0QMhSw/UL3hPlumVK5k8aE8b9ZEjRMStzOGZuYMuM3S0Cy1Gmip8t9zlgoMqw4i+mKvAMIkiFB/68ZU+WcckAPQLMDxfYL6Ylq+9kBXaGSGQhG/eKeKnfyjXUgkpmAxom0VJFmnH4SoBlR9HqOzpRH8qGloJkQ9HqaxrS78d2loBkQ6f0MI1PvrXx3aUjVROQhRhbAyNe6iFQNR1v0IuCRJ6NaitVn0FgIzZtXhlZHcD2NBdG4L0JVFKu1uBeF6LdBqnQSnYWBL1ZJ8JDHAvFY1R5kcTAeilCle70wuP8zCFoVxQH0omB8UAVVWvpnt2JgnDoCWh0oTmUsBOYcDUWVRfq+weiJc4uRPFcVVRc0vUEz95S1/Wk0MqloepEkLWGzvnr0jKWRUUXncR9NNybbeXwjAM0IBOg2cMdbEjZpZdQLMisBwPG0RNH55SBodoAQlvsjXYycvCI0SziDznRHPtqokpmATaZ5yhh5KjQrAZs005ly9xlrQ7MRsEkzjWk33iuSCcWmzTSmzpuXg1RCVMtTbNpMY/Kd+0ErIACkHEH/7xmZ/ujXVkJQt8kaKFOk/glGFkDnaIQOCXo/EluOgrSjOIzmBcD878HQjoj0eJ7O2auitKDntzQWAV4DQQcl4HxGjzyqHcVWi90LQOSfg6Ad0IDdFpsz+ssN7V1DY/ojfR8oyhVVYPPf6KRxSr9SgocZk+fknJNEUaYogKUvnEsn6Zy9ZXsPefrI59YGpAwF6je8cQrpLD2+lOJUWuKcM0cDdYJ2RdB53LvzSHO2O7q9ITPMUzfryvUBlVIK7PwRyWgssx0IbmBMW9t5968HSBtFl6sW0c1Z9vj2pM+zjNbG0xXJWWd3hgKKwW+RkWU7W9ZvB4JeT5PRzJhwj+Q9nSGCAZNpzvKNU/7THhTdj/qNJD/Y8SdaokiPvKcztPEptrKjxre6lgEBVrl88u/XD8AtCaNH3lGPsxjZ4cibULYEoGcToDu2uieLbr5Fv2m0jjkPLg/QAEgdRi5gwuj8+nVW0Pj3yh0BIFCsk7a2Xgn/sLFDSzQCKskzYwWdhyF0oP6CZUJdPUYsTFxFzaeuCC1LMXjS8gA63eHGwsHLIChb0O3zVw877vCHWTyNfw+AlgfFKWzrhcNj65FQdFCk/1dc1Brdi0bkvRDpCBQjvmIBjXy2jwg6Lmg66cdZ0xcUCo/8dmkoKqlAvyErXUorDuZ8dnkoKisK4I7C4Obkfb2gqHjQIbPohcCN5OfjAUUVcDSNRdDIBR8e1AMQVOUCj0XAOf/xTTsBiqoGnExLn5O3rgNABdVVrLvAPX12jUJUUG2RTk8ypi7yqSABWVQMbmb0Em5O0mK0tLj7XgjIpmKbZjKae2SinbaRaEYgWPUpY9vfr5pLj7eeefWz9LTMHInMQKHbP//N3JZn1sNZ9EXrA+stcCfdPA3GL7pAMgMFpPv6qwMBZ5PPdEGXiW5s64l4qz5LEEVbFcHRX815e8+uE2jRp//ONBovQkCmRVQFEKDbmnuP6FR/Dck7+m9/Sqtb7rnHnaHZKlNRMhwwqXXmocANrLZF81ozft8HUiMQDQIAXbfaf8WgDUf+Tq+CO0ma19oNUNS2KNqK4Dha5Zyc/PKkhaTXlMcdEGoMEA0CBN2wlV4p59T9e6LLJif/Rqsh4zd9IDVXWrHh4oq5tx4CCIDdZpjX0lFQ5F/kG/VBIVqHYxitVozf9hXJkdaKOY+CAoBow42k18zhUOSloOkHWmWcCzcoBUH9ObNpNWF8ubNIjtRNrJTxm96QEhDgv7MYa8DYMhSK/FS9s3Jfd28PEvDfvxgz5xb3hSJHA0a5VybyHpStWONjmmfLI2+FSp4IenxLq4hz4rZaDgKWvouMniGPvLuzCHJFNvqFXhE6W3eBlgGFHP0XaZkx8q5GCPJUMXQGnRU2TkAoByoY+jxplo3IxTc2QpGrgiW+oFWKvn0HIIq6Pb8nzbxq5pw6ARDkrGKtP90rZDwNWh6gQNOJP5KMXhWP5AdrQAR5K+jyFa1C5J4IHYEo0HTi10Za9Aq5Gfm/w7pBBfkjjfd75bapACAB6LHro/+QdIvmXpZbNJLNlw4AFHks6HwzrTLGM6EVAEQBDDn9hT9YMlq70UmydeIxAwEV5HPARvPdKxJ5h4aKAKICYIUx177x61yWPf+XZ07ZshugirxWWf5vVupRQCoDQBVtlxsy+uSL3n3//fff++iWEw8duTQABEV+K9aeXSHnjAubIJUCIEFRMtS1RVtRFeR5wP40VvxIaBUAiKgGRUkJQQU5L1J3U+Va7WFIdUpLSaQwYO/orLTxw86QDCRU5XJaxZzzN4IWCFFcVwUaD0coDqI4boGzGvsVCcXxkdW5v16kKCiOju6spttu0IKgWG8WjVU1Po2CKNL4GiOr9WMTtBAotlzsXiXngjULw1U0Vm3eiIIgeJixQN2fAZ87sii5tXLx0MLwsLV2yOkxWslIktPPaxApBIrrGaOX5zSWO+3d84ehKAqWeopkNPM2btFJTr35wje+mTz5m8fPH7VyHSBFAUDdQW+2suxbtjppdaC+W9eu3dBWFcVRgPrNz39pyuw2i35+ekIdAA0oGVQFhVICgLp+W0wYM2b8zksDCKqAlETOAwBWUDggwkgAAHCnAJ0BKqwA8AA+FQiDQSEGZ0FZBABRLYAarznP4DsOIq9X/HT9zP9n8jvCfNr2/+2/mn+3/+X/O/Gn/O9UfPvle+Zfrv+r/uv70/5D5hf5j/dewj9Cf9L/AfAF+n/+2/sf5U/P//reqP9u/xV+Af8+/wf/h/y/u3/5v9pPct/bf9F+2H93+QD+cf2//qe1V/v//n7i/+J/2v/39wL+Z/43/wezn/zP22+Cj+rf7H9tPgI/n39y/8n59f9j6AP+36gH/a9iL+Afvp3AH8u/C3v+/pH4kft56o/iXyL9I/rH+N/t/9p/6H+V+Bb+x/KDzB+bftH+n/NT3N/in2J+tf3L9hf7z/7P9j8Q/6L8lvOH33/w/5Y/3v9vfsF/D/5B/V/7t+yX9o/9n+v+lf2T/L/lz47Gn/4z/ZeoL6ofNP75/df2k/u37i+yx/K/lv7n/nH9t/w/9t/cf/T/YD/Gv5V/ev7J/hP9V/fv/r9Kf4z/O+NP9z/x3/L/1/wAfyH+ff4X/B/5j/X/4X/8f738S/4j/b/4//Qf8v/Kf/P3ifmP9t/2X+M/0P/M/w3/5/6f6Bfxj+X/3n+2f5P/Zf3f/8/7z7pfYf+zHsZfqn92f7xuUu5gCP8iMZmZS7WG3r+wNO8bOD7jL7/BsH0fTKiIXWpHRMEW9ggbuwKydT041sUeE63wecCmrIrulQB6Ia+Va8oWkvuP1kyeasszxv5kkeaXHk/PZSrhM+sBGNYRr+YfzH/2XcLWhNOTX5IKC19N3N4CPjI1n84DxDfVsN0CPm0Qf/5wtKGMQZJtOIaUxmn6Z3YIgmKC5s7JzIYZz7LHv52bAMja+OaQ5BQVskFM4qXp+fiBTK+l5PvoxvhdSmZXpAawrloolLy9dU6X4mfdCvx7AlgjU8/V2fM3Raf2udKdu6VwsXkfe72Vy12aeq4jq4I93KxU2FzWnqdIt5Dqf26eWsBMhaG41HRZPVMCMFw+slMaq11UP+yocJ7kb3Xobq/oXCTW+uVtlwz/LNYf+rMqXP/F2X/Grt+zxZLQK8dTSECiK2m/Mhodxmjyte+9D/+IGh5kHUbN3t3bhUIx0DGJ0/DAP33FpQtTpt4vtTpJdHCPNYtpCXagevcXRMeOZslDvv3SAwypdN5CJ1ZYd00inf9lM8qfS1NyQ//af6UHx+Wr1DgH/tc1ebeynpdM2D3FXW82opGtCpIDkVXyE5U+XoRnIToTJpW9X5OZov2mQbesNFFuXAgdUf/+xk0jcLJnDOVWU77nikeGPTer4f6skZJY4ZRVk+OtY6RhX95dS9lAlOLX6HbntJDjv4TqCa2O6TeqB90VSgEFsp3WaDcZZ7s07TlOQz6dXJ0K8zYxuUVVZD1HRIh/ERV85TykeWy3uEcxjj4KGg2hJg6sqcFsgoa9S5XQqoWBBGn2KnZpb5eaJZEJ7uYDwmN5UckxAQFG4OnJjWBewgxNMdqEjY/V1NlYJLXaEZ3MxNz57YJ/a+1d5lJwIYFUcXXauE9ZKUC97m7ExfeReQaH8iGc7eKKydGr8r273duJ+auPxL9weLQMyin/x5bMYioScLIOJ/ClsGhoGcFRNdtZucTfaqtUJuaoPvLYh+yfXja3DxrS9q/N4IbJU69l0RkO2yw6iFqF5+irnhu9m7PCUL3xzQRXBYMhzB8u8mg/vRvr4UsCiD2yAD1u0iyWs6mqrafi8HQ9l/KC6F1B+1xe9Ky+/vGqbAnR9uZ2xWqwawKd+7MYCKlljzFMeZSfT5am3vP5E2X4AbUmNTxsf4PJl2j42bfj7AAA/v/JoTDNWeM1jxaLjyu48rMotK6RWVz5VNeZBRg2p9OqM0k7yLeqp4ABzgjHSQhnaLpqRXOFB+uz6SvLghfaoar007MbLX43tG3AhL5G2WZtpy4+s4QvhVOohRcnXFER7b1OIrwz4y7h2VVOzxtrQGtch/s5AZlM4n96t57ZXKSd1B7e8o1y/4UVjmm1LZaFnMQzk9vu0pAEShW3hU9IcdvRFnv0O2dXZbO0N4EczbOIgdX1bieJRf57REbEAxkYtZq7jNFLv5hU18N+A66ZNnWoJPSdQi+jMw7DMXhiuKfF+XsJz7H9Nh/KyL+BJ6JI+gjyuiOWVcg2DcEgcXke/GzE6Eb/XkUxTytXXuhy2nJHVetcYN5f+dT02m7zDZpEj0jMgkekMifU0i8jbsH8hMBPMCg0GDMGjzJD8LLbdd2vBh8s/XnYHfOdCU0o1UimLsCuyzuwEITMZ+U2vHTHEil1PIvCdcL2vlmRiG2w9ZnB+gh8OoxMa91qt8ikv8a4uGo5zmIZqmEIJFlDibsh6fEJvbNe4hoXur80iDxEVyPC32BVqb3ywEoKBCb5PLgkhLJBBOmq9/ZbSe6bXhpHQrFVEV+0JPXYFO10RmPIbxlL9iqRzx52udDT5y5TSoBSexsVfAqzrlbpEVmzSnDuWQz3s0thPiG+rb07ELz2yXI9a1IAkOoukeKXIGhqm26SMvSrVMb/0LcAHYowqrsDw+569cPAKM/O7GhnzGhETrPxsLCRAMJJ5hjesqyQuAj23YVKnv/zrVWDLx0K6N3ihklZv8lxCJYxveabfRTrcY1dTFKumB73ePCJ7Wr2Qo6B5/M4/pvPG5LAw0N2/d1VMhhVD02j3pYX+9w++bmwureblCJHywBT/9VRHY5l/8rOLyGx6gNI99fpGfARIUUrt4TeRd6GY8fAAxOg/rfrz1X6fO/WNJlOGd4WnkLnqmqhtHLPXCOt91MNxqN1m1QqLsApKnBDVIyLRkSe7nXB30YWHM/zgtBD6LSjdKHndSyG2ItIlg2vm9kiheb8IkuPkE4f7HaCU93kVVTVBBhJlXFqARcQSinXRmG5mMlHACKlrnRgIBwMR83WeO7sRB8azVJQM/XwnZybQV1ecEACK1zvDWPN10m14z3amFaXa2DDIAk13OF5WhdfL3V0viqhPoS9gdn2eGfeh8iL8tizO9FcQzYRzAJyeJMvslbXscVgbRTF8GnewSa+sf5yO///ik5ubDwgWIre8bO3qQiOQNaeJBJO+q2NaJncIcwNsJnQAU4H1DR4xB8rVuNqv+2OvLwg3RRNKs6FxS6y6meOSG/4OmhXvyDmP/o8nq92OiR6iJb3GaGOFAmIVu33QSpZI0bAnyqebv4rWDfXMbpfXaN3Y2ixbJU1ayFPgNdVNXnODybRhW10MpTRJi5PeKAO+IHOGggNgjRAX5tOE7TxWy/aiwo57V7N/dZYyPujb/GU0uTRsvPK5rYk8lqAaCl1tQt+GMb/RKAOPjltFpFlsxI0QFp1XqiZAM0r21bzBRUC1M+3fCbBQZJFD+FrJRxECUdf6I9lBNs09y1aA032xeLbO3XJAl1UQ0r5eKukzkLBK0ECq7Rf3wB+RichlP8pdGWIWmr0DjV0VE3HAFplsccndYToi8GEs0DBhYOoICNUls8Yu+R+R5f6NA19OhdjUAKqSQJOyDhGMMZda9zsn8At6C/nC9VDEgWXzZmbcyrsjluvyNL0KvtCkAqPbLW2tYdTL7uLATBZAsqBCslZQSWb4ID7H6t11iflGuxgDP3pKlxiQdxRhKW9VUdNVy4TD97GKix/ROsYVqNU0PUfQT7J8TmGhpTrgilGovaOb3kLdcqw3kS2CFKeelFMfYyW1b5PKAGswPH9TcEKgDiz8wxiYPnNQiQ8OW/w3Px5VYoa+cL/JZjPVaIiQWSoLZ10R4/NAmub/BHI0J0hxcns6AInofli/JSR34tmj8E8fOJ17mNaQz1w4G8A0yi2tdtRzQhscIu3H/nOrOD8G4rl6Vg8leP5bVvqdR7SPn/z9HekbMOSbMM43Asy4SO8iJEPUxqidrg3XahxzoZO3LIIubokpfrQFcd4jjeJNqaHzcy136TYJPW5ONeVad+2+OlxA5u7G9IXnlGWT2rhviMkdWtVI9O02aIC1q7LJHIhNRfcVoK+kJC/TkNluwxNniOPEcpCzq8dwC9Xv1H9FvmYOf1ESQovfDo3LtUUHGsXo37BOkUFPN73R7BhNrG4h1Uqs9RF0zxqTlk7Bo0S9MZHdUIssRYitR7ZHEKgIwScDKJFKX3JeseS9SguqrOb3RKgYICWN/VfI35KlgJuksRnCJR6JMw//8cuhBzqNZ5LndaeIYfiGYVlNw0WXBdELDY/0tqgjVaTxseGOQPW0/3Xb6zuzvK2zcc4T+nNK8IiWEhHyyxcEitXIvyHn0BUGx5ziUAnkmjePw910Ho4jHWIipFO8uofmK7AsZhTcb0uGJ7a67VSoSQeRHQ34FvoyH/KD1tnrEBfx+SEi4S3ws5tXb9WrN7E4mAwBEhj7PXy7QlrXmJZasVfjq3IsgbN8gpc4KwEAvochxr+U0JTuW3Ab8osS0ZGE0+xIFlezUfjbD7lbJj5ObBXifEMT3wjXAQ3xkhF6LdQ7vTs1TkHD1GW5ERoxj71c2OGeBMyZXE0iEG/WPkxWPwpnykFHmQKhQZwTQOIstplxZ3BNVfYUHW9OqcPU+qzUJqE5zk8tFuQ341Wb1G+w+aL5T4/+LHQrJMfePCYvNWAJJhZEkA+xZpIJm3Xr1eRx0kPPIQNcdoIlt3WPwo8DBtLxg4oWpoCdtE7H4cApdBuTlI0CB7Wv973kXcNY/qlwsX+ldJeWYa7fJ1jjhjKOygSs8+rWud3sHC3Pfh3IUxCUw+oqV036pTsaAyTwZW6Nka5gqZYEJvQpjdKvZtw6XHVc2Uw0AZuvz/noCwGcNd44px8bZzlM/Yk/yd1ZydNduFcshK/fpB1bTGV+XguNVyOFDMvAf8SHR5LuLXX4XVKfps76n359x5km2O6wrDjUby0R/h+gz8yGvPcC6HTBS2wjDMh4+d2I8cl4FAC9ZdQVAJVbgBlkVCcA1oxGRUFbdF0M7FCKp4S4W3uzw5zsYtVzPQWBbuxGrtyVfLnc0DurF3h8uv3cs2OKoKnTDgjpkyzb5OeyKsklcIC9Z7hHFWa2cGq8JE9RO9CjcBgmmDT6EekKoGlwdEPMf7ZByZeSBtseDGbdiqtQJJr24UKfICniFBkdqXcGWXMrziF1BIsgHMLLQkoFlmbKL0w5M+W+eMdRzZrFdeJkPeSEAbQESht2utqERSAG/FNGAGjX8TXBnmHjhU1no1eqLGX3F+hyR/WGbi2cmnJEj7Gr7xd3kyqLAGtYQdybf+AxKPefuevg0OYrmjsxRW58DQSxD68q06DF7agcMjm6SoIDeYlIea9q4gmmN49o4OSSXXNI3Y+oN5XRmKjbvVs0hgEw0RHWUpIedl4gYFwV1+JtcBgwKeJ6bEPnLol0yhdpGHW8PRYg/uqkC3PowdYRwCWHgeWbXtNHTipMBeZWUie47vHtznzoYIoxVw9TngP7Vul3aCWxp2EhFNrRLOJKf3mIxzSxEdsocd4EFn4ODxQ7fbGrkuehYdFVWF0bMtO3BTs9r8Jp3exNrdFM7zCEbNmLanaPP0+/rPhivCKCsjc2obMELiGL+8bY3Q5hx1wTucyhDGXN08Y2tOxo7uVscfXqo86E8UIii+lLCgLgFSO5IRgZgcLxnuJdVRCn/sK5jd1HyclmUaMlBdBdoT+4LtLIG7/QIfGWyuMJxM2akp8lTinsW99Clm6EeMoPvm1rkfFQvurj6/exvuQ2UEVAPuO5IVqniMv3ROE9DgAJhfnUXiUnhWPCDenOwH6alasQ9LCmOF1k44p1ateKFeUfPQ4xdFFmO62T2nUZcElh3xXUdxhlCur3mGC+d8mDCpJwFrrNzlF+hfdAk6DyH+LIuKRFE9FzW4Acz0xb6UdI3C2OTO9YTXaOk0zwhwT9BuTM2zOjm5KRzIOM+VVlqxqAqPMUpbDujnrN6YuMLxU/1e1dfvLIs2IrcyIr5p1zcdnrWxGdeeKiZtduGqiMT9eEbQzFc1iZeFHn4188GW8tCtwq+PwyZ0Pekc2rqYTp5OMlK6HW58/pNo/vtbqnmnXeg94SWTccNQANET/ulObfiPfDIgq+4XmrkLxa169XFKKHv6iqVO0emnZOKH2XljrAGRY3qoVz9yJOrTyYeU1JiYwCYDyC0e9XbfCRuD4iDx/SptnFUsGFOKAo5Ztns/UDQffPDIWv/yF1SONhO+cu4wz6UqoBZmpTCqUIyYn7DPPhJ54YxTaY80wA67pr8hdnoZwYABZMZL//bN7WiE0Nka+jdoez5Sa5u50O3JUEecNWMYMccki9+vw8NV7ralhqzhcg5YurcF+FXkPepPDVIg33Uc+B29uhQGtCY4X/6MzXi+/MC+o4wCpjgcW/qOZmJOa1avU0d8MXtqHK8iQpWCH+3zReF9IewmdC0n2nfxB2ci9fZMyYfPX/uaR5j8RTep2DFKmQl8BsIwbqOxmYA1me1E+b7ry4/RnzmFfDQI7WLOMlDdnyLLqbFUwtfBuYYkGQLJKHJ1lfVVZnFzNuE7HLRfjBD+REuFo4C+mMURGAzZm9n9XEKzIXTqcFA7ySCHeYH1x/5c3CQwF/zfQxBNXDW24tpeKbS1l126/voWdno8PK4v0DqGuTu+cVsceuxS5OBLjB3mR8eRXSF/NBYTnJ+JWbQBO/BZhHPDzkHmV3VxpfJbUDDMIt+BkC3Y1m5fSv5LDR9PnbSynHs18EQkSPRCTlRQil6GeBmPkxNIFjbhTJPhY2Ql4s6PraDUdas+rYpKwXlEDmOmxaq29lfrHh7TTZfE0MxPsB0AFfgWjskvPX2zlbC40DlPiAQycsW8XcILrtMCR3BOvQEWl+ol3vIIcYFpsb9soKTvGN36vpHNvShqNkmsu578IZ5dUQgso0Iw+xbd0fpNX/0qJo8YXTKDG6Heyp/ks/Z4Mb/6iFSDuKAMCzTIXRPvh3voiJCBKEREdoCkkW/ZiFpXl4aOqNqRnIukzu/KUG0DUDKy9psQawQeEQhDKLvnTswX1eYJjkNPpORo6N+W+krzrXe+JvzmbKo28bvw3Q7eR8szSfto6h/WH3vOpSCyxq3VGyI0Bj1NcTlFQq8O6YZsJHInLaV3q8fwQbF/d0iJvlUHymhBCq/NKkjh0XDsZJTi25YYV3+fGqsXBSYTaOlmEoflvwS0spfjqfg2PzMalSk5Yfu7S9z5jQYRKq8N96RPUZRzykTYotm+t3se0RK0i+VqyspqzKnw1IZ83mCT6WZs1Z6R6aZX6EpVuLKoXWe64vuxmsD0QPUDalOCM+xqwcV03bsDBzYjHK1dLUOzMAokjBv54RwCyMFUmUpTnVLAq/f2pU22Q66NuAOwitV9gNPGbNmNbe+9MM1I/xcQcy9WJK99wEEuQ98OYHTzGVBYsHFjcKPz1iNliyeD/nEgqubu4YXosMfLKlChwhicvQcEx9wNpVxkvbJVqxWIThxP0XFTsLTFRhwb/wOFqzfFQg/waq3tyPQzFK99uFSRiDHmcQoZDPrR5qVNjLrQv+s1DeTz0fNd72AR3cYM9ZDUE2pvUdCWmt9yDekMpL/yFLGRKDxVOtWXoSxL7VpGB6dJ+MzgNfvEHWHEe2cLdZcsb+qt5Dne3hFA6PVDdBbqMUx/25RAayfxdvOceqKjLSTSUNjDpUvKe21q50WMMD/PJsu9jS75ZdkN4MtyjPHMGYlSMth5UgO/uFvFMuVX5QPTXNTub3GxRmXsb2gjt11z5EdQrGzgfPdbS2nnQagmSQqA5bpXBdRwOiVRu0WdquImuPaugybL0rAYZssQfKjM0U7tMFq6RnI2e9NGOc3vbAZk0WL1feIwqhMAsNJnuprP6sFcUgwM9pSMdYjiHpW/2Xx4guyVEMHwK5+knQrA77cf+/WjgZuFqppzq7aVF3YtpxlVJsvFdNcdP539/mtIHfMjOD89K2JzDyDvdyWBQPr/Yi9aWKneMJirMWBtofHOIqATAZeCHb/UDaT1Nq/0JKLY66ax+YSu2/oMe3efMMD7fgm5jJL91q5aqIddzRXm1Pt5z7zUgklFvxvL4awXEQYR0QrPJLugQHk2tOTG8bF5KRDXeMb3/0zV5U7jgpDvOKZh6qG2d6KzniYAos+lUpjcR8OsAwST9m4DqWhlqGm+ZIrH5htwaUTrmCc3y150wMaowq8gHQxFXuof+CRPwUs8eNJuC0ROERMERtvtnnnY4i/O7p+AadraG2eDWsapNsPYeHaaEJ3KnmClHBA0BmRyCugG9Sd9YrWFT+OBWkwJRIRiAHOYoA2Mq/7zDUSkyGa+b2xI/1Lv8GkVRrlQmK4X3PQRsxTAuyE7G5NIrdCkL2+MqwPEFFlthW8ZPpoDRMjjDLcSiM88Jbp6Hta/lvUn13DolQ8maP8thWh2oLVel21/T7BeRhqqMUsWJDBg+TdVvu0FJDBYy7OzZ/kXOd6gpaRQl75nKhsfLWmm5w4PdlOdHvxZynM4YpgkWqPQ8VWmNVFfnSShtWx1X5O9f6xGPPZZ+TUA/N8NauwC+w9+HZol3ipVvdvtDYYmwtBEoWuoFdZ5ylLGeZ6/LC6ZbnsTKD9DF0nDLmMu0nrgBaD4lPmD8SFu1czuSgU9XrrD4kfzN/jb9hTHGrVB7OPQJl0QN3dNOcLKvscLuycvaqUMJIWuyBh9nLOXBRngNBJ25C7/JSAkdrYiZGSmPMoR2g9EKQepOXoVZ75ELCEfnr294Mfp2r+uPQiJKUYOpFP01G/QH3bNQkzz6StivxzqzuWOdNvEXUxRZ91XPP7M8ND8RkFkFkDHxjEdgSFfkbXWCK9cuoO+eJH9l+zmkr0GfiO9/k3O5XgzLcCLcCkGZvfCmZ/qq6pm80nwQeX9FzhROnmIudUnVPUqWi/2fUlMqNFs0lauScMWenJUt60Z09gaxHEeKbMLjSFYgv0rlMfEo0BKp+NaKIAJ1LnRdjEqxxYS/KM6OxUaTw3fiABG6qs0d8A0/sSVrJ3v7F7HnXEwlBpr2fN6g5MTn5RZfayru9Q1GAalv6IES3QK2+ARzY26wQ8wkqSP1iCwUBnl1L2nZaw0myG9c/xKdr4x1yjljcfoGToB38WR0iHUjpjFuobHxu3QmvnZFRuJqgdv0sbssatb2U8Ms+c8beAOoTnS/5iougQ4j7yBsPaVRTzuRcKox1yQOv1Z3s1FDG0LuUtcGRwV8evO0v0IDx122XQaEEMePE/fCGGF6O/Bplxl+j7IKP0EbsI6iqmD44IFCIRUpOKSWbc5HC8rNX4gJ0xf8xDsaIWnYtfByBlDu4XaS7hNBo7yn81QmepYdI5kC6eu9zzjvkjra9ZRHYbvkvolw1uuzpj3CDlnuDGnZp6oJD0+3WEMLidwDLd2NGRY7zVtEvvidBTWpzcWxcg4sXtC4W13IhyHq61Y0M1+nymsyhco12dSeHpQHNwd8iFbpBMr/flr9RdP2XUkldLQNawn36Dyob9use062QQRAlWG/h2IP4JUDtarUgCQroflWewFbzLk0LtdN2W3iBFrD08M69bHxpO/B1S4ZnswZjtynkgFDVhk6cAlEcDjwCNI8Ho9muq2CL7BtUqqSDyiQhGJMNVH0IRCdm0XjeOyDxhEonHJOAMCI5xSSFYSBJtjPTCQVs0LdsuuYN0G2ks4+KS8kvkRSnbSPcmh80v0dSZ/tgdV6NNVNrL7NoJh2ph2nSclEJICBQ500cSKVimhp0w2IDeDLY5dwssyQAoflHmg16Iext8HGJxOvBEjgH/dc6B3YvaTmv6KnvVjJXV0qUXdWjdIrFFMLrJbIIsoz76LUAit+HN04llB1aMucl99RQQIpd5rMzKOMzJLu/tU9ulmHnMtrL8+rSGV3547gACBMEvIUlNJMHXfUb3UV1Bu2eGjJDOs5EkwP8qtoGZ19HiHfi9KZitxYFt3p78PX96ZiAT/naMTMaihzGAMnTIKRsdyVvUE8Hnz7j7EiRsubNfJXJC2TGTPLagIpokxCQho40kdJ6oiSB81ifnAgdNDHsTFlsLQS5PNcWrhWJdvEO58K6a1qahxAQbPfSrrk2Wv/jERsnTX15WRB+Dyxo3/DLTDaLYtgR9TA2zF1s5A4JV77mBW8AQgQjQNByIDNGDg9eLpPjq+dO38hhKsP1av6nctYsrdRGBjtO2M1/wrODzzEtEyWQ/cvRkR/LHIsInez6Un1/nsGxGB4y/jWaNPRfX35QGf5MVWkUA3yGIq5n3neboLZZfduD/OuITMjkac/SRTP6k9U1JoY9OnBzw1lFgESQoiPwC19AjrQc2CTIyi9765VWf3ucD78tyAUXXAIFV2WGhdtCyb1vWEDSuJd1GqRQGCiQYk7B2wIngTXCi3AWUtszdxCvHnwrRikpPiOCLs7NG7zEwo647qE8380R9AtKC/5zxIBIiTku3FGwgwI0mXRi64edhjqmY0mV/DomZ2LONWzsYnjKogFIP2lNb53eDTM5ShMsTrJL8S7GUSkFWEnEphiEKNUE4xFNqgfeE4c6F3QF1qGRhzaLlJlPGtrdy6WZnC2hXJZxfw08VYPdx2IzwUGkjXjB9HJ8j98gDRoVaAqmS7ZK6+6H/D3ahisn51Hva2EZxLp94YXaO0zVEgpf7sTmO6/ZQ3lm+Sx6TaOpntQ5LIeBeU7vR0WugLzbzFnUvDcVJ4pxw1mYC36uVEQ5cqdWGqjoJDzAFaN9Rl71X6HkThpJuBK8lR77I92gnoGEZHqacxP0P3dwZ/JNyVUOVZTE5iwF3+a6LUmsjino65W+Ha6FlxL85LdxuMav8R0s8K+a7JYgoNSibyABy1pvO7fN5nLLN+KXqKDEt66KL9Jts2jKrkTIUGPSz46VzTeF6aGx+G3vuFLLnL3pdDkqySw+Zcd5Ov/Yyhfl4+s67w0sObSLvdzy8EYoWgWWeA1eVRWuHlj3z1H1NuP7gmm2EKjNXRV2qVlNK0L3WvYmrBuRAGyyVLd8lRwvE0y5bn3MRGCJOKzgIwliMLxvwlDrt5MhevqPaCOpFI7WVZN+DjhOlCHSAt4vPM1wrEpBpGdTAklercrVpL1NNWO8QnO1Nk4jDZTEbg1e7d1f9ukAExx7XW3aMV8Kmm0k967AWbcDoSoKZzv8XGQv6XAuuOgasHWo258h2ovj+H+PLaYKpaiWFFo67KgkDxt05OElSDpCIhqp2rfQHlZcA0Za032n78nGatj2TWDYGOskCBa2D3rTggNSGcrcpTjAxZ2SqHzWdp8flkZOmNlxcTqCS1RFeDgPR+eJ/0+pER1zLrI4K9+KvIFb+4Y/GJGdTtCr4o2OMx92MqmMFv9S/9j9pbbyVFkCkowTeQzboKCtP5aTcPZFxbwAbfG5253pdeR46C+CA3RK7tOOH7T/PcdnDC6Nq/7YBz4LGf8WXoxgwDVq0W2eqwSGe7gsZNSpSB1GPCOGfFwHro8rDy/d8Mm1hNT6lnYlvJ/0sE0iPoDV3x+rLtwgxojJ7vYMfNQCfGYY2iGfboP7PKc6hooHENwH2DPe/3XrMQ8yCxmuwT/CyjW0dvyAGS5cE5zbxWH5wzefReD7mGikPEwbQNTabkVNngskR0ZHRRiKNDH0OlHaHE0rhl1twYAGrPWZXQfImKpK2sraZsVFBUX4o1YRLVjYCjtnrP+ImX6P2/4L9H/27yEYdtqLadb/D507B7mNbIDS3qPUto7STKNkq57PlgY8Vla4iliPFVryyCe6c7zf4gzPdTCd+gJJBLjRxufsoyMcM6MJeVAMJN64Q3Ew7GtEebucWK2dYQyF0VIczRol4ZW5FTR4AVAUv40/hJFSTcz8sxNTQ+7m8ubh+uFv6d9Y6xgmVX7clODQ7Uh4pyKDKU/3uFb5rYjwcpDpGFnJuWQy3uvzI/1lfBe29TbNCOOmqsK1P+36I0YmlCBh3SMdwNQt4N0u/9Zc0OWsXHIJW11+EqjUScdfHyIWJWIrKzYbXKEJA0sON8xRDHkOk9MFKLsRx9LnVoSZ21mBu6b9DXJeHy7hSOVIPZ9r6yGtq4hEARMvznXkqnZ+EYh4H5kv5fTfqZRFLokB/v+v3npUaAtajSd+E+ucOt9+eGwqgJQZLRR/O79O12sXDjfQ91gZnDQAYX7giEi97naX2z9Y62f+FqRbi7Oesosnkde5vPpyKYd8MiQ9tP+JCPJEMDQzF5bryFYbaepYEPwrznLPyvB8ou5m4zPjXbWJpUcF3EOfIAP0K4SF+Hq0vPVL2agQWUrmavi/z/4dTG+Kd7Cx3SXgnkMZh6OnC8LUeGVy+FkR32SlIWEvGgZZzbq/zZeF9xGA95jyOk6T2mCWd4pSK1iD3qsg/HwREOtx0dSKKNqQcs4mW8RiiLQtSJPOqSUSgD4BOtzBs09Kox9Wm4Muo5hlUzRhF+qAY0VtbR9ANF6MdveuyfHiLzprf1G+1vqiwSrHo5UrAyIpHb7gXYbAbPJXUcSEn6fEWtBpUTu6QyFSu5lHl1xSz9xkj2dYbt5vIqlEUbxtImWidffzSsVIOdDVDp4ZqT1cE4tZn/zCnha5Z9ipNUEyu90THPIGwf8Akl4bPhox5mGMNuHsqnccLVYDZ00yk4pG/9+yV7y5yZ1xCJv8nyA6U0JUZtjQydjdsePT+Jcc3RsKGQ7lJPTskB+/8qTltmdWZhQG1bQOSsWJFhk3PQg1XmCra4m/5OJtpMt4ZrGbJE2/UsaW497TmRReyrmCag9zltWFHovjj+p+eNv4dv5sgPfXp173ffKl1Iv7WbYhsee8Zpis3Q7s2Wvd0FZ65C1Jn7v3bsvhubPR+CCeoBzB2tboHVrxownmyCOSHHDYl0WXY5Osx+ckxYpYc4OyQZuXRZKt0ndCp+RIn+yJ4ogSPzboNrQZKQMml9ogzO0HYLuTGyyx18DnL0aWoI3zSJ7fxKCoh+Q1+bDXEWM9DmtX6xq2kpHNg3TzkxRFv+vN+n3DI2463C0FV3dlZjLWwQDw8g3wjsLcigDoRWPlDSTx61BxGkqImq2jwrzSrU/N/axHq8V6JfMWM0elso0h6oD4luYcpcXclfODVc+pYsKBsuMytAjFAv2AvR2lKU6sq0SriQ1jM7ZZOqEt6FgEb7lv5RW4jFcKqV1IlX47s8LEgweG3+n1BesaYB7FfO/+F5c3/3F64G24ddQgY9YdaUw/ZIdS3SxgZB7x28h2wi0b7cCTdEj6e2h06lTE/H8YT86Fu6HfCQT44LFfp2T849WZ3y+jIG/8sw/hobzx9JR9EhYYlaVN44nNxmhIqs70H3yaIynmyBYYZU44SbrKBfYfDQayFf9siKIhLnlXeZCBV1Wx/26/98fMvfRXreDnn6tWCw0cnxoizRw/hsPcortZt9TKu2WYAK56emqbCpYG05d4J1p1kYaUqIFB0tv9Rr5r4s5oxhgja9dSgDzni3ZJ7BqJu2fLedaDyMWkPQRkBoqA18vc69Oqu2GNivQuq7S95DVE0jl+WA2vltrEooPtIqxwUmZEePY59c/EOYnkK41876ZS7JXNRK3AAXcDFcBDQM1LSoop9wo+66fH9SyW6c3G/K7oh+Heqx7V9uCR+m8D1EnK12Fjluu4CVUllIP7/Ei+eMUbiyQInNmm64mvSqE74eoLfxp1fEhU2NTAMdSwffBocRnfLNafmUbOZ9T8xr+XdSjNqY3IiuGaFS8SSkgn7jXxve+TqkuonL2PbyJ9qmHcuhT3tSvwIOy8n5aFvuMPTnBFwC+vAehbeYZm+FZ6b6OZjsY6TEcaSxw3X6MU60JceKPTeocyHU8LGvWGV/QThZwqBulgkE7bOw/aGBOqNqwm/SCnYz6mnLC8cKNS8+sLrCR6j+aQmna3U2FVPNSDjEenWdC4NM7Qj616tgMA6QLpbnaKexpiCMotSIIbkouMnu24fNE++7xJONkXg//P4WVccZSN9ZUXaKj8SItmEx5cvFrZMnryltQ5HI8CgGpbgoD13SRGkdmmqVoWFPdLYjdIBuRDcUQFw2qrF9CW66zmtRYDL3aMhgKFduOamWPY/l0dUNbi9p1c5f666r4KohMmhmqnheaqEtRwc3WAJUSAj610Ug+U8EM++fHTGecV3DdIGzgYwzYtONiG5bQz0xm/wXUnNIyHexW25OBWFH6EW3lo0BbHp6W6dcgYxdOOSY1RGibItNynsQE1QZrS35xMLVaQiw6WBQIBEyg4beHua4i3jckxwenN4I+D/8fmqrKQOU7bqkcugDbbDBwwTSO4KFGWSyRi5vDJGyKi57gZ/Mdh8Oi4AYgtZpLqFlUpc/YeamCrsPcdeo9MkAh0Ad2wE3kNnqatKxsYQpEjciH8ME36D8CA5yX+HeyBjCmnNbDuMFQTAk0462p4I2FLRSgIkhoCJNgc4KmA0q9IwgjHpNs3Fpc2Gi3chgW2HMQZhU4gpii3q07g1Xif/d6XAn2mIMDHJbe6BjKHll1K1RnbHkbowjZ1NRxsTefl9UutZsUstcUcr1NHEmxpTEOkVPnotPAANSH+pwkFgatI37C2hxj5Ac/3iMCBgcb3g8wDyBxXGcj2FZX4CahpxS8CrpJIHxWs3t5PRZ6jxMHVtL59tz9pcTPDwGqAkVdJWg2oWp4juOqbleoiUr+uIhqf/3cMqkb+NNzEVNAxpDkS/4m4raRV72T7jeTNlLKSzIfrwRot9E0xscBhHbfgYOwBwoS92ZPgU9ygEozF68Rm0VCTTB0Mb+K3dLi7KT55jx9aM0rPjYIPtLHg2CA/e7ajwhN53MK+4iq0kky2m50eFasZPjGtMswaks9uVJMqlCR27AsvlldmG0SxAQI2oWcR9zWAcjHe4iSI8XTPFirokQ2n0aNQs9WQEJ93lKNdCEaUhkuFnYqIh6Sz4AeOwCJNaEJhLNd2QRIopBxdGcehQArep+w4CG9nYFDPK3inWwiXH0nFeVfB21/7aoQXtZvSM4yJgBSRPRhSUyib8nnbUKAgItyKoYyw/B3pVKVd6Jruqc/tHUm8yV0G+vO3pVnquAO8UsPxqn+rtMKETVGM3WSUoA8+a6zAsPGCTyqvlnvEBoqyS3z77R0CjL/24cvuO5v5e/+vagrsfQOzazroaSZ3KDIC67ot5tAq0CPIJeTVCLWE72BkoHHCBU6Gq1BhlJxbikRTcPq8lzinzoLkfbfG3wz30dYdv/VAUe8H9nMDB/cMuiKWRgoJU75arCnvK8CIqie+WkN5gDQDPkDDr6L/4p+avMGgm8V6A38qoQGSttAK3FB8JC5t2U9I4DJFKboH7ENuE2fuyolYrgyAEFe/ZmNWiiuwlR4W0DUduTuUYiYqU71qSqjEJFyr9NqILAyBZ9VIQfaNI/+9aAmAKGzbNBFtkms7K+FeOYy0xY7Vs3yZwsSyS83KGqEhF8oqqVZQuT0BFGdmE5RCYdoIQNNvyu9rpyV0AGbPt1tlXz4u7KdzbUm8QYTi1UWkQJMJ7jho96G+XM78nMsOQmCRihHNUlK6+xl2zLPL1lryeuQ0xNEmTDAHnzwVJCeVp/COHdO3APtIyFVj7MSF0FG6Th8dabtEX+bUjgO7UNfP2w4EYptQrAq3BI95CFG5RukVKepWlQoUff22jT/zhPTgtuG/fb570hQ+5MPgZq14IwRIbUWQEv+9bNSKmD+qNQW6zKI24F7qDz1M1nYDHMebnPLcXb5CMG6pEwL1+X+R9gQP+arxQV+zdnTBIK7gARnlsxhGgjuWzVQTysU8EMSyPtYtYTnpIcIU4frGKx8RRnxFmbWDM84ljmATZPpB/uf2+0EjCo1gmv3bsqw7Y1la+bsDJXqUSjl0upagI8EFN4HHd4v9BNdVR0UqnnBWtburQp45aSJCvPE6Nen4Ch+7wtC5B4SbiVYPk8gNzn/AvSfIfMmA+zM3mdczLLgjsfoS3OQA0L9lfSodRAtZ9zgTr+IKOJZfXHdy83NPIZNjpFcB2Jf+gtl8kdUUfWDfWrH+EsB+GDO9UJHfiyD1ddt2sS9lUzd610i0qbBOTlu1NAfM//J2pQVXVi+vyRi4f1+43bQS2HqcKkpv01OPGV9tKUxLerycu4n/FN1bMw37sbgvnjtWT5xE15sWT6YkavYR8tuFLqRcE/t/Nq3bU23oT9mpgBC10WxB/svaxmfJzTtgmqHj1iMBLvlR9K+0p77oQXHKovqRgKh82rxn4IDI0Qe5QH7VSEEyThssk4HoNAgo6UxtCTKe4SG+5tYSF1BVbfmCXaAOjbS+FWnl7NICm7InuT/BCWfEAvPHkpLpc4RpPDsdUorykRJe/ZxGuSyySJQIRgdkkzqMQsCI+kGDoECnIJ4k+C97H8lApfDXmQ/iHlcoZ7+MS783QJQHwjnSqqkhuafd3zdQ583tRgAYkKH3HQPsHHh3aSPRYyVlw3Rp4ttSX0CUQErGdrnPjxN249HMUgjiEpgMAiTqgLaOr6134KMSSezgZhmn4PWdG9Q/ZPXRSLrK+a7DD70QfLfvHCfd9yVBX1iovmDNTf8+RjSHGbLDFS0fMNKx7Au8YNlSUafmM6WcXgWAuGrDlu+RM1MiInkBTSE1U2S8SBqZNhK5ic+QlyIwbND+REsKGLZkMH16LYbXybwmRnRIN5vMdStmRRjnmDZ2GPxivvy6kpyqZ4WqxrR9AyKHl1qNMcQ18lcSVEQ02XRD3lUShSoMMBjLoL7eCmH4HtRlFy26jKLTu2RRbGVCXX519bWDJqoKDS+dQpIUF/e4GyD+hLeM2i+3BiAgd6scS3YiD9Qx+PfgMcoHT4amkUeYMG51qXrp9ZdP35FMZ80EjT0k0/wT2Ug0BiKicsHC+PaDAqqwEerGjGksCA1y6a7Khst0SCm5VH4P9APWu+gPYxHhWtelSFE6JfSDee8cS7IHxCxKNuJfm1fJEwbzfwR2H2TU4Dr2uKHkzAPlm0aZI/FilAA4Cf/aI5LTSUebE/l/Ck4ASNJOB9DtQ7UBV3QDF98eFWYCPk2TsNgUEoO5dOI6Z0enpa7WwplPNXhDmn+oiV7kmtFP+aDM26RXmrpCkbWyjiNeJ3Yu6MWoPV4EL7uJe2KQqZxkV2jmQe0SAOHRT0czjLjGFGnhZTrc+6v0Ibi14Wh3bp9YqUfIcryLvglsJWuhQX5t2ZlC7I91gCeVAuB5c6KYvI+DtyI/fl6Bj/wxYsOojr/TmazKa18/HFnsvko96vlcL3HnSeU2ZjtaOonlN0SjY46aSUAD+qsmGovbxZo+1fUW0Txd15k9d7E+UPyDnbCyrBh63vB0RUyIZU4qe5+9XkOWSXldFebrcadoSEkPU3QoQxTdN3Dba74vEaw0vdlViu3b0h49vIRq9vwzdhkqqyK3dMiJtZnYFTyQewDbrcwy3QPCuuqmP5elupcpeeJwVLRZK7IqDagiQaq9loobKTp7nTp0hSAAnJ0DNNSyQAEl/HvFuh19d664zDWyznbPJ8zgnFv5mq1ee/DoHPjUfeN21mj6HYI06vTVYxABPmtyr3FOKa0svb6isbt2YHo7woj/aTK3DpxZqomomgOdXSIVDJBMDVDn5YXLY4knVObjFezqwYlyTPsmYNMuI0/p0o/e+hKtXMpbGuOvy2j7+f3CBqvqN1YeFB174kGRKa1FRWltH7OueIZ8WGzH899e3PReWLHnYN1mvY44OPRbdRHxjZsrFmgkyNgJMoqlTtij/KVseDJIpWLDE+4NbcGboMpRyhM6FIi8UJf07fXgcz/qpLVIBiICdT74YAKWOM6ut13lsFAj+eLioIEr8Ies2zsZeWd3nEUjbJ4MpPLVAIejiCYQmfvQFVKBCuS8u7YPSguZu88UfP2Wx2o4h2L/i67ZPl2Oc2t03xCWD4nRhm1OuuFkdHghsbnJJpPhhZltB+wFfhY5S3NfHWBgufo+yGKwExwZdW32VNtpLx97B7QgZQlJEsq4hEHVXN60TQwP38Hi1D0YwymgQXYKFefYCpgPUky2Bqt0lT8yqREMZQpsg/iHiGR8Cq2zVkH69bg9O8UXkDtiMHsBw9x/KowpdlXrSKa/GnGGmGfC1bXNg7t1qlFPEkXabKabrCtvpjTOCXzStY6hP6fZxV9nEvmt5Q4Sl8Jn2MFKqjWqe309ewQUXVoauY3ujaPG8AI0CkqKJsqVf93JOX03LszhdgpyhepEqjCRJpvpLgRC9rTrrJPMM5LiG/XX7IUbBwFoTNcSLDZdf2wvNLzdCYB9Hp1VQ6jTMeHk5UMqSu751drK7QoIkygKcVYTOj/U7AO4bciW2pc2AoOiwC+Aru8EJB+hj3/PqiHAxm5NQvisLLDIqGLeJl0IzoMjUhpd7Eg4W+7NGh9H3NgaKe0KbAUa9VAtytDlZgEp5bV1NSSYyz0mfV6mLcnYEUOMFr4wGG4tJmw8bcPv+jxTqL0eBtgJ8tBhwvjXjOSZkaSfhfcI3a0WD6cPovqJDOPsw082tgThzQps22llboiMf66Bv3+lUM2SAQUXAE05hgdOajmgSdRhK8Sw5gsJgIWBpUOwmhZ9ku3F9YlAS4OUHaRTHg2h//Z3dV/fJOmbX8waXKy9Q1UAPQzGl6DSWajcrcxFjErm1edPgUtiFJmFog4KQwnzzdWJ9irkan2g55VPStXhtatQyRPjV6kX1wq8w3cD04RXFQeswmvlSWigd4Dyq2i//ktVQ5ULaGWweFDhEgpVkvXDvRm+XvuPBv/FobfLC2FR3MbmRw3LY6syvoYypdsfpTuEWkfcCQWGGrMdMkRWObxYswp1/TI/ux7KHVkC5hgxXMj69ismCPNUidBlLO9gdB4SQiBCsz+UWgl7UjkC0spArfQiUofxl2Ix1MFtyQray1r8kKCwtFPyMuq/yCv3yvpMUyNjJJ5JxP0BToCV8+hP0uqfd1XTnyBxI2xJlkolidrLLo/Z+lhjVqviYpEcSqQFIeNb+IZHPLIXtWY/MqH4xff093QILaxtIvGFdFyb0BQ1BHzyK3AHBi9NkGtDTE5iLQ00u1c7ivHIOTABdhnA1FAld7UXootxQj9QiS1XTI9VpQCbNNzEkz1GPZRYbWuYcxtNwykoUkLSbQvHSbHgg62Gq6U7yp+7E2xu5SMPRAZ21uduuSyE3ZOuOo8hHCcSJ5IIk3/hCjlhAvG50tzGNDwoBBUW6V1lT7FAHy04ygMUtkIOsoYCMUKFaOMwuS/NYPw/ulbH0riiX3xK2h3KcG43esxCtc5f5CfwDOukD+0GTPepxDEsEMYzVCq7qFdIWEta2WL7sQ861r81g2gbEZ85yq5SDZwTCGAbSE+6XpRSQ7fKk2mteYNcsAfBBDt9fzSBMWlvN4snohVjv9LkWthTzKMNHCtyEbaVnWd+H1YUR4iJjiQsAk2CxtQsCbDHAHGsGuOt9Nt23aCGGeMYQE+YI2w2iBcyusRQh8zRxc75b72EJb18P+FXPuVhtu49eZ9ksuUIA4Qzka7K6TY7iZ7d8xp+lnouZj5cVmN4vXF+u0z0JZF0v2rifWJHMwkpulsd8ENS6jV4qWxS3Phkg9WJcns0eY3MRfJItKw7kWqfunQF0rWjtsLCEqillSGNjwRATYX0nsLsoluJ2W1wY/vWImDyqkrIz4rnmHrVw7iPva4SfM8JfQDKhm38m3F020tqk302uEumQZf56pEwDY7bYhGD2BviUHvYWrbEwSfMfqx1AoKQcj3NVwpw+8YM0E7nj46YatzTqHLjli7U9HdkLl2OeTQHa2ajdnWWC6WzREL8iS1NxbSG1Gp8hM723SZsmREvkyG5gIbMT2PsLS5UwTF5W2vjngm/9PCI1ymgUJbkejrj4ylcolH0TbuQfUO6RG+sNBNfS2y3evbFUXKCYjznjuv5a4HeE7eQq2RzVCUvDbp84m3kffEc6TgZMmaaI7EuYlCyxldjoBKSraszXRvdDTkWLt2Xr7VoOlufpw3Bh3WV19gM058kuv6Srnx5ritmUIw9Yb09PHb6EuKtWz6pbaHqGgEYJMPXC+FQ++pnFrK6w52YxqHB2fa2jtW5A1EeYKrZvfAn2En+BpgWNtYWwabu6a5E8IGvnopBtCqpLkIZF7PQPCyLYElep8gXC1z+Usg42qCT3RPRHaneuPF62MPweQDrBHk+If6dt1UOdroqofLB8nm3ZT3BINrTwjCkgkrvtSRxa9rAFCq9X8Dls6xZ9re00nON08laA1OSXUVh+zaDOViu4/xUjjUskJdCfDBZICOyNHWGqOGwSSOlC2WvigPpUIJ0GmwhItqIqnno0WgcFwQxQzaSk2Fuq7kPIey8Cb3pRn+m3XTdeap6nQAfy2H1mGTY2iadFztBC8XKClB2Q6g5oxkNAHncyx3hxnIu9+gIbN5z8XmVH9pnUSOAugB6ZEJBLgYH02jfjb35j67lXoYp7zNheXQgPfAsXI+6v5rI89lwqO1+l/YKKxrL4Pyc/86ZDUroGt9nh/7wkmVwBaEDQmX2tEc9k2A2MNxW0KGtXXJDEahFK5h4Sr3qsEFXu5vEn3lKZV1nIbBicriSIGBKlm1wgOxlNRX8xxwiS7Yuxj2J5CU2yAKQ0dy94KSRu97A3QGBwwa73tcZU6YHrN3t4E2DSW5bIfvGjYAgkpW6WJwgJsL/lTARmchb4qE60ThnFSFWjDi2pWq9/GcM42gl+H6lMZNepDdHfbBbF06WQlF2TzI1KfIVj+3stBo+F50ehky0kF6BcNy6GYoSk0bMC0KfBpj+4t2vjR3WVxp2mw9q+v3GF1R3I/Sewt5oKoQvQ3r2b1qfzNSvscMwvs+k0sgJ6s26PRm5NILkMlzWW+9rdF2/FbM+p7s7VAgbM7hB+SJw8U5tPq+LwXQfEm6jMjr0jgrBDjQD2XTh/afBHxvjA7XiWkaR9EgRvzmSjxVbbFBEO8rISF6QOGIp6XAe2uh5Q6cQOoSaeV6PdR/aMh6LmosOjy62vA8v0RM3tQLPWktYOjIMMqFS0pubfYdJxV+zmxNfY3S5G90OUD7Blu1E+oj+3GK5LbUODntf/miGaCXfN/ic7PraqVon0uNRvv0DgYXaKNUy3nx2Btz/P6KhFQcvsZNxF2yo5e09Vq5eC+N42587bmqoKgD+vx6yJkvD/MDhhxnDHKLI0aJ+ZA+o8mCTfGsOWW7kNvxPULrQjqx1e9LVDq/Dr/hhK0HRvMaI4pjN7BF4ftkPRdvAYfgPenChXDV38gJ7GJRFD+ei90iEDreO7HqAyfFrZmAcbWVVRUeFbc6qHUwSrlqe5L8tFIs4IiLBuiuzI0s7NhSkD+UDUm7jjei5FITINyNX4LqhBjh1FXXcJ9a00Sy+DgSxW02jW9knyZGvbo6s4rJ60E7uj05FEYZDdYm0qfteXQxHr2CMFJ8SXyBRKSpV6g82pHZwNUXnfuFn5EbkGWSz2By5NBpzKhP3q80Hvl08FwusYfgUMrnebKGBSHHtkcEyX6B68+MKUgMgODWb0wyw0p0gHECnF1aW9CSeVOtTkR3IL3vJCwFMa3217UywaxKbC7/vDOpWGgP3rahnlY3sP/1pvEGKBAGFLvkHryVUflTudv2fDbRCuTx0AWNIAELpQgqwec6Q9KW8WKCg4EqEANQqdcRkIDK1ndnMt4Un6+tnjFkir/jnOmnJP6k3O1bzSE4kjQLk8cjRGrrZcRy1+v4h13iry4j7nnrfP5eQXV4VnM8bV4moUEy21hXiYfT7084QyZ9BKxsP+f0o/4k6dSjmvHpWX19FE/PsqlajOg19oxdWewboTLbtreb6wb5YaEl1YJuTPoU9Wfnm8l6oDRiKpi4v93p4Akg4NdOBY5UcceW+rtki97A3FY2e8N8BwZ4yRb9oGbREb1s+3XpBe1MXa8UtHyqMqPv7vWEUnWsmh+5voij57Yph4Y/KSmSPIbBaOwgBvTPcKyoQDMt/OxmYXY5uxpF7W0Dyjw0PyxuQhs9TlOuFTP1tlnu2Ku8fskxHtqM2AWgqUij9qXDlQqA/LAM7ae4ZZgPG3Dx+4xYPddRu7BcBzIQX0zZnJqEfEUdTIH9ehwDp+KmwCuUMnymInEIkVra3YScCGwaaannoe8JgOLw+nc78VFblUSE31CsEw/U7XiF5WVliOTHV8cBm3f+l5ozoSk2cqfQWe4j3npg2CdpUYiwlK9vvVNWjtyJDhjZO7UZe6Vc3J5IQ5x81S7x4+FShLMxm8N7cgVpdkwU8yY9kg8RImRmNKt6yRPy2wPO7tqONa4ZRkygTEKwpQOxMxqqL4PPCQWPjrAXRMuo93DFA70UycyXe/flI4pZJjYFr1humWC4P03HYRwZTb5zk+PptRMDoNycyrhqIt+tk3wppPS9xnsris/uxcI+PXMM9KUBZxC+wnMfTOsjGW6AItxo2SkPsu6RaMTH1yXveCgOBBxM9n9CBkKmRd8JKXtr3WkPL38X9AqvF3UJhL6cQUQvCuuIFJKoQB35nGXglgV2mJkHdDks5cksiwEz4zDrZ9EjR59MfldeZXPSepIG+2ftBAgtlrwGAj7mSWU/ca4GBX8ASOn2NLgDAzG6EdWSUDfKDwY4kiVO50FjP9WCmp+lHaSNSOdHwlIxP300WqY2q0Sw26EuiGpkLFlTSr2HKGQvmD2ZfpprpLEWVhTJ5p9aGxBe4ksNEh28aQyf24bkbB0wdajVrLEZ9r1tqBEJX5aCkXeA99ZAelXl4FrWWYFsD846J5b+Nxxyy1f4g9BzaTinaBfmNtfPNUl1hZjtn2qDzXXzZyVtf1apFJimgCO4yPtr6lv2sGsM9kgqGLng9dVBYBcx51dPA2+t5CS678EOL2cPONlWBpxpyUnL7eum4qTpstNSXCJ/F+F+WxnNte6hO03JQ/QS5YDuI2gWmL0igywZqqyzeGL52wWUFiMpBJbuUVrSn7AEbtWtXd9otihu0Cs1fBuw5dywEnUxepRKPGGYdSFwo8HZFTIlNpgwHQhtNbTnxywjbtyvSgHX7PNHoCB97rDyQxL6fUy1n7HIauN03ebnw5q/Q4nWTUoYiXpRXX4ZhfCDWAnjV6Cw8eIeU0urTyEmvQsAAAY7lPDu3SZdxtAjL/CgsScjLQSR2iDVtbFfEQ6xngXdQzVN99bNnMQ7x/aTBgm7hLPcLQp5uEE7bCCjLdCq9fJW8/fq5WG07VCub0eTev9Nw05adNYr4h9luPPUDQ7DU+RowMjhpOljmQygWyA1gLZUcdD/h269xFL92FlCcaSqLsPksYiNveCHnFbfDvcwzOhi0J/rrNIh7wq5OtQ0rgHY6Wynk8QlmF49kkukcIzKB1RKDn8VwIKRd9iVJuy3UKADrVgop/+n+nrrMaNPKMTIRfSjj0++eDk2hEeKnfbpBWpNcLwJxJZT4Rj7z1IOn6kCyifrOBDP/6tDtbt0b8LU6AaEX9FVm6Nbgo0NzYTcboq+YjIrJiwc/U/yVPv41GNwteOKUJMLq48iMkHqi5Weq5rvepriu5ryqzFv4FX4pZqFML6ZACaIBYfhR5oMphDT4wxvidkMfmJEblVtI329Y8D0mvCIN0hErSwLZNATivchgMRDc2uNHLIBnpke+ruDH7BgHgXyUgOJNy4y0ehVc2uBJc53TRwF9jwbXproqhZQ9doU6F3RBVSTHdTQ8n5r48CwKyPJRQStMh2F76didc+dIRm8Cxy+spoXTTjjSW3qaowkOQ6DjmhZy8e4MgeHXnBbXaqKZ9P5ljLaXigx3UKpJf2qUL+MgJef3R/sB3Tdz0hywX30vR32tonyhE+lFmWlSM9gTJRIhkPkwVCkqudBHN+IjrhbRHP8vDZFzAauFlKEM0TQpu1mo7hibkfZzTgQXwvDxDSwIiO5L7pfAMUTAjKL2ShlHLgPIqnffyNaGtiVG+KsixrBqjWI0spVJ2/BLvlqD3ZT5mmVbBcgNf2UK/JoS4y+Hq3L/EZYt5eQeL10Ogmt/cVe2iGzG65QoqTqs/g2/mhnE29l5vW6NGKZqBTapXJ/sfTEynfbdsLLQP11+XvidSTjggWSLjj1UoDwtInsFTs1vNfmGzdw4BvGwApwzESuFZ/2+LY/MieNvI4m5wX+YOSUGCWidJMw0e0O53Sbol6Q5PPgerRwLhn9ikjd7yFHfD+d5VzYdFhuUac1QjmY3NvVNrclraDErmhtiKx0yyGym1kwzyxKAV5dAWuLkdYOlVJ4HS3/miabezm3QSweNB5Y7V/EskuPVLprrzJjMxYLAOsAM/+E4emt3KOZjRuguT4Goj2V+g3+CTSvrj8PfLq3QqgdFRySXL3YXlptIRAbX2f1aME90dg4w1m5Cnu+BXL83uZGJXxcbvxF2gRxIu3RuzVj0GMVnpWMP8Ec2UkKvIM+0PDrJ7GqaGM1TSWJxuUlQZtUAT0F+ggFy1LqEy+ZIYG5ukKJX4225XAepg6aq5r2+sEgZrEzs8Qk3kxaN0mBBSHhcOnUsEI/25aiEOXhZzlw8URDoUdufY6r/uWnHgxrMAbqVKd3FRNeyPJuoPCiaKQE37Uy9tkYB/kYllpXLkM0JbHO+LmBeACIEctGCG59W4NbX1twOsvwZqrbwL7z98tV9rBcinvlBY+NA8zpnmdH3u8iMQ69oRyDEYOWpqcF9O7982U2wgUWimxGRKwr0adN7t0AXRClZbMXGg8tmu1+cGKx6Hiy1QmatwxQZ9O/sJ5rgDQmYh68MeiDV+7CQqlizXFoLOg9URYtofOTjpCtN46WS4uspaY+86AXqFb8+0HoxnH8fBJL/3kCb2OKF6g8mP3jp4GkoE4TpYiY2gsmtsv3VC3h4w+kau5XX7HZwxw1Z42WnrNfAm4L+YKLIi+159ghyNdcp6Fe4SPyygqc8NHxce250zM38qGolPt1wLGB+QzmkEMSRjkbJooGq2mn/JscO/ZqiANgAAAAAAAA'
    const GIRL_GAME_SRC = 'data:image/webp;base64,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'
    const GIRL_WORK1_SRC = 'data:image/webp;base64,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'
    const GIRL_WORK2_SRC = 'data:image/webp;base64,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'
    const GIRL_SLACK1_SRC = 'data:image/webp;base64,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'
    const GIRL_SLACK2_SRC = 'data:image/webp;base64,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'
    const GIRL_GAME1_SRC = 'data:image/webp;base64,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'
    const GIRL_GAME2_SRC = 'data:image/webp;base64,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'
    const GIRL_SPRITE_SRC = {
      front: GIRL_FRONT_SRC,
      side: GIRL_SIDE_SRC,
      stand: GIRL_STAND_SRC,
      happy: GIRL_HAPPY_SRC,
      rest: GIRL_REST_SRC,
      slack: GIRL_SLACK_SRC,
      game: GIRL_GAME_SRC,
      work1: GIRL_WORK1_SRC,
      work2: GIRL_WORK2_SRC,
      slack1: GIRL_SLACK1_SRC,
      slack2: GIRL_SLACK2_SRC,
      game1: GIRL_GAME1_SRC,
      game2: GIRL_GAME2_SRC,
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
    let girlSpritesPending = Object.keys(GIRL_SPRITE_SRC).length
    let girlSpritesSettled = false
    function markGirlPoseSettled() {
      girlSpritesPending = Math.max(0, girlSpritesPending - 1)
      if (girlSpritesPending === 0) girlSpritesSettled = true
    }
    function ensureGirlSprites() {
      // Retry any pose that is not decoded yet; each pose is loaded at most once at
      // a time. A failed data URL is remembered so a broken asset cannot re-decode
      // 60 times per second forever.
      if (typeof Image === 'undefined') {
        girlSpritesSettled = true
        return
      }
      for (const pose of Object.keys(GIRL_SPRITE_SRC)) {
        if (girlPoseData[pose] || girlLoadingPoses.has(pose) || girlPoseFailed.has(pose)) continue
        girlLoadingPoses.add(pose)
        const finish = () => {
          girlLoadingPoses.delete(pose)
          markGirlPoseSettled()
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
      if (mode === 'slack') return 'slack'
      if (mode === 'game') return 'game'
      return 'front'
    }
    function girlSpriteFor(mode, color, frame) {
      ensureGirlSprites()
      let pose = girlPoseFor(mode)
      if (mode === 'busy') {
        // Two clean transparent keyframes make the working pose breathe without
        // pulling the whole generated action GIF into the canvas.
        const has1 = Boolean(girlPoseData.work1)
        const has2 = Boolean(girlPoseData.work2)
        pose = has1 || has2 ? (frame && has2 ? 'work2' : has1 ? 'work1' : 'work2') : 'stand'
      } else if (mode === 'slack' || mode === 'game') {
        const has1 = Boolean(girlPoseData[mode + '1'])
        const has2 = Boolean(girlPoseData[mode + '2'])
        pose = has1 || has2 ? (frame && has2 ? mode + '2' : has1 ? mode + '1' : mode + '2') : girlPoseFor(mode)
      }
      // Never draw the old procedural character as a placeholder. While the
      // embedded WebP data URLs decode, the unit is simply skipped for a frame or
      // two; once decoding settles, a failed pose may reuse the front sprite.
      const sourcePose = girlPoseData[pose] ? pose : girlSpritesSettled && girlPoseData.front ? 'front' : null
      if (!sourcePose) return null
      const base = girlPoseData[sourcePose]
      const targetHue = girlHue(color)
      const key = sourcePose + '|' + Math.round(targetHue)
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
      const actionFrame = !reduced && (mode === 'busy' || mode === 'slack' || mode === 'game')
        ? Math.floor(now / 360 + seed * 11) % 2
        : 0
      const sprite = girlSpriteFor(mode, color, actionFrame)
      if (!sprite) return
      const busy = mode === 'busy'
      const idle = mode === 'idle'
      const error = mode === 'error'
      const walk = mode === 'walk'
      const talk = mode === 'talk'
      const slack = mode === 'slack'
      const game = mode === 'game'
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
              : slack
                ? Math.sin(now / 1700 + seed) * 0.008
                : game
                  ? Math.sin(now / 240 + seed) * 0.014
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
                : slack
                  ? Math.sin(now / 1900 + seed) * H * 0.003
                  : game
                    ? Math.abs(Math.sin(now / 210 + seed)) * H * 0.012
                    : 0
      const sway = reduced
        ? 0
        : idle
          ? Math.sin(now / 1600 + seed) * H * 0.004
          : walk
            ? Math.sin(now / 250 + seed) * H * 0.004
            : slack
              ? Math.sin(now / 1800 + seed) * H * 0.006
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
      if ((slack || game) && !reduced) {
        const drift = (now / 1400 + seed) % 1
        context.fillStyle = slack ? 'rgba(170,170,190,0.85)' : 'rgba(255,255,85,0.9)'
        context.font = Math.max(8, Math.round(10 * u)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.textAlign = 'center'
        context.fillText(slack ? '…' : '♪', dx + drawW * 0.9, dy + drawH * 0.2 - drift * 4)
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

    function startStage(canvas, readState, onPick, onHover) {
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
      let lastFrame = 0
      const idleFrameInterval = 1000 / 20
      const activeFrameInterval = 1000 / 30
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
      let hoverAreaId = null
      const agentLastState = new Map()
      const agentCelebrateUntil = new Map()
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
        const nextDpr = Math.min(1.25, window.devicePixelRatio || 1)
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
        if (state.paused) return
        const now = performance.now()
        // The office is ambient: active work gets 30fps, an idle room 20fps.
        // This keeps motion readable without the old full-rate DOM cost.
        const active = !reduceMotion && (state.agents || []).some((agent) => agent.state === 'run' || agent.state === 'wait')
        const frameInterval = reduceMotion ? 1000 / 10 : active ? activeFrameInterval : idleFrameInterval
        if (now - lastFrame < frameInterval) return
        lastFrame = now
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
        const hudRow = state.hud ? Math.min(140, Math.max(96, height * 0.18)) + 10 : 0
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
        const topologyEdges = (state.topology && state.topology.edges) || []
        const liveForChief = agents.filter((agent) => !agent.held)
        const parentIds = new Set(topologyEdges.map((edge) => edge.from))
        const childIds = new Set(topologyEdges.map((edge) => edge.to))
        const supervisorAgent = liveForChief.find((agent) => parentIds.has(agent.id) && !childIds.has(agent.id)) || null
        const totals = state.totals || {}
        const history = state.history || []
        const toolStats = state.toolStats || []
        const hover = state.hover && agents.some((agent) => agent.id === state.hover) ? state.hover : null
        const hoverIds = new Set(hover ? [hover] : [])
        if (hover) {
          for (const edge of (state.topology && state.topology.edges) || []) {
            if (edge.from === hover) hoverIds.add(edge.to)
            else if (edge.to === hover) hoverIds.add(edge.from)
          }
        }
        const legendFilter = state.legendFilter || null
        for (const agent of agents) {
          const previous = agentLastState.get(agent.id)
          if (previous === 'run' && agent.state !== 'run' && !reduceMotion) {
            agentCelebrateUntil.set(agent.id, now + 1500)
          }
          agentLastState.set(agent.id, agent.state)
        }
        for (const [id, until] of agentCelebrateUntil) {
          if (now >= until) agentCelebrateUntil.delete(id)
        }
        const DESK_COLS = 4
        const DESK_ROWS = 2
        const TOTAL_DESKS = DESK_COLS * DESK_ROWS

        // shallow isometric (2.5D): rows run horizontally, depth recedes up-right
        const pitchX = 3.0
        // Nudge the eight workstations left so the right-side supervisor podium
        // keeps a clear walkway instead of sitting on top of the last column.
        const DESK_SHIFT_X = -1.2
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
        const wallInk = themed('rgba(11,11,11,0.99)', 'rgba(18,18,18,0.99)')
        const wallTrim = themed('rgba(20,20,20,0.99)', 'rgba(30,30,30,0.99)')
        const floorInk = themed('rgba(4,4,4,1)', 'rgba(10,10,10,1)')
        const topInk = themed('rgba(27,27,27,1)', 'rgba(105,105,105,1)')
        const topEdge = themed('rgba(48,48,48,1)', 'rgba(150,150,150,1)')
        const frontInk = themed('rgba(13,13,13,1)', 'rgba(95,95,95,1)')
        const sideInk = themed('rgba(9,9,9,1)', 'rgba(130,130,130,1)')
        const legInk = themed('rgba(19,19,19,1)', 'rgba(85,85,85,1)')
        const chairInk = themed('rgba(15,15,15,1)', 'rgba(95,95,95,1)')
        const panelInk = themed('rgba(2,2,2,0.98)', 'rgba(45,45,45,0.98)')

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

        context.restore()

        // back wall: no side walls; extend the wall and floor horizontally so
        // the stage width is fully covered instead of leaving paper-white wings.
        const wallSpan = areaW / Math.max(1, s) + 10
        const wallMinX = minX - wallSpan
        const wallMaxX = maxX + wallSpan
        quad(
          [iso(wallMinX, minY, 0), iso(wallMaxX, minY, 0), iso(wallMaxX, minY, wallH), iso(wallMinX, minY, wallH)],
          wallInk,
          'rgba(255,255,85,0.26)',
        )
        context.save()
        context.strokeStyle = 'rgba(85,255,255,0.1)'
        context.lineWidth = 1
        for (let gx = Math.ceil(wallMinX) + 1; gx < wallMaxX; gx += 1.5) {
          const a = iso(gx, minY, 0)
          const b = iso(gx, minY, wallH)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        for (let gz = 0.7; gz < wallH; gz += 0.7) {
          const a = iso(wallMinX, minY, gz)
          const b = iso(wallMaxX, minY, gz)
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.stroke()
        }
        context.restore()
        quad([iso(wallMinX, minY, 1.9), iso(wallMaxX, minY, 1.9), iso(wallMaxX, minY, 2.04), iso(wallMinX, minY, 2.04)], wallTrim, 'rgba(255,255,85,0.2)')
        const baseA = iso(wallMinX, minY, 0.04)
        const baseB = iso(wallMaxX, minY, 0.04)
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
        // signage
        const signAnchor = iso(minX + 0.5, minY, wallH - 0.3)
        context.save()
        context.textAlign = 'left'
        context.textBaseline = 'alphabetic'
        context.fillStyle = 'rgba(85,255,255,0.95)'
        context.font = '600 ' + Math.max(10, Math.round(s * 0.2)) + 'px "JetBrains Mono", ui-monospace, monospace'
        context.fillText('AGENT DECK // FLOOR 07', signAnchor.x, signAnchor.y)
        context.restore()

        // Three separately mounted wall displays share one baseline:
        // SECTOR 07 (live status), THROUGHPUT, TOOL LOAD. No shared backboard.
        const wallPw = Math.max(84, s * 2.1)
        const wallPh = Math.max(42, s * 1.0)
        const wallGap = Math.max(8, s * 0.28)
        const wallY = Math.max(48, wallTopScreen - 58)
        const wallRowW = wallPw * 3 + wallGap * 2
        const wallRowX = Math.max(210, (areaW - wallRowW) / 2 - 20)
        const sectorX = wallRowX
        const throughputX = sectorX + wallPw + wallGap
        const toolLoadX = throughputX + wallPw + wallGap
        const clockR = Math.max(18, s * 0.42)
        const clockAnchor = {
          x: Math.min(areaW - clockR - 14, toolLoadX + wallPw + clockR + 48),
          y: wallY + wallPh * 0.5,
        }

        const drawScreenFrame = (sx, sy) => {
          context.fillStyle = 'rgba(0,0,0,0.78)'
          context.fillRect(sx - 4, sy - 4, wallPw + 8, wallPh + 8)
          context.strokeStyle = 'rgba(255,255,85,0.34)'
          context.lineWidth = 1
          context.strokeRect(sx - 3.5, sy - 3.5, wallPw + 7, wallPh + 7)
          context.fillStyle = panelInk
          context.fillRect(sx, sy, wallPw, wallPh)
          context.strokeStyle = 'rgba(85,255,255,0.48)'
          context.strokeRect(sx + 0.5, sy + 0.5, wallPw - 1, wallPh - 1)
          context.fillStyle = 'rgba(85,255,255,0.12)'
          context.fillRect(sx + 1, sy + 1, wallPw - 2, 11)
          // small wall bracket under the display
          context.strokeStyle = 'rgba(125,125,125,0.45)'
          context.beginPath()
          context.moveTo(sx + 10, sy + wallPh + 4)
          context.lineTo(sx + 10, sy + wallPh + 9)
          context.lineTo(sx + 20, sy + wallPh + 9)
          context.moveTo(sx + wallPw - 10, sy + wallPh + 4)
          context.lineTo(sx + wallPw - 10, sy + wallPh + 9)
          context.lineTo(sx + wallPw - 20, sy + wallPh + 9)
          context.stroke()
        }

        const wallPanel = (sx, label, values, kind, color) => {
          drawScreenFrame(sx, wallY)
          const series = values && values.length > 1 ? values : [0, 0]
          const peak = Math.max(1, ...series)
          const innerX = sx + 6
          const innerY = wallY + 17
          const innerW = wallPw - 12
          const innerH = wallPh - 22
          context.save()
          context.fillStyle = 'rgba(85,255,255,0.9)'
          context.font = '600 ' + Math.max(7, Math.round(s * 0.12)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = 'left'
          context.fillText(label, sx + 5, wallY + 9)
          if (kind === 'line') {
            const grad = context.createLinearGradient(0, innerY, 0, innerY + innerH)
            grad.addColorStop(0, hexA(color, 0.24))
            grad.addColorStop(1, hexA(color, 0.01))
            context.beginPath()
            context.moveTo(innerX, innerY + innerH)
            for (let index = 0; index < series.length; index++) {
              const px = innerX + (index / (series.length - 1)) * innerW
              const py = innerY + innerH - (series[index] / peak) * innerH
              context.lineTo(px, py)
            }
            context.lineTo(innerX + innerW, innerY + innerH)
            context.closePath()
            context.fillStyle = grad
            context.fill()
            context.beginPath()
            for (let index = 0; index < series.length; index++) {
              const px = innerX + (index / (series.length - 1)) * innerW
              const py = innerY + innerH - (series[index] / peak) * innerH
              if (index === 0) context.moveTo(px, py)
              else context.lineTo(px, py)
            }
            context.strokeStyle = hexA(color, 0.9)
            context.lineWidth = 1.2
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

        // SECTOR 07 is a live status display, not a fake window.
        const drawSectorScreen = () => {
          const sx = sectorX
          drawScreenFrame(sx, wallY)
          context.save()
          context.textAlign = 'left'
          context.fillStyle = 'rgba(85,255,255,0.9)'
          context.font = '600 ' + Math.max(7, Math.round(s * 0.12)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('SECTOR 07', sx + 5, wallY + 9)
          context.textAlign = 'right'
          context.fillStyle = 'rgba(255,255,85,0.85)'
          context.font = Math.max(6, Math.round(s * 0.1)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('NIGHT SHIFT', sx + wallPw - 5, wallY + 9)
          context.textAlign = 'left'
          context.fillStyle = '#55ffff'
          context.font = '600 ' + Math.max(14, Math.round(s * 0.34)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText(String(totals.count || 0), sx + 6, wallY + wallPh - 15)
          context.fillStyle = 'rgba(125,125,125,0.95)'
          context.font = Math.max(6, Math.round(s * 0.1)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('ACTIVE', sx + 6, wallY + wallPh - 6)
          context.textAlign = 'right'
          context.fillStyle = '#ffffff'
          context.font = '600 ' + Math.max(9, Math.round(s * 0.17)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText((totals.tpsDisplay !== undefined ? totals.tpsDisplay : totals.tps || 0).toFixed(1), sx + wallPw - 6, wallY + wallPh - 17)
          context.fillStyle = 'rgba(125,125,125,0.95)'
          context.font = Math.max(6, Math.round(s * 0.1)) + 'px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('TPS', sx + wallPw - 6, wallY + wallPh - 8)
          context.restore()
        }

        drawSectorScreen()
        wallPanel(throughputX, 'THROUGHPUT', history, 'line', '#55ffff')
        wallPanel(toolLoadX, 'TOOL LOAD', toolStats.slice(0, 8).map((stat) => stat.calls), 'bars', '#55ff55')

        // clock, separately mounted to the right of the three screens
        context.save()
        context.beginPath()
        context.arc(clockAnchor.x, clockAnchor.y, clockR + 4, 0, Math.PI * 2)
        context.fillStyle = 'rgba(0,0,0,0.55)'
        context.fill()
        context.strokeStyle = 'rgba(85,255,255,0.26)'
        context.lineWidth = 1
        context.stroke()
        context.beginPath()
        context.arc(clockAnchor.x, clockAnchor.y, clockR, 0, Math.PI * 2)
        context.fillStyle = 'rgba(0,0,0,0.92)'
        context.fill()
        context.strokeStyle = 'rgba(85,255,255,0.68)'
        context.lineWidth = 1.4
        context.stroke()
        for (let hour = 0; hour < 12; hour++) {
          const angle = (hour / 12) * Math.PI * 2 - Math.PI / 2
          const inner = hour % 3 === 0 ? 0.58 : 0.76
          context.beginPath()
          context.moveTo(clockAnchor.x + Math.cos(angle) * clockR * inner, clockAnchor.y + Math.sin(angle) * clockR * inner)
          context.lineTo(clockAnchor.x + Math.cos(angle) * clockR * 0.9, clockAnchor.y + Math.sin(angle) * clockR * 0.9)
          context.strokeStyle = hour % 3 === 0 ? 'rgba(85,255,255,0.85)' : 'rgba(85,255,255,0.35)'
          context.lineWidth = hour % 3 === 0 ? 1.5 : 1
          context.stroke()
        }
        const stampNow = new Date()
        const hourAngle = ((stampNow.getHours() % 12) / 12) * Math.PI * 2 - Math.PI / 2
        const minuteAngle = (stampNow.getMinutes() / 60) * Math.PI * 2 - Math.PI / 2
        context.strokeStyle = 'rgba(255,255,255,0.9)'
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(clockAnchor.x, clockAnchor.y)
        context.lineTo(clockAnchor.x + Math.cos(hourAngle) * clockR * 0.45, clockAnchor.y + Math.sin(hourAngle) * clockR * 0.45)
        context.stroke()
        context.strokeStyle = 'rgba(255,255,85,0.95)'
        context.lineWidth = 1.5
        context.beginPath()
        context.moveTo(clockAnchor.x, clockAnchor.y)
        context.lineTo(clockAnchor.x + Math.cos(minuteAngle) * clockR * 0.72, clockAnchor.y + Math.sin(minuteAngle) * clockR * 0.72)
        context.stroke()
        context.fillStyle = 'rgba(85,255,255,0.95)'
        context.beginPath()
        context.arc(clockAnchor.x, clockAnchor.y, 2, 0, Math.PI * 2)
        context.fill()
        context.restore()

        const slots = []
        for (let col = 0; col < DESK_COLS; col++) slots.push({ row: DESK_ROWS - 1, col })
        for (let col = 0; col < DESK_COLS; col++) slots.push({ row: 0, col })
        const slotAgent = new Map()
        for (const agent of agents) {
          if (supervisorAgent && agent.id === supervisorAgent.id) continue
          const seat = agent.deskSlot
          if (!Number.isInteger(seat) || seat < 0 || seat >= TOTAL_DESKS) continue
          const slot = slots[seat]
          slotAgent.set(slot.row * DESK_COLS + slot.col, agent)
        }
        const spotBySlot = []
        for (let slot = 0; slot < TOTAL_DESKS; slot++) {
          const row = Math.floor(slot / DESK_COLS)
          const col = slot % DESK_COLS
          const wx = col * pitchX + deskW * 0.9 + DESK_SHIFT_X
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
        const prefs = state.prefs || DEFAULT_PREFS
        const visitPace = visitPaceFor(prefs)
        const visitLimit = visitLimitFor(seatedAll.length, prefs, reduceMotion)
        const visitEnabled = visitLimit > 0
        if (visitEnabled && officeNextVisitAt === 0) officeNextVisitAt = now + (8000 + Math.random() * 12000) * visitPace
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
        if (visitEnabled && officeVisits.length >= visitLimit && now >= officeNextVisitAt) {
          officeNextVisitAt = now + (5000 + Math.random() * 8000) * visitPace
        }
        if (
          visitEnabled &&
          visitLimit > 0 &&
          officeVisits.length < visitLimit &&
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
            officeNextVisitAt = now + (9000 + Math.random() * 16000) * visitPace
          } else {
            officeNextVisitAt = now + (8000 + Math.random() * 12000) * visitPace
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
          desks.push({ slot, x: col * pitchX + DESK_SHIFT_X, y: row * pitchY, agent: slotAgent.get(slot) || null })
        }
        desks.sort((a, b) => a.y - b.y || a.x - b.x)
        hitAreas = []

        const drawHoverRing = (anchor, height, now, color) => {
          context.save()
          const ringR = Math.max(12, height * 0.5)
          const pulse = 0.72 + 0.28 * Math.sin(now / 220)
          context.strokeStyle = hexA(color, 0.9)
          context.lineWidth = 1.6
          context.shadowColor = color
          context.shadowBlur = 12
          context.beginPath()
          context.ellipse(anchor.x, anchor.y + 2, ringR, ringR * 0.28, 0, 0, Math.PI * 2)
          context.stroke()
          context.strokeStyle = hexA(color, 0.35 + pulse * 0.25)
          context.beginPath()
          context.ellipse(anchor.x, anchor.y + 2, ringR * 1.28, ringR * 0.36, 0, 0, Math.PI * 2)
          context.stroke()
          context.restore()
        }

        const drawSmokePuffs = (anchor, height, now, seed) => {
          if (reduceMotion) return
          context.save()
          for (let puff = 0; puff < 3; puff++) {
            const phase = ((now / 900 + seed * 0.13 + puff * 0.27) % 1)
            const px = anchor.x + Math.sin(now / 420 + puff * 2.1 + seed) * (height * 0.20)
            const py = anchor.y - height * 0.78 - phase * height * 0.55
            const radius = height * (0.035 + phase * 0.09)
            context.fillStyle = themed(
              'rgba(255,110,110,' + (0.20 * (1 - phase)).toFixed(2) + ')',
              'rgba(85,255,255,' + (0.20 * (1 - phase)).toFixed(2) + ')',
            )
            context.beginPath()
            context.arc(px, py, radius, 0, Math.PI * 2)
            context.fill()
          }
          context.restore()
        }

        const drawCelebration = (anchor, height, now, until, seed) => {
          if (reduceMotion || now >= until) return
          const progress = 1 - (until - now) / 1500
          context.save()
          for (let spark = 0; spark < 7; spark++) {
            const angle = (spark / 7) * Math.PI * 2 + seed
            const travel = height * (0.18 + progress * 0.6)
            const px = anchor.x + Math.cos(angle) * travel
            const py = anchor.y - height * 0.45 + Math.sin(angle) * travel * 0.45 - progress * height * 0.2
            context.strokeStyle = 'rgba(255,255,85,' + (0.85 * (1 - progress)).toFixed(2) + ')'
            context.lineWidth = 1.5
            context.beginPath()
            context.moveTo(px - 2, py)
            context.lineTo(px + 2, py)
            context.moveTo(px, py - 2)
            context.lineTo(px, py + 2)
            context.stroke()
          }
          context.restore()
        }

        // A distinct command desk in the middle aisle: the supervisor/chief sits
        // between the two agent rows instead of occupying one of the 8 unit seats.
        const drawSupervisorStation = (chief) => {
          // A teacher-style podium on the right side, between the two desk rows:
          // it stays out of the center aisle and does not take a numbered seat.
          const x = 11.55
          const y = 1.45
          const w = 1.85
          const d = 1.0
          const z = 0.6
          const gold = '#ffff55'
          const pad = iso(x + w / 2, y + d / 2, 0)
          context.save()
          context.strokeStyle = 'rgba(255,255,85,0.55)'
          context.lineWidth = 1.4
          context.shadowColor = gold
          context.shadowBlur = 14
          context.beginPath()
          context.ellipse(pad.x, pad.y, s * 1.5, s * 0.42, 0, 0, Math.PI * 2)
          context.stroke()
          context.shadowBlur = 0
          context.restore()
          // chair behind the command desk
          solid(x + w * 0.28, y - 0.52, w * 0.44, 0.3, 0, 0.48, themed('rgba(22,22,18,1)', 'rgba(52,50,42,1)'), themed('rgba(16,16,12,1)', 'rgba(62,60,50,1)'), themed('rgba(12,12,9,1)', 'rgba(72,70,58,1)'), hexA(gold, 0.24))
          solid(x + w * 0.28, y - 0.58, w * 0.44, 0.08, 0.48, 0.98, themed('rgba(25,25,20,1)', 'rgba(58,56,46,1)'), themed('rgba(16,16,12,1)', 'rgba(70,68,56,1)'), themed('rgba(12,12,9,1)', 'rgba(82,78,64,1)'), hexA(gold, 0.35))
          // Supervisor: use the topology root/parent when one exists; otherwise
          // keep a fixed gold resident as the fallback NPC.
          const supervisorAnchor = iso(x + w / 2, y - 0.02, 0)
          if (chief) {
            const chiefMode = chief.state === 'run' ? 'busy' : chief.state === 'err' ? 'error' : 'idle'
            drawAgentGirl(
              context,
              now,
              supervisorAnchor,
              Math.max(38, s * 1.25),
              chief.color || '#ffb84d',
              chiefMode,
              0.72,
              u,
              { reduced: reduceMotion },
            )
          } else {
            drawAgentGirl(
              context,
              now,
              supervisorAnchor,
              Math.max(38, s * 1.25),
              '#ffb84d',
              'idle',
              0.72,
              u,
              { reduced: reduceMotion },
            )
          }
          // desk
          solid(x, y, w, d, 0, z, themed('rgba(30,30,24,1)', 'rgba(72,70,56,1)'), themed('rgba(18,18,14,1)', 'rgba(58,56,46,1)'), themed('rgba(12,12,9,1)', 'rgba(78,75,60,1)'), hexA(gold, 0.55))
          for (const [lx, ly] of [
            [x + 0.08, y + 0.08],
            [x + w - 0.08, y + 0.08],
            [x + 0.08, y + d - 0.08],
            [x + w - 0.08, y + d - 0.08],
          ]) {
            solid(lx - 0.035, ly - 0.035, 0.07, 0.07, 0, z, themed('rgba(24,24,18,1)', 'rgba(62,60,50,1)'), themed('rgba(15,15,11,1)', 'rgba(70,68,56,1)'), themed('rgba(12,12,9,1)', 'rgba(82,78,64,1)'), hexA(gold, 0.2))
          }
          // dual command monitors
          for (const offset of [0.62, 1.58]) {
            const base = iso(x + offset, y + d * 0.3, z + 0.08)
            const screenW = Math.max(30, s * 0.58)
            const screenH = Math.max(20, s * 0.36)
            context.fillStyle = 'rgba(4,6,3,1)'
            context.fillRect(base.x - screenW / 2 - 2, base.y - screenH - 4, screenW + 4, screenH + 4)
            context.strokeStyle = hexA(gold, 0.8)
            context.lineWidth = 1
            context.strokeRect(base.x - screenW / 2 - 1.5, base.y - screenH - 3.5, screenW + 3, screenH + 3)
            context.fillStyle = 'rgba(255,255,85,0.12)'
            context.fillRect(base.x - screenW / 2, base.y - screenH - 2, screenW, screenH)
            context.strokeStyle = 'rgba(255,255,85,0.65)'
            context.beginPath()
            context.moveTo(base.x - screenW / 2 + 3, base.y - screenH * 0.72)
            context.lineTo(base.x - screenW / 2 + screenW * 0.45, base.y - screenH * 0.72)
            context.lineTo(base.x - screenW / 2 + screenW * 0.62, base.y - screenH * 0.32)
            context.lineTo(base.x - screenW / 2 + screenW * 0.9, base.y - screenH * 0.32)
            context.stroke()
            context.fillStyle = themed('rgba(40,40,30,1)', 'rgba(90,88,70,1)')
            context.fillRect(base.x - 1.5, base.y - 4, 3, 4)
            context.fillRect(base.x - 7, base.y, 14, 2)
          }
          // nameplate
          const plate = iso(x + w / 2, y + d + 0.34, 0)
          context.save()
          context.textAlign = 'center'
          context.textBaseline = 'alphabetic'
          context.fillStyle = 'rgba(0,0,0,0.92)'
          context.fillRect(plate.x - 45, plate.y - 13, 90, 16)
          context.strokeStyle = hexA(gold, 0.8)
          context.lineWidth = 1
          context.strokeRect(plate.x - 44.5, plate.y - 12.5, 89, 15)
          context.fillStyle = gold
          context.font = '600 8px "JetBrains Mono", ui-monospace, monospace'
          context.fillText('SUPERVISOR', plate.x, plate.y - 2)
          context.restore()
        }

        const drawDeskBatch = (batch) => {
          for (const desk of batch) {
          const { x, y, agent } = desk
          const vacant = !agent
          const color = vacant ? '#555555' : agent.color || '#55ffff'
          const state = vacant ? 'vacant' : agent.state
          const chatVisit = vacant ? null : chatTargets.get(agent.id)
          const waitAction = vacant ? '' : waitActionFor(agent, prefs, Date.now(), reduceMotion)
          const baseMode = vacant ? 'vacant' : state === 'err' ? 'error' : state === 'wait' ? 'idle' : state === 'run' ? 'busy' : 'idle'
          const mode = vacant
            ? 'vacant'
            : visitingIds.has(agent.id)
              ? 'away'
              : chatVisit && state !== 'err'
                ? 'talk'
                : waitAction || baseMode
          const edge = hexA(color, vacant ? 0.15 : 0.55)
          const robotAnchor = vacant ? null : iso(x + deskW * 0.9, y + deskD + 0.06, 0)
          const robotHeight = robotAnchor ? Math.max(36, s * 1.45) : 0
          const dimmed = !vacant && ((legendFilter && legendFilter !== state) || (hover && !hoverIds.has(agent.id)))
          context.save()
          if (dimmed) context.globalAlpha *= 0.26

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
            drawAgentGirl(
              context,
              now,
              robotAnchor,
              robotHeight,
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
              mode === 'slack'
                ? 'SLACKING'
                : mode === 'game'
                  ? 'GAMING'
                  : mode === 'busy'
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

          if (!vacant) {
            hitAreas.push({ id: agent.id, x: screenX - 8, y: screenY - 8, w: screenW + 16, h: screenH + 30 })
            if (hoverIds.has(agent.id)) drawHoverRing(robotAnchor, robotHeight, now, color)
            if (state === 'err') drawSmokePuffs(robotAnchor, robotHeight, now, desk.slot)
            const celebrateUntil = agentCelebrateUntil.get(agent.id)
            if (celebrateUntil) drawCelebration(robotAnchor, robotHeight, now, celebrateUntil, desk.slot)
          }
          context.restore()
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
        drawSupervisorStation(supervisorAgent)
        for (const visit of officeVisits) if (visit.worldY < pitchY) drawVisitor(visit)
        drawDeskBatch(desks.filter((desk) => desk.slot >= DESK_COLS))
        for (const visit of officeVisits) if (visit.worldY >= pitchY) drawVisitor(visit)

        // With no sessions at all, keep one resident whale-girl at desk #00 so the
        // office never looks abandoned. She is decorative: no hit area, no session.
        if (seatedAll.length === 0) {
          const residentSpot = spotBySlot[0]
          drawAgentGirl(context, now, residentSpot.anchor, residentSpot.height, '#55ffff', 'idle', 0.35, u, { reduced: reduceMotion })
          const tagX = residentSpot.anchor.x
          const tagY = residentSpot.anchor.y - residentSpot.height * 1.22
          const tagW = 72
          context.save()
          context.fillStyle = 'rgba(0,0,0,0.9)'
          context.fillRect(tagX - tagW / 2, tagY - 11, tagW, 16)
          context.strokeStyle = 'rgba(85,255,255,0.5)'
          context.lineWidth = 1
          context.strokeRect(tagX - tagW / 2 + 0.5, tagY - 10.5, tagW - 1, 15)
          context.fillStyle = '#55ffff'
          context.font = '600 8px "JetBrains Mono", ui-monospace, monospace'
          context.textAlign = 'center'
          context.textBaseline = 'alphabetic'
          context.fillText('#00  IDLE', tagX, tagY - 1)
          context.restore()
        }

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
      const pickAt = (event) => {
        const state = readState()
        if (!state || state.hidden) return null
        if (state.mode !== 'net' && state.mode !== 'office' && state.mode !== 'radar') return null
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
        return best
      }
      const onCanvasClick = (event) => {
        const best = pickAt(event)
        if (best && typeof onPick === 'function') onPick(best)
      }
      const onCanvasMove = (event) => {
        if (typeof onHover !== 'function') return
        const best = pickAt(event)
        if (best !== hoverAreaId) {
          hoverAreaId = best
          onHover(best)
        }
      }
      const onCanvasLeave = () => {
        if (hoverAreaId !== null) {
          hoverAreaId = null
          if (typeof onHover === 'function') onHover(null)
        }
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
      canvas.addEventListener('pointermove', onCanvasMove)
      canvas.addEventListener('pointerleave', onCanvasLeave)
      raf = window.requestAnimationFrame(draw)
      window.addEventListener('resize', onResize)
      return () => {
        window.cancelAnimationFrame(raf)
        window.removeEventListener('resize', onResize)
        canvas.removeEventListener('click', onCanvasClick)
        canvas.removeEventListener('pointermove', onCanvasMove)
        canvas.removeEventListener('pointerleave', onCanvasLeave)
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
      const hoverRef = useRef(null)
      const legendRef = useRef(null)
      const modeRef = useRef('office')
      const cinemaRef = useRef(false)
      const prefsRef = useRef(loadPrefs())
      const prefsOpenRef = useRef(false)
      const railOpenRef = useRef({ runtime: true, system: false })
      const stageStateRef = useRef({
        agents: [],
        totals: { tps: 0 },
        focused: null,
        mode: 'office',
        hidden: false,
        paused: false,
        topology: { nodes: [], edges: [] },
        prefs: prefsRef.current,
      })
      const visibleRef = useRef(true)
      const lastRevRef = useRef(-1)

      useEffect(() => {
        const root = rootRef.current
        if (!root || !monitor) return undefined
        const canvas = root.querySelector('#nxt-canvas')
        if (!canvas) return undefined
        const $ = (id) => root.querySelector('#' + id)
        const refs = {
          count: $('nxt-c-count'),
          clock: $('nxt-c-localtime'),
          wall: $('nxt-wall'),
          wallHint: $('nxt-wallhint'),
          rail: $('nxt-rail'),
          ticker: $('nxt-ticker'),
          stage: $('nxt-stage'),
          analyze: $('nxt-analyze'),
          prefs: $('nxt-prefs'),
          hudTL: $('nxt-shud-tl'),
          hudTR: $('nxt-shud-tr'),
          hudBL: $('nxt-shud-bl'),
          hudBR: $('nxt-shud-br'),
          stageTitle: $('nxt-stage-title'),
          stageSub: $('nxt-stage-sub'),
          stageTag: $('nxt-stage-tag'),
          tray: $('nxt-standby-tray'),
          battle: $('nxt-battlebar'),
          strip: $('nxt-agentstrip'),
          legend: $('nxt-legend'),
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

        let lastPaintAt = -Infinity
        let lastHeavyPaintAt = -Infinity
        const paint = (force = false) => {
          const view = readView()
          if (!view || !visibleRef.current) return
          const paintNow = performance.now()
          // The snapshot changes at 10Hz; rebuilding the whole rail and filmstrip
          // at that rate is the largest DOM cost. 5-6Hz is plenty for a monitor.
          if (!force && paintNow - lastPaintAt < 300) return
          lastPaintAt = paintNow
          const heavyDue = force || paintNow - lastHeavyPaintAt >= 900
          if (heavyDue) lastHeavyPaintAt = paintNow
          if (refs.clock) refs.clock.textContent = fmtClock(new Date())
          if (refs.count) refs.count.textContent = String(view.totals.count)
          const liveAgents = view.agents.filter((agent) => !agent.held)
          const prefs = prefsRef.current
          const hover = hoverRef.current
          setHtml(refs.battle, battleHtml(view))
          if (heavyDue) {
            const filmSummary = liveAgents.length < 3 ? roomSummaryHtml(view) : ''
            setHtml(
              refs.wall,
              (liveAgents.length > 0
                ? liveAgents.slice(0, MAX_CARDS).map((agent) => cardHtml(agent, focusRef.current, hover, legendRef.current)).join('')
                : standbyHtml(view, prefs)) + filmSummary,
            )
          }
          if (refs.strip) {
            const showStrip = liveAgents.length > MAX_CARDS && !focusRef.current
            refs.strip.hidden = !showStrip
            if (showStrip && heavyDue) setHtml(refs.strip, agentStripHtml(liveAgents, focusRef.current, hover))
          }
          if (refs.legend) {
            setHtml(refs.legend, legendHtml(legendRef.current))
            refs.legend.dataset.show = !focusRef.current && modeRef.current === 'office' ? '1' : '0'
          }
          if (refs.wallHint) {
            refs.wallHint.textContent =
              liveAgents.length > MAX_CARDS
                ? 'LIVE FEED +' + (liveAgents.length - MAX_CARDS)
                : liveAgents.length > 0
                  ? 'LIVE FEED · ' + liveAgents.length
                  : 'RESIDENT · STANDBY'
          }
          if (heavyDue) {
            setHtml(refs.rail, railHtml(view, legendRef.current, railOpenRef.current))
            setHtml(refs.ticker, tickerHtml(view))
          }
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
          root.classList.toggle('nxt-cold', Boolean(cinemaRef.current && prefs.cinemaSkin === 'cold'))
          if (heavyDue) setHtml(refs.analyze, focusedAgent ? analyzeHtml(focusedAgent) : '')
          if (refs.prefs) {
            refs.prefs.dataset.open = prefsOpenRef.current ? '1' : '0'
            if (prefsOpenRef.current) setHtml(refs.prefs, prefsHtml(prefs))
          }
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
            if (heavyDue) setHtml(
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
            paused: !visibleRef.current,
            topology: view.topology || { nodes: [], edges: [] },
            toolBins: view.toolBins || [],
            history: view.history || [],
            toolStats: view.toolStats || [],
            prefs,
            hover: hoverRef.current,
            legendFilter: legendRef.current,
          }
        }

        // Pause all work when the panel is hidden by the host. Without this the
        // animation loop and telemetry DOM updates keep running in the background.
        const syncVisibility = () => {
          const visible = !document.hidden && visibleRef.current
          stageStateRef.current = { ...stageStateRef.current, paused: !visible }
          if (visible) paint(true)
        }
        const onVisibilityChange = () => syncVisibility()
        document.addEventListener('visibilitychange', onVisibilityChange)
        let visibilityObserver = null
        if (typeof IntersectionObserver !== 'undefined') {
          visibilityObserver = new IntersectionObserver(
            (entries) => {
              visibleRef.current = Boolean(entries[0] && entries[0].isIntersecting)
              syncVisibility()
            },
            { threshold: 0.01 },
          )
          visibilityObserver.observe(root)
        }

        paint()
        // Canvas-rendered throughput charts. The monitor samples at 10Hz; the
        // chart layer interpolates between samples at 30fps so the line glides
        // instead of visibly stepping once per sample.
        const mixSeries = (from, to, t) => {
          const count = Math.max(from.length, to.length)
          const out = new Array(count)
          for (let index = 0; index < count; index++) {
            const a = from[index] === undefined ? 0 : from[index]
            const b = to[index] === undefined ? 0 : to[index]
            out[index] = a + (b - a) * t
          }
          return out
        }
        const hexToRgba = (color, alpha) => {
          const match = /^#?([0-9a-f]{6})$/i.exec(String(color || ''))
          if (!match) return 'rgba(85,255,255,' + alpha + ')'
          const value = parseInt(match[1], 16)
          return 'rgba(' + ((value >> 16) & 255) + ',' + ((value >> 8) & 255) + ',' + (value & 255) + ',' + alpha + ')'
        }
        const drawCanvasSpark = (canvas, values, color = '#55ffff') => {
          if (!canvas) return
          const cssW = canvas.clientWidth
          const cssH = canvas.clientHeight
          if (cssW < 2 || cssH < 2 || values.length < 2) return
          const chartDpr = Math.min(2, window.devicePixelRatio || 1)
          const backingW = Math.round(cssW * chartDpr)
          const backingH = Math.round(cssH * chartDpr)
          if (canvas.width !== backingW) canvas.width = backingW
          if (canvas.height !== backingH) canvas.height = backingH
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.setTransform(chartDpr, 0, 0, chartDpr, 0, 0)
          ctx.clearRect(0, 0, cssW, cssH)
          const peak = Math.max(1, ...values)
          const padX = 1
          const padY = 3
          const usableW = cssW - padX * 2
          const usableH = cssH - padY * 2
          const pts = values.map((value, index) => ({
            x: padX + (index / (values.length - 1)) * usableW,
            y: padY + usableH - (value / peak) * usableH,
          }))
          const grad = ctx.createLinearGradient(0, padY, 0, cssH)
          grad.addColorStop(0, hexToRgba(color, 0.30))
          grad.addColorStop(1, hexToRgba(color, 0.015))
          ctx.beginPath()
          ctx.moveTo(pts[0].x, cssH)
          for (const point of pts) ctx.lineTo(point.x, point.y)
          ctx.lineTo(pts[pts.length - 1].x, cssH)
          ctx.closePath()
          ctx.fillStyle = grad
          ctx.fill()
          ctx.beginPath()
          for (let index = 0; index < pts.length; index++) {
            if (index === 0) ctx.moveTo(pts[index].x, pts[index].y)
            else ctx.lineTo(pts[index].x, pts[index].y)
          }
          ctx.strokeStyle = hexToRgba(color, 0.9)
          ctx.lineWidth = 1.4
          ctx.stroke()
          const last = pts[pts.length - 1]
          ctx.beginPath()
          ctx.arc(last.x, last.y, 1.8, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
        }
        let chartRaf = 0
        let lastChartRead = 0
        let lastChartDraw = 0
        let chartFrom = []
        let chartTo = []
        let chartT0 = 0
        let latestChartView = null
        const cardChartStates = new Map()
        const drawBarCanvas = (canvas, pct, color) => {
          const cssW = canvas.clientWidth
          const cssH = canvas.clientHeight
          if (cssW < 2 || cssH < 2) return
          const barDpr = Math.min(2, window.devicePixelRatio || 1)
          const backingW = Math.round(cssW * barDpr)
          const backingH = Math.round(cssH * barDpr)
          if (canvas.width !== backingW) canvas.width = backingW
          if (canvas.height !== backingH) canvas.height = backingH
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.setTransform(barDpr, 0, 0, barDpr, 0, 0)
          ctx.clearRect(0, 0, cssW, cssH)
          ctx.fillStyle = 'rgba(85,255,255,0.14)'
          ctx.fillRect(0, 0, cssW, cssH)
          const width = Math.max(0, Math.min(100, pct)) * 0.01 * cssW
          if (width > 0) {
            ctx.fillStyle = color || '#55ffff'
            ctx.fillRect(0, 0, width, cssH)
          }
        }
        const drawPhaseCanvas = (canvas) => {
          const cssW = canvas.clientWidth
          const cssH = canvas.clientHeight
          if (cssW < 2 || cssH < 2) return
          const phaseDpr = Math.min(2, window.devicePixelRatio || 1)
          const backingW = Math.round(cssW * phaseDpr)
          const backingH = Math.round(cssH * phaseDpr)
          if (canvas.width !== backingW) canvas.width = backingW
          if (canvas.height !== backingH) canvas.height = backingH
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.setTransform(phaseDpr, 0, 0, phaseDpr, 0, 0)
          ctx.clearRect(0, 0, cssW, cssH)
          ctx.fillStyle = 'rgba(85,255,255,0.08)'
          ctx.fillRect(0, 0, cssW, cssH)
          const segments = [
            ['think', '#55ffff'],
            ['act', '#ff55ff'],
            ['out', '#55ff55'],
            ['wait', '#555555'],
          ]
          let cursor = 0
          for (const [key, color] of segments) {
            const value = parseFloat(canvas.getAttribute('data-' + key)) || 0
            const width = (Math.max(0, value) / 100) * cssW
            if (width <= 0) continue
            ctx.fillStyle = color
            ctx.fillRect(cursor, 0, width, cssH)
            cursor += width
          }
        }
        const drawUnitVizCanvas = (canvas, agent, kind) => {
          if (!agent) return
          if (kind === 0) {
            drawCanvasSpark(canvas, (agent.tpsHistory || []).slice(-24), agent.color || '#55ffff')
            return
          }
          const cssW = canvas.clientWidth
          const cssH = canvas.clientHeight
          if (cssW < 2 || cssH < 2) return
          const vizDpr = Math.min(2, window.devicePixelRatio || 1)
          const backingW = Math.round(cssW * vizDpr)
          const backingH = Math.round(cssH * vizDpr)
          if (canvas.width !== backingW) canvas.width = backingW
          if (canvas.height !== backingH) canvas.height = backingH
          const ctx = canvas.getContext('2d')
          if (!ctx) return
          ctx.setTransform(vizDpr, 0, 0, vizDpr, 0, 0)
          ctx.clearRect(0, 0, cssW, cssH)
          const color = agent.color || '#55ffff'
          if (kind === 1) {
            const bins = new Array(6).fill(0)
            const now = Date.now()
            for (const entry of agent.toolLog || []) {
              const age = now - entry.t
              if (age < 0 || age > TIMELINE_WINDOW) continue
              const index = clamp(5 - Math.floor(age / (TIMELINE_WINDOW / 6)), 0, 5)
              bins[index] += 1
            }
            const peak = Math.max(1, ...bins)
            const barW = cssW / bins.length
            bins.forEach((value, index) => {
              const height = value === 0 ? 1 : Math.max(2, (value / peak) * cssH)
              ctx.globalAlpha = value === 0 ? 0.25 : 0.85
              ctx.fillStyle = color
              ctx.fillRect(index * barW + 1, cssH - height, Math.max(1, barW - 2), height)
            })
            ctx.globalAlpha = 1
            return
          }
          const durations = (agent.tools || []).slice(-5).map((tool) => tool.ms || 0)
          const peak = Math.max(1, ...durations)
          const rowH = cssH / Math.max(1, durations.length)
          durations.forEach((ms, index) => {
            const width = ms === 0 ? 2 : Math.max(3, (ms / peak) * cssW)
            ctx.fillStyle = color
            ctx.globalAlpha = 0.75
            ctx.fillRect(0, index * rowH + 0.5, width, Math.max(1, rowH - 1.2))
          })
          ctx.globalAlpha = 1
        }
        const drawAnalyzeCharts = () => {
          for (const canvas of root.querySelectorAll('[data-ring-pct]')) {
            const pct = parseFloat(canvas.getAttribute('data-ring-pct')) || 0
            const value = canvas.getAttribute('data-ring-value') || ''
            const sub = canvas.getAttribute('data-ring-sub') || ''
            const hot = canvas.getAttribute('data-ring-hot') === '1'
            const cssW = canvas.clientWidth
            const cssH = canvas.clientHeight
            if (cssW < 4 || cssH < 4) continue
            const key = pct + ':' + value + ':' + sub + ':' + hot + ':' + cssW + 'x' + cssH
            const ringDpr = Math.min(2, window.devicePixelRatio || 1)
            const backingW = Math.round(cssW * ringDpr)
            const backingH = Math.round(cssH * ringDpr)
            if (canvas.width !== backingW) canvas.width = backingW
            if (canvas.height !== backingH) canvas.height = backingH
            const ctx = canvas.getContext('2d')
            if (!ctx) continue
            ctx.setTransform(ringDpr, 0, 0, ringDpr, 0, 0)
            ctx.clearRect(0, 0, cssW, cssH)
            const cx = cssW / 2
            const cy = cssH / 2
            const radius = Math.max(10, Math.min(cssW, cssH) * 0.36)
            ctx.lineWidth = Math.max(4, Math.min(cssW, cssH) * 0.065)
            ctx.strokeStyle = 'rgba(85,255,255,0.14)'
            ctx.beginPath()
            ctx.arc(cx, cy, radius, 0, Math.PI * 2)
            ctx.stroke()
            ctx.strokeStyle = hot ? '#ff55ff' : '#55ffff'
            ctx.beginPath()
            ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * Math.max(0, Math.min(100, pct))) / 100)
            ctx.stroke()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = '#ffffff'
            ctx.font = '600 ' + Math.max(12, Math.round(Math.min(cssW, cssH) * 0.14)) + 'px "JetBrains Mono",Consolas,monospace'
            ctx.fillText(value, cx, cy - cssH * 0.04)
            ctx.fillStyle = '#55ffff'
            ctx.font = '8px "JetBrains Mono",Consolas,monospace'
            ctx.fillText(sub, cx, cy + cssH * 0.13)
          }
          for (const canvas of root.querySelectorAll('[data-matrix-values]')) {
            const values = String(canvas.getAttribute('data-matrix-values') || '').split(',').map(Number)
            const max = Math.max(1, Number(canvas.getAttribute('data-matrix-max')) || 1)
            const cssW = canvas.clientWidth
            const cssH = canvas.clientHeight
            if (cssW < 4 || cssH < 4) continue
            const key = cssW + 'x' + cssH + ':' + max + ':' + values.join(',')
            const mxDpr = Math.min(2, window.devicePixelRatio || 1)
            if (canvas.width !== Math.round(cssW * mxDpr)) canvas.width = Math.round(cssW * mxDpr)
            if (canvas.height !== Math.round(cssH * mxDpr)) canvas.height = Math.round(cssH * mxDpr)
            const ctx = canvas.getContext('2d')
            if (!ctx) continue
            ctx.setTransform(mxDpr, 0, 0, mxDpr, 0, 0)
            ctx.clearRect(0, 0, cssW, cssH)
            const gap = 2
            const cellW = (cssW - gap * Math.max(0, values.length - 1)) / Math.max(1, values.length)
            values.forEach((cell, index) => {
              ctx.fillStyle = 'rgba(85,255,255,' + (cell === 0 ? 0.06 : 0.2 + 0.8 * (cell / max)).toFixed(2) + ')'
              ctx.fillRect(index * (cellW + gap), 0, cellW, cssH)
            })
          }
          for (const canvas of root.querySelectorAll('[data-lane-segments]')) {
            let segments = []
            try {
              segments = JSON.parse(decodeURIComponent(canvas.getAttribute('data-lane-segments') || '[]'))
            } catch (err) {
              segments = []
            }
            const cssW = canvas.clientWidth
            const cssH = canvas.clientHeight
            if (cssW < 4 || cssH < 4) continue
            const key = cssW + 'x' + cssH + ':' + JSON.stringify(segments)
            const laneDpr = Math.min(2, window.devicePixelRatio || 1)
            if (canvas.width !== Math.round(cssW * laneDpr)) canvas.width = Math.round(cssW * laneDpr)
            if (canvas.height !== Math.round(cssH * laneDpr)) canvas.height = Math.round(cssH * laneDpr)
            const ctx = canvas.getContext('2d')
            if (!ctx) continue
            ctx.setTransform(laneDpr, 0, 0, laneDpr, 0, 0)
            ctx.clearRect(0, 0, cssW, cssH)
            for (const segment of segments) {
              ctx.fillStyle = segment[2] || '#55ffff'
              ctx.fillRect((segment[0] / 100) * cssW, 0, Math.max(1, (segment[1] / 100) * cssW), cssH)
            }
          }
          if (latestChartView) {
            for (const canvas of root.querySelectorAll('[data-analyze-tps-id]')) {
              const id = canvas.getAttribute('data-analyze-tps-id')
              const agent = (latestChartView.agents || []).find((item) => item.id === id)
              if (!agent) continue
              const history = (agent.tpsHistory || []).slice(-48)
              const key = history.length + ':' + shownTps(agent).toFixed(1) + ':' + (agent.color || '')
              drawCanvasSpark(canvas, history.length > 1 ? history : [0, 0], agent.color || '#55ffff')
            }
          }
        }
        const drawInlineCharts = (now) => {
          const bars = Array.from(root.querySelectorAll('[data-bar]'))
          const maxByKind = new Map()
          for (const bar of bars) {
            const kind = bar.getAttribute('data-bar')
            if (kind === 'phase' || kind === 'ctxpct') continue
            const value = parseFloat(bar.getAttribute('data-value')) || 0
            maxByKind.set(kind, Math.max(maxByKind.get(kind) || 0, value))
          }
          for (const bar of bars) {
            const kind = bar.getAttribute('data-bar')
            if (kind === 'phase') {
              drawPhaseCanvas(bar)
              continue
            }
            const value = parseFloat(bar.getAttribute('data-value')) || 0
            const max = kind === 'ctxpct' ? 100 : Math.max(1, maxByKind.get(kind) || 1)
            let pct = kind === 'ctxpct' ? value : (value / max) * 100
            if (value > 0 && pct < 4) pct = 4
            const color =
              kind === 'file' ? '#ff55ff' : bar.getAttribute('data-err') === '1' ? '#ff5555' : '#55ffff'
            const key = kind + ':' + value + ':' + max + ':' + color
            drawBarCanvas(bar, pct, color)
          }
          if (latestChartView) {
            for (const canvas of root.querySelectorAll('[data-viz-id]')) {
              const agent = (latestChartView.agents || []).find((item) => item.id === canvas.getAttribute('data-viz-id'))
              const kind = Number.parseInt(canvas.getAttribute('data-viz-kind'), 10) || 0
              const key = agent
                ? agent.state + ':' + shownTps(agent).toFixed(1) + ':' + (agent.tools || []).length + ':' + kind
                : 'none'
              drawUnitVizCanvas(canvas, agent, kind)
            }
          }
          drawAnalyzeCharts()
        }
        const readCardCharts = (view, now) => {
          const seen = new Set()
          for (const agent of view.agents || []) {
            const id = agent.id
            const next = (agent.tpsHistory || []).slice(-36)
            if (!id || next.length < 2) continue
            const previous = cardChartStates.get(id)
            const from = previous ? mixSeries(previous.from, previous.to, Math.min(1, (now - previous.t0) / 100)) : next
            cardChartStates.set(id, {
              from,
              to: next,
              t0: now,
              color: agent.color || '#55ffff',
            })
            seen.add(id)
          }
          for (const id of cardChartStates.keys()) if (!seen.has(id)) cardChartStates.delete(id)
        }
        const stepCharts = () => {
          chartRaf = window.requestAnimationFrame(stepCharts)
          if (!visibleRef.current) return
          const now = performance.now()
          if (now - lastChartDraw < 1000 / 30) return
          lastChartDraw = now
          if (now - lastChartRead >= 100) {
            const chartView = readView()
            if (chartView) {
              latestChartView = chartView
              const next = (chartView.history || []).slice(-56)
              if (next.length > 1) {
                const t = chartTo.length ? Math.min(1, (now - chartT0) / 100) : 1
                chartFrom = mixSeries(chartFrom, chartTo, t)
                chartTo = next
                chartT0 = now
              }
              readCardCharts(chartView, now)
            }
            lastChartRead = now
          }
          if (chartTo.length >= 2) {
            const t = chartT0 ? Math.min(1, (now - chartT0) / 100) : 1
            const values = mixSeries(chartFrom, chartTo, t)
            drawCanvasSpark($('nxt-hud-spark'), values)
            drawCanvasSpark($('nxt-rail-spark'), values)
          }
          for (const cardCanvas of root.querySelectorAll('[data-spark-id]')) {
            const state = cardChartStates.get(cardCanvas.getAttribute('data-spark-id'))
            if (!state) continue
            const t = state.t0 ? Math.min(1, (now - state.t0) / 100) : 1
            drawCanvasSpark(cardCanvas, mixSeries(state.from, state.to, t), state.color)
          }
          drawInlineCharts(now)
        }
        stepCharts()
        const stopStage = startStage(canvas, () => stageStateRef.current, (id) => {
          focusRef.current = id
          paint(true)
        }, setHover)

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
          paint(true)
        }

        const onRootClick = (event) => {
          const target = event.target
          if (!target || !target.closest) return
          const railGroup = target.closest('[data-rail-group]')
          if (railGroup) {
            const key = railGroup.getAttribute('data-rail-group')
            railOpenRef.current = { ...railOpenRef.current, [key]: !railOpenRef.current[key] }
            paint(true)
            return
          }
          const modeButton = target.closest('[data-mode]')
          if (modeButton) {
            const picked = modeButton.getAttribute('data-mode')
            modeRef.current = picked === 'net' ? 'net' : picked === 'radar' ? 'radar' : 'office'
            paint(true)
            return
          }
          const legendButton = target.closest('[data-legend]')
          if (legendButton) {
            const picked = legendButton.getAttribute('data-legend')
            legendRef.current = picked === 'all' || picked === legendRef.current ? null : picked
            paint(true)
            return
          }
          if (target.closest('[data-cinema]')) {
            setCinema(!cinemaRef.current)
            return
          }
          if (target.closest('[data-prefs]')) {
            prefsOpenRef.current = !prefsOpenRef.current
            paint(true)
            return
          }
          if (target.closest('[data-prefs-close]')) {
            prefsOpenRef.current = false
            paint(true)
            return
          }
          const prefButton = target.closest('[data-pref]')
          if (prefButton) {
            const key = prefButton.getAttribute('data-pref')
            const raw = prefButton.getAttribute('data-pref-val')
            const next = { ...prefsRef.current }
            if (key === 'visits') next.visits = raw === '1'
            else if (key === 'actions') next.actions = raw === '1'
            else if (key === 'visitPace') next.visitPace = raw
            else if (key === 'maxVisitors') next.maxVisitors = raw === '1' ? 1 : 2
            else if (key === 'cinemaSkin') next.cinemaSkin = raw === 'cold' ? 'cold' : 'cozy'
            prefsRef.current = next
            savePrefs(next)
            paint(true)
            return
          }
          if (target.closest('[data-focus-release]')) {
            focusRef.current = null
            paint(true)
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
          paint(true)
        }

        const onKeyDown = (event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
          if (event.key === 'Escape') {
            if (prefsOpenRef.current) {
              event.preventDefault()
              prefsOpenRef.current = false
              paint(true)
              return
            }
            if (focusRef.current) {
              event.preventDefault()
              focusRef.current = null
              paint(true)
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
              paint(true)
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
            paint(true)
          }
        }
        function setHover(id) {
          const next = id || null
          if (hoverRef.current === next) return
          hoverRef.current = next
          stageStateRef.current = { ...stageStateRef.current, hover: next }
          // Update attributes in place: repainting the whole card wall on every
          // pointer move would replace the node under the cursor and flicker.
          for (const item of root.querySelectorAll('[data-id]')) {
            item.setAttribute('data-hover', item.getAttribute('data-id') === next ? '1' : '0')
          }
        }

        const onRootHover = (event) => {
          const target = event.target
          if (!target || !target.closest) return
          const item = target.closest('[data-id]')
          if (item) setHover(item.getAttribute('data-id'))
        }
        const onRootOut = (event) => {
          const target = event.target
          if (!target || !target.closest) return
          if (!target.closest('[data-id]')) return
          const next = event.relatedTarget
          if (next && next.closest && next.closest('[data-id]')) return
          setHover(null)
        }
        root.addEventListener('click', onRootClick)
        root.addEventListener('mouseover', onRootHover)
        root.addEventListener('mouseout', onRootOut)
        document.addEventListener('keydown', onKeyDown)

        return () => {
          stopStage()
          unsubscribe()
          window.clearInterval(clockTimer)
          window.cancelAnimationFrame(chartRaf)
          if (visibilityObserver) visibilityObserver.disconnect()
          document.removeEventListener('visibilitychange', onVisibilityChange)
          root.removeEventListener('click', onRootClick)
          root.removeEventListener('mouseover', onRootHover)
          root.removeEventListener('mouseout', onRootOut)
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
      // Start decoding the embedded sprites as soon as the plugin is applied;
      // opening the monitor later should not flash a placeholder character.
      ensureGirlSprites()
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

    // Non-invasive hook for the repository's Node test runner; production never
    // defines __AGENT_DECK_TEST__, so these helpers stay private.
    if (typeof globalThis !== 'undefined' && globalThis.__AGENT_DECK_TEST__) {
      Object.assign(globalThis.__AGENT_DECK_TEST__, {
        normalizePrefs,
        visitPaceFor,
        visitLimitFor,
        waitActionFor,
        DEFAULT_PREFS,
        VISIT_PACE_MULT,
        PREFS_KEY,
      })
    }

    return { inject, apply }
  },
})
