/**
 * dsh-svn-review —— 把代码审查钉死在 SVN 的真实改动上。
 *
 * 它只做一件事：让 Agent 在动手之前先拿到"这次到底改了哪些文件"，
 * 而不是靠猜、靠翻整个仓库，从而避免顺手改动不相干的地方。
 *
 * 实现上不依赖 `svn` 命令行，直接读工作副本里的 `.svn/wc.db`，
 * 所以在只装了 TortoiseSVN 图形壳、`svn.exe` 不在 PATH 的机器上也能用。
 */
import { readChangeSet } from './wc.js'

/** 加载器用来识别这个插件。 */
export const name = 'svn-review'

/** 需要工具注册表，其它一概不碰。 */
export const inject = ['tools']

const TOOL_DESCRIPTION = [
  '读取当前 SVN 工作副本的真实变更集：直接解析 .svn/wc.db，不需要 svn.exe 或命令行工具。',
  '返回 M（已修改）、A（本地新增）、D（已删除）、!（文件缺失）、C（冲突）的文件清单与计数。',
  '',
  '使用约定——这几条比工具本身重要：',
  '1. 拿到清单后，这些文件就是本次允许修改的全部范围。范围外的文件一个字都不要动，',
  '   即使你确信那里有问题：写进结论，不要顺手改。',
  '2. 修改完成后可以再调用一次，确认变更集没有扩大。多出来的文件说明越界了。',
  '3. 判断"某个问题是不是 bug"之前，先看看项目里有没有同类实现做对照。',
  '   找不到对照就按缺陷处理，不要用"可能是设计"当免责理由。',
].join('\n')

/**
 * 注册 `svn_change_set` 工具。
 * @param {any} ctx Cordis 上下文，这里只用到 ctx.tools。
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'svn_change_set',
    description: TOOL_DESCRIPTION,
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
        },
      },
      render: (_args, value) => {
        const { counts } = value
        if (value.files.length === 0) {
          return [{ type: 'text', text: `工作副本 ${value.root} 没有未提交的改动。` }]
        }
        const head = `工作副本 ${value.root}（基线 r${value.revision ?? '?'}）：`
          + `M=${counts.M} A=${counts.A} D=${counts.D} !=${counts['!']} C=${counts.C}`
        const lines = value.files.map((file) => ` ${file.status}  ${file.path}`)
        return [{ type: 'text', text: [head, ...lines].join('\n') }]
      },
    },
    async execute(args) {
      const start = typeof args.path === 'string' && args.path.length > 0 ? args.path : process.cwd()
      const changeSet = await readChangeSet(start)
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
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取 SVN 变更集',
      kind: 'other',
      rawInput: args,
    }),
  })
}
