/**
 * dsh-svn-review —— 把代码审查钉死在 SVN 的真实改动上，并先认出这是什么项目。
 *
 * 两个工具：
 *   - `svn_change_set`   这次到底改了哪些文件（读 .svn/wc.db，不需要 svn.exe）
 *   - `project_profile`  这个工作目录是什么语言、什么版本、该按哪套规则判缺陷
 *
 * 后者是重点：NPE 在 Java 里是缺陷，在用了 `?.` 的 TypeScript 里多半不是；
 * 线程安全在 Java 多线程服务里要管，在 JS 单线程事件循环里根本不存在。
 * 所以审查前必须先把"语言 + 版本"确定下来，而不是套通用直觉。
 */
import { statSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readChangeSet } from './wc.js'
import { detectProject, profileForLanguage, profileSupportsVersion } from './detect.js'

/** 加载器用来识别这个插件。 */
export const name = 'svn-review'

/** 需要工具注册表，其它一概不碰。 */
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 规则目录解析顺序：
 *   1. 环境变量 `DSH_SVN_REVIEW_RULES`（临时切换用）
 *   2. 包内 `rules\local.json` 的 `rulesRoot`（本机配置，不进 git、不进 npm 包）
 *   3. 包内自带的 `rules\`（市场用户默认走这里）
 */
function rulesRoot() {
  const override = process.env.DSH_SVN_REVIEW_RULES
  if (override && override.trim()) {
    const absolute = resolve(override.trim())
    try {
      if (statSync(absolute).isDirectory()) return absolute
    } catch {
      /* 落回下一层 */
    }
  }
  const localPath = join(HERE, '..', 'rules', 'local.json')
  if (existingFile(localPath)) {
    try {
      const parsed = JSON.parse(readFileSync(localPath, 'utf8'))
      if (typeof parsed?.rulesRoot === 'string' && parsed.rulesRoot.trim()) {
        const absolute = resolve(parsed.rulesRoot.trim())
        if (statSync(absolute).isDirectory()) return absolute
      }
    } catch {
      /* 配置坏了就忽略，别让插件起不来 */
    }
  }
  return join(HERE, '..', 'rules')
}

function existingFile(absolute) {
  try {
    return statSync(absolute).isFile() ? absolute : null
  } catch {
    return null
  }
}

/**
 * 把检测结果映射成"该读哪几份档案"。
 * 语言识别到但版本不匹配档案时，明确返回不可用及原因——不给默认值。
 */
function resolveProfiles(detection) {
  const root = rulesRoot()
  return detection.stacks.map((stack) => {
    const profileName = profileForLanguage(stack.language)
    if (!profileName) {
      return {
        language: stack.language,
        version: stack.version,
        available: false,
        reason: `没有 ${stack.language} 的语言档案，只能按通用规则审查`,
        evidence: stack.evidence,
      }
    }
    if (!profileSupportsVersion(stack.language, stack.version)) {
      return {
        language: stack.language,
        version: stack.version,
        available: false,
        reason: `已有档案是 ${profileName}，与检测到的版本 ${stack.version ?? '未知'} 不匹配；不要套用该档案的豁免清单`,
        evidence: stack.evidence,
      }
    }
    const file = existingFile(join(root, 'languages', `${profileName}.md`))
    if (!file) {
      return {
        language: stack.language,
        version: stack.version,
        available: false,
        reason: `档案文件缺失：languages/${profileName}.md`,
        evidence: stack.evidence,
      }
    }
    return {
      language: stack.language,
      version: stack.version,
      available: true,
      profile: profileName,
      file,
      evidence: stack.evidence,
    }
  })
}

const CHANGE_SET_DESCRIPTION = [
  '读取当前 SVN 工作副本的真实变更集：直接解析 .svn/wc.db，不需要 svn.exe 或命令行工具。',
  '返回 M（已修改）、A（本地新增）、D（已删除）、!（文件缺失）、C（冲突）的文件清单与计数，',
  '同时附带 `project` 字段：自动识别出的语言、版本，以及该读哪份语言规范文件。',
  '',
  '使用约定——这几条比工具本身重要：',
  '1. 拿到清单后，这些文件就是本次允许修改的全部范围。范围外的文件一个字都不要动，',
  '   即使你确信那里有问题：写进结论，不要顺手改。',
  '2. 在下判断之前，先看 `project.languages`：每种语言都给出了应该加载的 `file`。',
  '   读到那份档案之前，不要对 NPE、线程安全、版本语法发表意见。',
  '3. 修改完成后可以再调用一次，确认变更集没有扩大。多出来的文件说明越界了。',
].join('\n')

const PROFILE_DESCRIPTION = [
  '识别工作目录的技术栈：语言、版本、构建系统、测试基建，以及**应该加载哪份审查规范**。',
  '',
  '为什么需要它：同一个"可能空指针"的告警，在不同语言里成立条件完全不同——',
  'Java 的 Map.get 返回 null 之后链式调用必炸；TypeScript 用了 `?.` 之后语言已经处理了空值；',
  'C# 开了可空引用类型后编译器已经保证；C++ 则是 UB，要看项目有没有 assert 约定。',
  '"线程安全"更是如此：Java 多线程服务里要管，JS 单线程事件循环里根本不存在这个问题。',
  '',
  '返回的每个 language 带 `file` 字段，是语言规范文件的绝对路径。**先读它，再写意见。**',
  '`available: false` 表示该语言/版本没有对应档案，此时只能按通用规则审查，',
  '并且必须在报告里声明"未套用语言层豁免"——因为这样更容易产生误报。',
  '',
  '版本检测不出来的，`version` 为 null。**不要假设版本**（不要默认"Java 都 17 了"），',
  '版本直接决定哪些语法可用、哪些建议是编译不过的。',
].join('\n')

/**
 * 注册两个工具。
 * @param {any} ctx Cordis 上下文，这里只用到 ctx.tools。
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'svn_change_set',
    description: CHANGE_SET_DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        description: '工作副本内的任意目录，会向上自动寻找 .svn/wc.db。省略时用当前工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true, description: '工作副本根目录' },
          revision: { type: 'integer', description: '基线版本号，取 NODES 里最大的 revision' },
          repository: { type: 'string', description: '仓库根 URL' },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              M: { type: 'integer', required: true },
              A: { type: 'integer', required: true },
              D: { type: 'integer', required: true },
              '!': { type: 'integer', required: true },
              C: { type: 'integer', required: true },
            },
          },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                status: { type: 'string', required: true, enum: ['M', 'A', 'D', '!', 'C'] },
                path: { type: 'string', required: true },
                size: { type: 'integer', description: '修改后的大小（仅 M）' },
              },
            },
          },
          project: {
            type: 'object',
            description: '自动识别出的技术栈摘要；详情用 project_profile',
          },
        },
      },
      render: (_args, value) => {
        const { counts } = value
        const lines = []
        if (value.files.length === 0) {
          lines.push(`工作副本 ${value.root} 没有未提交的改动。`)
        } else {
          lines.push(
            `工作副本 ${value.root}（基线 r${value.revision ?? '?'}）：`
              + `M=${counts.M} A=${counts.A} D=${counts.D} !=${counts['!']} C=${counts.C}`,
          )
          for (const file of value.files) lines.push(` ${file.status}  ${file.path}`)
        }
        const languages = value.project?.languages ?? []
        if (languages.length > 0) {
          lines.push('', '识别到的技术栈：')
          for (const language of languages) {
            const state = language.available
              ? `→ ${language.file}`
              : `→ 无对应档案（${language.reason}）`
            lines.push(`  ${language.language} ${language.version ?? '(版本未知)'}  ${state}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const start = typeof args.path === 'string' && args.path.length > 0 ? args.path : process.cwd()
      const changeSet = await readChangeSet(start)
      const detection = detectProject(changeSet.root)
      return {
        root: changeSet.root,
        ...(changeSet.revision === null ? {} : { revision: changeSet.revision }),
        ...(changeSet.repository === null ? {} : { repository: changeSet.repository }),
        counts: changeSet.counts,
        files: changeSet.files.map((file) => ({
          status: file.status,
          path: file.path,
          ...(file.size === undefined ? {} : { size: file.size }),
        })),
        project: {
          languages: resolveProfiles(detection).map((entry) => ({
            language: entry.language,
            version: entry.version,
            available: entry.available,
            ...(entry.file ? { file: entry.file } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
          })),
          notes: detection.notes,
        },
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取 SVN 变更集',
      kind: 'other',
      rawInput: args,
    }),
  })

  ctx.tools.register({
    name: 'project_profile',
    description: PROFILE_DESCRIPTION,
    parameters: {
      path: {
        type: 'string',
        description: '工作目录或其中任意子目录。省略时用当前工作目录。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string', required: true },
          projectName: { type: 'string', description: '检测到的工程名，用于匹配 projects/<名>.md' },
          languages: { type: 'array', required: true },
          build: { type: 'object' },
          testInfra: { type: 'array', required: true },
          concurrencyHints: { type: 'array', required: true },
          notes: { type: 'array', required: true },
          rules: { type: 'object', description: '各层规范文件的绝对路径' },
        },
      },
      render: (_args, value) => {
        const lines = [`工作目录 ${value.root}`]
        if (value.projectName) lines.push(`工程名 ${value.projectName}`)
        if (value.languages.length === 0) {
          lines.push('未识别出受支持的语言标记。')
        }
        for (const language of value.languages) {
          lines.push('', `${language.language} ${language.version ?? '(版本未知)'}`)
          if (language.available) {
            lines.push(`  规范：${language.file}`)
          } else {
            lines.push(`  无对应档案：${language.reason}`)
          }
          for (const item of language.evidence) lines.push(`  依据：${item}`)
        }
        if (value.build) lines.push('', `构建系统：${value.build.system}${value.build.modules ? `（${value.build.modules} 个模块）` : ''}`)
        if (value.testInfra.length > 0) lines.push(`测试基建：${value.testInfra.join('；')}`)
        else lines.push('测试基建：未发现（"建议补单元测试"因此不可执行）')
        if (value.concurrencyHints.length > 0) {
          lines.push(`并发线索：${value.concurrencyHints.join('、')}（仅为线索，并发模型以项目档案为准）`)
        }
        if (value.rules?.project) lines.push('', `项目档案：${value.rules.project}`)
        else if (value.projectName) {
          lines.push('', `项目档案：未找到 projects/${value.projectName}.md——项目层豁免无从套用`)
        }
        for (const note of value.notes) lines.push(`注意：${note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const start = typeof args.path === 'string' && args.path.length > 0 ? args.path : process.cwd()
      const detection = detectProject(start)
      const root = rulesRoot()
      // 项目档案按检测到的工程名去找：settings.gradle 里的 rootProject.name、package.json 的 name 等。
      const projectFile = detection.projectName
        ? existingFile(join(root, 'projects', `${detection.projectName}.md`))
        : null
      return {
        root: detection.root,
        ...(detection.projectName ? { projectName: detection.projectName } : {}),
        languages: resolveProfiles(detection),
        ...(detection.build ? { build: detection.build } : {}),
        testInfra: detection.testInfra,
        concurrencyHints: detection.concurrencyHints,
        notes: detection.notes,
        rules: {
          root,
          common: [
            existingFile(join(root, 'REVIEW_RULES.md')),
            existingFile(join(root, 'SVN_WORKFLOW.md')),
            existingFile(join(root, 'PROMPT.md')),
          ].filter(Boolean),
          ...(projectFile ? { project: projectFile } : {}),
          ...(projectFile ? {} : { projectTemplate: existingFile(join(root, 'projects', '_template.md')) }),
        },
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '识别项目技术栈',
      kind: 'other',
      rawInput: args,
    }),
  })
}
