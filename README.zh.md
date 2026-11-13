# dsh-svn-review

一次审查要想审得对，需要先知道两件事：**这次到底改了哪些文件**，以及**这是个什么项目**。

这个插件把两件事都做了，离线、不需要 `svn.exe`、不用传参数。

## 为什么需要它

**改动范围。** SVN 的改动集通常藏在图形界面里：TortoiseSVN 的提交对话框、右键菜单的「检查修改」。命令行 `svn status` 能给出同样的答案，但很多机器上只装了图形壳。而 Agent 恰恰最需要这份清单——没有它，你只能把规则复述一遍、再祈祷它别越界；有了它，越界就变成一个可以被工具检查的事实。

**语言与版本。** 同一句「这里可能空指针」，在 Java 里是缺陷，在已经用了 `?.` 的 TypeScript 里是误报；「建议加锁」在 Java 多线程服务里是对的，在 JS 单线程事件循环里根本无从谈起。不知道语言的审查方会一本正经地说废话——所以这个插件先把语言和版本钉死，再把对应的规则文件递过去。

## 安装

```sh
dsh plugin --profile web add dsh-svn-review
```

装完刷新页面即可，通常不需要重启。

## 用到的东西

| 名称 | 类型 | 说明 |
|---|---|---|
| `svn_change_set` | 工具 | 工作副本的变更集：`M` 已修改、`A` 本地新增、`D` 已删除、`!` 文件缺失、`C` 冲突；同时附带识别到的技术栈摘要 |
| `project_profile` | 工具 | 语言、版本、构建系统、测试基建，以及**该加载哪份规则文件** |

两个工具都只有一个可选参数 `path`（工作副本内任意目录，会自动向上找 `.svn/wc.db`）。

### `project_profile`

| 字段 | 含义 |
|---|---|
| `languages[].language` / `.version` | 识别出的技术栈。`version: null` 表示**识别到了但没声明版本**，绝不给默认值 |
| `languages[].file` | 语言规则文件的绝对路径。**写任何意见之前先读它** |
| `languages[].available` | 为 `false` 时表示没有覆盖该语言/版本的规则，并给出 `reason` |
| `languages[].evidence` | 判定所依据的那一行构建脚本原文，可自行核对 |
| `projectName` | 识别到的工程名，用于查找 `projects/<工程名>.md` |
| `build` | `gradle` / `maven` / `cmake` / `msbuild` / `npm` / `cargo` 等 |
| `testInfra` | 测试框架与版本。为空时，「建议补单元测试」就不是一条可执行的建议 |
| `concurrencyHints` | 构建文件里出现的并发相关依赖，**只是线索，不是结论** |
| `rules` | 通用规则文件与项目档案的路径 |

识别依据：

| 语言 | 识别文件 | 版本来源 |
|---|---|---|
| Java | `build.gradle`、`pom.xml`、`*.java` | `sourceCompatibility`、`maven.compiler.source`、`java.version` |
| C / C++ | `CMakeLists.txt`、`Makefile`、`*.vcxproj` | `CMAKE_CXX_STANDARD`、`-std=c++NN`、`LanguageStandard` |
| C# | `*.csproj` | `TargetFramework`、`LangVersion` |
| JavaScript / TypeScript | `package.json`、`tsconfig.json` | `engines.node`、`typescript` 版本 |
| Go | `go.mod` | `go` 指令 |
| Rust | `Cargo.toml` | `edition` |
| Python | `pyproject.toml`、`.python-version` | `requires-python` |
| Kotlin | `build.gradle(.kts)` 的 kotlin 插件、`*.kt` | 插件版本 |
| 鸿蒙 ArkTS | `build-profile.json5`、`module.json5`、`*.ets` | `compatibleSdkVersion` |
| Swift | `Package.swift`、`*.xcodeproj` | `swift-tools-version` |
| Dart / Flutter | `pubspec.yaml` | `sdk` 约束 |
| PHP / Ruby / Scala | `composer.json`、`Gemfile`、`build.sbt` | `require.php`、`ruby`、`scalaVersion` |
| **其它任何语言** | 源码扩展名 | 无 → 落到 `generic.md` |

识别跑两路：构建文件给**权威版本**，扩展名普查（3000 个文件、6 层、跳过 vendor 目录）兜住"根本没有构建文件"的语言——
只有 `.lua` 或 `.ex` 的仓库也能落到档案上，而不是返回"未知"。

构建脚本经常是 GBK 编码，所以判定是在**原始字节**上做的，不走解码——关键指令都是 ASCII，两条路径都能命中。

## 输出示例

```
工作目录 E:\x_japan
工程名 x_main

java 1.8
  规范：E:\rules\ai_code_review_files\languages\java8.md
  依据：build.gradle: sourceCompatibility = 1.8

构建系统：gradle（20 个模块）
测试基建：junit 4.12（Gradle 依赖中声明）

项目档案：E:\rules\ai_code_review_files\projects\x_main.md
```

## 随包附带的规则

包里自带一套规则，装在 `rules/`：

```
rules/
├─ REVIEW_RULES.md          方法论：范围、分级、举证、结论
├─ SVN_WORKFLOW.md          什么算在改动范围内
├─ PROMPT.md                可直接复制的命令模板
├─ languages/
│  ├─ java8.md              Java 8
│  ├─ kotlin.md             Kotlin
│  ├─ cpp.md                C / C++
│  ├─ csharp.md             C#
│  ├─ javascript.md         JavaScript / TypeScript
│  ├─ rust.md               Rust
│  ├─ go.md                 Go
│  ├─ python.md             Python
│  ├─ arkts.md              鸿蒙 ArkTS
│  └─ generic.md            其它任何语言的兜底
└─ projects/_template.md    项目档案模板
```

每份语言档案结构一致：版本约束、惯用法、真实缺陷，以及最重要的一节——**误报清单**，也就是"在这个语言里说这话就是错的"。

想用自己的规则库而不是包里这份，两种方式：设 `DSH_SVN_REVIEW_RULES` 环境变量，或者在包内放一个 `rules/local.json`（已加入 git/npm 忽略）：

```json
{ "rulesRoot": "E:\\rules\\ai_code_review_files" }
```

发布前跑 `node tools/sync-rules.mjs`，把本地规则库里通用的那几份同步进包。

## 判定方式

`.svn/wc.db` 的 `NODES` 表为每个受控文件记录了基线校验和与上次提交时的快照（大小、mtime）。

1. 文件不在了 → `!`
2. 大小和快照不同 → `M`，直接判定，不读文件内容
3. 大小与 mtime 都和快照一致 → 跳过，认为没动过
4. 大小相同但 mtime 不同 → 计算 SHA-1 与基线校验和比对，确认后才判定 `M`

第 3 步是关键：一个几千个文件的工作副本如果逐个算哈希要十几秒，走快路径通常不到一秒。第 4 步保证「改了但长度没变」的编辑不会漏掉。

`A` / `D` 来自 `op_depth > 0` 的节点，冲突来自 `ACTUAL_NODE`。

## 限制

- 不返回 `?`（未纳入版本控制的文件）。这类文件进不了本次提交，不构成修改范围。
- 不生成 diff。文件清单拿到之后，读文件用 Agent 自己的工具即可，比在插件里造一份 diff 更省事也更准确。
- 依赖 Node 内置的 `node:sqlite`（Node 22.5+，23.4 之后无需实验开关）。宿主 Node 太旧时，工具会明确说明而不是抛一个 SQLite 栈。
- 只读 `.svn/wc.db`，不写入工作副本的任何位置。
- 语言识别只读构建与工程文件，**推不出并发模型**——那属于项目档案的内容。

## 许可

MIT
