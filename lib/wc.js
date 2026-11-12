/**
 * 直接读取 SVN 工作副本的变更集。
 *
 * 原理：`.svn/wc.db` 是 SQLite，`NODES` 表记录每个受控路径的基线校验和，
 * `.svn/pristine/` 存着基线的原始副本。把磁盘文件算一遍 SHA-1 与之比对，
 * 就等价于 `svn status`，但完全离线、不需要 svn.exe、不需要装命令行工具。
 *
 * 这样设计是为了解决一个很具体的处境：机器上只装了 TortoiseSVN 的图形壳，
 * `svn.exe` 不在 PATH 里，而 Agent 又必须拿到"这次到底改了哪些文件"。
 */
import { createHash } from 'node:crypto'
import { existsSync, statSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** SVN 用 `$sha1$<40hex>` 表示校验和。 */
const CHECKSUM_PREFIX = '$sha1$'

/**
 * 从 `start` 开始向上查找工作副本根目录。
 * @param {string} start 起点，通常是项目目录。
 * @returns {string | null} 含 `.svn/wc.db` 的目录，找不到返回 null。
 */
export function findWorkingCopy(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.svn', 'wc.db'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** 把 NODES.checksum 剥成裸 40 位十六进制。 */
function checksumHex(checksum) {
  if (typeof checksum !== 'string') return null
  return checksum.startsWith(CHECKSUM_PREFIX) ? checksum.slice(CHECKSUM_PREFIX.length) : checksum
}

/** 整个文件的 SHA-1，用于和基线校验和比对。 */
function sha1OfFile(absolutePath) {
  return createHash('sha1').update(readFileSync(absolutePath)).digest('hex')
}

/**
 * 把 node:sqlite 变成可选依赖。
 *
 * 它在 Node 22.5 引入、23.4 之后无需实验开关。宿主太旧时给出能照着做的提示，
 * 而不是抛一个 SQLITE 栈。
 */
async function openDatabase(wcRoot) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch (error) {
    throw new Error(
      '当前 Node 没有内置 node:sqlite（需要 Node 22.5+，建议 24+），无法直接读取 .svn/wc.db。'
      + '请升级运行 DeepSeek Harness 的 Node，或改装带命令行工具的 SVN 客户端后改用 svn status。',
      { cause: error },
    )
  }
  return new DatabaseSync(join(wcRoot, '.svn', 'wc.db'), { readOnly: true })
}

/**
 * 读一个工作副本的变更集。
 *
 * @param {string} start 起点目录（会在其祖先中寻找工作副本）。
 * @param {{ includeUnversioned?: boolean }} [options]
 * @returns {Promise<{ root: string, revision: number | null, repository: string | null, files: Array<{ status: string, path: string, size?: number }>, counts: Record<string, number>, truncated: boolean }>}
 */
export async function readChangeSet(start, options = {}) {
  const root = findWorkingCopy(start)
  if (root === null) {
    throw new Error(`从 ${resolve(start)} 向上没有找到 SVN 工作副本（.svn/wc.db）。请把 path 指向工作副本内的任意目录。`)
  }

  const db = await openDatabase(root)
  try {
    const repository = db.prepare('SELECT root FROM REPOSITORY LIMIT 1').get()?.root ?? null
    const revision = db.prepare('SELECT MAX(revision) AS rev FROM NODES WHERE op_depth = 0').get()?.rev ?? null

    // op_depth = 0 是基线节点；它的 checksum 就是磁盘文件"没改过"时应有的 SHA-1。
    // `translated_size` / `last_mod_time` 是上次提交或更新时留下的快照。
    // 两者都对得上就说明文件自那以后没被动过，可以跳过哈希——否则整个
    // 工作副本有几千个文件，逐个算 SHA-1 要十几秒。
    const baseFiles = db.prepare(`
      SELECT n.local_relpath    AS relpath,
             n.checksum         AS checksum,
             n.translated_size  AS snapshotSize,
             n.last_mod_time    AS snapshotMtime,
             p.size             AS baseSize
      FROM NODES n
      LEFT JOIN PRISTINE p ON p.checksum = n.checksum
      WHERE n.op_depth = 0 AND n.kind = 'file' AND n.presence = 'normal'
    `).all()

    // op_depth > 0 是本地新增/删除/替换，不需要比对内容。
    const workingNodes = db.prepare(`
      SELECT local_relpath AS relpath, op_depth, presence, kind
      FROM NODES WHERE op_depth > 0
    `).all()

    const files = []
    const counts = { M: 0, A: 0, D: 0, '!': 0, C: 0 }

    for (const node of baseFiles) {
      const absolute = join(root, node.relpath)
      if (!existsSync(absolute)) {
        files.push({ status: '!', path: node.relpath })
        counts['!'] += 1
        continue
      }
      let stat
      try {
        stat = statSync(absolute)
      } catch {
        files.push({ status: '!', path: node.relpath })
        counts['!'] += 1
        continue
      }
      if (!stat.isFile()) continue

      // 快路径一：大小和提交时快照不同，必然是改过的。
      const snapshotSize = node.snapshotSize
      if (typeof snapshotSize === 'number' && stat.size !== snapshotSize) {
        files.push({ status: 'M', path: node.relpath, size: stat.size })
        counts.M += 1
        continue
      }

      // 快路径二：大小和 mtime 都和快照对得上，跳过哈希。
      // 文件系统时间精度各平台不同，留 2 秒余量；对不上再算 SHA-1 兜底。
      const snapshotMtime = node.snapshotMtime
      if (
        typeof snapshotSize === 'number'
        && typeof snapshotMtime === 'number'
        && Math.abs(stat.mtimeMs - snapshotMtime / 1000) < 2000
      ) {
        continue
      }

      // 慢路径：内容可能变了但大小没变，用基线校验和判定。
      const base = checksumHex(node.checksum)
      if (base === null || sha1OfFile(absolute) !== base) {
        files.push({ status: 'M', path: node.relpath, size: stat.size })
        counts.M += 1
      }
    }

    for (const node of workingNodes) {
      if (node.kind !== 'file') continue
      if (node.presence === 'normal') {
        files.push({ status: 'A', path: node.relpath })
        counts.A += 1
      } else if (node.presence === 'base-deleted' || node.presence === 'delete') {
        files.push({ status: 'D', path: node.relpath })
        counts.D += 1
      }
    }

    // 树冲突比文本冲突更容易被忽略，单独拎出来。
    const conflicts = db.prepare(`
      SELECT local_relpath AS relpath FROM ACTUAL_NODE
      WHERE conflict_old IS NOT NULL OR conflict_new IS NOT NULL
         OR tree_conflict_data IS NOT NULL OR conflict_data IS NOT NULL
    `).all()
    for (const row of conflicts) {
      files.push({ status: 'C', path: row.relpath })
      counts.C += 1
    }

    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

    return {
      root,
      repository,
      revision,
      files,
      counts,
      includeUnversioned: options.includeUnversioned === true,
    }
  } finally {
    db.close()
  }
}

/** 变更集是否为空（只算会进提交的部分）。 */
export function isEmpty(changeSet) {
  return changeSet.files.length === 0
}

/** 默认从进程工作目录开始找，找不到就报错。 */
export function defaultStart() {
  return isAbsolute(process.cwd()) ? process.cwd() : resolve(process.cwd())
}
