/**
 * Host 删除链路测试：走真实的 HTTP handler，覆盖成功、拒绝、校验与降级路径。
 *
 * 用真实的临时目录（而不是 mock fs），因为最容易出错的地方正是「删对了目录
 * 但算错了路径」——只有落到磁盘才能验证。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  deleteSession,
  describeActivityList,
  insideRoot,
  locateSessionDirs,
  ROUTE_PATH,
  splitActivity,
  summarizeActivity,
} from '../lib/index.js'
import { projectKey } from '../lib/paths.js'

const CWD = '/Users/wenyi/Desktop/DSH/demo-project'
const OTHER_CWD = '/Users/wenyi/Desktop/AI 教育产品'

let home
let sessionsRoot

/**
 * 造一个只会记录调用的假 Host 上下文。
 * @param {object} options - 各服务的桩。
 * @param {readonly object[]} [options.activity] - activity waterfall 的返回值。
 * @param {object} [options.liveAgent] - `agents.get()` 返回的活 Agent（缺省为未加载）。
 * @param {boolean} [options.registry] - 是否提供 workspaceRegistry。
 * @param {boolean} [options.stopSettles] - stop 是否真的能结束掉运行中的东西。
 * @returns {{ ctx: object, emitted: any[], stopped: any[], registry: object }} 上下文与观测点。
 */
function fakeContext({ activity = [], liveAgent, registry = true, stopSettles = true } = {}) {
  const emitted = []
  const stopped = []
  const calls = { unarchived: [], unpinned: [] }
  let activityRows = [...activity]
  const agent = liveAgent === undefined ? undefined : { ...liveAgent }
  const ctx = {
    waterfall: async (event, _payload, fallback) => {
      assert.equal(event, 'workspace/session-activity')
      return activityRows.length === 0 ? fallback() : activityRows
    },
    parallel: async (event, payload) => {
      stopped.push([event, payload.sessionId])
      if (!stopSettles) return
      activityRows = []
      if (agent !== undefined) agent.status = 'idle'
    },
    get: (name) => {
      if (name === 'agents') return { get: () => agent }
      if (name === 'workspaceRegistry' && registry) {
        return {
          unarchiveSession: async (id) => { calls.unarchived.push(id) },
          unpinSession: async (id) => { calls.unpinned.push(id) },
        }
      }
      return undefined
    },
    emit: (event, id) => { emitted.push([event, id]) },
  }
  return { ctx, emitted, stopped, registry: calls }
}

/**
 * 在临时 DSH 目录里铺一条会话。
 * @param {string} sessionId - 会话 id。
 * @param {object} [options] - 文件名与项目目录覆盖。
 * @returns {Promise<{ dir: string, cachePath: string }>} 落盘位置。
 */
async function seedSession(sessionId, { cwd = CWD, filename = 'session.v4.jsonl.zst', cache = true } = {}) {
  const dir = join(sessionsRoot, projectKey(cwd), sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, filename), '{"type":"header"}\n')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${sessionId}.json`)
  if (cache) await writeFile(cachePath, '{"title":"旧标题"}')
  return { dir, cachePath }
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsd-test-'))
  home = join(root, 'dsh')
  sessionsRoot = join(home, 'sessions')
  await mkdir(sessionsRoot, { recursive: true })
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

test('成功删除：日志目录与投影缓存都消失，广播 removed，归档/置顶标记被摘掉', async () => {
  const sessionId = 'session-abc'
  const { dir, cachePath } = await seedSession(sessionId)
  const { ctx, emitted, registry } = fakeContext({})

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })

  assert.equal(result.ok, true)
  assert.deepEqual(result.sessionDirs, [dir])
  assert.equal(result.projectionCacheRemoved, true)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(cachePath), false)
  assert.deepEqual(emitted, [['api-session/removed', sessionId]])
  assert.deepEqual(registry.unarchived, [sessionId])
  assert.deepEqual(registry.unpinned, [sessionId])
})

test('格式损坏的会话也能删（不依赖会话服务校验后缀）', async () => {
  const sessionId = 'session-corrupt'
  // 后端配置为 zstd，这里故意写成裸 .jsonl：sessionPersistence.stat() 会抛错，
  // 但用户最想删的往往正是这种读不出来的会话。
  const { dir } = await seedSession(sessionId, { filename: 'session.v4.jsonl' })
  const { ctx } = fakeContext({})

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.equal(existsSync(dir), false)
})

test('会话在任意项目目录下都能定位', async () => {
  const sessionId = 'session-other-project'
  const { dir } = await seedSession(sessionId, { cwd: OTHER_CWD })
  const { ctx } = fakeContext({})

  const located = await locateSessionDirs(sessionsRoot, sessionId)
  assert.deepEqual(located, [dir])

  await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(existsSync(dir), false)
})

test('同一会话只删自己的目录，兄弟会话不受影响', async () => {
  const target = await seedSession('session-target')
  const sibling = await seedSession('session-sibling')
  const { ctx } = fakeContext({})

  await deleteSession(ctx, 'session-target', { sessionsRoot })
  assert.equal(existsSync(target.dir), false)
  assert.equal(existsSync(sibling.dir), true)
  assert.equal(existsSync(sibling.cachePath), true)
})

test('运行中的会话先被停止，再删除', async () => {
  const sessionId = 'session-running'
  const { dir, cachePath } = await seedSession(sessionId)
  const { ctx, emitted, stopped } = fakeContext({
    activity: [{ kind: 'turn', items: [{ id: 't1', label: '正在生成回复' }] }],
  })

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(stopped, [['workspace/session-stop', sessionId]], '先走宿主的 stop 通路')
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(cachePath), false)
  assert.deepEqual(emitted, [['api-session/removed', sessionId]])
})

test('停不下来的会话返回 session-stuck 并点名卡住的东西', async () => {
  const sessionId = 'session-stuck'
  const { dir, cachePath } = await seedSession(sessionId)
  const { ctx, stopped } = fakeContext({
    activity: [{ kind: 'job', items: [{ id: 'j1', label: 'pnpm test' }] }],
    stopSettles: false,
  })

  await assert.rejects(
    () => deleteSession(ctx, sessionId, { sessionsRoot, stopTimeoutMs: 60 }),
    (error) => {
      assert.equal(error.code, 'session-stuck')
      assert.equal(error.status, 409)
      assert.match(error.message, /后台任务（pnpm test）/)
      assert.match(error.message, /强制删除/)
      return true
    },
  )
  assert.equal(stopped.length, 1)
  assert.equal(existsSync(dir), true, '拒绝时数据原样保留')
  assert.equal(existsSync(cachePath), true)
})

test('force 跳过卡死判定，直接删掉', async () => {
  const sessionId = 'session-stuck-forced'
  const { dir } = await seedSession(sessionId)
  const { ctx } = fakeContext({
    activity: [{ kind: 'turn' }],
    stopSettles: false,
  })

  const result = await deleteSession(ctx, sessionId, { sessionsRoot, stopTimeoutMs: 60, force: true })
  assert.equal(result.ok, true)
  assert.equal(existsSync(dir), false)
})

test('Agent 正在跑的会话被拒绝（status = running 且停不下来）', async () => {
  const sessionId = 'session-agent-running'
  const { dir } = await seedSession(sessionId)
  const { ctx } = fakeContext({ liveAgent: { id: sessionId, status: 'running' }, stopSettles: false })

  await assert.rejects(
    () => deleteSession(ctx, sessionId, { sessionsRoot, stopTimeoutMs: 60 }),
    (error) => error.code === 'session-stuck' && error.status === 409,
  )
  assert.equal(existsSync(dir), true)
})

test('已加载但空闲的 Agent 不再阻止删除（点开过就该删得掉）', async () => {
  const sessionId = 'session-agent-idle'
  const { dir, cachePath } = await seedSession(sessionId)
  const { ctx, emitted } = fakeContext({ liveAgent: { id: sessionId, status: 'idle' } })

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(cachePath), false)
  assert.deepEqual(emitted, [['api-session/removed', sessionId]])
})

test('只挂着定时提醒的会话照删，并顺手停掉提醒', async () => {
  const sessionId = 'session-scheduled'
  const { dir } = await seedSession(sessionId)
  const { ctx, stopped } = fakeContext({
    activity: [{ kind: 'schedule', items: [{ id: 's1', label: 'Check the build' }] }],
  })

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(result.stoppedIncidental, ['schedule'])
  assert.deepEqual(stopped, [['workspace/session-stop', sessionId]])
  assert.equal(existsSync(dir), false)
})

test('磁盘上找不到会话时返回 404，不假装成功', async () => {
  const { ctx, emitted } = fakeContext({})
  await assert.rejects(
    () => deleteSession(ctx, 'session-missing', { sessionsRoot }),
    (error) => error.code === 'not-found' && error.status === 404,
  )
  assert.deepEqual(emitted, [])
})

test('只有缓存没有日志时，仍算删除成功', async () => {
  const sessionId = 'session-cache-only'
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${sessionId}.json`), '{}')
  const { ctx } = fakeContext({})

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.deepEqual(result.sessionDirs, [])
  assert.equal(result.projectionCacheRemoved, true)
})

test('配置开关可关掉缓存与记账清理', async () => {
  const sessionId = 'session-keep-cache'
  const { dir, cachePath } = await seedSession(sessionId)
  const { ctx, registry } = fakeContext({})

  await deleteSession(ctx, sessionId, {
    sessionsRoot, removeProjectionCache: false, forgetWorkspaceMarks: false,
  })
  assert.equal(existsSync(dir), false)
  assert.equal(existsSync(cachePath), true)
  assert.deepEqual(registry.unarchived, [])
})

test('缺少 workspaceRegistry 时不报错', async () => {
  const sessionId = 'session-no-registry'
  const { dir } = await seedSession(sessionId)
  const { ctx } = fakeContext({ registry: false })

  const result = await deleteSession(ctx, sessionId, { sessionsRoot })
  assert.equal(result.ok, true)
  assert.equal(existsSync(dir), false)
})

test('HTTP 路由：正常请求返回 ok:true', async () => {
  const sessionId = 'session-http'
  const { dir } = await seedSession(sessionId)
  const { ctx } = fakeContext({})
  const route = mountRoute(ctx)

  const response = await route.fetch(new Request('http://host' + ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  }))
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(existsSync(dir), false)
})

test('HTTP 路由：非法会话 id、空体、坏 JSON 都返回 400', async () => {
  const { ctx } = fakeContext({})
  const route = mountRoute(ctx)
  const cases = [
    {},
    { sessionId: '' },
    { sessionId: 42 },
    { sessionId: '../../etc/passwd' },
    { sessionId: 'a/b' },
    { sessionId: 'x'.repeat(201) },
  ]
  for (const body of cases) {
    const response = await route.fetch(new Request('http://host' + ROUTE_PATH, {
      method: 'POST', body: JSON.stringify(body),
    }))
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal((await response.json()).code, 'invalid-request')
  }

  const empty = await route.fetch(new Request('http://host' + ROUTE_PATH, { method: 'POST', body: '' }))
  assert.equal(empty.status, 400)

  const broken = await route.fetch(new Request('http://host' + ROUTE_PATH, { method: 'POST', body: '{oops' }))
  assert.equal(broken.status, 400)
})

test('HTTP 路由：停不下来时返回 409 session-stuck 并带上活动摘要', async () => {
  const { ctx } = fakeContext({
    activity: [{ kind: 'job', items: [{ id: 'j1' }, { id: 'j2', label: '构建' }] }],
    stopSettles: false,
  })
  const route = mountRoute(ctx)
  const response = await route.fetch(new Request('http://host' + ROUTE_PATH, {
    method: 'POST', body: JSON.stringify({ sessionId: 'session-busy' }),
  }))
  assert.equal(response.status, 409)
  const payload = await response.json()
  assert.equal(payload.code, 'session-stuck')
  assert.deepEqual(payload.activity, [{ kind: 'job', label: '后台任务', count: 2, labels: ['j1', '构建'] }])
})

test('HTTP 路由：请求体带 force 时跳过卡死判定', async () => {
  const sessionId = 'session-force-http'
  await seedSession(sessionId)
  const { ctx } = fakeContext({
    activity: [{ kind: 'turn' }],
    stopSettles: false,
  })
  const route = mountRoute(ctx, { stopTimeoutMs: 60 })
  const response = await route.fetch(new Request('http://host' + ROUTE_PATH, {
    method: 'POST', body: JSON.stringify({ sessionId, force: true }),
  }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
})

test('HTTP 路由：找不到会话返回 404', async () => {
  const { ctx } = fakeContext({})
  const route = mountRoute(ctx)
  const response = await route.fetch(new Request('http://host' + ROUTE_PATH, {
    method: 'POST', body: JSON.stringify({ sessionId: 'session-ghost' }),
  }))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'not-found')
})

test('insideRoot 挡住根目录本身与兄弟目录', () => {
  assert.equal(insideRoot('/a/b', '/a/b/c'), true)
  assert.equal(insideRoot('/a/b', '/a/b'), false)
  assert.equal(insideRoot('/a/b', '/a/bc/d'), false)
  assert.equal(insideRoot('/a/b', '/a/b/../etc'), false)
})

test('summarizeActivity 无 items 时计数为 0 并带上家族中文名', () => {
  assert.deepEqual(summarizeActivity([{ kind: 'turn' }]), [{
    kind: 'turn', label: '正在生成的回复', count: 0, labels: [],
  }])
})

test('splitActivity 把 schedule 归为可清理，把其余家族归为阻塞', () => {
  const { blocking, incidental } = splitActivity([
    { kind: 'job', items: [{ id: 'j1' }] },
    { kind: 'schedule', items: [{ id: 's1' }] },
    { kind: 'subagent' },
  ])
  assert.deepEqual(blocking.map(entry => entry.kind), ['job', 'subagent'])
  assert.deepEqual(incidental.map(entry => entry.kind), ['schedule'])
})

test('未知活动家族按阻塞处理，不放行来历不明的写入方', () => {
  const { blocking, incidental } = splitActivity([{ kind: 'some-future-family' }])
  assert.deepEqual(blocking.map(entry => entry.kind), ['some-future-family'])
  assert.deepEqual(incidental, [])
})

test('describeActivityList 拼出「家族（条目、条目）」', () => {
  assert.equal(
    describeActivityList([
      { kind: 'job', items: [{ id: 'j1', label: 'pnpm test' }, { id: 'j2' }] },
      { kind: 'turn' },
    ]),
    '后台任务（pnpm test、j2）；正在生成的回复',
  )
})

/**
 * 用 apply() 把路由注册到一个假 connection 上，返回被捕获的路由对象。
 * @param {object} ctx - 假 Host 上下文。
 * @param {object} [config] - 插件配置。
 * @returns {{ fetch: (request: Request) => Promise<Response> }} 注册进去的路由。
 */
function mountRoute(ctx, config = {}) {
  let captured
  const context = {
    ...ctx,
    effect: (fn) => fn(),
    connection: { fetch: { register: (route) => { captured = route; return () => {} } } },
  }
  apply(context, config)
  assert.equal(captured.path, ROUTE_PATH)
  assert.deepEqual(captured.methods, ['POST'])
  assert.equal(captured.requestBody, 'buffered')
  return captured
}
