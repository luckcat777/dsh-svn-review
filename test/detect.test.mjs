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

test('Java 各版本都套同一份档案，版本矩阵在档案正文里', async (t) => {
  const root = fixture({ 'build.gradle': 'sourceCompatibility = 17\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const java = detectProject(root).stacks.find((stack) => stack.language === 'java')
  assert.equal(java.version, '17')

  // 档案按语言分，不按版本分：17 和 8 读同一份 java.md，由正文的版本矩阵区分可用语法。
  assert.equal(profileForLanguage('java'), 'java')
  for (const version of ['1.8', '8', '11', '17', '21', '23']) {
    assert.equal(profileSupportsVersion('java', version), true, `Java ${version} 应有档案可读`)
  }
  // 7 及更老没有 lambda/Stream，语法差异太大，明说没有档案比套错好。
  assert.equal(profileSupportsVersion('java', '7'), false)
  assert.equal(profileSupportsVersion('java', '1.6'), false)
})

test('版本未声明时返回 null，不给默认值', async (t) => {
  const root = fixture({ 'build.gradle': "plugins { id 'java' }\n" })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  const java = result.stacks.find((stack) => stack.language === 'java')
  assert.equal(java.version, null)
  assert.ok(result.notes.some((note) => note.includes('版本未在构建文件中声明')))
  // 版本未知不等于没有档案：档案正文能按与版本无关的判据审，退回 generic 会丢掉全部语言知识。
  assert.equal(profileSupportsVersion('java', null), true)
})

test('没有任何标记的目录：不瞎猜', async (t) => {
  const root = fixture({ 'README.md': '# nothing here\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  assert.equal(result.stacks.length, 0)
  assert.ok(result.notes.length > 0)
})

test('Rust：读 Cargo.toml 的 edition', async (t) => {
  const root = fixture({
    'Cargo.toml': '[package]\nname = "demo"\nedition = "2021"\n',
    'src/main.rs': 'fn main() {}\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const rust = detectProject(root).stacks.find((stack) => stack.language === 'rust')
  assert.equal(rust.version, 'edition 2021')
  assert.equal(profileForLanguage('rust'), 'rust')
})

test('鸿蒙 ArkTS：读 build-profile.json5 的 compatibleSdkVersion', async (t) => {
  const root = fixture({
    'build-profile.json5': '{"app":{"products":[{"compatibleSdkVersion":"5.0.0(12)"}]}}',
    'entry/src/main/ets/pages/Index.ets': '@Entry\n@Component\nstruct Index {}\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const arkts = detectProject(root).stacks.find((stack) => stack.language === 'arkts')
  assert.ok(arkts, '应识别出 arkts')
  assert.match(arkts.version, /5\.0\.0/)
  assert.equal(profileForLanguage('arkts'), 'arkts')
})

test('Kotlin 工程不能被误判成 Java', async (t) => {
  const root = fixture({
    'build.gradle.kts': 'plugins {\n  kotlin("jvm") version "1.9.22"\n}\n',
    'src/main/kotlin/Main.kt': 'fun main() {}\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = detectProject(root)
  assert.equal(result.stacks.some((stack) => stack.language === 'java'), false, '没有 java 插件就不该报 Java')
  const kotlin = result.stacks.find((stack) => stack.language === 'kotlin')
  assert.equal(kotlin.version, '1.9.22')
  assert.equal(profileForLanguage('kotlin'), 'kotlin')
})

test('没有构建文件时按扩展名认语言（Lua）', async (t) => {
  const root = fixture({ 'src/a.lua': 'return 1\n', 'src/b.lua': 'return 2\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const lua = detectProject(root).stacks.find((stack) => stack.language === 'lua')
  assert.ok(lua, '扩展名普查应认出 lua')
  assert.equal(lua.version, null)
  // 没有专用档案 → 走通用兜底
  assert.equal(profileForLanguage('lua'), null)
})

test('Go 版本影响循环变量语义，必须读出来', async (t) => {
  const root = fixture({ 'go.mod': 'module example.com/demo\n\ngo 1.22\n', 'main.go': 'package main\n' })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const go = detectProject(root).stacks.find((stack) => stack.language === 'go')
  assert.equal(go.version, '1.22')
  assert.equal(profileForLanguage('go'), 'go')
})

test('Python 读 requires-python', async (t) => {
  const root = fixture({
    'pyproject.toml': '[project]\nrequires-python = ">=3.11"\n',
    'app.py': 'print(1)\n',
  })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const python = detectProject(root).stacks.find((stack) => stack.language === 'python')
  assert.equal(python.version, '>=3.11')
  assert.equal(profileForLanguage('python'), 'python')
})

test('未知语言也有兜底档案路径，不会"无档案可读"', async () => {
  // generic 档案按约定存在；这里只断言映射层的行为
  assert.equal(profileForLanguage('zig'), null)
  assert.equal(profileForLanguage('haskell'), null)
  assert.equal(profileForLanguage('java'), 'java')
  assert.equal(profileForLanguage('typescript'), 'javascript')
})