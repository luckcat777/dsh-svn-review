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
