/**
 * dsh-workmate — Node (host) half.
 *
 * 工作搭档：任务完成通知 + 私有知识库。
 *
 *   - 任务通知：监听 agent/status（idle ⇄ running）计时，长任务（超过阈值）
 *     结束/失败时发系统通知（PowerShell Toast）或 Webhook。
 *   - 私有知识库：扫描本地目录、分块、BM25 词频检索；注册模型工具 kb_search。
 *   - 设置持久化：插件自己的 config.json（GET/POST /wf/settings）。
 *   - 数据落盘在 DSH 数据目录（<DSH_HOME>/plugin-data/<profile>/dsh-workmate/），
 *     不再写进 pnpm 管理的 node_modules 包目录——更新/重装不会清空数据。
 *
 * @author 芝麻 (halosb) <i@halosb.com>
 * License: MIT
 */
import { readFile, writeFile, readdir, mkdir, rename, stat, copyFile, rm } from 'node:fs/promises'
import { join, extname, relative, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { lookup } from 'node:dns/promises'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-workmate'

/** 依赖的服务：路由注册 + 模型工具注册。 */
export const inject = ['webServer', 'tools']

/**
 * 数据目录：<DSH_HOME>/plugin-data/<profile>/dsh-workmate/
 * 放在 pnpm 拥有的包目录之外，`dsh plugin update/remove` 不会碰到它。
 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 从包路径推导 DSH_HOME 与 profile。插件装在
 * `<DSH_HOME>\profiles\<profile>\node_modules\<包名>\`，这条路比环境变量可靠：
 * 实测宿主进程里只有 DSH_HOME、**没有** DSH_PROFILE，只靠环境变量会让所有
 * profile 都落到 plugin-data\default\ 上互相覆盖。
 */
function deriveProfilePaths(packageDir) {
  const matched = /^(.*)[\\/]profiles[\\/]([^\\/]+)[\\/]node_modules[\\/]/i.exec(packageDir)
  return matched === null ? null : { home: matched[1], profile: matched[2] }
}
const DERIVED = deriveProfilePaths(PACKAGE_DIR)
const DSH_HOME = DERIVED !== null
  ? DERIVED.home
  : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const PROFILE = DERIVED !== null
  ? DERIVED.profile
  : (typeof process.env.DSH_PROFILE === 'string' && process.env.DSH_PROFILE !== '' ? process.env.DSH_PROFILE : 'default')
const DATA_DIR = join(DSH_HOME, 'plugin-data', PROFILE, 'dsh-workmate')
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const INDEX_PATH = join(DATA_DIR, 'kb-index.json')

/**
 * 0.3.0 在拿不到 profile 名时把数据写进了 plugin-data/default/，这里按需搬回当前 profile。
 * 只搬不覆盖：新位置已有的文件保留。
 */
async function migrateDefaultProfileData() {
  const legacyDir = join(DSH_HOME, 'plugin-data', 'default', 'dsh-workmate')
  if (legacyDir === DATA_DIR) return
  try {
    await stat(legacyDir)
  } catch {
    return // 没有旧目录
  }
  await mkdir(DATA_DIR, { recursive: true })
  for (const file of ['config.json', 'kb-index.json']) {
    const target = join(DATA_DIR, file)
    try {
      await stat(target)
      continue
    } catch { /* 目标不存在才搬 */ }
    try {
      await copyFile(join(legacyDir, file), target)
      await rm(join(legacyDir, file), { force: true })
      warnings.push(`已把 ${file} 从 plugin-data/default 迁移到 ${DATA_DIR}`)
    } catch { /* 单个失败忽略 */ }
  }
}

/** 老版本把数据写在包目录里；首次启动搬到数据目录（不覆盖已有新文件）。 */
async function migrateLegacyData() {
  await mkdir(DATA_DIR, { recursive: true })
  for (const file of ['config.json', 'kb-index.json']) {
    const legacy = join(PACKAGE_DIR, file)
    const target = join(DATA_DIR, file)
    try {
      await stat(target)
      continue // 新位置已有数据，保留它
    } catch {
      // 目标不存在，尝试迁移
    }
    try {
      await stat(legacy)
    } catch {
      continue // 没有老数据
    }
    try {
      await copyFile(legacy, target)
      await rm(legacy, { force: true })
      warnings.push(`已把 ${file} 从插件目录迁移到 ${DATA_DIR}`)
    } catch (error) {
      warnings.push(`迁移 ${file} 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** 运行期诊断信息（读失败、迁移、跳过等），经 /wf/kb/status 暴露给设置页。 */
const warnings = []
function warn(message) {
  if (warnings.length < 20) warnings.push(message)
}

/** 原子写 JSON：先写同目录临时文件再 rename，避免半截文件；并保留上一版 .bak。 */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temp, JSON.stringify(value, null, 2))
    try {
      await copyFile(path, `${path}.bak`)
    } catch {
      // 首次写入没有旧文件可备份
    }
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

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

/** 校验并归一化配置；未知字段丢弃。重叠必须小于分块大小，否则会出现逐字切块。 */
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
  // 关键：overlap >= chunkSize 会让步长退化为 1，1MB 文本能切出上百万块。
  if (out.kbOverlap >= out.kbChunkSize) out.kbOverlap = Math.max(0, out.kbChunkSize - 1)
  return out
}

/** 配置内存缓存：事件路径不再每次读盘。 */
let cachedConfig = null

async function readConfig() {
  if (cachedConfig !== null) return cachedConfig
  try {
    cachedConfig = sanitizeConfig(JSON.parse(await readFile(CONFIG_PATH, 'utf8')))
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      warn(`config.json 读取失败（已回退默认值）：${error instanceof Error ? error.message : String(error)}`)
    }
    cachedConfig = Object.assign({}, DEFAULT_CONFIG)
  }
  return cachedConfig
}

async function writeConfig(config) {
  await writeJsonAtomic(CONFIG_PATH, config)
  cachedConfig = config
}

// ── 私有知识库：索引 + BM25 检索 ───────────────────────────────────────────

/**
 * 内存索引：{ version, chunks: [{ id, doc, text, addedAt? }], files, stats }。
 * `files` 记录每个相对路径的 { mtimeMs, size }，用于增量重建。
 */
let kbIndex = null

/** BM25 预计算缓存（tf/df/dl/avgdl 只算一次，索引变化时置空）。 */
let bm25 = null

/** 当前索引是否处于可用状态（形状校验，避免坏文件在检索时抛异常）。 */
function indexIsUsable(index) {
  return index !== null && typeof index === 'object' && Array.isArray(index.chunks)
}

function invalidateSearch() {
  bm25 = null
}

async function loadIndex() {
  try {
    const parsed = JSON.parse(await readFile(INDEX_PATH, 'utf8'))
    if (!indexIsUsable(parsed)) {
      warn('kb-index.json 形状不正确（缺少 chunks 数组），已忽略。')
      kbIndex = null
    } else {
      kbIndex = parsed
      if (parsed.files === undefined) parsed.files = {}
    }
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code !== 'ENOENT') {
      warn(`kb-index.json 读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
    kbIndex = null
  }
  invalidateSearch()
}

async function saveIndex() {
  if (kbIndex === null) return
  try {
    await writeJsonAtomic(INDEX_PATH, kbIndex)
  } catch (error) {
    warn(`kb-index.json 写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 把一段文本按 size/overlap 切成块，追加到 chunks（id 从当前长度续号）。 */
function chunkText(text, doc, size, overlap, chunks) {
  const safeSize = Math.max(100, Math.floor(size) || 1000)
  const safeOverlap = Math.max(0, Math.min(Math.floor(overlap) || 0, safeSize - 1))
  const step = Math.max(1, safeSize - safeOverlap)
  for (let i = 0; i < text.length; i += step) {
    const seg = text.slice(i, i + safeSize)
    if (seg.trim().length < 20) continue
    chunks.push({ id: chunks.length, doc, text: seg })
    if (i + step >= text.length) break
  }
}

/** 目录遍历时跳过的重目录（索引仓库根目录时的常见噪声）。 */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target'])

/**
 * 文本解码：优先 UTF-8（严格模式），失败则按 GB18030 解，避免 Windows 中文
 * 文档被解成 U+FFFD 乱码后仍入库污染检索。
 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.subarray(3).toString('utf8')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf)
    } catch {
      return buf.toString('utf8')
    }
  }
}

/** 重建索引：全量/增量扫描 kbDir；同时合并保留旧索引中的网页捕获（web: 前缀 chunk）。 */
async function reindex(config) {
  const dir = config.kbDir
  // 合并逻辑：web_capture 抓的网页文档不因重建而丢失。
  const keptWeb = indexIsUsable(kbIndex)
    ? kbIndex.chunks.filter(chunk => typeof chunk.doc === 'string' && chunk.doc.startsWith('web: '))
    : []

  if (dir === '') {
    if (keptWeb.length === 0) {
      kbIndex = null
      invalidateSearch()
      return null
    }
    const chunks = keptWeb.map((chunk, i) => ({
      id: i,
      doc: chunk.doc,
      text: chunk.text,
      ...(typeof chunk.addedAt === 'number' ? { addedAt: chunk.addedAt } : {}),
    }))
    kbIndex = {
      version: 2,
      chunks,
      files: {},
      stats: {
        fileCount: 0,
        chunkCount: chunks.length,
        wordCount: countWords(chunks),
        indexedAt: Date.now(),
        dir: '',
      },
    }
    await saveIndex()
    invalidateSearch()
    return kbIndex.stats
  }

  const exts = new Set(
    config.kbExtensions.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean),
  )
  // 增量：上一版按相对路径保存的块与指纹。
  const previousFiles = indexIsUsable(kbIndex) && kbIndex.files !== null && typeof kbIndex.files === 'object'
    ? kbIndex.files
    : {}
  const previousChunks = new Map()
  if (indexIsUsable(kbIndex)) {
    for (const chunk of kbIndex.chunks) {
      if (typeof chunk.doc !== 'string' || chunk.doc.startsWith('web: ')) continue
      const list = previousChunks.get(chunk.doc)
      if (list === undefined) previousChunks.set(chunk.doc, [chunk])
      else list.push(chunk)
    }
  }

  const chunks = []
  const files = {}
  let fileCount = 0
  let reusedCount = 0
  let skippedSymlinks = 0

  async function walk(p) {
    let entries
    try {
      entries = await readdir(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(p, entry.name)
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1 // 符号链接/目录联接：跳过，避免环与重复
        continue
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase().slice(1)
      if (!exts.has(ext)) continue
      // 先 stat 判断体积，避免把超大文件整个读进内存再丢弃。
      let info
      try {
        info = await stat(full)
      } catch {
        continue
      }
      if (info.size > 2 * 1024 * 1024) continue // 单文件 >2MB 跳过
      const doc = relative(dir, full) || full
      const fingerprint = { mtimeMs: info.mtimeMs, size: info.size }
      const priorFingerprint = previousFiles[doc]
      const priorChunks = previousChunks.get(doc)
      if (priorChunks !== undefined && priorFingerprint !== undefined
        && priorFingerprint.mtimeMs === fingerprint.mtimeMs && priorFingerprint.size === fingerprint.size) {
        // 未变更：复用已有块，跳过读盘与分块。
        for (const chunk of priorChunks) chunks.push({ id: 0, doc: chunk.doc, text: chunk.text })
        files[doc] = fingerprint
        fileCount += 1
        reusedCount += 1
        continue
      }
      let text
      try {
        text = decodeText(await readFile(full))
      } catch {
        continue
      }
      files[doc] = fingerprint
      fileCount += 1
      chunkText(text, doc, config.kbChunkSize, config.kbOverlap, chunks)
    }
  }

  await walk(dir)

  // 合并本地扫描 + 保留的网页捕获，重新编号 id（captureWeb 依 chunk 数续号）。
  const merged = [
    ...chunks.map((chunk, i) => ({ id: i, doc: chunk.doc, text: chunk.text })),
    ...keptWeb.map((chunk, i) => ({
      id: chunks.length + i,
      doc: chunk.doc,
      text: chunk.text,
      ...(typeof chunk.addedAt === 'number' ? { addedAt: chunk.addedAt } : {}),
    })),
  ]
  kbIndex = {
    version: 2,
    chunks: merged,
    files,
    stats: {
      fileCount,
      chunkCount: merged.length,
      wordCount: countWords(merged),
      indexedAt: Date.now(),
      dir,
      reusedCount,
      skippedSymlinks,
    },
  }
  await saveIndex()
  invalidateSearch()
  return kbIndex.stats
}

/** 词数统计（与检索分词一致，中文不再退化成"块数"）。 */
function countWords(chunks) {
  let total = 0
  for (const chunk of chunks) total += tokenize(chunk.text).length
  return total
}

/**
 * 分词：拉丁文按词、CJK 按 bigram。
 * 中文没有空格，按"最大字母连续段"切会把整句当成一个词导致查不到；bigram 让
 * "私有知识库" → 私有/有知/知识/识库，查询侧同样切分即可命中。
 */
const CJK_CHAR = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/

function tokenize(text) {
  const out = []
  const matches = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu)
  if (matches === null) return out
  for (const match of matches) {
    let buffer = ''
    let bufferIsCjk = null
    const flush = () => {
      if (buffer === '') return
      if (bufferIsCjk === true) {
        for (let i = 0; i < buffer.length; i++) {
          out.push(i + 1 < buffer.length ? buffer.slice(i, i + 2) : buffer.slice(i, i + 1))
        }
      } else {
        out.push(buffer)
      }
      buffer = ''
    }
    for (const char of match) {
      const isCjk = CJK_CHAR.test(char)
      if (bufferIsCjk === null) {
        bufferIsCjk = isCjk
        buffer = char
        continue
      }
      if (isCjk !== bufferIsCjk) {
        flush()
        bufferIsCjk = isCjk
      }
      buffer += char
    }
    flush()
  }
  return out
}

/** 构建并缓存 BM25 统计（tf/df/dl/avgdl），索引不变时不重复计算。 */
function ensureBm25() {
  if (!indexIsUsable(kbIndex)) return null
  if (bm25 !== null && bm25.source === kbIndex.chunks && bm25.size === kbIndex.chunks.length) return bm25
  const chunks = kbIndex.chunks
  const n = chunks.length
  const df = new Map()
  const tfs = new Array(n)
  const dl = new Array(n)
  for (let i = 0; i < n; i++) {
    const tokens = tokenize(chunks[i].text)
    dl[i] = tokens.length
    const tf = new Map()
    for (const term of tokens) tf.set(term, (tf.get(term) || 0) + 1)
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
    tfs[i] = tf
  }
  let totalDl = 0
  for (let i = 0; i < n; i++) totalDl += dl[i]
  bm25 = { source: chunks, size: n, n, df, tfs, dl, avgdl: Math.max(1, totalDl / Math.max(1, n)) }
  return bm25
}

/** BM25 词频打分，返回 top-limit 个块。 */
function search(query, limit = 5) {
  if (kbIndex === null || kbIndex.chunks.length === 0) {
    return { ok: false, message: '知识库未配置或未索引：请先在设置页填写索引目录并点击“重新索引”。' }
  }
  const terms = tokenize(query)
  if (terms.length === 0) return { ok: false, message: '查询为空。' }

  const stats = ensureBm25()
  if (stats === null) return { ok: false, message: '知识库索引不可用。' }
  const { n, df, tfs, dl, avgdl } = stats
  const chunks = kbIndex.chunks
  const k1 = 1.5
  const b = 0.75
  const scores = new Array(n).fill(0)
  for (const term of terms) {
    const d = df.get(term) || 0
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
    for (let i = 0; i < n; i++) {
      const tf = tfs[i].get(term) || 0
      if (tf === 0) continue
      scores[i] += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl[i]) / avgdl)))
    }
  }
  const top = scores
    .map((score, i) => ({ score, i }))
    .filter(x => x.score > 0)
    .sort((a, b2) => b2.score - a.score)
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

/**
 * 列出最近通过 web_capture 捕获的网页文档（按 doc 聚合、最新在前）。
 * 让 AI 直接"告知"用户知识库里存了哪些网页，无需盲搜。
 */
function listRecentCaptures(limit = 10) {
  if (!indexIsUsable(kbIndex) || kbIndex.chunks.length === 0) {
    return { ok: false, message: '知识库为空：还没有通过 web_capture 捕获的内容。' }
  }
  const byDoc = new Map()
  for (const chunk of kbIndex.chunks) {
    if (typeof chunk.doc !== 'string' || !chunk.doc.startsWith('web: ')) continue
    let entry = byDoc.get(chunk.doc)
    if (entry === undefined) {
      const title = chunk.doc.slice(5).replace(/\s*\([^)]*\)\s*$/, '').trim()
      const urlMatch = /\((https?:\/\/[^)]+)\)\s*$/.exec(chunk.doc)
      entry = {
        doc: chunk.doc,
        title,
        url: urlMatch === null ? '' : urlMatch[1],
        chunkCount: 0,
        addedAt: typeof chunk.addedAt === 'number' ? chunk.addedAt : 0,
      }
      byDoc.set(chunk.doc, entry)
    }
    entry.chunkCount += 1
    if (typeof chunk.addedAt === 'number' && chunk.addedAt > entry.addedAt) entry.addedAt = chunk.addedAt
  }
  const captures = [...byDoc.values()]
    .sort((a, b) => b.addedAt - a.addedAt)
    .slice(0, Math.max(1, Math.min(limit, 50)))
  return {
    ok: true,
    indexFile: INDEX_PATH,
    count: captures.length,
    captures,
  }
}

/** 归一化 URL 便于比较：去末尾斜杠、去 hash、统一小写主机名。 */
function normalizeUrl(value) {
  try {
    const parsed = new URL(value)
    parsed.hash = ''
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

/**
 * 删除一条或多条网页捕获（只删 web_capture 抓的，本地文档由重新索引决定）。
 * 支持传完整 URL、标题，或一段能唯一匹配的片段。
 */
function forgetCapture(target) {
  if (!indexIsUsable(kbIndex) || kbIndex.chunks.length === 0) {
    return { ok: false, message: '知识库为空。' }
  }
  const needle = typeof target === 'string' ? target.trim() : ''
  if (needle === '') return { ok: false, message: '请提供要删除的网页 URL 或标题。' }
  const normalizedNeedle = normalizeUrl(needle)
  const removedDocs = new Set()
  let removedChunks = 0
  const kept = []
  for (const chunk of kbIndex.chunks) {
    if (typeof chunk.doc !== 'string' || !chunk.doc.startsWith('web: ')) {
      kept.push(chunk)
      continue
    }
    const urlMatch = /\((https?:\/\/[^)]+)\)\s*$/.exec(chunk.doc)
    const url = urlMatch === null ? '' : urlMatch[1]
    const title = chunk.doc.slice(5).replace(/\s*\([^)]*\)\s*$/, '').trim()
    const hit = (url !== '' && normalizeUrl(url) === normalizedNeedle)
      || title === needle
      || needle.length >= 4 && ((url !== '' && url.includes(needle)) || title.includes(needle))
    if (hit) {
      removedDocs.add(chunk.doc)
      removedChunks += 1
      continue
    }
    kept.push(chunk)
  }
  if (removedChunks === 0) {
    const available = listRecentCaptures(20)
    return {
      ok: false,
      message: '没有匹配的网页捕获。',
      captures: available.ok === true ? available.captures.map(c => c.url) : [],
    }
  }
  kbIndex.chunks = kept.map((chunk, i) => Object.assign({}, chunk, { id: i }))
  kbIndex.stats = Object.assign({}, kbIndex.stats, {
    chunkCount: kbIndex.chunks.length,
    wordCount: countWords(kbIndex.chunks),
    indexedAt: Date.now(),
  })
  invalidateSearch()
  return {
    ok: true,
    removedDocs: [...removedDocs],
    removedChunks,
    remainingChunks: kbIndex.chunks.length,
    indexFile: INDEX_PATH,
  }
}

/**
 * 正文提取：先锁定正文容器，再剥噪声标签，最后解码实体。
 *
 * 旧实现是"去 script/style → 去所有标签 → 压成一行"，结果把侧边栏导航
 * （"首页 文库 数据统计…"）和页脚一起收进库，还把整篇压成一个没有段落的大字符串。
 * 导出以便 tests/host-smoke.mjs 用夹具直接验证。
 */
export function extractText(html) {
  const picked = pickContentHtml(html)
  const stripped = stripNoiseElements(picked.content, picked.pageLevel)
  // 块级收尾转换行：段落边界保留，行内标签转空格（避免把词切开）
  const withBreaks = stripped
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/blockquote|\/pre|\/dd|\/dt)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const lines = decodeEntities(withBreaks)
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    // 丢掉空行与纯标点行（'•'、'|'、'—' 这类装饰性分隔符）
    .filter(line => line !== '' && /[\p{L}\p{N}]/u.test(line))
  // 段落级去重：不少站点把摘要卡与正文放在同一容器里，重复段落只留首次
  const seen = new Set()
  const kept = []
  for (const line of lines) {
    if (line.length > 40) {
      if (seen.has(line)) continue
      seen.add(line)
    }
    kept.push(line)
  }
  return kept.join('\n')
}

/** 噪声标签：脚本、样式、导航、侧栏、页脚、表单等。 */
const NOISE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'aside', 'footer', 'form', 'button', 'select', 'textarea']

/** 正文容器：article / main / [role=main] 取最长的一块；都太短则退回 body。 */
function pickContentHtml(html) {
  const patterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<div\b[^>]*\brole\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/div>/gi,
  ]
  for (const pattern of patterns) {
    let best = ''
    for (const matched of html.matchAll(pattern)) {
      if (matched[1].length > best.length) best = matched[1]
    }
    if (best.trim().length > 400) return { content: best, pageLevel: false }
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)
  if (body !== null) return { content: body[1], pageLevel: true }
  return { content: html, pageLevel: true }
}

/** 剥掉噪声标签；pageLevel 时连 <header> 一起去掉（页面级头部通常是站点导航）。 */
function stripNoiseElements(html, pageLevel) {
  let out = html.replace(/<!--[\s\S]*?-->/g, ' ')
  const tags = pageLevel ? NOISE_TAGS.concat('header') : NOISE_TAGS
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
  }
  return out.replace(/<(?:script|style|svg|iframe|link|meta|br|hr|img|source|track)\b[^>]*\/?>/gi, ' ')
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
}

function safeCodePoint(value) {
  if (!Number.isFinite(value) || value < 0 || value > 0x10FFFF) return ''
  try {
    return String.fromCodePoint(value)
  } catch {
    return ''
  }
}

/** 提取 <title>。导出以便测试。 */
export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return ''
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ── web_capture 的网络防护 ─────────────────────────────────────────────────

/** 抓取上限、超时与可接受的正文类型。 */
const CAPTURE_TIMEOUT_MS = 15000
const CAPTURE_MAX_BYTES = 5 * 1024 * 1024
const CAPTURE_MAX_REDIRECTS = 5
const CAPTURE_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'text/markdown']

function isLoopbackAddress(address) {
  const value = address.toLowerCase()
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

function isPrivateAddress(address) {
  const value = address.toLowerCase()
  if (value === '::1' || value === '::') return true
  if (value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd')) return true
  const v4 = value.startsWith('::ffff:') ? value.slice(7) : value
  const parts = v4.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/** 目标主机必须是公网地址：拒绝回环/私网/链路本地，防御 SSRF 与内网探测。 */
async function assertPublicHost(hostname) {
  const literal = hostname.replace(/^\[|\]$/g, '')
  if (isLoopbackAddress(literal) || isPrivateAddress(literal)) {
    return '拒绝抓取本机或内网地址。'
  }
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) return null // 已是公网 IP 字面量
  let records
  try {
    records = await lookup(literal, { all: true })
  } catch (error) {
    return `域名解析失败：${error instanceof Error ? error.message : String(error)}`
  }
  if (records.some(record => isPrivateAddress(record.address))) {
    return '拒绝抓取解析到内网地址的主机。'
  }
  return null
}

/** 逐跳跟随重定向，每一跳都重新做主机与协议校验。 */
async function fetchGuarded(url, signal) {
  let current = url
  for (let hop = 0; hop <= CAPTURE_MAX_REDIRECTS; hop++) {
    const parsed = new URL(current)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: '仅支持 http/https 链接。' }
    }
    const blocked = await assertPublicHost(parsed.hostname)
    if (blocked !== null) return { ok: false, message: blocked }
    const res = await fetch(current, {
      headers: { 'user-agent': 'dsh-workmate/0.2' },
      redirect: 'manual',
      signal,
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (location === null) return { ok: false, message: `抓取失败：HTTP ${res.status}` }
      current = new URL(location, current).href
      continue
    }
    return { ok: true, res, finalUrl: current }
  }
  return { ok: false, message: '重定向次数过多。' }
}

/** 限制体积的流式读取：超限立即中断，而不是先读完再判断。 */
async function readCapped(res, cap, signal) {
  const body = res.body
  if (body === null) return { ok: true, text: await res.text() }
  const reader = body.getReader()
  const parts = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => {})
        return { ok: false, message: '页面过大（>5MB）。' }
      }
      parts.push(value)
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, message: '抓取超时（15 秒）。' }
    return { ok: false, message: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return { ok: true, text: decodeText(Buffer.from(merged)) }
}

/** 抓取网页 → 提取正文 → 分块 → 写入知识库索引（同一 URL 覆盖式更新）。 */
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS)
  let html
  let finalUrl = parsed.href
  try {
    const fetched = await fetchGuarded(parsed.href, controller.signal)
    if (fetched.ok !== true) return { ok: false, message: fetched.message }
    const res = fetched.res
    finalUrl = fetched.finalUrl
    if (!res.ok) return { ok: false, message: `抓取失败：HTTP ${res.status}` }
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType !== '' && !CAPTURE_CONTENT_TYPES.some(type => contentType.includes(type))) {
      return { ok: false, message: `不支持的内容类型：${contentType.split(';')[0]}` }
    }
    const read = await readCapped(res, CAPTURE_MAX_BYTES, controller.signal)
    if (read.ok !== true) return { ok: false, message: read.message }
    html = read.text
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, message: '抓取超时（15 秒）。' }
    return { ok: false, message: `抓取失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
  }

  const title = extractTitle(html)
  const text = extractText(html)
  if (text.length < 50) return { ok: false, message: '未能提取到有效正文。' }

  const doc = `web: ${title !== '' ? title : parsed.hostname} (${finalUrl})`
  const chunks = []
  chunkText(text, doc, config.kbChunkSize, config.kbOverlap, chunks)
  if (chunks.length === 0) return { ok: false, message: '正文过短，未生成块。' }

  // 确保索引容器存在（即使没有本地目录也允许纯网页库）
  if (!indexIsUsable(kbIndex)) {
    kbIndex = { version: 2, chunks: [], files: {}, stats: { fileCount: 0, chunkCount: 0, wordCount: 0, indexedAt: 0, dir: config.kbDir } }
  }
  // 同一 URL 重新抓取：覆盖旧内容，避免 kb_recent 出现重复条目、索引线性膨胀。
  const suffix = `(${finalUrl})`
  kbIndex.chunks = kbIndex.chunks.filter(chunk => !(typeof chunk.doc === 'string' && chunk.doc.startsWith('web: ') && chunk.doc.endsWith(suffix)))

  const offset = kbIndex.chunks.length
  const now = Date.now()
  for (const chunk of chunks) {
    chunk.id = offset + chunk.id
    chunk.addedAt = now // 捕获时间戳，供 kb_recent 排序
  }
  kbIndex.chunks.push(...chunks)
  kbIndex.stats = {
    fileCount: kbIndex.stats.fileCount,
    chunkCount: kbIndex.chunks.length,
    wordCount: countWords(kbIndex.chunks),
    indexedAt: Date.now(),
    dir: config.kbDir,
  }
  await saveIndex()
  invalidateSearch()
  return {
    ok: true,
    title,
    url: finalUrl,
    doc,
    chunkCount: chunks.length,
    indexFile: INDEX_PATH,          // 索引落盘位置（AI 可直接告知用户）
    totalChunks: kbIndex.chunks.length,
    howToRetrieve: '在 kb_search 里搜 "' + (title !== '' ? title : parsed.hostname) + '" 即可取回这段内容。',
  }
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

/**
 * 浏览器页面可见性（客户端心跳）。存时间戳而不是布尔值：
 * 页面被直接关掉不会再有 hidden 心跳，无限期沿用旧值会把通知永久静音。
 */
const VISIBILITY_TTL_MS = 90000
let pageVisibleAt = 0

function markPageVisible(visible) {
  pageVisibleAt = visible ? Date.now() : 0
}

function pageIsVisible() {
  return pageVisibleAt !== 0 && Date.now() - pageVisibleAt < VISIBILITY_TTL_MS
}

/** 各会话 running 开始时间。 */
const runningSince = new Map()

/** 刚报过失败的会话：用于抑制随后 idle 事件误报"任务完成"。 */
const recentErrors = new Map()
const ERROR_SUPPRESS_MS = 30000

/** 同一 agent 同一状态的重复事件去重窗口。 */
const lastNotified = new Map()
const DEDUPE_MS = 3000

function formatDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

/**
 * 提示音：常驻一个 PowerShell 从 stdin 逐行执行 beep 命令。
 * 原来每次响都新起一个进程（事件密集时进程抖动），且非 Windows 静默失效。
 */
let soundProc = null
let soundBuffer = ''

const SOUND_HELPERS = 'while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }; if ($line -ne "") { try { Invoke-Expression $line } catch {} } }'

function ensureSoundProc() {
  if (soundProc !== null && soundProc.exitCode === null && soundProc.killed !== true) return soundProc
  soundProc = spawn('powershell', ['-NoProfile', '-Command', SOUND_HELPERS], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
  })
  soundProc.on('error', () => { soundProc = null })
  soundProc.on('exit', () => { soundProc = null })
  soundProc.unref?.()
  return soundProc
}

/** 播放提示音（PowerShell Console.Beep，零依赖）：done=双音"叮"，error=低音，approve=短促提醒。 */
function playSound(kind) {
  if (process.platform !== 'win32') return
  const seq = kind === 'done' ? '880,140;1175,180'
    : kind === 'error' ? '196,420'
    : '660,150;660,150'
  const command = seq.split(';').map(p => `[console]::beep(${p})`).join(';')
  try {
    const proc = ensureSoundProc()
    if (proc === null || proc.stdin === null) {
      spawn('powershell', ['-NoProfile', '-Command', command], { stdio: 'ignore', windowsHide: true }).on('error', () => {})
      return
    }
    proc.stdin.write(command + '\n')
  } catch {
    // 音效失败不影响通知
  }
}

function disposeSound() {
  if (soundProc === null) return
  try {
    soundProc.stdin?.end()
    soundProc.kill()
  } catch {
    // 忽略
  }
  soundProc = null
}

/**
 * Windows Toast。标题与正文经**环境变量**传递，绝不拼进脚本文本：
 * PowerShell 双引号串里的 $(...) 会执行，而标题来自会话标题/工作区目录名；
 * 另外 JSON 的 \" 转义在 PowerShell 里不是转义，含引号的标题会让整段脚本语法错误。
 */
function showToast(title, message) {
  if (process.platform !== 'win32') return
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    '$n.BalloonTipIcon = "Info"',
    '$n.BalloonTipTitle = $env:WM_TITLE',
    '$n.BalloonTipText = $env:WM_MESSAGE',
    '$n.Visible = $true',
    '$n.ShowBalloonTip(10000)',
    'Start-Sleep -Seconds 11',
    '$n.Dispose()',
  ].join('; ')
  spawn('powershell', ['-NoProfile', '-STA', '-Command', script], {
    stdio: 'ignore',
    windowsHide: true,
    env: Object.assign({}, process.env, { WM_TITLE: title, WM_MESSAGE: message }),
  }).on('error', () => {})
}

/** 分发通知：系统 Toast + Webhook + 音效。 */
async function notify(config, info) {
  if (config.notifyEnabled !== true) return
  if (config.notifyBackgroundOnly === true && pageIsVisible()) return
  const rawTitle = info.title !== '' ? info.title : 'dsh-workmate'
  const title = rawTitle.length > 30 ? rawTitle.slice(0, 30) + '…' : rawTitle
  const message = `任务${info.status === 'error' ? '失败' : '完成'}，用时 ${formatDuration(info.durationMs)}`

  if (config.notifySystem === true) showToast(title, message)

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
        signal: AbortSignal.timeout(10000),
      })
    } catch {
      // Webhook 失败不打断主流程
    }
  }
}

// ── apply ──────────────────────────────────────────────────────────────────

/** 收集请求体；超限立即销毁连接（否则客户端仍在发送，socket 悬挂）。 */
async function readBody(req, cap) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > cap) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** 回环地址判定（Host 栅栏与来源校验共用）。 */
function isLoopbackHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return value === 'localhost' || value === '::1' || value.startsWith('127.')
}

/**
 * 请求准入。优先用编排里的 `connection` 服务（Host/Origin 栅栏 + 浏览器会话认证，
 * 与官方 open-in-app 等路由属主同一套策略）；服务不可用时退化为自带的回环栅栏。
 * @returns 拒绝时返回 HTTP 状态码，放行返回 undefined。
 */
function requestRejection(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      const code = connection.requestRejection(req)
      if (code !== undefined) return code
      return undefined
    }
  } catch {
    // 服务不可用，走自带栅栏
  }
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return 403
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 403
  if (req.headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  const remote = req.socket === null || req.socket === undefined ? undefined : req.socket.remoteAddress
  if (typeof remote === 'string' && remote !== '' && !isLoopbackAddress(remote)) return 403
  return undefined
}

/** 写请求必须声明 JSON：阻止浏览器用简单请求跨站提交（免预检的那类）。 */
function contentTypeAllowed(req) {
  const type = req.headers['content-type']
  if (typeof type !== 'string') return false
  return type.toLowerCase().includes('application/json')
}

/**
 * 注册一条受保护的路由。
 * @param ctx - 插件上下文。
 * @param path - 路由绝对路径。
 * @param handler - 已通过准入检查的处理函数。
 */
function registerRoute(ctx, path, handler) {
  return ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      const rejection = requestRejection(ctx, req)
      if (rejection !== undefined) {
        json(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      if (req.method === 'POST' && !contentTypeAllowed(req)) {
        json(res, 415, { error: 'expected application/json' })
        return
      }
      await handler(req, res)
    },
  }), `dsh-workmate: ${path}`)
}

export function apply(ctx) {
  // 启动顺序：迁移数据 → 读索引 → 读配置 →（配置了目录才）重建。
  // 必须串行：原来 loadIndex 与 reindex 并发，reindex 会在索引还没读完时把
  // "本地扫描 + 空" 当成合并结果写回磁盘，直接清空网页库。
  const ready = (async () => {
    await migrateDefaultProfileData()
    await migrateLegacyData()
    await loadIndex()
    await readConfig()
  })()

  void ready.then(async () => {
    const config = await readConfig()
    if (config.kbDir !== '') await reindex(config)
  }).catch(error => {
    warn(`启动索引失败：${error instanceof Error ? error.message : String(error)}`)
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
      // 失败标记必须在任何提前返回之前消费掉：失败路径已经删掉了计时，
      // 若先按 start === undefined 返回，标记会留到下一次正常任务，
      // 把那次真实的"完成"通知也一起压掉。
      const errorAt = recentErrors.get(sessionId)
      if (errorAt !== undefined && Date.now() - errorAt < ERROR_SUPPRESS_MS) {
        recentErrors.delete(sessionId)
        return
      }
      if (start === undefined) return
      const durationMs = Date.now() - start
      void readConfig().then(config => {
        if (config.soundEnabled === true) playSound('done')
        if (config.notifyEnabled === true && durationMs >= config.notifyMinDurationMs) {
          if (isDuplicate(sessionId, 'done')) return
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
    // 记下失败，并清掉计时：否则紧随其后的 idle 会把同一次失败再报一遍"完成"。
    recentErrors.set(sessionId, Date.now())
    const start = runningSince.get(sessionId)
    runningSince.delete(sessionId)
    const durationMs = start === undefined ? 0 : Date.now() - start
    void readConfig().then(config => {
      if (config.soundEnabled === true) playSound('error')
      if (config.notifyEnabled === true && config.notifyOnError === true) {
        if (isDuplicate(sessionId, 'error')) return
        void notify(config, {
          status: 'error',
          durationMs,
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

  // 提问表单提示音：AI 调用 ask_user_question（多选/复选/选项问题表单）时播放提示。
  // tools/execute 是 around-dispatch 瀑布，必须透传 next()，不得吞掉结果。
  ctx.on('tools/execute', (exec, next) => {
    if (exec !== null && typeof exec === 'object' && exec.name === 'ask_user_question') {
      void readConfig().then(config => {
        if (config.soundEnabled === true) playSound('approve')
      })
    }
    return next()
  })

  ctx.effect(() => () => disposeSound(), 'dsh-workmate: sound process')

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
      return ready.then(() => search(String(args.query ?? ''), 5))
    },
  }))

  // 模型工具：抓取网页进知识库。
  ctx.tools.register(defineTool({
    name: 'web_capture',
    description:
      'Fetch a web page, extract its readable text, and add it to the private knowledge base indexed by the '
      + 'dsh-workmate plugin. Use this when the user wants to save a web page / article into their KB for later '
      + 'retrieval via kb_search. Returns the captured title, doc label, chunk count, and the index file path.',
    parameters: {
      url: { type: 'string', required: true, description: 'The page URL to capture (http/https).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      await ready
      return captureWeb(String(args.url ?? ''), await readConfig())
    },
  }))

  // 模型工具：直接列出最近捕获的网页（告诉用户知识库存了什么，无需盲搜）。
  ctx.tools.register(defineTool({
    name: 'kb_recent',
    description:
      'List the most recently captured web pages in the dsh-workmate private knowledge base, newest first. '
      + 'Each entry includes the doc label, page title, URL, chunk count, and capture time. '
      + 'Use this when the user asks what pages have been saved to their KB (e.g. "我把哪些网页存进知识库了") '
      + '— it directly tells you what is stored and where, without a fuzzy search. Returns up to `limit` entries.',
    parameters: {
      limit: { type: 'number', description: 'Max entries to return (default 10).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      await ready
      const n = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 10
      return listRecentCaptures(n)
    },
  }))

  // 模型工具：删除网页捕获（解决"存进去删不掉，只能重建整个索引"）。
  ctx.tools.register(defineTool({
    name: 'kb_forget',
    description:
      'Remove one or more captured web pages from the dsh-workmate private knowledge base. '
      + 'Pass the page URL, its title, or a distinctive fragment of either. '
      + 'Only pages added by web_capture are removable this way — local documents are governed by reindexing. '
      + 'Use this when the user wants to delete something they saved earlier. Returns what was removed.',
    parameters: {
      target: { type: 'string', required: true, description: 'Page URL, title, or a distinctive fragment of either.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      await ready
      const result = forgetCapture(String(args.target ?? ''))
      if (result.ok === true) await saveIndex()
      return result
    },
  }))

  // 设置路由
  registerRoute(ctx, '/wf/settings', async (req, res) => {
    await ready
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
      try {
        await writeConfig(config)
      } catch {
        json(res, 500, { error: 'write failed' })
        return
      }
      json(res, 200, config)
      return
    }
    res.writeHead(405); res.end()
  })

  // 知识库状态 / 重新索引
  registerRoute(ctx, '/wf/kb/status', async (req, res) => {
    await ready
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    json(res, 200, {
      configured: indexIsUsable(kbIndex),
      stats: indexIsUsable(kbIndex) ? kbIndex.stats : undefined,
      dataDir: DATA_DIR,           // 数据落盘位置（便于用户备份/迁移）
      warnings: warnings.slice(),
    })
  })

  registerRoute(ctx, '/wf/kb/reindex', async (req, res) => {
    await ready
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const body = await readBody(req, 16 * 1024)
    let payload = {}
    if (body !== null) {
      try { payload = JSON.parse(body.toString('utf8')) } catch { payload = {} }
    }
    const config = sanitizeConfig(payload.config === undefined ? await readConfig() : payload.config)
    const stats = await reindex(config)
    if (stats === null) { json(res, 200, { ok: false, message: '未配置索引目录' }); return }
    json(res, 200, { ok: true, stats })
  })

  // 浏览器可见性心跳（仅后台通知）
  registerRoute(ctx, '/wf/visibility', async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const body = await readBody(req, 4096)
    if (body === null) { json(res, 413, { error: 'too large' }); return }
    try {
      const parsed = JSON.parse(body.toString('utf8'))
      if (typeof parsed.visible === 'boolean') markPageVisible(parsed.visible)
    } catch {
      // ignore
    }
    json(res, 200, { ok: true })
  })
}

/** 同一会话同一状态在短时间内重复到达时只通知一次。 */
function isDuplicate(sessionId, status) {
  const key = `${sessionId}:${status}`
  const previous = lastNotified.get(key)
  const now = Date.now()
  if (previous !== undefined && now - previous < DEDUPE_MS) return true
  lastNotified.set(key, now)
  if (lastNotified.size > 200) {
    for (const [entryKey, at] of lastNotified) {
      if (now - at > DEDUPE_MS * 10) lastNotified.delete(entryKey)
    }
  }
  return false
}
