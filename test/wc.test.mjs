/**
 * 用一个合成的工作副本把每条状态分支都走一遍。
 *
 * 不依赖真实的 SVN 客户端：直接写出 `.svn/wc.db` 的最小结构，
 * 于是 M / A / ! / C 以及「改长度不变」这条必须走 SHA-1 的路径
 * 都能在几毫秒内确定性地验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
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
  }
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
    insertNode.run(name, 0, 'file', 'normal', checksum(content), content.length, future, 100)
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
