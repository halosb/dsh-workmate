/**
 * dsh-workmate host 半边冒烟测试（零依赖，直接跑宿主代码）。
 *
 *   node tests/host-smoke.mjs
 *
 * 做法：把 `@deepseek-ai/dsh-tools` 换成桩后加载 index.js（宿主运行时才提供它），
 * 用临时 DSH_HOME + 假 ctx 真实跑一遍索引、检索、路由准入、通知与启动顺序。
 * 覆盖的都是曾经出过问题的地方，改代码后跑一次可以防回归。
 */
import { mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOME = join(tmpdir(), 'dsh-workmate-smoke-' + process.pid)
const DATA = join(HOME, 'plugin-data', 'test', 'dsh-workmate')
const DOCS = join(HOME, 'docs')

const results = []
const check = (label, ok, detail) => {
  results.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`)
}
const exists = async p => { try { await stat(p); return true } catch { return false } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

await rm(HOME, { recursive: true, force: true })
await mkdir(DOCS, { recursive: true })
await mkdir(DATA, { recursive: true })

// 中文夹具：让"知识库"只作为长句的一部分出现（旧的"最大字母连续段"分词会完全搜不到）
await writeFile(join(DOCS, 'note.md'), '# 笔记\n\n这是私有知识库检索的测试文档，用于验证中文分块与检索。\n\n第二段：向量检索与全文检索的区别与取舍。\n')
await writeFile(join(DOCS, 'code.md'), '# 代码\n\nfunction add(a, b) { return a + b }\n\nbm25 ranking implementation notes and details.\n')
await writeFile(join(DOCS, 'tiny.md'), 'x')

process.env.DSH_HOME = HOME
process.env.DSH_PROFILE = 'test'

const source = await readFile(join(ROOT, 'index.js'), 'utf8')
const stubPath = join(ROOT, '_dsh-tools-stub.mjs')
const underTestPath = join(ROOT, '_index_under_test.mjs')
await writeFile(stubPath, 'export function defineTool(config) { return config }\n')
await writeFile(underTestPath, source.replace("'@deepseek-ai/dsh-tools'", "'./_dsh-tools-stub.mjs'"))

// ── webhook 接收器（验证通知次数）─────────────────────────────────────────
const received = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c })
  req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end('ok') })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const hookUrl = `http://127.0.0.1:${server.address().port}/hook`

function makeCtx() {
  const state = { tools: new Map(), routes: new Map(), events: new Map() }
  state.ctx = {
    get(name) {
      if (name === 'connection') {
        return {
          requestRejection(req) {
            const host = req.headers.host
            if (typeof host !== 'string' || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return 403
            if (req.headers['sec-fetch-site'] === 'cross-site') return 403
            return undefined
          },
        }
      }
      return undefined
    },
    on(name, handler) { state.events.set(name, handler) },
    effect(factory) { return factory() },
    tools: { register(tool) { state.tools.set(tool.name, tool) } },
    webServer: { register(route) { state.routes.set(route.path, route) } },
  }
  return state
}

const fakeRes = () => ({ code: 0, body: '', writeHead(c) { this.code = c }, end(b) { if (b) this.body = String(b) } })
const jsonReq = (payload, headers = {}) => ({
  method: 'POST',
  headers: Object.assign({ host: '127.0.0.1:3080', 'content-type': 'application/json' }, headers),
  socket: {},
  [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(payload)) },
})

async function boot(version) {
  const mod = await import(pathToFileURL(underTestPath).href + '?v=' + version)
  const state = makeCtx()
  mod.apply(state.ctx)
  await sleep(900) // 等 ready 链（迁移 → 读索引 → 读配置）
  return state
}

const first = await boot(1)
const settings = first.routes.get('/wf/settings')
const reindexRoute = first.routes.get('/wf/kb/reindex')

check('包目录内未生成 config.json', !(await exists(join(ROOT, 'config.json'))))
check('包目录内未生成 kb-index.json', !(await exists(join(ROOT, 'kb-index.json'))))

let res = fakeRes()
await settings.handler(jsonReq({ kbDir: DOCS, kbExtensions: 'md', kbChunkSize: 200, kbOverlap: 400, notifyEnabled: false }), res)
check('overlap=400 > chunkSize=200 被钳制', res.code === 200 && res.body.includes('"kbOverlap":199'),
  res.body.match(/"kbOverlap":\d+/)?.[0])

res = fakeRes()
await reindexRoute.handler(jsonReq({}), res)
const reindexed = JSON.parse(res.body)
check('重新索引成功', reindexed.ok === true, JSON.stringify(reindexed.stats ?? reindexed))

const index1 = JSON.parse(await readFile(join(DATA, 'kb-index.json'), 'utf8'))
check('数据写在 DSH_HOME/plugin-data 下（不在包目录）', await exists(join(DATA, 'kb-index.json')))
check('索引记录了文件指纹（增量重建用）', index1.files !== undefined && Object.keys(index1.files).length === 3,
  JSON.stringify(Object.keys(index1.files ?? {})))
check('过短内容不产块', index1.chunks.every(c => c.doc !== 'tiny.md'), `chunkCount=${index1.stats.chunkCount}`)

const search = first.tools.get('kb_search')
const hit = await search.execute({ query: '知识库' })
check('中文片段检索命中（bigram 分词）', hit.ok === true && hit.results.length > 0, hit.ok ? `${hit.results.length} 条` : hit.message)
const hit2 = await search.execute({ query: '向量检索' })
check('中文短语检索命中', hit2.ok === true && hit2.results.length > 0, hit2.ok ? `${hit2.results.length} 条` : hit2.message)
const hit3 = await search.execute({ query: 'bm25 ranking' })
check('英文检索仍可用', hit3.ok === true && hit3.results.length > 0, hit3.ok ? `${hit3.results.length} 条` : hit3.message)

res = fakeRes()
await reindexRoute.handler(jsonReq({}), res)
check('增量重建复用未变更文件', JSON.parse(res.body).stats.reusedCount === 2, `reusedCount=${JSON.parse(res.body).stats.reusedCount}`)

res = fakeRes()
await settings.handler({ method: 'GET', headers: { host: 'evil.example.com' }, socket: {} }, res)
check('Host 非回环 → 403', res.code === 403, `code=${res.code}`)

res = fakeRes()
await settings.handler({ method: 'GET', headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }, socket: {} }, res)
check('跨站标记 → 403', res.code === 403, `code=${res.code}`)

res = fakeRes()
await settings.handler({ method: 'GET', headers: { host: '127.0.0.1:3080' }, socket: {} }, res)
check('可信 Host → 200', res.code === 200, `code=${res.code}`)

res = fakeRes()
await settings.handler({ method: 'POST', headers: { host: '127.0.0.1:3080' }, socket: {} }, res)
check('POST 无 JSON content-type → 415', res.code === 415, `code=${res.code}`)

res = fakeRes()
await settings.handler(jsonReq({
  kbDir: DOCS, kbExtensions: 'md', notifyEnabled: true, notifyMinDurationMs: 0,
  notifySystem: false, notifyWebhook: hookUrl, notifyOnError: true,
  notifyBackgroundOnly: false, soundEnabled: false,
}), res)
check('设置写入成功', res.code === 200 && res.body.includes(hookUrl))

const statusHandler = first.events.get('agent/status')
const errorHandler = first.events.get('agent/error')
const agent = { id: 'agent-1', session: null }

received.length = 0
statusHandler({ agent, status: 'running' })
await sleep(30)
errorHandler({ agent, error: new Error('boom') })
await sleep(30)
statusHandler({ agent, status: 'idle' }) // 失败后的收尾 idle
await sleep(400)
check('长任务失败只发一条通知（不再补报"完成"）', received.length === 1 && received[0].status === 'error',
  `收到 ${received.length} 条：${received.map(r => r.status).join(',')}`)
check('失败通知带真实时长', received.length === 1 && received[0].durationMs >= 0)

received.length = 0
statusHandler({ agent, status: 'running' })
await sleep(30)
statusHandler({ agent, status: 'idle' }) // 正常完成：不能被上一次失败标记压制
await sleep(400)
check('正常长任务发"完成"通知', received.length === 1 && received[0].status === 'done',
  `收到 ${received.length} 条：${received.map(r => r.status).join(',')}`)

// 启动竞态：模拟的网页捕获必须在"重启 + 启动重建"之后仍然存在
const withWeb = JSON.parse(await readFile(join(DATA, 'kb-index.json'), 'utf8'))
withWeb.chunks.push({ id: withWeb.chunks.length, doc: 'web: 示例页面 (http://example.com/a)', text: '模拟的网页捕获正文，用于验证重建不丢网页库。' })
await writeFile(join(DATA, 'kb-index.json'), JSON.stringify(withWeb))
await boot(2)
const after = JSON.parse(await readFile(join(DATA, 'kb-index.json'), 'utf8'))
check('重启后网页捕获仍在（启动顺序已修）',
  after.chunks.filter(c => typeof c.doc === 'string' && c.doc.startsWith('web: ')).length === 1)

check('Toast 标题经环境变量传递（不拼脚本）', source.includes('WM_TITLE') && !/BalloonTipTitle\s*=\s*\$\{/.test(source))
check('web_capture 有超时与私网拦截', source.includes('AbortSignal.timeout') && source.includes('assertPublicHost'))

server.close()
await rm(HOME, { recursive: true, force: true })
await rm(stubPath, { force: true })
await rm(underTestPath, { force: true })

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
