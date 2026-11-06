/**
 * 确认浮层的 DOM 行为测试。
 *
 * 浮层是原生 DOM 构建的（不走 slot），所以可以脱离浏览器用最小 DOM 桩直接驱动：
 * 检查结构、取消关闭、确认成功关闭、确认失败显示文案。三条分支都是真实代码路径，
 * 不 mock 插件内部函数。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

/** 最小 DOM 节点。 */
class FakeNode {
  constructor(tag) {
    this.tagName = tag
    this.children = []
    this.className = ''
    this.hidden = false
    this.disabled = false
    this.attributes = {}
    this.listeners = {}
    this._text = ''
    this.parent = null
    this.focused = false
  }

  set textContent(value) {
    this._text = value
    this.children = []
  }

  get textContent() {
    return this.children.length > 0 ? this.children.map(child => child.textContent).join('') : this._text
  }

  appendChild(node) {
    node.parent = this
    this.children.push(node)
    return node
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }

  remove() {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter(child => child !== this)
    this.parent = null
  }

  addEventListener(type, handler) {
    ;(this.listeners[type] ??= []).push(handler)
  }

  setAttribute(name, value) {
    this.attributes[name] = value
  }

  focus() {
    this.focused = true
  }

  /** 派发一个已注册的事件。 */
  fire(type) {
    for (const handler of this.listeners[type] ?? []) handler({ type, stopPropagation() {} })
  }

  /** 按 class 名递归查找（按空格拆分，支持多类名）。 */
  findAll(className) {
    const found = []
    const walk = (node) => {
      if (typeof node.className === 'string' && node.className.split(/\s+/).includes(className)) found.push(node)
      for (const child of node.children) walk(child)
    }
    walk(this)
    return found
  }
}

const body = new FakeNode('body')
const head = new FakeNode('head')
const windowListeners = {}

globalThis.document = {
  createElement: tag => new FakeNode(tag),
  createElementNS: (_ns, tag) => new FakeNode(tag),
  head,
  body,
  querySelector: () => null,
}
globalThis.window = {
  __ModuleLoader__: { load: (loaded) => { globalThis.__spec = loaded } },
  addEventListener: (type, handler) => { (windowListeners[type] ??= []).push(handler) },
  removeEventListener: (type, handler) => {
    windowListeners[type] = (windowListeners[type] ?? []).filter(entry => entry !== handler)
  },
}

await import('../lib/client.js')
const plugin = globalThis.__spec.factory(() => ({ createElement: () => null }))
const { openDeleteDialog } = plugin._internals

let fetchCalls = []
let fetchResponse = { ok: true, payload: { ok: true } }

beforeEach(() => {
  body.children = []
  fetchCalls = []
  fetchResponse = { ok: true, payload: { ok: true } }
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init })
    return {
      ok: fetchResponse.ok,
      json: async () => fetchResponse.payload,
    }
  }
})

test('浮层结构：标题、说明、删除范围、不可恢复警告、两个按钮', () => {
  openDeleteDialog({ sessionId: 's1', displayTitle: '示例会话' })

  const root = body.children[0]
  assert.equal(root.className, 'dsd-root')
  assert.equal(root.attributes.role, 'dialog')
  assert.equal(root.attributes['aria-modal'], 'true')

  const dialog = root.findAll('dsd-dialog')[0]
  assert.ok(dialog, '应有卡片容器')
  const text = dialog.textContent
  assert.ok(text.includes('删除会话？'), text)
  assert.ok(text.includes('示例会话'), text)
  assert.ok(text.includes('会话日志文件'), text)
  assert.ok(text.includes('此操作不可撤销'), text)

  const buttons = dialog.findAll('dsd-btn')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].textContent, '取消')
  assert.equal(buttons[1].textContent, '删除')
  assert.ok(dialog.findAll('dsd-btnDanger').length === 1, '删除按钮应为危险色')
})

test('没有标题时用会话 id 兜底', () => {
  openDeleteDialog({ sessionId: 'session-xyz' })
  assert.ok(body.children[0].textContent.includes('session-xyz'))
})

test('点取消关闭浮层，不发请求', () => {
  openDeleteDialog({ sessionId: 's1' })
  const cancel = body.children[0].findAll('dsd-btn')[0]
  cancel.fire('click')
  assert.equal(body.children.length, 0)
  assert.equal(fetchCalls.length, 0)
})

test('按 Esc 关闭浮层并解绑监听', () => {
  openDeleteDialog({ sessionId: 's1' })
  assert.equal((windowListeners.keydown ?? []).length, 1)
  windowListeners.keydown[0]({ key: 'Escape', stopPropagation() {} })
  assert.equal(body.children.length, 0)
  assert.equal((windowListeners.keydown ?? []).length, 0)
})

test('确认成功后关闭浮层，请求体和路由正确', async () => {
  openDeleteDialog({ sessionId: 's1' })
  const [, confirm] = body.children[0].findAll('dsd-btn')
  confirm.fire('click')
  await new Promise(resolve => { setTimeout(resolve, 0) })

  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/api/session-delete')
  assert.equal(fetchCalls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { sessionId: 's1' })
  assert.equal(body.children.length, 0, '成功后应关闭')
})

test('确认失败时保留浮层并显示中文错误', async () => {
  fetchResponse = { ok: false, payload: { ok: false, code: 'session-active' } }
  openDeleteDialog({ sessionId: 's1' })
  const [, confirm] = body.children[0].findAll('dsd-btn')
  confirm.fire('click')
  await new Promise(resolve => { setTimeout(resolve, 0) })

  const root = body.children[0]
  assert.ok(root, '失败后浮层应保留')
  const error = root.findAll('dsd-error')[0]
  assert.equal(error.hidden, false)
  assert.equal(error.textContent, '这条对话还在运行，请先停止当前任务再删除。')
  const [, confirmAgain] = root.findAll('dsd-btn')
  assert.equal(confirmAgain.disabled, false, '应可以重试')
})

test('卡住的会话：第一次挡回后按钮变「强制删除」，再点带 force 再试', async () => {
  fetchResponse = {
    ok: false,
    payload: {
      ok: false,
      code: 'session-stuck',
      activity: [{ kind: 'job', label: '后台任务', labels: ['pnpm test'] }],
    },
  }
  openDeleteDialog({ sessionId: 's1' })
  const [, confirm] = body.children[0].findAll('dsd-btn')
  confirm.fire('click')
  await new Promise(resolve => { setTimeout(resolve, 0) })

  const root = body.children[0]
  assert.equal(
    root.findAll('dsd-error')[0].textContent,
    '这条对话卡在「运行中」，已尝试停止但没退出：后台任务（pnpm test）。可以强制删除。',
  )
  assert.equal(confirm.textContent, '强制删除')
  assert.equal(confirm.disabled, false)
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { sessionId: 's1' }, '第一次不带 force')

  fetchResponse = { ok: true, payload: { ok: true } }
  confirm.fire('click')
  await new Promise(resolve => { setTimeout(resolve, 0) })

  assert.deepEqual(JSON.parse(fetchCalls[1].init.body), { sessionId: 's1', force: true }, '第二次带 force')
  assert.equal(body.children.length, 0, '强制删除成功后关闭')
})

test('网络异常也落到错误行', async () => {
  globalThis.fetch = async () => { throw new Error('连接中断') }
  openDeleteDialog({ sessionId: 's1' })
  const [, confirm] = body.children[0].findAll('dsd-btn')
  confirm.fire('click')
  await new Promise(resolve => { setTimeout(resolve, 0) })

  assert.equal(body.children[0].findAll('dsd-error')[0].textContent, '连接中断')
})

test('同时只保留一个浮层', () => {
  openDeleteDialog({ sessionId: 'a' })
  openDeleteDialog({ sessionId: 'b' })
  assert.equal(body.children.length, 1)
  assert.ok(body.children[0].textContent.includes('b'))
})
