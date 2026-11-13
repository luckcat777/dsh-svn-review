/**
 * 技术栈识别的回归测试。
 *
 * 每个用例造一个临时目录，只放"判定所需的最小文件"，然后断言识别结果。
 * 特别覆盖了 GBK 字节：构建脚本经常不是 UTF-8，按 UTF-8 解码会乱码，
 * 但判定必须仍然成立。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectProject, profileForLanguage, profileSupportsVersion } from '../lib/detect.js'

/** 造一个临时工程目录。键是相对路径，值可以是字符串或 Buffer。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-detect-'))
  for (const [name, content] of Object.entries(files)) {
    const absolute = join(root, name)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

test('Gradle 项目：识别 Java 8、模块数、junit，以及工程名', async (t) => {
  // 模拟 GBK：中文注释按 GBK 编码写入，判定只能靠 ASCII 部分
  const gbk = Buffer.concat([
    Buffer.from("sourceCompatibility = 1.8 // jvm", 'ascii'),
    Buffer.from([0xb0, 0xe6, 0xb1, 0xbe]), // "版本" 的 GBK 字节
    Buffer.from('\n', 'ascii'),
  ])
  const root = fixture({
    'settings.gradle': "rootProject.name = 'x_main'\ninclude 'a'\ninclude 'b'\ninclude 'c'\n",
    'build.gradle': gbk,
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  assert.equal(result.projectName, 'x_main')
  const java = result.stacks.find((stack) => stack.language === 'java')
  assert.ok(java, '应识别出 java')
  assert.equal(java.version, '1.8')
  assert.equal(result.build.system, 'gradle')
  assert.equal(result.build.modules, 3)
  // 证据里不能带 GBK 乱码
  assert.match(java.evidence[0], /sourceCompatibility = 1\.8/)
  assert.doesNotMatch(java.evidence[0], /[\u0080-\u00ff]/)
})

test('Maven 项目：从 pom.xml 读 maven.compiler.source', async (t) => {
  const root = fixture({
    'pom.xml': '<project><properties><maven.compiler.source>1.8</maven.compiler.source></properties></project>',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const java = detectProject(root).stacks.find((stack) => stack.language === 'java')
  assert.equal(java.version, '1.8')
  assert.equal(detectProject(root).build.system, 'maven')
})

test('C++：从 CMakeLists 读 CMAKE_CXX_STANDARD', async (t) => {
  const root = fixture({ 'CMakeLists.txt': 'set(CMAKE_CXX_STANDARD 17)\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const cpp = detectProject(root).stacks.find((stack) => stack.language === 'cpp')
  assert.equal(cpp.version, '17')
  assert.equal(detectProject(root).build.system, 'cmake')
})

test('C#：读 TargetFramework 与 LangVersion', async (t) => {
  const root = fixture({
    'App.csproj':
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
      + '<TargetFramework>net8.0</TargetFramework><LangVersion>12</LangVersion>'
      + '</PropertyGroup></Project>',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  const csharp = result.stacks.find((stack) => stack.language === 'csharp')
  assert.equal(csharp.version, '12')
  assert.equal(csharp.framework, 'net8.0')
  assert.equal(result.projectName, 'App')
})

test('TypeScript：区分 node 与 typescript 版本，并识别 jest', async (t) => {
  const root = fixture({
    'package.json': JSON.stringify({
      name: 'demo',
      engines: { node: '>=20' },
      devDependencies: { typescript: '5.4.2', jest: '29.0.0' },
    }),
    'tsconfig.json': '{}',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  const ts = result.stacks.find((stack) => stack.language === 'typescript')
  assert.ok(ts, '应识别为 typescript')
  assert.match(ts.version, /node >=20/)
  assert.match(ts.version, /typescript 5\.4\.2/)
  assert.equal(result.projectName, 'demo')
  assert.ok(result.testInfra.some((item) => item.startsWith('jest')))
  // typescript 映射到 javascript 档案
  assert.equal(profileForLanguage('typescript'), 'javascript')
  assert.equal(profileSupportsVersion('typescript', ts.version), true)
})

test('版本不匹配时明确拒绝套用档案', async (t) => {
  const root = fixture({ 'build.gradle': 'sourceCompatibility = 17\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const java = detectProject(root).stacks.find((stack) => stack.language === 'java')
  assert.equal(java.version, '17')
  assert.equal(profileSupportsVersion('java', '17'), false, 'Java 17 不应套用 java8 档案')
  assert.equal(profileSupportsVersion('java', '1.8'), true)
  assert.equal(profileSupportsVersion('java', '8'), true)
})

test('版本未声明时返回 null，不给默认值', async (t) => {
  const root = fixture({ 'build.gradle': "plugins { id 'java' }\n" })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  const java = result.stacks.find((stack) => stack.language === 'java')
  assert.equal(java.version, null)
  assert.ok(result.notes.some((note) => note.includes('版本未在构建文件中声明')))
  assert.equal(profileSupportsVersion('java', null), false)
})

test('没有任何标记的目录：不瞎猜', async (t) => {
  const root = fixture({ 'README.md': '# nothing here\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  assert.equal(result.stacks.length, 0)
  assert.ok(result.notes.length > 0)
})
