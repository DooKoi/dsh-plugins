# @dookoi/dsh-client-ui-session-delete

DeepSeek Harness 插件：给侧栏会话菜单加一条 **删除会话**，把这条对话独占的数据一起删掉。

![platform](https://img.shields.io/badge/platform-web-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 为什么需要它

DSH 自带的会话生命周期只有「归档」——归档只往 `workspace.json` 的 `archivedSessionIds`
里写一个 id，**日志文件永久留在磁盘上**，只能靠手工删目录清理。这个插件补上真正的删除。

## 删什么、不删什么

| 数据 | 位置 | 处理 |
| --- | --- | --- |
| 会话日志 | `~/.dsh/sessions/<项目目录>/<会话id>/` | **删除**（整目录：jsonl/zstd、`session.lock`、将来放在同目录的会话级产物） |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<会话id>.json` | **删除** |
| 归档/置顶标记 | `~/.dsh/storages/workspace.json` | **摘掉**（否则侧栏会留一条幽灵会话） |
| 附件（图片/文件） | `~/.dsh/attachments/v1/` | **保留** |

附件不删是有意为之：附件库是**内容寻址的全局共享对象**（`objects/<sha前2位>/<sha256>`），
没有会话归属，也没有引用计数。同一条消息里的图片可能正被另一条会话引用，按会话删除
必然会毁掉别人的数据。要清附件得先做全局引用计数，属于独立功能。

## 安全边界

- **点删除就是授权停止**：命中 `turn` / `job` / `subagent` 或任何未知家族时，插件先按宿主归档
  的同一条通路 `workspace/session-stop` 停一轮（取消回合、结束子代理、清提醒），等 agent 落回
  `idle` 再复查。停下来了就照删；**停不下来**才返回 409 `session-stuck`，前端把按钮换成
  「强制删除」，用户再点一次带 `force: true` 跳过判定。活 Agent 另有一道兜底，判据与宿主归档
  一致（`agent.status === 'running'`）。
- **已加载但空闲不算在跑**：`agents.get()` 有值只说明会话被加载进内存（点开过），不代表正在工作，
  照删。早期版本把"存在即拒绝"当成安全判定，导致每个点开过的会话都永远删不掉。
- **只挂定时提醒不算在跑**：`schedule` 家族单独放行，删除时会先 `workspace/session-stop`
  停掉这些提醒，否则它们会投递到已经消失的会话。放行用的是白名单（只放 `schedule`），
  宿主将来新增活动家族时默认落在阻塞侧。
- **路径穿越挡两层**：会话 id 先拒掉 `/` `\` `\0` 并限制长度，再经宿主同款 `encodeSegment`
  编码成单段；拼出的目录还要过 `insideRoot` 前缀校验。
- **不依赖会话服务读 header**：`sessionPersistence.stat()` 会按当前压缩配置校验文件后缀，
  一个格式损坏或迁移到一半的会话会直接抛错——而那类会话恰恰是最想删的。插件改为按目录名
  扫描会话根（项目目录通常个位数），坏掉的会话也能删干净。
- **找不到就报 404**，不会假装删成功。
- 删除不可撤销，前端有二次确认。

## 快捷键

选中某条会话后按 **⌘⌫**（Windows/Linux 为 **Ctrl+⌫**）即可打开删除确认框，侧栏菜单里也标注了键位。

- **只在页面区生效**：焦点在输入框、文本域、`contenteditable`（对话输入框）里时，⌘⌫ 照旧交给
  浏览器删文字。判据与宿主 DOM 适配器一致——用 `closest` 往上找，而不是只看事件目标本身。
- **只认干净的组合**：带 Shift/Alt、长按重复、输入法组字中都不触发；混按的 ⌃⌘⌫ 是系统的
  「清空废纸篓」，不抢。
- **不走宿主快捷键服务**：宿主的 `bindingIssue`（`packages/client/shortcuts/src/configuration.ts:104`）
  把含 `Backspace`/`Delete`/`Enter`/方向键的组合一律判为 `reserved`，唯一的提前放行口是"至少三个
  修饰键"；`ShortcutRegistry.register` 又会为 desktop/web × 三个平台逐个校验、任一不过就整条抛错。
  也就是说 web 端根本注册不进 ⌘⌫（表现为菜单没键位、按了没反应，而且异常被 `ctx.effect` 吞掉）。
  所以插件自己监听 `keydown`，代价是它不会出现在宿主的快捷键设置面板里。

## 安装

```bash
git clone https://github.com/DooKoi/dsh-plugins.git

# 从仓库装（推荐，路径指向插件目录而不是仓库根）
dsh plugin --profile web add ./dsh-plugins/plugins/session-delete

# 或者直接按包名装
dsh plugin --profile web add @dookoi/dsh-client-ui-session-delete

# 重启生效
dsh web
```

装完重启 DSH。侧栏任意会话的「…」菜单底部即是 **删除会话**，或选中会话后按 ⌘⌫。

改这个插件自己的代码时注意冷热边界：**客户端半**（`lib/client.js`）是每次请求现取的静态文件，
浏览器刷新页面就生效；**宿主半**（`lib/`）在进程启动时装载，必须重启 `dsh web` 才会换。

## 配置项

写在 profile 的 `cordis.patch.yml` 里（`~/.dsh/profiles/<名字>/cordis.patch.yml`）：

```yaml
- id: ui-session-delete
  name: '@dookoi/dsh-client-ui-session-delete'
  config:
    sessionsRoot: /abs/path/to/sessions   # 默认 <DSH_HOME>/sessions
    removeProjectionCache: true           # 默认 true
    forgetWorkspaceMarks: true            # 默认 true
    stopTimeoutMs: 3000                   # 默认 3000：停一轮后等 agent 落回 idle 的上限
```

## 实现结构

| 层 | 文件 | 说明 |
| --- | --- | --- |
| Host | `lib/index.js` | `ctx.connection.fetch.register` 注册 `POST /api/session-delete`；认证由 connection 服务负责 |
| Host | `lib/paths.js` | 目录规则，与宿主 `session-persistence-jsonl/src/format.ts` 逐值一致 |
| Client | `lib/client.js` | 零构建产物：注册 `sidebar.workspaces.session.menu.item`（order 500）、自建原生 DOM 确认框、自己监听 ⌘⌫ |

## 测试

```bash
node --test tests/*.test.mjs
```

52 个用例，覆盖：目录规则与宿主源码逐值对比（用仓库自带 tsx 加载宿主 TS 求值）、
真实临时目录上的删除/拒绝/降级、活动家族分类（idle 放行 / running 拒绝 / schedule 清理）、
停不下来时的 `session-stuck` 与 `force` 二次点按、HTTP 路由的 400/404/409/500、
客户端注册契约、快捷键判定（平台键位、可编辑区放行、组合过滤）与纯逻辑。

## 已知限制

- 只删当前用户本机的会话；跨进程仍持有同一会话（多实例共用 `DSH_HOME`）时无法检测占用。
- 删除的是正在显示的会话时，主区域不会自动切换（侧栏行会消失），需手动点选其他会话。
- 不删 fork 出来的子会话：子会话有自己的日志，需单独删。
