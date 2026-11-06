/**
 * Client 半测试：注册契约（slot 名、顺序、注入面）与纯逻辑（错误文案、常量）。
 *
 * Client 半是零构建产物，靠 `window.__ModuleLoader__` 装载。这里用最小桩装载
 * 一次验证「注册到了哪里、点了会发生什么」；真实浮层的 DOM 行为靠浏览器验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE_PATH } from '../lib/index.js'

/** 每次 createElement 的实参，用来取回注册时注入给组件的 props。 */
const rendered = []
/** apply 期挂到 window 上的 keydown 监听，供快捷键用例直接驱动。 */
const keydownListeners = []

let spec
globalThis.window = {
  __ModuleLoader__: {
    load: (loaded) => { spec = loaded },
  },
  addEventListener: (type, handler) => {
    if (type === 'keydown') keydownListeners.push(handler)
  },
  removeEventListener: (type, handler) => {
    if (type !== 'keydown') return
    const index = keydownListeners.indexOf(handler)
    if (index >= 0) keydownListeners.splice(index, 1)
  },
}
await import('../lib/client.js')

/** 组件只用到 createElement；按 React 的约定把 children 也放进 props。 */
const fakeReact = {
  createElement: (type, props, ...children) => {
    const resolved = { ...(props ?? {}) }
    if (children.length === 1) resolved.children = children[0]
    else if (children.length > 1) resolved.children = children
    const element = { type, props: resolved, children }
    rendered.push(element)
    return element
  },
}

const plugin = spec.factory(name => {
  assert.equal(name, 'react')
  return fakeReact
})
const {
  describeActivity, describeFailure, CSS, ROUTE, MENU_ORDER, STYLE_ID, IS_MAC,
  deleteShortcutKeys, isEditableTarget, matchesDeleteShortcut, currentSession, openDeleteDialog,
} = plugin._internals

test('装载契约：id 与 package.json 一致，只硬依赖 slots', () => {
  assert.equal(spec.id, 'dsh-session-delete')
  // `sessions` 用 ctx.get 短轮询拿：写进插件级 inject 会让插件在服务就绪前
  // 一直停在 loading，连删除菜单都不会出现。
  assert.deepEqual(plugin.inject, ['slots'])
})

test('路由常量与 Host 半一致', () => {
  assert.equal(ROUTE, ROUTE_PATH)
  assert.equal(ROUTE, '/api/session-delete')
})

test('菜单项注册到侧栏会话菜单，排在归档之后', () => {
  const { menu } = mountApply()
  assert.equal(menu.spec.id, 'delete-session')
  assert.equal(menu.spec.order, MENU_ORDER)
  assert.ok(MENU_ORDER > 400, '应排在归档（400）之后')
})

test('点菜单项先关菜单，再请求确认', () => {
  const { menu } = mountApply()
  const closed = []
  const requested = []
  const rowProps = {
    sessionId: 's1',
    displayTitle: '示例会话',
    useMenuOpenState: () => [true, (next) => { closed.push(next) }],
  }

  menu.render(rowProps)
  const wrapper = rendered.at(-1)
  assert.equal(typeof wrapper.props.requestDelete, 'function', '渲染时应注入打开函数')

  // 组件体不依赖 React hooks，可以直接调用取回它渲染出的菜单行。
  const row = wrapper.type({ ...rowProps, requestDelete: request => { requested.push(request) } })
  assert.equal(row.props.className, 'dsd-item')
  row.props.onClick()

  assert.deepEqual(closed, [false], '应先关掉菜单')
  assert.deepEqual(requested, [{ sessionId: 's1', displayTitle: '示例会话' }], '再把会话交给确认框')
})

test('菜单行文案是「删除会话」，右侧带快捷键符号', () => {
  const { menu } = mountApply()
  const expected = deleteShortcutKeys(IS_MAC).join('')
  menu.render({ sessionId: 's1', displayTitle: '示例', useMenuOpenState: () => [false, () => {}] })
  const row = rendered.at(-1).type({
    sessionId: 's1', displayTitle: '示例', useMenuOpenState: () => [false, () => {}], requestDelete: () => {},
  })
  const labels = row.children.map(child => child?.props?.children).flat().filter(value => typeof value === 'string')
  assert.deepEqual(labels, ['删除会话', expected])
  const kbd = row.children.find(child => child?.props?.className === 'dsd-kbd')
  assert.equal(kbd.props.children, expected)
  assert.equal(row.props.role, 'menuitem')
})

test('describeFailure 把宿主错误码翻成中文提示', () => {
  assert.equal(
    describeFailure({ code: 'session-active' }),
    '这条对话还在运行，请先停止当前任务再删除。',
  )
  assert.equal(describeFailure({ code: 'not-found' }), '找不到这条对话，它可能已经被删除。')
  assert.equal(describeFailure({ code: 'internal', message: '磁盘只读' }), '磁盘只读')
  assert.equal(describeFailure(null), '删除失败，请稍后重试。')
})

test('describeFailure 在拒绝时点名具体在跑什么', () => {
  assert.equal(
    describeFailure({
      code: 'session-active',
      activity: [
        { kind: 'job', label: '后台任务', labels: ['pnpm test', 'pnpm build'] },
        { kind: 'subagent', label: '子代理', labels: [] },
      ],
    }),
    '这条对话还在运行，请先停止后再删除：后台任务（pnpm test、pnpm build）；子代理。',
  )
  // 没有 label 字段时退回 kind，不至于显示 undefined。
  assert.equal(
    describeFailure({ code: 'session-active', activity: [{ kind: 'turn', count: 0, labels: [] }] }),
    '这条对话还在运行，请先停止后再删除：turn。',
  )
  // 旧版 Host 的 session-live 仍给出可读文案。
  assert.equal(
    describeFailure({ code: 'session-live' }),
    '这条对话还在运行，请先停止当前任务再删除。',
  )
})

test('describeActivity 对空/畸形输入返回空串', () => {
  assert.equal(describeActivity(undefined), '')
  assert.equal(describeActivity(null), '')
  assert.equal(describeActivity([]), '')
  assert.equal(describeActivity([null, 'x']), '')
})

test('样式齐全且危险色走主题 token', () => {
  for (const cls of ['.dsd-item', '.dsd-root', '.dsd-dialog', '.dsd-btnDanger', '.dsd-kbd']) {
    assert.ok(CSS.includes(cls), cls)
  }
  assert.ok(CSS.includes('--dsw-alias-state-error-primary'))
  assert.ok(CSS.includes('--dsw-alias-label-tertiary'), '快捷键用三级文字色')
  assert.equal(STYLE_ID, 'dsh-session-delete-css')
})

test('键位符号随平台切换：macOS 是 ⌘⌫，其它是 Ctrl+⌫', () => {
  assert.deepEqual(deleteShortcutKeys(true), ['⌘', '⌫'])
  assert.equal(deleteShortcutKeys(true).join(''), '⌘⌫')
  assert.deepEqual(deleteShortcutKeys(false), ['Ctrl', '+', '⌫'])
  assert.equal(deleteShortcutKeys(false).join(''), 'Ctrl+⌫')
  // 每次返回新数组：调用方就地改不会污染常量。
  assert.notEqual(deleteShortcutKeys(true), deleteShortcutKeys(true))
})

test('快捷键只在页面区生效：输入框/文本域/可编辑区都放行给删文字', () => {
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' }), true)
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'div', isContentEditable: true }), true)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget(undefined), false)
  // 输入框里真正被点中的是内层节点：与宿主 DOM 适配器一样靠 closest 往上找。
  assert.equal(isEditableTarget({ closest: () => null }), false)
  assert.equal(isEditableTarget({ closest: () => ({ tagName: 'DIV' }) }), true)
})

test('matchesDeleteShortcut：只认干净的 ⌘⌫ / Ctrl+⌫', () => {
  const base = { key: 'Backspace', code: 'Backspace', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }
  assert.equal(matchesDeleteShortcut(base, true), true, 'macOS 的 ⌘⌫')
  assert.equal(matchesDeleteShortcut({ ...base, metaKey: false, ctrlKey: true }, false), true, '其它平台的 Ctrl+⌫')
  // 混按 ⌃⌘⌫ 是系统的「清空废纸篓」，不抢。
  assert.equal(matchesDeleteShortcut({ ...base, ctrlKey: true }, true), false)
  assert.equal(matchesDeleteShortcut({ ...base, metaKey: false }, true), false, '没修饰键的 ⌫ 是删字符')
  assert.equal(matchesDeleteShortcut({ ...base, shiftKey: true }, true), false)
  assert.equal(matchesDeleteShortcut({ ...base, altKey: true }, true), false)
  assert.equal(matchesDeleteShortcut({ ...base, repeat: true }, true), false, '长按不连删')
  assert.equal(matchesDeleteShortcut({ ...base, isComposing: true }, true), false, '输入法组字中')
  assert.equal(matchesDeleteShortcut({ ...base, key: 'Delete', code: 'Delete' }, true), false, 'Del 键不算')
  assert.equal(matchesDeleteShortcut(null, true), false)
})

test('currentSession 取主区域正在显示的那条会话', () => {
  assert.equal(currentSession(undefined), undefined)
  assert.equal(currentSession({ list: { getSnapshot: () => ({ byId: {} }) } }), undefined)
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          s1: { id: 's1', retainedBy: { mainView: 0 } },
          s2: { id: 's2', retainedBy: { mainView: 1 }, title: '当前会话' },
        },
      }),
    },
  }
  assert.equal(currentSession(sessions).id, 's2')
})

test('⌘⌫ 命中时打开当前会话的确认框并吃掉这次按键', () => {
  const { keydown } = mountApply({
    rows: [{ id: 's2', retainedBy: { mainView: 1 }, title: '当前会话' }],
  })
  const effects = []
  const event = {
    key: 'Backspace', code: 'Backspace', altKey: false, shiftKey: false,
    metaKey: IS_MAC, ctrlKey: !IS_MAC, target: { tagName: 'DIV' },
    preventDefault: () => { effects.push('prevent') },
    stopPropagation: () => { effects.push('stop') },
  }
  keydown(event)
  // 无 document 时 openDeleteDialog 是空操作，用"是否吃掉按键"验证命中。
  assert.deepEqual(effects, ['prevent', 'stop'])
})

test('没有当前会话 / 焦点在输入框 / 组合不成立时不碰按键', () => {
  const idle = mountApply({ rows: [{ id: 's1', retainedBy: { mainView: 0 } }] }).keydown
  const editable = mountApply({ rows: [{ id: 's2', retainedBy: { mainView: 1 } }] }).keydown
  const press = (overrides = {}) => {
    const effects = []
    const event = {
      key: 'Backspace', code: 'Backspace', altKey: false, shiftKey: false,
      metaKey: IS_MAC, ctrlKey: !IS_MAC, target: { tagName: 'DIV' },
      preventDefault: () => { effects.push('prevent') },
      stopPropagation: () => { effects.push('stop') },
      ...overrides,
    }
    return { event, effects }
  }

  const noTarget = press()
  idle(noTarget.event)
  assert.deepEqual(noTarget.effects, [], '没有当前会话就什么都不做')

  const inEditor = press({ target: { tagName: 'TEXTAREA' } })
  editable(inEditor.event)
  assert.deepEqual(inEditor.effects, [], '输入框里的 ⌘⌫ 必须留给删文字')

  const withShift = press({ shiftKey: true })
  editable(withShift.event)
  assert.deepEqual(withShift.effects, [], '⌘⇧⌫ 不是我们的组合')
})

/**
 * 用假 client 上下文跑 apply，收集槽位注册与全局键盘监听。
 * @param {object} [options] - 覆盖项。
 * @param {object[]} [options.rows] - `sessions.list` 快照里的会话行。
 * @returns {{ menu: object, keydown: Function }} 菜单注册结果与生效的 keydown 处理器。
 */
function mountApply({ rows = [] } = {}) {
  const registrations = []
  const slots = {
    inject: (_name, factory) => { factory() },
    register: (registered, component) => {
      registrations.push({ spec: registered, component })
      return () => {}
    },
  }
  const byId = Object.fromEntries(rows.map(row => [row.id, row]))
  const sessions = { list: { getSnapshot: () => ({ byId }) } }
  const ctx = {
    effect: fn => fn(),
    slots,
    // 与宿主的非阻塞服务读取同形；shortcuts 刻意不提供——本插件不再走注册表。
    get: name => (name === 'sessions' ? sessions : undefined),
  }
  keydownListeners.length = 0
  plugin.apply(ctx)
  const menu = registrations.find(entry => entry.spec.name === 'sidebar.workspaces.session.menu.item')
  return { menu: { spec: menu.spec, render: menu.component }, keydown: keydownListeners.at(-1) }
}
