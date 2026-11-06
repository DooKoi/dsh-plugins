/**
 * dsh-session-delete — Client 半（Web）。
 *
 * 在侧栏会话的「…」菜单里加一条「删除会话」（order 500，排在归档 400 之后）。
 * 点击后弹一个自建的确认浮层，确认即调用 Host 路由 `POST /api/session-delete`。
 *
 * 两个刻意的设计选择：
 *
 * 1. **浮层用原生 DOM，不走 `shell.overlay` 槽**。槽的 hooks 契约（inject.hooks →
 *    `use<Name>` 选择器）对插件不透明，注册失败时是静默的——按钮点了没反应，
 *    很难排查。原生 DOM 只依赖已验证可用的菜单槽，行为可预测。
 * 2. **只 require 平台表里的 'react'**，不 require 任何 Harness Client 包；控件
 *    自绘，颜色/圆角只用 `--dsw-alias-*` 与 `--dsw-radius-*` token。
 * 3. **⌘⌫ 自己监听 keydown，不走宿主快捷键服务**。宿主的 `bindingIssue`
 *    （packages/client/shortcuts/src/configuration.ts:104）把含 `Backspace`、
 *    `Delete`、`Enter`、方向键的组合一律判为 `reserved`，唯一的提前放行口是
 *    "至少三个修饰键"；`ShortcutRegistry.register` 又会为 desktop/web × 三个
 *    平台逐个校验、任一不过就整条抛错。所以在 web 端 ⌘⌫ 根本注册不进去
 *    （表现为菜单没键位、按了没反应，而且异常被 ctx.effect 吞掉）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 路由路径，与 lib/index.js 的 ROUTE_PATH 一致（测试锁定）。 */
    const ROUTE = '/api/session-delete'
    const STYLE_ID = 'dsh-session-delete-css'
    /** 菜单项排序位：归档（400）之后，插件之间留出 100 的间隔。 */
    const MENU_ORDER = 500
    /** macOS 的删除组合是 ⌘⌫，其余平台是 Ctrl+⌫。 */
    const KEYS_MAC = ['⌘', '⌫']
    const KEYS_OTHER = ['Ctrl', '+', '⌫']
    /** 当前设备是否 macOS：决定菜单画哪一套键位、以及监听哪个修饰键。 */
    const IS_MAC = isMacPlatform()

    const CSS = [
      '.dsd-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
      '.dsd-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05));color:var(--dsw-alias-state-error-primary)}',
      '.dsd-item:focus-visible{outline:2px solid var(--dsw-alias-text-accent);outline-offset:-2px}',
      '.dsd-itemIcon{flex:none;display:inline-flex}',
      '.dsd-kbd{display:inline-flex;gap:2px;margin-left:auto;padding-left:12px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.dsd-root{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;font-family:inherit}',
      '.dsd-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35))}',
      '.dsd-dialog{position:relative;z-index:1;box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:min(420px,100%);padding:22px 24px 20px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-module-platform,#fff));box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary)}',
      '.dsd-title{margin:0;font-size:16px;line-height:24px;font-weight:500}',
      '.dsd-desc{margin:0;font-size:14px;line-height:22px}',
      '.dsd-list{margin:0;padding-left:18px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsd-warn{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
      '.dsd-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary)}',
      '.dsd-status{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.dsd-footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px}',
      '.dsd-btn{height:32px;padding:0 14px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}',
      '.dsd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsd-btn:disabled{cursor:default;opacity:.5}',
      '.dsd-btnDanger:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dsd-btnDanger:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
    ].join('')

    /** 挂载插件样式，重复调用是幂等的（HMR 重挂不会叠加）。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const style = document.createElement('style')
      style.setAttribute('data-plugin-css', STYLE_ID)
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /**
     * 建一个元素。
     * @param {string} tag - 标签名。
     * @param {string} [className] - class 名。
     * @param {string} [text] - 文本内容（走 textContent，不解析 HTML）。
     * @returns {HTMLElement} 新建元素。
     */
    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className !== undefined) node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    /** 垃圾桶图标（内联 SVG，与宿主 16px 描边图标同一网格）。 */
    function trashSvg() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.2')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('class', 'dsd-itemIcon')
      for (const d of [
        'M2.5 4.5h11',
        'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3',
        'M4 4.5l.7 8.1c.05.6.55 1 1.15 1h4.3c.6 0 1.1-.4 1.15-1L12 4.5',
        'M6.8 7v4M9.2 7v4',
      ]) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
      }
      return svg
    }

    /**
     * 把 Host 回报的 activity 明细拼成一句话，让用户知道到底是什么在跑。
     * @param {unknown} activity - Host 返回的 activity 数组。
     * @returns {string} 例如「：后台任务（pnpm test）；子代理（researcher）」，空则空串。
     */
    function describeActivity(activity) {
      if (!Array.isArray(activity) || activity.length === 0) return ''
      const parts = []
      for (const entry of activity) {
        if (entry === null || typeof entry !== 'object') continue
        const label = typeof entry.label === 'string' && entry.label !== '' ? entry.label : entry.kind
        const labels = Array.isArray(entry.labels) ? entry.labels.filter(name => typeof name === 'string') : []
        parts.push(labels.length === 0 ? label : label + '（' + labels.join('、') + '）')
      }
      return parts.length === 0 ? '' : '：' + parts.join('；')
    }

    /**
     * Host 拒绝原因 → 一行可读文案。
     * @param {unknown} payload - Host 返回的 JSON。
     * @returns {string} 面向用户的说明。
     */
    function describeFailure(payload) {
      const code = payload !== null && typeof payload === 'object' ? payload.code : undefined
      const message = payload !== null && typeof payload === 'object' ? payload.message : undefined
      // `session-live` 是旧版 Host 的错误码，保留兼容，避免灰度期两头不一致。
      if (code === 'session-active' || code === 'session-live') {
        const detail = describeActivity(payload !== null && typeof payload === 'object' ? payload.activity : undefined)
        return (detail === ''
          ? '这条对话还在运行，请先停止当前任务再删除。'
          : '这条对话还在运行，请先停止后再删除' + detail + '。')
      }
      if (code === 'session-stuck') {
        const detail = describeActivity(payload !== null && typeof payload === 'object' ? payload.activity : undefined)
        return '这条对话卡在「运行中」，已尝试停止但没退出' + detail + '。可以强制删除。'
      }
      if (code === 'not-found') return '找不到这条对话，它可能已经被删除。'
      return typeof message === 'string' && message !== '' ? message : '删除失败，请稍后重试。'
    }

    /** 当前打开的浮层；同一时间只允许一个。 */
    let openDialog = null

    /**
     * 打开删除确认浮层。
     * @param {{ sessionId: string, displayTitle?: string }} request - 目标会话。
     * @returns {() => void} 关闭函数。
     */
    function openDeleteDialog(request) {
      if (typeof document === 'undefined') return () => {}
      openDialog?.()
      ensureStyles()

      const root = el('div', 'dsd-root')
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      root.setAttribute('aria-label', '删除会话')
      const mask = el('div', 'dsd-mask')
      const dialog = el('div', 'dsd-dialog')
      const title = el('h2', 'dsd-title', '删除会话？')
      const title2 = request.displayTitle !== undefined && request.displayTitle !== ''
        ? request.displayTitle
        : request.sessionId
      const desc = el('p', 'dsd-desc', '将永久删除「' + title2 + '」这条对话记录。')
      const list = el('ul', 'dsd-list')
      for (const line of ['会话日志文件（含全部消息与工具调用记录）', '该会话的缓存与侧栏位置标记']) {
        list.appendChild(el('li', undefined, line))
      }
      const warn = el('p', 'dsd-warn', '此操作不可撤销，删除后无法恢复。附件不会被删除。')
      const hint = el('p', 'dsd-status', '若这条对话仍在运行，会先停止它再删除。')
      const status = el('p', 'dsd-status')
      status.setAttribute('role', 'status')
      status.hidden = true
      const error = el('p', 'dsd-error')
      error.setAttribute('role', 'alert')
      error.hidden = true
      const footer = el('div', 'dsd-footer')
      const cancel = el('button', 'dsd-btn', '取消')
      cancel.type = 'button'
      const confirm = el('button', 'dsd-btn dsd-btnDanger', '删除')
      confirm.type = 'button'
      footer.append(cancel, confirm)
      dialog.append(title, desc, list, warn, hint, status, error, footer)
      root.append(mask, dialog)

      let busy = false
      /** 第一次点删除被「停不下来」挡回后置真，再点一次就走强制收尾。 */
      let force = false
      /** 关闭浮层并解绑全局监听。 */
      const close = () => {
        if (busy) return
        root.remove()
        window.removeEventListener('keydown', onKeyDown, true)
        if (openDialog === close) openDialog = null
      }
      /** @param {KeyboardEvent} event - 键盘事件。 */
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        }
      }
      mask.addEventListener('click', close)
      cancel.addEventListener('click', close)
      confirm.addEventListener('click', () => {
        busy = true
        confirm.disabled = true
        cancel.disabled = true
        error.hidden = true
        status.hidden = false
        status.textContent = force ? '正在强制删除…' : '正在删除…'
        fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(force ? { sessionId: request.sessionId, force: true } : { sessionId: request.sessionId }),
        }).then(async (response) => {
          const payload = await response.json().catch(() => null)
          if (response.ok && payload !== null && payload.ok === true) {
            busy = false
            close()
            return
          }
          busy = false
          confirm.disabled = false
          cancel.disabled = false
          status.hidden = true
          error.hidden = false
          error.textContent = describeFailure(payload)
          // 停不下来的会话：给第二次点按换成「强制删除」，选择权交给用户。
          if (payload !== null && typeof payload === 'object' && payload.code === 'session-stuck') {
            force = true
            confirm.textContent = '强制删除'
          }
        }).catch((reason) => {
          busy = false
          confirm.disabled = false
          cancel.disabled = false
          status.hidden = true
          error.hidden = false
          error.textContent = reason instanceof Error ? reason.message : String(reason)
        })
      })
      window.addEventListener('keydown', onKeyDown, true)
      document.body.appendChild(root)
      cancel.focus()
      openDialog = close
      return close
    }

    /**
     * 当前设备是否 macOS。
     * @returns {boolean} 是则 true。
     */
    function isMacPlatform() {
      const nav = typeof navigator === 'undefined' ? undefined : navigator
      if (nav === null || nav === undefined) return false
      const hinted = nav.userAgentData?.platform
      const platform = typeof hinted === 'string' && hinted !== ''
        ? hinted
        : typeof nav.platform === 'string' ? nav.platform : ''
      if (platform !== '') return /^mac/i.test(platform)
      return /Mac OS X/i.test(typeof nav.userAgent === 'string' ? nav.userAgent : '')
    }

    /**
     * 菜单里显示的键位符号。
     * @param {boolean} mac - 是否 macOS。
     * @returns {string[]} 例如 `['⌘', '⌫']`；拼起来即 `⌘⌫`。
     */
    function deleteShortcutKeys(mac) {
      return mac ? [...KEYS_MAC] : [...KEYS_OTHER]
    }

    /**
     * 焦点是否落在可编辑控件里——那里 ⌘⌫ 必须留给删文字。
     *
     * 判据与宿主 DOM 适配器（packages/client/shortcuts/src/client/dom.ts:71）保持
     * 一致：用 `closest` 往上找，而不是只看 `event.target` 的标签名——输入框
     * 里真正被点中的往往是个内层节点（编辑器里的 span）。
     *
     * @param {unknown} target - KeyboardEvent.target。
     * @returns {boolean} 是则可编辑。
     */
    function isEditableTarget(target) {
      if (target === null || typeof target !== 'object') return false
      if (typeof target.closest === 'function') {
        return target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]') !== null
      }
      const tag = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      return target.isContentEditable === true
    }

    /**
     * 这次按键是不是「删除会话」的组合：⌘⌫（macOS）/ Ctrl+⌫（其它）。
     * 只认干净的组合——带 Shift/Alt、长按重复、输入法组字中都不算，避免误删。
     * @param {object} event - KeyboardEvent。
     * @param {boolean} mac - 是否 macOS。
     * @returns {boolean} 命中则 true。
     */
    function matchesDeleteShortcut(event, mac) {
      if (event === null || typeof event !== 'object') return false
      if (event.key !== 'Backspace' && event.code !== 'Backspace') return false
      if (event.altKey === true || event.shiftKey === true) return false
      if (event.repeat === true || event.isComposing === true) return false
      // ⌘ 与 Ctrl 必须二选一：混按的 ⌃⌘⌫ 是系统的「清空废纸篓」，别抢。
      return mac
        ? event.metaKey === true && event.ctrlKey !== true
        : event.ctrlKey === true && event.metaKey !== true
    }

    /**
     * 侧栏当前选中的会话（主区域正在显示的那一条）。
     * @param {object|undefined} sessions - 宿主的 sessions 服务。
     * @returns {object|undefined} 会话行，没有则 undefined。
     */
    function currentSession(sessions) {
      const byId = sessions?.list?.getSnapshot?.().byId
      if (byId === null || typeof byId !== 'object') return undefined
      return Object.values(byId).find(row => (row?.retainedBy?.mainView ?? 0) > 0)
    }

    /**
     * 侧栏菜单项：关掉菜单，打开确认浮层。
     * @param {object} props - 行提供的会话身份、菜单开合 hook，以及 apply 期注入的打开函数。
     * @returns {object} 菜单行元素。
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete }) {
      const [, setMenuOpen] = useMenuOpenState()
      const keys = deleteShortcutKeys(IS_MAC)
      return h(
        'button',
        {
          type: 'button',
          className: 'dsd-item',
          role: 'menuitem',
          onClick: () => {
            setMenuOpen(false)
            requestDelete({ sessionId, displayTitle })
          },
        },
        h('span', { className: 'dsd-itemIcon', 'aria-hidden': true }, h(TrashIcon)),
        h('span', null, '删除会话'),
        keys.length === 0
          ? null
          : h('span', { className: 'dsd-kbd', 'aria-hidden': true }, keys.join('')),
      )
    }

    /** React 版的垃圾桶图标（菜单项内用）。 */
    function TrashIcon() {
      return h(
        'svg',
        {
          width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.4.3-.7.7-.7h2.6c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M4 4.5l.7 8.1c.05.6.55 1 1.15 1h4.3c.6 0 1.1-.4 1.15-1L12 4.5' }),
        h('path', { d: 'M6.8 7v4M9.2 7v4' }),
      )
    }

    return {
      inject: ['slots'],
      /**
       * 注册菜单项、快捷键与样式。
       * @param {object} ctx - client cordis 上下文。
       */
      apply(ctx) {
        ctx.effect(() => {
          ensureStyles()
          return () => {
            if (typeof document === 'undefined') return
            openDialog?.()
            document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')?.remove()
          }
        }, 'dsh-session-delete: styles')

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register(
          { name: 'sidebar.workspaces.session.menu.item', id: 'delete-session', order: MENU_ORDER },
          props => h(DeleteSessionMenuItem, { ...props, requestDelete: openDeleteDialog }),
        ))

        // ⌘⌫：自己听 keydown，理由见文件头第 3 条（宿主的 web 快捷键白名单
        // 把 Backspace 判成 reserved，注册不进去）。
        //
        // 需要 sessions 服务才能知道「当前是哪条会话」。`ctx.get` 是非阻塞读取，
        // 而 `ctx.inject` 在这类零构建插件里会让依赖永远等不到——插件直接停在
        // loading，连删除菜单都会消失。所以这里短轮询，拿到就绑，拿不到就算了：
        // 快捷键是加分项，删除入口照常可用。
        const installDeleteShortcut = (attempt) => {
          if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
          const sessions = ctx.get('sessions')
          if (sessions === undefined) {
            if (attempt < 100) setTimeout(() => { installDeleteShortcut(attempt + 1) }, 100)
            return
          }
          ctx.effect(() => {
            const onKeyDown = (event) => {
              // 确认框已经开着时不再抢键：里面的 ⌘⌫ 交给浏览器。
              if (openDialog !== null) return
              if (!matchesDeleteShortcut(event, IS_MAC)) return
              if (isEditableTarget(event.target)) return
              const session = currentSession(sessions)
              if (session === undefined) return
              event.preventDefault()
              event.stopPropagation()
              openDeleteDialog({ sessionId: session.id, displayTitle: session.title ?? undefined })
            }
            window.addEventListener('keydown', onKeyDown, true)
            return () => { window.removeEventListener('keydown', onKeyDown, true) }
          }, 'dsh-session-delete: shortcut')
        }
        installDeleteShortcut(0)
      },
      /** 测试与外部复用面。 */
      _internals: {
        ensureStyles, describeActivity, describeFailure, openDeleteDialog, trashSvg,
        isMacPlatform, deleteShortcutKeys, isEditableTarget, matchesDeleteShortcut, currentSession,
        CSS, STYLE_ID, ROUTE, MENU_ORDER, IS_MAC,
      },
    }
  },
})
