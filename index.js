/**
 * dsh-workmate — Node (host) half.
 *
 * 工作搭档：任务完成通知 + 私有知识库。
 *
 *   - 任务通知：监听 agent/status（idle ⇄ running）计时，长任务（超过阈值）
 *     结束/失败时发系统通知（PowerShell Toast）或 Webhook。
 *   - 私有知识库：扫描本地目录、分块、BM25 词频检索；注册模型工具 kb_search。
 *   - 设置持久化：插件自己的 config.json（GET/POST /wf/settings），
 *     不走宿主 settings 服务的配置客户端白名单。
 *
 * @author 芝麻 (halosb) <i@halosb.com>
 * License: MIT
 */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-workmate'

/** 依赖的服务：路由注册 + 模型工具注册。 */
export const inject = ['webServer', 'tools']

/** 本包目录下的配置文件与索引文件。 */
const CONFIG_PATH = fileURLToPath(new URL('./config.json', import.meta.url))
const INDEX_PATH = fileURLToPath(new URL('./kb-index.json', import.meta.url))

/** 出厂默认配置（与 client.js 的 DEFAULTS 保持一致）。 */
const DEFAULT_CONFIG = {
  notifyEnabled: true,
  notifyMinDurationMs: 60000,
  notifySystem: true,
  notifyWebhook: '',
  notifyOnError: true,
  notifyBackgroundOnly: true,
  soundEnabled: true,
  kbDir: '',
  kbExtensions: 'txt,md,json,yaml,yml,js,ts,jsx,tsx',
  kbChunkSize: 1000,
  kbOverlap: 100,
}

/** 校验并归一化配置；未知字段丢弃。 */
function sanitizeConfig(input) {
  const out = Object.assign({}, DEFAULT_CONFIG)
  if (input === null || typeof input !== 'object') return out
  for (const key of ['notifyEnabled', 'notifySystem', 'notifyOnError', 'notifyBackgroundOnly', 'soundEnabled']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  if (typeof input.notifyMinDurationMs === 'number' && Number.isFinite(input.notifyMinDurationMs)) {
    out.notifyMinDurationMs = Math.max(0, Math.floor(input.notifyMinDurationMs))
  }
  if (typeof input.notifyWebhook === 'string') out.notifyWebhook = input.notifyWebhook
  if (typeof input.kbDir === 'string') out.kbDir = input.kbDir
  if (typeof input.kbExtensions === 'string') out.kbExtensions = input.kbExtensions
  if (typeof input.kbChunkSize === 'number' && Number.isFinite(input.kbChunkSize)) {
    out.kbChunkSize = Math.max(100, Math.floor(input.kbChunkSize))
  }
  if (typeof input.kbOverlap === 'number' && Number.isFinite(input.kbOverlap)) {
    out.kbOverlap = Math.max(0, Math.floor(input.kbOverlap))
  }
  return out
}

async function readConfig() {
  try {
    return sanitizeConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')))
  } catch {
    return Object.assign({}, DEFAULT_CONFIG)
  }
}

// ── 私有知识库：索引 + BM25 检索 ───────────────────────────────────────────

/** 内存索引：{ chunks: [{ id, doc, text }], stats }；未索引为 null。 */
let kbIndex = null

async function loadIndex() {
  try {
    kbIndex = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
  } catch {
    kbIndex = null
  }
}

async function saveIndex() {
  if (kbIndex === null) return
  await writeFile(INDEX_PATH, JSON.stringify(kbIndex))
}

/** 把一段文本按 size/overlap 切成块，追加到 chunks（id 从当前长度续号）。 */
function chunkText(text, doc, size, overlap, chunks) {
  const step = Math.max(1, size - overlap)
  for (let i = 0; i < text.length; i += step) {
    const seg = text.slice(i, i + size)
    if (seg.trim().length < 20) continue
    chunks.push({ id: chunks.length, doc, text: seg })
    if (i + step >= text.length) break
  }
}

/** 全量扫描 kbDir，按扩展名白名单读取文本文件并分块。 */
async function reindex(config) {
  const dir = config.kbDir
  if (dir === '') {
    kbIndex = null
    return null
  }
  const exts = new Set(
    config.kbExtensions.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean),
  )
  const chunks = []
  let fileCount = 0

  async function walk(p) {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(p, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase().slice(1)
      if (!exts.has(ext)) continue
      let text
      try {
        const buf = await readFile(full)
        if (buf.length > 2 * 1024 * 1024) continue // 单文件 >2MB 跳过
        text = buf.toString('utf8')
      } catch {
        continue
      }
      fileCount += 1
      chunkText(text, relative(dir, full) || full, config.kbChunkSize, config.kbOverlap, chunks)
    }
  }

  await walk(dir)
  let wordCount = 0
  for (const chunk of chunks) wordCount += chunk.text.split(/\s+/).filter(Boolean).length
  kbIndex = {
    chunks,
    stats: {
      fileCount,
      chunkCount: chunks.length,
      wordCount,
      indexedAt: Date.now(),
      dir,
    },
  }
  try {
    await saveIndex()
  } catch {
    // 索引文件写失败不致命，仅内存索引继续可用
  }
  return kbIndex.stats
}

/** 简易分词：字母/数字/下划线（含中文等 Unicode 字符）。 */
function tokenize(text) {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []
}

/** BM25 词频打分，返回 top-limit 个块。 */
function search(query, limit = 5) {
  if (kbIndex === null || kbIndex.chunks.length === 0) {
    return { ok: false, message: '知识库未配置或未索引：请先在设置页填写索引目录并点击“重新索引”。' }
  }
  const terms = tokenize(query)
  if (terms.length === 0) return { ok: false, message: '查询为空。' }

  const chunks = kbIndex.chunks
  const n = chunks.length
  const df = new Map()
  const tfs = chunks.map(chunk => {
    const tf = new Map()
    for (const term of tokenize(chunk.text)) tf.set(term, (tf.get(term) || 0) + 1)
    for (const term of new Set(tf.keys())) df.set(term, (df.get(term) || 0) + 1)
    return tf
  })
  const avgdl = chunks.reduce((sum, c) => sum + c.text.split(/\s+/).length, 0) / Math.max(1, n)
  const k1 = 1.5
  const b = 0.75
  const scores = new Array(n).fill(0)
  for (const term of terms) {
    const d = df.get(term) || 0
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
    for (let i = 0; i < n; i++) {
      const tf = tfs[i].get(term) || 0
      if (tf === 0) continue
      const dl = chunks[i].text.split(/\s+/).length
      scores[i] += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgdl)))
    }
  }
  const top = scores
    .map((score, i) => ({ score, i }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return {
    ok: true,
    results: top.map(x => ({
      doc: chunks[x.i].doc,
      score: Number(x.score.toFixed(3)),
      snippet: chunks[x.i].text.slice(0, 600),
    })),
  }
}

/** 简易 HTML 正文提取：去 script/style、去标签、解码常见实体、压缩空白。 */
function extractText(html) {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  return withoutScripts
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 提取 <title>。 */
function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return ''
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

/** 抓取网页 → 提取正文 → 分块 → 追加进知识库索引。 */
async function captureWeb(url, config) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, message: '无效 URL。' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: '仅支持 http/https 链接。' }
  }
  let res
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'dsh-workmate/0.1' },
      redirect: 'follow',
    })
  } catch (error) {
    return { ok: false, message: `抓取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!res.ok) return { ok: false, message: `抓取失败：HTTP ${res.status}` }
  const html = await res.text()
  if (html.length > 5 * 1024 * 1024) return { ok: false, message: '页面过大（>5MB）。' }
  const title = extractTitle(html)
  const text = extractText(html)
  if (text.length < 50) return { ok: false, message: '未能提取到有效正文。' }

  const doc = `web: ${title !== '' ? title : parsed.hostname} (${parsed.href})`
  const chunks = []
  chunkText(text, doc, config.kbChunkSize, config.kbOverlap, chunks)
  if (chunks.length === 0) return { ok: false, message: '正文过短，未生成块。' }

  // 确保索引容器存在（即使没有本地目录也允许纯网页库）
  if (kbIndex === null || !Array.isArray(kbIndex.chunks)) {
    kbIndex = { chunks: [], stats: { fileCount: 0, chunkCount: 0, wordCount: 0, indexedAt: 0, dir: config.kbDir } }
  }
  const offset = kbIndex.chunks.length
  for (const chunk of chunks) chunk.id = offset + chunk.id
  kbIndex.chunks.push(...chunks)
  let wordCount = 0
  for (const chunk of kbIndex.chunks) wordCount += chunk.text.split(/\s+/).filter(Boolean).length
  kbIndex.stats = {
    fileCount: kbIndex.stats.fileCount,
    chunkCount: kbIndex.chunks.length,
    wordCount,
    indexedAt: Date.now(),
    dir: config.kbDir,
  }
  try {
    await saveIndex()
  } catch {
    // 写失败仅内存索引可用
  }
  return { ok: true, title, url: parsed.href, doc, chunkCount: chunks.length }
}

/** 会话标题：①标题服务 ②日志 title 事件 ③工作区目录名 ④会话 id。 */
function sessionLabelOf(ctx, agent, sessionId) {
  // ① 标题服务投影（UI 同源）
  try {
    const titleService = ctx.get('sessionTitle')
    if (titleService !== undefined && typeof titleService.get === 'function'
      && agent !== null && typeof agent === 'object' && agent.session !== null) {
      const snapshot = titleService.get(agent.session)
      if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.title === 'string' && snapshot.title !== '') {
        return snapshot.title
      }
    }
  } catch {
    // 服务不可用继续回退
  }
  // ② 日志最后一条 session/title 事件
  try {
    const events = agent !== null && typeof agent === 'object' && agent.session !== null
      ? agent.session.events
      : undefined
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event === null || typeof event !== 'object') continue
        if (event.type === 'session/title') {
          const payload = event.payload
          if (typeof payload === 'string' && payload !== '') return payload
          if (payload !== null && typeof payload === 'object' && typeof payload.title === 'string' && payload.title !== '') {
            return payload.title
          }
        }
      }
    }
  } catch {
    // 忽略
  }
  // ③ 工作区目录名（cwd 文件名，稳定可得）
  try {
    const meta = agent !== null && typeof agent === 'object' && agent.session !== null ? agent.session.meta : undefined
    const cwd = meta !== null && typeof meta === 'object' && typeof meta.cwd === 'string' ? meta.cwd : undefined
    if (cwd !== undefined && cwd !== '') {
      const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      if (base !== undefined && base !== '') return base
    }
  } catch {
    // 忽略
  }
  return sessionId
}

// ── 任务通知 ───────────────────────────────────────────────────────────────

/** 浏览器页面可见性（客户端心跳），用于「仅后台通知」。 */
let pageVisible = true

/** 各会话 running 开始时间。 */
const runningSince = new Map()

function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/** 播放提示音（PowerShell Console.Beep，零依赖）：done=双音"叮"，error=低音，approve=短促提醒。 */
function playSound(kind) {
  const seq = kind === 'done' ? '880,140;1175,180'
    : kind === 'error' ? '196,420'
    : '660,150;660,150'
  const parts = seq.split(';')
  const command = parts.map(p => `[console]::beep(${p})`).join(';')
  spawn('powershell', ['-NoProfile', '-Command', command], {
    stdio: 'ignore',
    windowsHide: true,
  }).on('error', () => {})
}

/** 分发通知：系统 Toast + Webhook + 音效。 */
async function notify(config, info) {
  if (config.notifyEnabled !== true) return
  if (config.notifyBackgroundOnly === true && pageVisible) return
  const rawTitle = info.title !== '' ? info.title : 'dsh-workmate'
  const title = rawTitle.length > 30 ? rawTitle.slice(0, 30) + '…' : rawTitle
  const message = `任务${info.status === 'error' ? '失败' : '完成'}，用时 ${formatDuration(info.durationMs)}`

  if (config.soundEnabled === true) playSound(info.status === 'error' ? 'error' : 'done')

  if (config.notifySystem === true) {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.BalloonTipIcon = "Info"',
      `$n.BalloonTipTitle = ${JSON.stringify(title)}`,
      `$n.BalloonTipText = ${JSON.stringify(message)}`,
      '$n.Visible = $true',
      '$n.ShowBalloonTip(10000)',
      'Start-Sleep -Seconds 11',
      '$n.Dispose()',
    ].join('; ')
    spawn('powershell', ['-NoProfile', '-STA', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', () => {})
  }

  if (config.notifyWebhook !== '') {
    try {
      await fetch(config.notifyWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: info.sessionId,
          title: info.title,
          status: info.status,
          durationMs: info.durationMs,
          message,
        }),
      })
    } catch {
      // Webhook 失败不打断主流程
    }
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

/** 收集请求体；超限返回 null。 */
async function readBody(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

export function apply(ctx) {
  // 启动时加载索引；若配置了目录则异步重建一次。
  void loadIndex()
  void readConfig().then(async (config) => {
    if (config.kbDir !== '') await reindex(config)
  })

  // 任务状态跟踪：running 计时，idle 判定长任务；error 失败通知。
  // 注意：Agent 的会话身份是 agent.id（不是 sessionId）。
  ctx.on('agent/status', (payload) => {
    const agent = payload.agent
    const sessionId = agent !== null && typeof agent === 'object' && typeof agent.id === 'string'
      ? agent.id
      : undefined
    const status = payload.status
    if (sessionId === undefined) return
    if (status === 'running') {
      runningSince.set(sessionId, Date.now())
      return
    }
    if (status === 'idle') {
      const start = runningSince.get(sessionId)
      runningSince.delete(sessionId)
      if (start === undefined) return
      const durationMs = Date.now() - start
      void readConfig().then(config => {
        if (config.notifyEnabled === true && durationMs >= config.notifyMinDurationMs) {
          void notify(config, {
            status: 'done',
            durationMs,
            sessionId,
            title: sessionLabelOf(ctx, agent, sessionId),
          })
        }
      })
    }
  })

  ctx.on('agent/error', (payload) => {
    const agent = payload.agent
    const sessionId = agent !== null && typeof agent === 'object' && typeof agent.id === 'string'
      ? agent.id
      : undefined
    if (sessionId === undefined) return
    void readConfig().then(config => {
      if (config.notifyEnabled === true && config.notifyOnError === true) {
        void notify(config, {
          status: 'error',
          durationMs: 0,
          sessionId,
          title: sessionLabelOf(ctx, agent, sessionId),
        })
      }
    })
  })

  // 审批提醒音：审批请求出现时播放提示（waterfall 观察者，透传 next）。
  ctx.on('approval/request', (req, next) => {
    void readConfig().then(config => {
      if (config.soundEnabled === true) playSound('approve')
    })
    return next()
  })

  // 模型工具：私有知识库检索（全局注册，agent 目录可见）。
  ctx.tools.register(defineTool({
    name: 'kb_search',
    description:
      'Search the private knowledge base indexed by the dsh-workmate plugin (the user\'s local documents: '
      + 'notes, code, configs). Use this when the user asks about their own documents or private materials. '
      + 'Returns up to 5 matching chunks with source file, score, and a snippet.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords, in Chinese or English.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args) {
      return Promise.resolve(search(String(args.query ?? ''), 5))
    },
  }))

  // 模型工具：抓取网页进知识库。
  ctx.tools.register(defineTool({
    name: 'web_capture',
    description:
      'Fetch a web page, extract its readable text, and add it to the private knowledge base indexed by the '
      + 'dsh-workmate plugin. Use this when the user wants to save a web page / article into their KB for later '
      + 'retrieval via kb_search. Returns the captured title, doc label, and chunk count.',
    parameters: {
      url: { type: 'string', required: true, description: 'The page URL to capture (http/https).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute(args) {
      return readConfig().then(config => captureWeb(String(args.url ?? ''), config))
    },
  }))

  // 设置路由
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wf/settings',
    handler: async (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        json(res, 200, await readConfig())
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req, 64 * 1024)
        if (body === null) { json(res, 413, { error: 'settings too large' }); return }
        let parsed
        try { parsed = JSON.parse(body.toString('utf8')) } catch { json(res, 400, { error: 'invalid JSON' }); return }
        const config = sanitizeConfig(parsed)
        try { await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2)) } catch { json(res, 500, { error: 'write failed' }); return }
        json(res, 200, config)
        return
      }
      res.writeHead(405); res.end()
    },
  }), 'dsh-workmate: /wf/settings')

  // 知识库状态 / 重新索引
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wf/kb/status',
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      json(res, 200, kbIndex === null ? { configured: false } : { configured: true, stats: kbIndex.stats })
    },
  }), 'dsh-workmate: /wf/kb/status')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wf/kb/reindex',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readBody(req, 16 * 1024)
      let payload = {}
      if (body !== null) {
        try { payload = JSON.parse(body.toString('utf8')) } catch { payload = {} }
      }
      const config = sanitizeConfig(payload.config ?? await readConfig())
      const stats = await reindex(config)
      if (stats === null) { json(res, 200, { ok: false, message: '未配置索引目录' }); return }
      json(res, 200, { ok: true, stats })
    },
  }), 'dsh-workmate: /wf/kb/reindex')

  // 浏览器可见性心跳（仅后台通知）
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/wf/visibility',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
      const body = await readBody(req, 4096)
      if (body === null) { json(res, 413, { error: 'too large' }); return }
      try {
        const parsed = JSON.parse(body.toString('utf8'))
        if (typeof parsed.visible === 'boolean') pageVisible = parsed.visible
      } catch {
        // ignore
      }
      json(res, 200, { ok: true })
    },
  }), 'dsh-workmate: /wf/visibility')
}
