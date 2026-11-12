# dsh-svn-review

Bind code review to the real SVN change set.

It does one thing: give the agent the list of files the author actually touched, before it starts editing. That list then becomes the boundary for the whole change — files outside it are reported, never modified.

## Why

SVN keeps its change set behind a GUI on most machines: the TortoiseSVN commit dialog, the "Check for modifications" menu item. `svn status` gives the same answer, but plenty of installs only ship the GUI shell, so `svn.exe` is not on `PATH`.

The agent is exactly the party that needs that list. Without it you re-paste the rules every time and hope it stays in scope; with it, going out of scope becomes a fact a tool can check.

This plugin reads `.svn/wc.db` (SQLite) and compares it against the base copies in `.svn/pristine/`. That is what `svn status` does, but fully offline, with no external program.

## Install

```sh
dsh plugin --profile web add dsh-svn-review
```

Refresh the page afterwards; a restart is usually not needed.

## What you get

| Name | Kind | Description |
|---|---|---|
| `svn_change_set` | tool | The working copy's change set: `M` modified, `A` added, `D` deleted, `!` missing, `C` conflicted |

One optional parameter:

| Parameter | Required | Description |
|---|---|---|
| `path` | no | Any directory inside the working copy; it walks up to `.svn/wc.db`. Defaults to the current working directory |

The result carries the working copy root, base revision, per-status counts, and the file list.

## How it decides

`NODES` records a base checksum and a commit-time snapshot (size, mtime) for every versioned file.

1. File gone → `!`
2. Size differs from the snapshot → `M`, decided without reading the file
3. Size and mtime both match the snapshot → skip, considered untouched
4. Same size, different mtime → SHA-1 the file and compare against the base checksum before calling it `M`

Step 3 matters: hashing every file in a several-thousand-file working copy takes a dozen seconds, while the fast path lands under one. Step 4 makes sure an edit that kept the length is still caught.

`A` / `D` come from nodes with `op_depth > 0`; conflicts come from `ACTUAL_NODE`.

## Limits

- No `?` (unversioned files). They cannot enter this commit, so they are not part of the change scope.
- No diff. Once you have the file list, the agent's own file-reading tool is a better fit than a diff grown inside the plugin.
- Requires Node's built-in `node:sqlite` (Node 22.5+; unflagged since 23.4). On an older host the tool says so instead of throwing a SQLite stack.
- Opens `.svn/wc.db` read-only and writes nothing into the working copy.

## License

MIT
