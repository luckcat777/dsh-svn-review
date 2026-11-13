/**
 * 把本地规则库同步进包里，发布前跑一次。
 *
 *   node tools/sync-rules.mjs [规则库目录]
 *
 * 默认源是 `E:\rules\ai_code_review_files`（或用环境变量 DSH_SVN_REVIEW_RULES）。
 *
 * 只同步**通用**的那几份：L0 方法论 + L1 语言档案。
 * `projects/*.md` 是每个项目自己的东西，不进包。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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

const COMMON = ['REVIEW_RULES.md', 'SVN_WORKFLOW.md', 'PROMPT.md']
const copied = []

mkdirSync(join(TARGET, 'languages'), { recursive: true })

for (const name of COMMON) {
  const from = join(source, name)
  if (!existsSync(from)) {
    console.warn(`跳过（源文件缺失）：${name}`)
    continue
  }
  copyFileSync(from, join(TARGET, name))
  copied.push(name)
}

const languagesDir = join(source, 'languages')
if (existsSync(languagesDir) && statSync(languagesDir).isDirectory()) {
  for (const entry of readdirSync(languagesDir)) {
    if (!entry.endsWith('.md')) continue
    copyFileSync(join(languagesDir, entry), join(TARGET, 'languages', entry))
    copied.push(`languages/${entry}`)
  }
}

console.log(`已从 ${source} 同步 ${copied.length} 份文件到 rules/：`)
for (const name of copied) console.log(`  ${name}`)
console.log('\nprojects/ 未同步——项目档案属于使用方，不随包发布。')
