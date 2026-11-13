#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""当宿主进程读到的是加密容器时，用子进程把变更集重算一遍。

为什么需要这个文件
------------------
有些公司的透明加密客户端（文件头形如 `%TSD-Header-…`）只对白名单进程返回明文。
DeepSeek Harness 跑在 Electron 里，通常不在白名单内：`fs.readFileSync` 拿到的是密文，
尺寸也比明文大。于是每个文件的 SHA-1 都和 `.svn/pristine` 里的基线对不上，
整个工作副本会被判成"全部修改"——一次性几千个假 M，审查就此跑偏。

`python.exe` / `powershell.exe` 往往在白名单里，读到的就是明文。所以这一步交给它们做：
本进程只负责判断"我读到的是不是密文"，真正的哈希由子进程算。

用法
----
    python wc-fallback.py <工作副本根> <输出 json 路径>

stdout 不用（宿主可能拿不到管道），结果写进输出文件。失败时输出
`{"error": "原因"}`，退出码非 0 由调用方处理。
"""

import hashlib
import json
import os
import sqlite3
import sys

CHECKSUM_PREFIX = '$sha1$'


def sha1_of(path, chunk=1 << 20):
    digest = hashlib.sha1()
    with open(path, 'rb') as handle:
        while True:
            block = handle.read(chunk)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def checksum_hex(checksum):
    if not isinstance(checksum, str):
        return None
    if checksum.startswith(CHECKSUM_PREFIX):
        return checksum[len(CHECKSUM_PREFIX):]
    return checksum


def to_posix(path):
    return path.replace('\\', '/')


def read_change_set(root):
    db_path = os.path.join(root, '.svn', 'wc.db')
    if not os.path.exists(db_path):
        raise RuntimeError('没有找到 .svn/wc.db：%s' % db_path)

    connection = sqlite3.connect('file:%s?mode=ro' % to_posix(db_path), uri=True)
    try:
        row = connection.execute('SELECT root FROM REPOSITORY LIMIT 1').fetchone()
        repository = row[0] if row else None
        row = connection.execute(
            'SELECT MAX(revision) FROM NODES WHERE op_depth = 0').fetchone()
        revision = row[0] if row else None

        base_files = connection.execute(
            """
            SELECT local_relpath, checksum, translated_size, last_mod_time
            FROM NODES
            WHERE op_depth = 0 AND kind = 'file' AND presence = 'normal'
            """).fetchall()

        working_nodes = connection.execute(
            'SELECT local_relpath, op_depth, presence, kind FROM NODES WHERE op_depth > 0'
        ).fetchall()

        conflicts = connection.execute(
            """
            SELECT local_relpath FROM ACTUAL_NODE
            WHERE conflict_old IS NOT NULL OR conflict_new IS NOT NULL
               OR tree_conflict_data IS NOT NULL OR conflict_data IS NOT NULL
            """
        ).fetchall()
    finally:
        connection.close()

    counts = {'M': 0, 'A': 0, 'D': 0, '!': 0, 'C': 0}
    files = []

    for relpath, checksum, _translated_size, _last_mod_time in base_files:
        absolute = os.path.join(root, relpath)
        if not os.path.exists(absolute):
            files.append({'status': '!', 'path': relpath})
            counts['!'] += 1
            continue
        if not os.path.isfile(absolute):
            continue
        try:
            size = os.path.getsize(absolute)
            actual = sha1_of(absolute)
        except OSError:
            files.append({'status': '!', 'path': relpath})
            counts['!'] += 1
            continue
        baseline = checksum_hex(checksum)
        # 这里刻意不看 translated_size / last_mod_time 的快路径：
        # 正因为快照字段和密文字节对不上，才走到这个脚本。
        if baseline is not None and actual == baseline:
            continue
        files.append({'status': 'M', 'path': relpath, 'size': size})
        counts['M'] += 1

    for relpath, _op_depth, presence, kind in working_nodes:
        if kind != 'file':
            continue
        if presence == 'normal':
            files.append({'status': 'A', 'path': relpath})
            counts['A'] += 1
        elif presence in ('base-deleted', 'delete'):
            files.append({'status': 'D', 'path': relpath})
            counts['D'] += 1

    for (relpath,) in conflicts:
        files.append({'status': 'C', 'path': relpath})
        counts['C'] += 1

    files.sort(key=lambda item: item['path'])
    return {
        'root': root,
        'repository': repository,
        'revision': revision,
        'files': files,
        'counts': counts,
    }


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: wc-fallback.py <working-copy-root> <output-json>\n')
        return 2

    root = os.path.abspath(sys.argv[1])
    output = sys.argv[2]

    try:
        payload = read_change_set(root)
    except Exception as error:  # noqa: BLE001 - 任何失败都要变成可读的 JSON
        payload = {'error': str(error)}

    with open(output, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
    return 0 if 'error' not in payload else 1


if __name__ == '__main__':
    sys.exit(main())
