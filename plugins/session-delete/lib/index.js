/**
 * dsh-session-delete — Host 半。
 *
 * 给 Web 客户端提供一条删除会话的 HTTP 路由：`POST /api/session-delete`。
 * 宿主自带的会话生命周期只有「归档」（只写一个 id 标记，日志文件永久留在
 * 磁盘上），没有删除能力，所以这里由插件自己完成：
 *
 *   1. 拒绝真正在跑（进行中的回合 / 后台任务 / 子代理）的会话——删掉正在写的
 *      日志会撕裂产物。**只挂定时提醒不算在跑**，那类会话照删，提醒一并停掉；
 *   2. 递归删除该会话独占的目录（`<sessions>/<项目>/<会话id>/`）；
 *   3. 删除 projection 缓存文档（`<storages>/session_projcache/sessions/<id>.json`）；
 *   4. 从 workspace 记账里摘掉归档/置顶标记；
 *   5. 广播 `api-session/removed`，让已打开的侧栏立即移除该行。
 *
 * 不删除附件：附件库是内容寻址的全局共享对象（`~/.dsh/attachments/v1`），没有
 * 会话归属，也没有引用计数，删会话就删附件会连带毁掉其他会话正在用的图片。
 *
 * 认证由 connection 服务负责（与宿主其他 `/api` 路由一致）。
 *
 * @module dsh-session-delete
 */

import { readdir, rm, stat, unlink } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { encodeSegment, defaultSessionsRoot, dshHome, projectionCachePath } from './paths.js'

/** 插件名，与 profile 里的 Loader 行 id 一致。 */
export const name = 'dsh-session-delete'

/** 只硬依赖 connection：其余服务软取，缺了也不该让插件整个不加载。 */
export const inject = ['connection']

/** 路由路径，Client 半按同一常量调用。 */
export const ROUTE_PATH = '/api/session-delete'

/** 单个会话 id 的长度上限，超出必然是构造出来的请求。 */
const MAX_SESSION_ID = 200

/**
 * 唯一放行的活动家族：`schedule` 只是「未来某刻要提醒你」，不代表会话在跑。
 * 把它当成「正在运行」会让所有配过自动化任务的会话永远删不掉。删除时会连带
 * 停掉这些提醒（见下面的 `workspace/session-stop`），否则它们会投递到已消失
 * 的会话。
 *
 * 这里刻意用**放行清单**而不是阻塞清单：将来宿主新增活动家族时，默认落在
 * 阻塞侧（拒绝删除）而不是悄悄放行一个会写产物的生产者。
 */
const NON_BLOCKING_KINDS = new Set(['schedule'])

/** 活动家族的中文名，用于把拒绝原因说到用户能看懂。 */
const ACTIVITY_LABELS = {
  turn: '正在生成的回复',
  job: '后台任务',
  subagent: '子代理',
  schedule: '定时提醒',
}

/**
 * 活动家族 → 中文名；未知家族原样返回，不至于显示成 undefined。
 * @param {string} kind - 活动家族 key。
 * @returns {string} 可读文案。
 */
function activityLabel(kind) {
  return ACTIVITY_LABELS[kind] ?? kind
}

/**
 * 把一次 `workspace/session-activity` 的结果拆成「真在跑」与「顺手清理」两摞。
 * @param {readonly { kind: string, items?: readonly { id: string, label?: string }[] }[]} activity - waterfall 结果。
 * @returns {{ blocking: typeof activity, incidental: typeof activity }} 拆分结果。
 */
function splitActivity(activity) {
  const blocking = []
  const incidental = []
  for (const entry of activity) {
    if (NON_BLOCKING_KINDS.has(entry.kind)) incidental.push(entry)
    else blocking.push(entry)
  }
  return { blocking, incidental }
}

/**
 * 把被阻塞的活动拼成一句人话，附在错误信息里。
 * @param {readonly { kind: string, items?: readonly { id: string, label?: string }[] }[]} blocking - 阻塞项。
 * @returns {string} 例如「后台任务（pnpm test、pnpm build）」。
 */
function describeActivityList(blocking) {
  return blocking.map((entry) => {
    const items = entry.items ?? []
    if (items.length === 0) return activityLabel(entry.kind)
    return `${activityLabel(entry.kind)}（${items.map(item => item.label ?? item.id).join('、')}）`
  }).join('；')
}

/** 取消一个回合后等它落回 idle 的上限；超过就当它卡住了。 */
const DEFAULT_STOP_TIMEOUT_MS = 3000

/**
 * 轮询等待 Agent 落回 idle。取消是异步的，立刻读状态一定还是 running。
 * @param {() => ({ status?: string } | undefined)} lookup - 取当前活 Agent。
 * @param {number} timeoutMs - 最长等待时间。
 * @returns {Promise<boolean>} 是否已经不在运行。
 */
async function settleAgent(lookup, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (lookup()?.status !== 'running') return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => { setTimeout(resolve, 100) })
  }
}

/**
 * 读取并校验请求体里的会话 id。
 * @param {unknown} body - 已解析的 JSON 体。
 * @returns {string} 合法会话 id。
 * @throws {DeleteRequestError} 结构不合法时。
 */
function readSessionId(body) {
  const sessionId = body !== null && typeof body === 'object' ? body.sessionId : undefined
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID) {
    throw new DeleteRequestError(400, 'invalid-request', 'sessionId 缺失或格式不合法')
  }
  if (sessionId.includes('\0') || sessionId.includes('/') || sessionId.includes('\\')) {
    throw new DeleteRequestError(400, 'invalid-request', 'sessionId 含非法路径字符')
  }
  return sessionId
}

/** 带 HTTP 状态码的删除失败，供 handler 统一转成响应。 */
class DeleteRequestError extends Error {
  /**
   * @param {number} status - HTTP 状态码。
   * @param {string} code - 机器可读错误码。
   * @param {string} message - 面向用户的说明。
   * @param {unknown} [activity] - 拒绝时附带的运行中活动摘要。
   */
  constructor(status, code, message, activity) {
    super(message)
    this.status = status
    this.code = code
    this.activity = activity
  }
}

/**
 * 把任意异常转成 `{ status, body }`。
 * @param {unknown} error - 捕获到的异常。
 * @returns {{ status: number, body: Record<string, unknown> }} 响应描述。
 */
function toResponse(error) {
  if (error instanceof DeleteRequestError) {
    return {
      status: error.status,
      body: { ok: false, code: error.code, message: error.message, activity: error.activity },
    }
  }
  return {
    status: 500,
    body: { ok: false, code: 'internal', message: error instanceof Error ? error.message : String(error) },
  }
}

/**
 * 判断目标目录确实是会话根目录的子目录，挡住一切路径穿越。
 * @param {string} root - 会话根目录。
 * @param {string} target - 待删除目录。
 * @returns {boolean} 是否安全。
 */
function insideRoot(root, target) {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  return normalizedTarget.startsWith(normalizedRoot + sep) && normalizedTarget !== normalizedRoot
}

/**
 * 汇总运行中活动的摘要，供确认框展示（与归档弹窗同一份数据形状）。
 * @param {readonly { kind: string, items?: readonly { id: string, label?: string }[] }[]} activity - waterfall 收集到的活动。
 * @returns {{ kind: string, count: number, labels: string[] }[]} 精简摘要。
 */
function summarizeActivity(activity) {
  return activity.map(entry => ({
    kind: entry.kind,
    label: activityLabel(entry.kind),
    count: entry.items?.length ?? 0,
    labels: (entry.items ?? []).map(item => item.label ?? item.id),
  }))
}

/**
 * 在会话根目录下找出属于该会话的目录。
 *
 * 不向 `ctx.sessionPersistence` 要 cwd：那个服务的 `stat()` 会先按当前压缩配置
 * 校验文件后缀，一个格式损坏或迁移到一半的会话会直接抛错——而这类「读不出来的
 * 会话」恰恰是最需要删掉的。直接按目录名扫描（项目目录数量是个位数），既绕开
 * 该失败点，也免去对宿主内部服务形状的依赖。
 *
 * @param {string} sessionsRoot - 会话根目录。
 * @param {string} sessionId - 已校验的会话 id。
 * @returns {Promise<string[]>} 该会话独占的目录（通常 0 或 1 个）。
 */
async function locateSessionDirs(sessionsRoot, sessionId) {
  const segment = encodeSegment(sessionId)
  const projects = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => [])
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const dir = join(sessionsRoot, project.name, segment)
    // 项目目录名来自磁盘，仍要挡住符号链接/异常目录名拼出的越界路径。
    if (!insideRoot(sessionsRoot, dir)) continue
    const present = await stat(dir).then(entry => entry.isDirectory()).catch(() => false)
    if (present) found.push(dir)
  }
  return found
}

/**
 * 删除一个会话及其独占数据。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 * @param {string} sessionId - 已校验的会话 id。
 * @param {{ sessionsRoot?: string, removeProjectionCache?: boolean, forgetWorkspaceMarks?: boolean }} options - 生效的插件配置。
 * @returns {Promise<Record<string, unknown>>} 删除结果摘要。
 */
async function deleteSession(ctx, sessionId, options) {
  const home = dshHome()
  const sessionsRoot = options.sessionsRoot ?? defaultSessionsRoot()

  // 1. 先问一次活动，但「有东西在跑」不再等于拒绝：用户点删除就是授权停止。
  const liveAgent = () => ctx.get('agents')?.get?.(sessionId)
  const ask = () => ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  let activity = await ask()
  let { blocking, incidental } = splitActivity(activity)
  const running = () => liveAgent()?.status === 'running'

  if (blocking.length > 0 || running()) {
    // 与宿主归档的 stopActivity 同一条通路：取消回合、结束子代理、清掉提醒。
    await ctx.parallel('workspace/session-stop', { sessionId }).catch(() => {})
    await settleAgent(liveAgent, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
    activity = await ask()
    ;({ blocking, incidental } = splitActivity(activity))
  }

  // 停过一轮还在跑，说明这条会话的状态卡住了（中断的流、等审批的死循环）。
  // 常规路径到此已经结束；要不要强制收尾交给用户决定，不替他赌。
  if ((blocking.length > 0 || running()) && options.force !== true) {
    throw new DeleteRequestError(
      409,
      'session-stuck',
      blocking.length > 0
        ? `这条对话仍在运行：${describeActivityList(blocking)}。已尝试停止但未退出，可以强制删除。`
        : '这条对话的状态是「运行中」，已尝试停止但未退出，可以强制删除。',
      summarizeActivity(blocking),
    )
  }

  // 2. 顺手清掉不阻塞删除的挂留活动（定时提醒等），否则它们会投递到已消失的会话。
  if (incidental.length > 0) {
    await ctx.parallel('workspace/session-stop', { sessionId }).catch(() => {})
  }

  // 3. 定位并删除会话目录（可能尚未落盘：创建后没写过事件，此时没有目录）。
  const dirs = await locateSessionDirs(sessionsRoot, sessionId)
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })

  // 4. projection 缓存：文档名即会话 id，删掉可避免列表继续读到陈旧标题。
  const cachePath = projectionCachePath(home, sessionId)
  const cacheRemoved = options.removeProjectionCache === false
    ? false
    : await unlink(cachePath).then(() => true).catch(() => false)

  // 两边都没有，说明这条会话本来就不存在：报 404，不要假装删成功了。
  if (dirs.length === 0 && !cacheRemoved) {
    throw new DeleteRequestError(404, 'not-found', '找不到这条对话，它可能已经被删除')
  }

  // 5. workspace 记账：归档/置顶集合里残留的 id 会让侧栏继续过滤或置顶一条幽灵会话。
  if (options.forgetWorkspaceMarks !== false) {
    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined) {
      await registry.unarchiveSession?.(sessionId).catch(() => {})
      await registry.unpinSession?.(sessionId).catch(() => {})
    }
  }

  // 6. 广播移除：冷会话不会触发 session/disposed，这一条是侧栏刷新的唯一通路。
  ctx.emit('api-session/removed', sessionId)

  return {
    ok: true,
    sessionId,
    sessionDirs: dirs,
    projectionCacheRemoved: cacheRemoved,
    stoppedIncidental: incidental.map(entry => entry.kind),
  }
}

/**
 * 读出请求体 JSON；空体按结构错误处理。
 * @param {Request} request - 传入的 fetch 请求。
 * @returns {Promise<unknown>} 解析结果。
 */
async function readJson(request) {
  const text = await request.text()
  if (text.trim() === '') throw new DeleteRequestError(400, 'invalid-request', '请求体为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new DeleteRequestError(400, 'invalid-request', '请求体不是合法 JSON')
  }
}

/**
 * 挂载删除路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host 上下文。
 * @param {Record<string, unknown>} config - Loader 行配置。
 */
export function apply(ctx, config = {}) {
  const options = {
    sessionsRoot: typeof config.sessionsRoot === 'string' && config.sessionsRoot !== ''
      ? config.sessionsRoot
      : undefined,
    removeProjectionCache: config.removeProjectionCache !== false,
    forgetWorkspaceMarks: config.forgetWorkspaceMarks !== false,
    stopTimeoutMs: typeof config.stopTimeoutMs === 'number' && config.stopTimeoutMs >= 0
      ? config.stopTimeoutMs
      : DEFAULT_STOP_TIMEOUT_MS,
  }
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const sessionId = readSessionId(body)
        // force 只来自这一次请求：用户在「停不下来」的提示后再点一次才带。
        const force = body !== null && typeof body === 'object' && body.force === true
        const result = await deleteSession(ctx, sessionId, { ...options, force })
        return Response.json(result, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        const { status, body } = toResponse(error)
        return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
      }
    },
  }), 'dsh-session-delete: route')
}

export {
  ACTIVITY_LABELS,
  DEFAULT_STOP_TIMEOUT_MS,
  NON_BLOCKING_KINDS,
  DeleteRequestError,
  activityLabel,
  deleteSession,
  describeActivityList,
  insideRoot,
  locateSessionDirs,
  settleAgent,
  splitActivity,
  summarizeActivity,
}
