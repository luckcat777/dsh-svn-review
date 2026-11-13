/**
 * 把本地规则库同步进包里，发布前跑一次。
 *
 *   node tools/sync-rules.mjs [规则库目录]
 *
 * 默认源是 `E:\rules\ai_code_review_files`（或用环境变量 DSH_SVN_REVIEW_RULES）。
 *
 * 只同步**通用**的东西：L0 方法论 + L1 语言档案 + 项目档案模板。
 * `projects/<具体项目>.md` 是每个项目自己的资产，不进包。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')
const TARGET = join(PACKAGE_ROOT, 'rules')

const source = resolve(
  process.argv[2] ?? process.env.DSH_SVN_REVIEW_RULES ?? 'E:\\rules\\ai_code_review_files',
)

if (!existsSync(source)) {
  console.error(`规则库不存在：${source}`)
  process.exit(2)
}

/**
 * 复制时统一成 LF。
 * 源文件常是 CRLF（Windows 上的编辑器），而 git 入库会转成 LF——
 * 直接拷原始字节会让"本地文件哈希"和"仓库 blob 哈希"对不上。
 */
function copyNormalized(from, to) {
  const text = readFileSync(from, 'utf8').replace(/\r\n/g, '\n')
  writeFileSync(to, text, 'utf8')
}

const COMMON = ['REVIEW_RULES.md', 'SVN_WORKFLOW.md', 'PROMPT.md']
const copied = []

mkdirSync(join(TARGET, 'languages'), { recursive: true })
mkdirSync(join(TARGET, 'projects'), { recursive: true })

for (const name of COMMON) {
  const from = join(source, name)
  if (!existsSync(from)) {
    console.warn(`跳过（源文件缺失）：${name}`)
    continue
  }
  copyNormalized(from, join(TARGET, name))
  copied.push(name)
}

const languagesDir = join(source, 'languages')
if (existsSync(languagesDir) && statSync(languagesDir).isDirectory()) {
  for (const entry of readdirSync(languagesDir)) {
    if (!entry.endsWith('.md')) continue
    copyNormalized(join(languagesDir, entry), join(TARGET, 'languages', entry))
    copied.push(`languages/${entry}`)
  }
}

// 项目档案模板要随包走——用户需要它才知道项目层该写什么。
const template = join(source, 'projects', '_template.md')
if (existsSync(template)) {
  copyNormalized(template, join(TARGET, 'projects', '_template.md'))
  copied.push('projects/_template.md')
}

console.log(`已从 ${source} 同步 ${copied.length} 份文件到 rules/：`)
for (const name of copied) console.log(`  ${name}`)
console.log('\n具体项目档案未同步——它们属于使用方，不随包发布。')
