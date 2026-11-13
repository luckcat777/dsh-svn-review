/**
 * DSH 用自定义的 JSON Schema 子集校验工具定义，比标准 JSON Schema 更严：
 * `required` 必须是**对象级的字符串数组**，写成属性级的 `required: true` 会抛
 * JsonSchemaError，整个插件被停用（0.2.0 就是这么挂掉的）。
 *
 * 原因：DSH 内置插件走 `defineTool()`，它会用 `parameterSchemaSpecToJsonSchema` /
 * `valueSchemaSpecToJsonSchema` 把"属性级 required"这种写法规范化掉；
 * 而直接调 `ctx.tools.register()` 是**裸接口**，必须自己给出规范化后的 JSON Schema。
 *
 * 这里把两条硬约束固化下来：
 *   1. 任何 `required` 都是字符串数组；
 *   2. `parameters` 必须是完整的 `{type:'object', properties:{...}}`，
 *      否则会被当成"纯注解 schema = 任意 JSON"，模型根本看不到参数名。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/index.js'

function collect(node, path, problems) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return

  if ('required' in node) {
    if (!Array.isArray(node.required)) {
      problems.push(`${path}.required 必须是字符串数组，不能是 ${JSON.stringify(node.required)}`)
    } else {
      for (const key of node.required) {
        if (typeof key !== 'string') {
          problems.push(`${path}.required 里有非字符串项`)
        } else if (!node.properties || !(key in node.properties)) {
          problems.push(`${path}.required 声明了未定义的属性 "${key}"`)
        }
      }
    }
  }

  if (node.properties) {
    for (const [key, value] of Object.entries(node.properties)) {
      collect(value, `${path}.properties.${key}`, problems)
    }
  }
  if (node.items) collect(node.items, `${path}.items`, problems)
}

function registeredTools() {
  const tools = {}
  apply({ tools: { register: (tool) => { tools[tool.name] = tool } } })
  return tools
}

test('注册了两个工具，且都有 description / execute / render', () => {
  const tools = registeredTools()
  assert.deepEqual(Object.keys(tools).sort(), ['project_profile', 'svn_change_set'])
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.description, `${name} 缺 description`)
    assert.equal(typeof tool.execute, 'function', `${name} 缺 execute`)
    assert.ok(tool.output?.schema, `${name} 缺 output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${name} 缺 output.render`)
  }
})

test('parameters 必须是完整的对象 schema，不能是 {名字: 规格} 映射', () => {
  for (const [name, tool] of Object.entries(registeredTools())) {
    const spec = tool.parameters
    assert.equal(spec.type, 'object', `${name}.parameters 缺少 type:'object'（否则会被当成任意 JSON）`)
    assert.ok(spec.properties && Object.keys(spec.properties).length > 0, `${name} 没有声明任何参数`)
    assert.ok('path' in spec.properties, `${name} 应该声明 path 参数`)
    assert.equal(spec.properties.path.type, 'string', `${name}.path 应是 string`)
  }
})

test('任何 schema 里的 required 都是字符串数组', () => {
  const problems = []
  for (const [name, tool] of Object.entries(registeredTools())) {
    collect(tool.parameters, `${name}.parameters`, problems)
    collect(tool.output.schema, `${name}.output.schema`, problems)
  }
  assert.deepEqual(problems, [], `schema 不合规：\n${problems.join('\n')}`)
})

test('output.schema 的 required 都真的定义了对应属性', () => {
  for (const [name, tool] of Object.entries(registeredTools())) {
    const { schema } = tool.output
    for (const key of schema.required ?? []) {
      assert.ok(schema.properties[key], `${name}: required 里的 ${key} 没有定义`)
    }
  }
})

test('lib 源码里不许出现写死的盘符路径', async () => {
  // 用户可能根本没有 E: 盘。规则随包发布、路径一律相对包或用户目录解析，
  // 写死 `E:\rules\...` 会让别人的插件指向一个不存在的目录，
  // 而且这种问题在本机永远复现不出来——只能靠测试守住。
  const { readdirSync, readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib')

  const offenders = []
  for (const entry of readdirSync(libDir)) {
    if (!entry.endsWith('.js')) continue
    const text = readFileSync(join(libDir, entry), 'utf8')
    // 匹配 'E:\' / "D:/" 这类字面量，不匹配注释里的举例说明由下一行白名单兜住。
    const lines = text.split('\n')
    // 只认"字符串字面量里的盘符"：['"`] 后面紧跟 X:\ 或 X:/
    // 这样 `plugin:\s` 这类正则文本不会误报，而 'E:\rules' 会。
    lines.forEach((line, index) => {
      if (!/['"`][A-Za-z]:[\\/]/.test(line)) return
      if (/^\s*(\*|\/\/)/.test(line)) return
      offenders.push(`${entry}:${index + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `lib 里出现了写死的盘符路径：\n${offenders.join('\n')}`)
})

test('包内自带规则，缺 E 盘也能解析到档案', async () => {
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const rulesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules')

  for (const relative of ['REVIEW_RULES.md', 'languages/java.md', 'languages/generic.md']) {
    assert.ok(existsSync(join(rulesDir, relative)), `包内缺少规则文件：rules/${relative}`)
  }
  // 旧档案必须已经删掉，否则用户可能读到被取代的那份。
  assert.equal(existsSync(join(rulesDir, 'languages', 'java8.md')), false, 'java8.md 应已被 java.md 取代')
})
