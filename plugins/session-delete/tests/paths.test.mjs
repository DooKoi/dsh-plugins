/**
 * 路径规则一致性测试。
 *
 * 插件的目录计算是宿主 `session-persistence-jsonl/src/format.ts` 的等价实现，
 * 两份代码必须逐值相同：一旦漂移，删除操作会找不到目标目录（表现为「会话
 * 不存在」）而不是误删，但功能会静默失效。这里直接拿宿主源码算期望值对比。
 *
 * 宿主是 TypeScript，用仓库自带的 tsx loader 在子进程里求值；仓库不在预期
 * 位置时退化为黄金用例（仍能发现本插件自身被改坏）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dshHome, encodeSegment, projectKey, sessionDir } from '../lib/paths.js'

const REPO = process.env.DSH_REPO ?? '/Users/wenyi/Desktop/DSH/dsh-ai/deepseek-harness'
const TSX = join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')

/** 覆盖 ASCII、分隔符、`~` 转义、点段、非 ASCII 与代理对的样本。 */
const SEGMENT_CASES = [
  'session-1',
  'a/b',
  '..',
  '.',
  '~tilde',
  'C:\\Users\\wenyi\\proj',
  '/Users/wenyi/Desktop/DSH',
  '中文会话',
  'has space',
  'emoji-🙂',
  'a:b',
  '\u0000nul',
]

/** 项目路径样本，覆盖分隔符折叠、驱动器号与超长截断。 */
const PROJECT_CASES = [
  '/Users/wenyi/Desktop/DSH',
  'C:\\Users\\wenyi',
  '/',
  '/a//b///c',
  '/带 空格/中文',
  '/' + 'x'.repeat(400),
]

/**
 * 在带 tsx loader 的子进程里求宿主实现的结果。
 * @param {string[]} segments - encodeSegment 的输入。
 * @param {string[]} projects - projectKey 的输入。
 * @returns {{ segments: string[], projects: string[] }} 宿主算出的期望值。
 */
function hostExpectations(segments, projects) {
  const script = `
    const m = await import(${JSON.stringify(`file://${join(REPO, 'packages/session/session-persistence-jsonl/src/format.ts')}`)})
    process.stdout.write(JSON.stringify({
      segments: ${JSON.stringify(segments)}.map(v => m.encodeSegment(v)),
      projects: ${JSON.stringify(projects)}.map(v => m.projectKey(v)),
    }))
  `
  const output = execFileSync(process.execPath, ['--import', `file://${TSX}`, '--input-type=module', '-e', script], {
    encoding: 'utf8',
  })
  return JSON.parse(output)
}

test('encodeSegment 与宿主实现逐值一致', () => {
  const expected = ['session-1', 'a~002Fb', '~002E~002E', '~002E', '~007Etilde',
    'C~003A~005CUsers~005Cwenyi~005Cproj', '~002FUsers~002Fwenyi~002FDesktop~002FDSH',
    '~4E2D~6587~4F1A~8BDD', 'has~0020space', 'emoji-~D83D~DE42', 'a~003Ab', '~0000nul']
  assert.deepEqual(SEGMENT_CASES.map(encodeSegment), expected)
  if (!existsSync(TSX)) return
  assert.deepEqual(SEGMENT_CASES.map(encodeSegment), hostExpectations(SEGMENT_CASES, []).segments)
})

test('projectKey 与宿主实现逐值一致', () => {
  if (!existsSync(TSX)) {
    assert.equal(projectKey('/Users/wenyi/Desktop/DSH'), '--Users-wenyi-Desktop-DSH--')
    return
  }
  assert.deepEqual(PROJECT_CASES.map(projectKey), hostExpectations([], PROJECT_CASES).projects)
})

test('sessionDir 把会话 id 收敛成单段路径', () => {
  assert.equal(sessionDir('/root', '/Users/wenyi/p', 'abc'), join('/root', '--Users-wenyi-p--', 'abc'))
  assert.equal(sessionDir('/root', undefined, 'abc'), join('/root', '_no-cwd', 'abc'))
  // 穿越尝试必须被编码成单段：分隔符全部转义，路径层级不增加。
  const projectRoot = join('/root', '--p--')
  const escaped = sessionDir('/root', '/p', '../../etc/passwd')
  assert.ok(escaped.startsWith(projectRoot), escaped)
  const remainder = escaped.slice(projectRoot.length + 1)
  assert.ok(remainder.length > 0, escaped)
  assert.ok(!remainder.includes('/'), `会话 id 段内不得出现分隔符: ${escaped}`)
  assert.equal(escaped.split('/').length, projectRoot.split('/').length + 1, escaped)
})

test('dshHome 优先读 DSH_HOME，否则回落到 ~/.dsh', () => {
  assert.equal(dshHome(() => '/custom/home'), '/custom/home')
  assert.equal(dshHome(() => ''), join(process.env.HOME ?? '', '.dsh'))
  assert.equal(dshHome(() => undefined), join(process.env.HOME ?? '', '.dsh'))
})
