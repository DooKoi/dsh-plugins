/**
 * 会话目录路径规则。
 *
 * 与宿主 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `format.ts` 保持逐字节
 * 一致：插件不能依赖宿主的私有 `locate()`，只能自己算。规则漂移会让删除操作
 * 找不到目标目录（视为「会话不存在」），不会误删别的会话，但功能会静默失效，
 * 因此 `tests/paths.test.mjs` 直接用宿主源码对比锁定这两份实现。
 *
 * @module dsh-session-delete/lib/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 把任意字符串编码成单个安全路径段（宿主 `encodeSegment` 的等价实现）。
 * @param {string} raw - 待编码字符串，不能为空。
 * @returns {string} 可逆的单段路径名。
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * 项目路径 → 可读的项目目录名（宿主 `projectKey` 的等价实现）。
 * @param {string} cwd - 会话的项目目录。
 * @returns {string} `--slug--` 形式的目录名。
 */
export function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 单个会话独占的目录（宿主 `sessionDir` 的等价实现）。
 * @param {string} root - 会话根目录。
 * @param {string|undefined} cwd - 会话项目目录；`undefined` 走 `_no-cwd`。
 * @param {string} id - 会话 id。
 * @returns {string} 该会话的目录绝对路径。
 */
export function sessionDir(root, cwd, id) {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(project, encodeSegment(id))
}

/**
 * DSH 用户目录，与宿主 `dshHomePath()` 同规则：`DSH_HOME` 优先，否则 `~/.dsh`。
 * @param {() => string} [env] - 读取环境变量的函数（测试注入用）。
 * @returns {string} DSH 用户目录绝对路径。
 */
export function dshHome(env = () => process.env.DSH_HOME) {
  const configured = env()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/**
 * 会话日志根目录的默认值，对应 base bundle 里的 `dshHomePath('sessions')`。
 * @param {() => string} [env] - 读取环境变量的函数（测试注入用）。
 * @returns {string} 会话根目录绝对路径。
 */
export function defaultSessionsRoot(env) {
  return join(dshHome(env), 'sessions')
}

/**
 * projection 缓存文档的默认路径。
 *
 * 宿主 `session-projection-cache` 的域名为 `session_projcache`、表 `sessions`，
 * `storage-json` 的 `per-record` 布局把每条记录写成 `<root>/<name>/<table>/<key>.json`。
 * @param {string} home - DSH 用户目录。
 * @param {string} sessionId - 会话 id。
 * @returns {string} 缓存文档绝对路径。
 */
export function projectionCachePath(home, sessionId) {
  return join(home, 'storages', 'session_projcache', 'sessions', `${encodeSegment(sessionId)}.json`)
}
