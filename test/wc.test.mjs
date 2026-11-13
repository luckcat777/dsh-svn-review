/**
 * 用一个合成的工作副本把每条状态分支都走一遍。
 *
 * 不依赖真实的 SVN 客户端：直接写出 `.svn/wc.db` 的最小结构，
 * 于是 M / A / ! / C 以及「改长度不变」这条必须走 SHA-1 的路径
 * 都能在几毫秒内确定性地验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { findWorkingCopy, readChangeSet } from '../lib/wc.js'

const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const checksum = (text) => `$sha1$${sha1(text)}`

/**
 * 造一个工作副本：四个受控文件，改一个长度变化的、改一个长度不变的、
 * 删一个、再加一个本地新增，外加一条冲突记录。
 */
function makeWorkingCopy() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-svn-review-'))
  mkdirSync(join(root, '.svn'), { recursive: true })

  const base = {
    'same.txt': 'unchanged\n',
    'mod.txt': 'old content\n',
    'gap.txt': 'hello\n',
    'gone.txt': 'x\n',
    // 内容没动，但快照尺寸故意写错——模拟 eol 翻译或复制工作副本后的快照漂移。
    'drift.txt': 'drift\n',
  }
  const sizeOverride = { 'drift.txt': 999 }
  for (const [name, content] of Object.entries(base)) {
    writeFileSync(join(root, name), content)
  }

  writeFileSync(join(root, 'mod.txt'), 'old content plus more\n')
  writeFileSync(join(root, 'gap.txt'), 'HELLO\n')
  rmSync(join(root, 'gone.txt'))
  writeFileSync(join(root, 'added.txt'), 'new\n')

  const db = new DatabaseSync(join(root, '.svn', 'wc.db'))
  db.exec(`CREATE TABLE NODES (
    local_relpath TEXT, op_depth INTEGER, kind TEXT, presence TEXT,
    checksum TEXT, translated_size INTEGER, last_mod_time INTEGER, revision INTEGER);`)
  db.exec('CREATE TABLE PRISTINE (checksum TEXT, size INTEGER);')
  db.exec(`CREATE TABLE ACTUAL_NODE (local_relpath TEXT, conflict_old TEXT,
    conflict_new TEXT, tree_conflict_data TEXT, conflict_data TEXT);`)
  db.exec('CREATE TABLE REPOSITORY (root TEXT);')

  const insertNode = db.prepare('INSERT INTO NODES VALUES (?,?,?,?,?,?,?,?)')
  const insertPristine = db.prepare('INSERT INTO PRISTINE VALUES (?,?)')
  // 快照时间故意放到未来，让 mtime 快路径失效，强制走内容比对。
  const future = Date.now() * 1000 + 60_000_000
  for (const [name, content] of Object.entries(base)) {
    insertNode.run(name, 0, 'file', 'normal', checksum(content), sizeOverride[name] ?? content.length, future, 100)
    insertPristine.run(checksum(content), content.length)
  }
  insertNode.run('added.txt', 1, 'file', 'normal', null, 5, future, 100)
  db.prepare('INSERT INTO REPOSITORY VALUES (?)').run('svn://example/repo')
  db.prepare('INSERT INTO ACTUAL_NODE VALUES (?,?,?,?,?)').run('conflict.txt', 'a', 'b', null, null)
  db.close()

  return root
}

test('把每条状态都判对', async (t) => {
  const root = makeWorkingCopy()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const changeSet = await readChangeSet(root)
  assert.deepEqual(changeSet.counts, { M: 2, A: 1, D: 0, '!': 1, C: 1 })
  assert.equal(changeSet.revision, 100)
  assert.equal(changeSet.repository, 'svn://example/repo')

  const statusOf = (name) => changeSet.files.find((file) => file.path === name)?.status
  assert.equal(statusOf('mod.txt'), 'M', '大小变了要判为 M')
  assert.equal(statusOf('gap.txt'), 'M', '长度不变但内容变了也要判为 M')
  assert.equal(statusOf('added.txt'), 'A')
  assert.equal(statusOf('gone.txt'), '!')
  assert.equal(statusOf('conflict.txt'), 'C')
  assert.equal(statusOf('same.txt'), undefined, '没动过的文件不应出现')
  assert.equal(statusOf('drift.txt'), undefined, '快照尺寸和磁盘不符但内容一致时，不能判 M')
})

test('从子目录也能找到工作副本根', async (t) => {
  const root = makeWorkingCopy()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const nested = join(root, 'a', 'b', 'c')
  mkdirSync(nested, { recursive: true })
  assert.equal(findWorkingCopy(nested), root)
  assert.equal((await readChangeSet(nested)).root, root)
})

test('不在工作副本里时给出可读的错误', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'dsh-svn-review-outside-'))
  try {
    assert.equal(findWorkingCopy(outside), null)
    await assert.rejects(() => readChangeSet(outside), /没有找到 SVN 工作副本/)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

/** python 是否可用——子进程通道的测试没有它就跳过，不能因为环境缺 python 就红。 */
function hasPython() {
  for (const interpreter of ['python', 'python3', 'py']) {
    const result = spawnSync(interpreter, ['--version'], { stdio: 'ignore', windowsHide: true })
    if (result.error === undefined && result.status === 0) return true
  }
  return false
}

test('强制走子进程时结果与直接读一致', async (t) => {
  if (!hasPython()) {
    t.skip('没有可用的 python')
    return
  }
  const root = makeWorkingCopy()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const direct = await readChangeSet(root)
  const delegated = await readChangeSet(root, { forceFallback: true })

  assert.equal(delegated.engine, 'python')
  assert.deepEqual(delegated.counts, direct.counts)
  assert.deepEqual(
    delegated.files.map((file) => `${file.status} ${file.path}`).sort(),
    direct.files.map((file) => `${file.status} ${file.path}`).sort(),
  )
})

test('源码文件带 NUL 字节时，自动改由子进程判定', async (t) => {
  if (!hasPython()) {
    t.skip('没有可用的 python')
    return
  }
  const root = makeWorkingCopy()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  // 模拟透明加密客户端：白名单外的进程读到的是带文件头的容器，不是明文。
  const encrypted = Buffer.from('%TSD-Header-###%\u0000\u0000\u0000binary-ish', 'latin1')
  writeFileSync(join(root, 'same.txt'), encrypted)
  // 让基线与磁盘内容一致：这条只验证"会不会改道去子进程"，不验证内容判定——
  // 真实环境里 python 读到的是明文，哈希本来就对得上。
  const db = new DatabaseSync(join(root, '.svn', 'wc.db'))
  db.prepare('UPDATE NODES SET checksum = ?, translated_size = ? WHERE local_relpath = ?')
    .run(checksum(encrypted.toString('latin1')), encrypted.length, 'same.txt')
  db.close()

  const changeSet = await readChangeSet(root)
  assert.equal(changeSet.engine, 'python', '读到密文时必须交给子进程，不能自己算哈希')
  assert.deepEqual(changeSet.counts, { M: 2, A: 1, D: 0, '!': 1, C: 1 })})