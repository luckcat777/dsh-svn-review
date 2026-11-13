/**
 * 从工作目录推断"这是哪个语言、哪个版本的项目"。
 *
 * 设计约束：
 * 1. **不猜。** 推断不出来就返回 `null` 并说明原因，不给默认值——默认值会制造误报。
 * 2. **按字节匹配。** 构建脚本经常是 GBK/GB18030，按 UTF-8 解码会是乱码，
 *    但 `sourceCompatibility = 1.8` 这类关键行全是 ASCII，所以一律在 latin1 视图上匹配。
 * 3. **只读少量文件。** 只看根目录标记文件和一层子目录的工程文件，不扫全树。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, extname } from 'node:path'

import { findWorkingCopy } from './wc.js'

/** 读文本用于特征匹配：不关心非 ASCII，用 latin1 保证关键行不会被解码破坏。 */
function readBytesForMatch(absolute) {
  try {
    const buffer = readFileSync(absolute)
    // 超过 512 KB 的构建脚本不常见，截断只为匹配关键字，不影响判定。
    return buffer.subarray(0, 512 * 1024).toString('latin1')
  } catch {
    return null
  }
}

/** 读 JSON，失败返回 null。 */
function readJson(absolute) {
  try {
    return JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    return null
  }
}

function exists(absolute) {
  try {
    return statSync(absolute).isFile()
  } catch {
    return false
  }
}

function isDir(absolute) {
  try {
    return statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

function listFiles(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 从一段文本里按顺序尝试多个正则，返回第一个命中组。 */
function firstMatch(text, patterns) {
  if (!text) return null
  for (const pattern of patterns) {
    const found = pattern.exec(text)
    if (found) return found
  }
  return null
}

/** 收集证据用：把命中的原始行裁出来，方便用户核对推断依据。 */
function evidenceLine(text, index) {
  if (!text) return ''
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  const raw = text.slice(start, end === -1 ? text.length : end)
  // latin1 视图下 GBK/UTF-8 的非 ASCII 字节会变成 0x80 以上的字符，表现为乱码。
  // 证据只保留 ASCII（构建指令本身全是 ASCII），避免把乱码带进报告。
  return raw.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
}

// ---------------------------------------------------------------------------
// 各语言的判定规则
// ---------------------------------------------------------------------------

/** Java：Gradle / Maven 两条线。 */
function detectJava(root, files) {
  const evidence = []
  let version = null

  const gradleBuild = ['build.gradle', 'build.gradle.kts'].map((n) => join(root, n)).find(exists)
  if (gradleBuild) {
    const text = readBytesForMatch(gradleBuild)
    const hit = firstMatch(text, [
      /sourceCompatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?(1\.\d+|\d+)/,
      /targetCompatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?(1\.\d+|\d+)/,
      /JavaVersion\.VERSION_(1_\d+|\d+)/,
    ])
    if (hit) {
      version = hit[1].replace('_', '.')
      evidence.push(`${gradleBuild.replace(root + '\\', '')}: ${evidenceLine(text, hit.index)}`)
    }
  }

  const pom = join(root, 'pom.xml')
  if (!version && exists(pom)) {
    const text = readBytesForMatch(pom)
    const hit = firstMatch(text, [
      /<maven\.compiler\.source>\s*([\d.]+)\s*</,
      /<maven\.compiler\.release>\s*([\d.]+)\s*</,
      /<java\.version>\s*([\d.]+)\s*</,
      /<source>\s*([\d.]+)\s*</,
      /<release>\s*([\d.]+)\s*</,
    ])
    if (hit) {
      version = hit[1]
      evidence.push(`pom.xml: ${evidenceLine(text, hit.index)}`)
    }
  }

  // gradle.properties 里也可能声明
  if (!version) {
    const props = join(root, 'gradle.properties')
    if (exists(props)) {
      const text = readBytesForMatch(props)
      const hit = firstMatch(text, [/(?:^|\n)\s*java\.version\s*=\s*([\d.]+)/])
      if (hit) {
        version = hit[1]
        evidence.push(`gradle.properties: ${evidenceLine(text, hit.index)}`)
      }
    }
  }

  const hasJavaFiles = files.some((f) => f.endsWith('.java'))
  if (!gradleBuild && !exists(pom) && !hasJavaFiles) return null

  if (!version) evidence.push('未在构建文件中找到 sourceCompatibility / maven.compiler.source')
  return { language: 'java', version, evidence }
}

/** C / C++：CMake、MSBuild、Makefile、Meson。 */
function detectCpp(root) {
  const evidence = []
  let version = null

  const cmake = join(root, 'CMakeLists.txt')
  if (exists(cmake)) {
    const text = readBytesForMatch(cmake)
    const hit = firstMatch(text, [
      /CMAKE_CXX_STANDARD\s+(?:REQUIRED\s+)?(\d{2})/,
      /-std=c\+\+(\d{2})/,
    ])
    if (hit) {
      version = hit[1]
      evidence.push(`CMakeLists.txt: ${evidenceLine(text, hit.index)}`)
    }
  }

  if (!version) {
    const makefile = ['Makefile', 'makefile', 'GNUmakefile'].map((n) => join(root, n)).find(exists)
    if (makefile) {
      const text = readBytesForMatch(makefile)
      const hit = firstMatch(text, [/-std=c\+\+(98|11|14|17|20|23)/])
      if (hit) {
        version = hit[1]
        evidence.push(`Makefile: ${evidenceLine(text, hit.index)}`)
      }
    }
  }

  if (!version) {
    const vcx = listFiles(root).find(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.vcxproj'),
    )
    if (vcx) {
      const text = readBytesForMatch(join(root, vcx.name))
      const hit = firstMatch(text, [/<LanguageStandard>\s*stdcpp(\d{2})/, /<LanguageStandard>\s*(C\+\+\w+)/])
      if (hit) {
        version = hit[1]
        evidence.push(`${vcx.name}: ${evidenceLine(text, hit.index)}`)
      }
    }
  }

  if (evidence.length === 0) return null
  if (!version) evidence.push('未找到明确的 C++ 标准，档案里"先确认标准"这一步必须人工补')
  return { language: 'cpp', version, evidence }
}

/** C#：csproj / sln 里的 TargetFramework。 */
function detectCsharp(root) {
  const entries = listFiles(root)
  const project = entries.find(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.csproj'),
  )
  if (!project) return null

  const text = readBytesForMatch(join(root, project.name))
  const evidence = []
  let framework = null
  let langVersion = null

  const tf = firstMatch(text, [/<TargetFramework>\s*([\w.]+)\s*</, /<TargetFrameworks>\s*([\w.;]+)\s*</])
  if (tf) {
    framework = tf[1].split(';')[0]
    evidence.push(`${project.name}: ${evidenceLine(text, tf.index)}`)
  }
  const lv = firstMatch(text, [/<LangVersion>\s*([\w.]+)\s*</])
  if (lv) {
    langVersion = lv[1]
    evidence.push(`${project.name}: ${evidenceLine(text, lv.index)}`)
  }
  if (!framework) evidence.push('未找到 TargetFramework，.NET 版本未知')

  return { language: 'csharp', version: langVersion ?? framework, framework, evidence }
}

/** JavaScript / TypeScript。 */
function detectJavascript(root, files) {
  const pkg = join(root, 'package.json')
  if (!exists(pkg)) {
    const hasJs = files.some((f) => /\.(?:js|mjs|cjs|jsx|ts|tsx)$/.test(f))
    return hasJs ? { language: 'javascript', version: null, evidence: ['有脚本文件但无 package.json'] } : null
  }

  const json = readJson(pkg)
  const evidence = []
  const parts = []
  let language = 'javascript'

  const engines = json?.engines?.node
  if (engines) {
    evidence.push(`package.json: "engines": { "node": "${engines}" }`)
    parts.push(`node ${engines}`)
  }

  const typescript = json?.devDependencies?.typescript ?? json?.dependencies?.typescript
  if (typescript) {
    language = 'typescript'
    evidence.push(`package.json: typescript@${typescript}`)
    parts.push(`typescript ${typescript}`)
  } else if (exists(join(root, 'tsconfig.json'))) {
    language = 'typescript'
    evidence.push('tsconfig.json 存在')
  }

  if (parts.length === 0) {
    const nvmrc = ['.nvmrc', '.node-version'].map((n) => join(root, n)).find(exists)
    if (nvmrc) {
      const text = readBytesForMatch(nvmrc)
      if (text && text.trim()) {
        parts.push(`node ${text.trim()}`)
        evidence.push(`${nvmrc.replace(root + '\\', '')}: ${text.trim()}`)
      }
    }
  }

  return { language, version: parts.length > 0 ? parts.join(' / ') : null, evidence }
}

/** Go。 */
function detectGo(root) {
  const gomod = join(root, 'go.mod')
  if (!exists(gomod)) return null
  const text = readBytesForMatch(gomod)
  const hit = firstMatch(text, [/(?:^|\n)\s*go\s+(\d+\.\d+(?:\.\d+)?)/])
  return {
    language: 'go',
    version: hit ? hit[1] : null,
    evidence: hit ? [`go.mod: ${evidenceLine(text, hit.index)}`] : ['go.mod 存在但未声明 go 版本'],
  }
}

/** Rust。 */
function detectRust(root) {
  const cargo = join(root, 'Cargo.toml')
  if (!exists(cargo)) return null
  const text = readBytesForMatch(cargo)
  const hit = firstMatch(text, [/edition\s*=\s*"(\d{4})"/])
  return {
    language: 'rust',
    version: hit ? `edition ${hit[1]}` : null,
    evidence: hit ? [`Cargo.toml: ${evidenceLine(text, hit.index)}`] : ['Cargo.toml 未声明 edition'],
  }
}

/** Python。 */
function detectPython(root) {
  const evidence = []
  let version = null

  const pyproject = join(root, 'pyproject.toml')
  if (exists(pyproject)) {
    const text = readBytesForMatch(pyproject)
    const hit = firstMatch(text, [/requires-python\s*=\s*"([^"]+)"/])
    if (hit) {
      version = hit[1]
      evidence.push(`pyproject.toml: ${evidenceLine(text, hit.index)}`)
    }
  }
  if (!version) {
    const marker = ['.python-version', 'runtime.txt'].map((n) => join(root, n)).find(exists)
    if (marker) {
      const text = readBytesForMatch(marker)
      if (text) {
        version = text.trim()
        evidence.push(`${marker.replace(root + '\\', '')}: ${text.trim()}`)
      }
    }
  }
  if (evidence.length === 0 && !exists(join(root, 'setup.py'))) return null
  if (!version) evidence.push('未声明 Python 版本')
  return { language: 'python', version, evidence }
}

// ---------------------------------------------------------------------------
// 工程画像：构建系统、测试基建、并发线索
// ---------------------------------------------------------------------------

const CONCURRENCY_HINTS = [
  { pattern: /\bnetty\b/i, hint: 'Netty（异步事件循环）' },
  { pattern: /\bspring-boot\b|\borg\.springframework\b/i, hint: 'Spring（可能有多线程 bean）' },
  { pattern: /\btokio\b/i, hint: 'Tokio（Rust 异步运行时）' },
  { pattern: /\breactor\b/i, hint: 'Reactor（响应式）' },
  { pattern: /\bthread|ExecutorService|ThreadPool/i, hint: '显式线程池' },
]

function detectBuild(root, files) {
  if (files.includes('settings.gradle') || files.includes('settings.gradle.kts') || files.includes('build.gradle')) {
    const settings = ['settings.gradle', 'settings.gradle.kts'].map((n) => join(root, n)).find(exists)
    let modules = null
    if (settings) {
      const text = readBytesForMatch(settings)
      if (text) {
        const count = (text.match(/^\s*include\s/gm) ?? []).length
        if (count > 0) modules = count
      }
    }
    return { system: 'gradle', ...(modules === null ? {} : { modules }) }
  }
  if (files.includes('pom.xml')) return { system: 'maven' }
  if (files.includes('CMakeLists.txt')) return { system: 'cmake' }
  if (files.some((f) => f.toLowerCase().endsWith('.csproj'))) return { system: 'msbuild' }
  if (files.some((f) => f.toLowerCase().endsWith('.sln'))) return { system: 'msbuild' }
  if (files.includes('package.json')) return { system: 'npm' }
  if (files.includes('go.mod')) return { system: 'go modules' }
  if (files.includes('Cargo.toml')) return { system: 'cargo' }
  return null
}

function detectTestInfra(root, files) {
  const seen = []
  const gradle = join(root, 'build.gradle')
  if (exists(gradle)) {
    const text = readBytesForMatch(gradle)
    const junit = firstMatch(text, [/junit['"]?\s*,?\s*(?:name:\s*['"]junit['"]\s*,\s*)?version:\s*['"]?([\d.]+)/i])
    if (junit) seen.push(`junit ${junit[1]}（Gradle 依赖中声明）`)
  }
  if (exists(join(root, 'package.json'))) {
    const json = readJson(join(root, 'package.json'))
    const dev = json?.devDependencies ?? {}
    for (const name of ['jest', 'vitest', 'mocha', 'ava', 'jasmine']) {
      if (dev[name]) seen.push(`${name} ${dev[name]}`)
    }
    const scripts = json?.scripts ?? {}
    if (scripts.test && !seen.length) seen.push(`npm test: ${scripts.test}`)
  }
  for (const dir of ['src/test/java', 'src/test', 'test', 'tests', '__tests__']) {
    if (isDir(join(root, dir))) seen.push(`存在测试目录 ${dir}/`)
  }
  return seen
}

function detectConcurrencyHints(root, files) {
  // 并发相关依赖几乎从不写在根 build.gradle 里，而是在各子模块中。
  // 最多扫 40 个一级子目录的构建文件——只为了给"线程安全"类讨论提供线索，不做判定。
  const probes = ['build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json', 'Cargo.toml', '*.csproj']
  const targets = []
  for (const name of probes) {
    if (name.includes('*')) continue
    const absolute = join(root, name)
    if (exists(absolute)) targets.push(absolute)
  }
  let scanned = 0
  for (const entry of listFiles(root)) {
    if (scanned >= 40) break
    if (!entry.isDirectory()) continue
    if (entry.name === '.svn' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    for (const name of ['build.gradle', 'build.gradle.kts', 'pom.xml', 'package.json', 'Cargo.toml']) {
      const absolute = join(root, entry.name, name)
      if (exists(absolute)) {
        targets.push(absolute)
        scanned += 1
        break
      }
    }
  }

  const hints = []
  for (const absolute of targets) {
    const text = readBytesForMatch(absolute)
    if (!text) continue
    for (const { pattern, hint } of CONCURRENCY_HINTS) {
      if (pattern.test(text) && !hints.includes(hint)) hints.push(hint)
    }
  }
  return hints
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/** 工程名：用来去找 `projects/<项目名>.md`。 */
function detectProjectName(root, files) {
  const settings = ['settings.gradle', 'settings.gradle.kts'].map((n) => join(root, n)).find(exists)
  if (settings) {
    const hit = firstMatch(readBytesForMatch(settings), [/rootProject\.name\s*=\s*['"]([\w.-]+)['"]/])
    if (hit) return hit[1]
  }

  if (files.includes('package.json')) {
    const json = readJson(join(root, 'package.json'))
    if (json?.name) return json.name
  }

  const cargo = join(root, 'Cargo.toml')
  if (exists(cargo)) {
    const hit = firstMatch(readBytesForMatch(cargo), [/(?:^|\n)\s*name\s*=\s*"([\w.-]+)"/])
    if (hit) return hit[1]
  }

  const gomod = join(root, 'go.mod')
  if (exists(gomod)) {
    const hit = firstMatch(readBytesForMatch(gomod), [/(?:^|\n)\s*module\s+(\S+)/])
    if (hit) return hit[1].split('/').pop()
  }

  const csproj = files.find((f) => f.toLowerCase().endsWith('.csproj'))
  if (csproj) return csproj.replace(/\.csproj$/i, '')

  return null
}

/**
 * 推断工作目录的技术栈。
 *
 * @param {string} [start] 目录或文件路径；会向上找 SVN 工作副本根，找不到就用该目录本身
 * @returns {object} 检测结果；`stacks[].version` 为 `null` 表示"有该语言但版本未知"
 */
export function detectProject(start = process.cwd()) {
  const root = findWorkingCopy(start) ?? resolve(start)
  const files = listFiles(root).filter((entry) => entry.isFile()).map((entry) => entry.name)

  const stacks = [
    detectJava(root, files),
    detectCpp(root),
    detectCsharp(root),
    detectJavascript(root, files),
    detectGo(root),
    detectRust(root),
    detectPython(root),
  ].filter(Boolean)

  const notes = []
  for (const stack of stacks) {
    if (!stack.version) {
      notes.push(`${stack.language} 已识别，但版本未在构建文件中声明——不要假设版本，先让用户确认`)
    }
  }
  if (stacks.length === 0) {
    notes.push('没有识别出任何受支持的语言标记（构建文件/工程文件），只能按通用规则审查')
  }

  return {
    root,
    projectName: detectProjectName(root, files),
    stacks,
    build: detectBuild(root, files),
    testInfra: detectTestInfra(root, files),
    concurrencyHints: detectConcurrencyHints(root, files),
    notes,
  }
}

/** 按语言档案的命名约定映射；没有对应档案时返回 null。 */
export function profileForLanguage(language) {
  switch (language) {
    case 'java':
      return 'java8'
    case 'cpp':
      return 'cpp'
    case 'javascript':
    case 'typescript':
      return 'javascript'
    case 'csharp':
      return 'csharp'
    default:
      return null
  }
}

/** Java 档案只覆盖 8；其它版本明确返回"无档案"。 */
export function profileSupportsVersion(language, version) {
  if (language !== 'java') return true
  if (!version) return false
  return /^(?:1\.)?8(?:\.|$)/.test(String(version))
}
