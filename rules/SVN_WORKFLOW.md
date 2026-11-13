# SVN 改动范围规则（SVN_WORKFLOW.md）

> 本文件规定 **任何 AI / 开发者在本仓库中工作时，如何确定"该改哪些代码"**。  
> 配套文件：`REVIEW_RULES.md`（L0 审查方法论）、`languages/<语言>.md`（L1 语言档案）、`projects/x_main.md`（L2 项目档案）。
>
> **一句话总纲：先读 SVN 改动，只在改动涉及的范围内写代码；没有改动的文件，一个字都不许动。**

| 项      | 值                                           |
| ------ | ------------------------------------------- |
| 工作副本   | 当前项目开发目录                                    |
| 仓库     | `svn://10.10.10.5`                          |
| 版本管理   | SVN（TortoiseSVN 1.8.11，**未安装 svn.exe 命令行**） |
| 变更读取方式 | 直接读 `.svn/wc.db` + 比对 `.svn/pristine`（见 §2） |
| 版本     | v1.0                                        |

---

## 1. 核心规则（强制）

### 1.1 变更范围即修改范围

**AI 在动手前，必须先确定本次的 SVN 变更集（变更文件清单），并且只允许修改清单内的文件。**

- ✅ 允许修改：`svn status` 显示为 `M`（已修改）、`A`（新增）的文件
- ❌ 禁止修改：清单外的任何版本化文件——哪怕它"写得不好""有问题""顺便可以优化"
- ❌ 禁止"顺手重构"：不相关的 import 整理、格式化、重命名、注释补充
- ❌ 禁止为了"通过编译"而改动未在清单中的类
- ❌ 禁止删除、移动、重命名未在清单中的文件

### 1.2 发现清单外问题时怎么办

如果确实发现范围外的缺陷（例如调用的方法本身有 bug）：

```text
发现范围外问题
   ↓
不要直接改
   ↓
在报告中标注「范围外」+ 文件:行 + 问题描述
   ↓
由人决定是否纳入本次改动
   ↓
仅在人明确同意后，才把该文件加入变更集再修改
```

**默认动作是"报告"，不是"修改"。**

### 1.3 例外：必须改的连带文件

以下情况可以修改清单外文件，但**必须先说明理由并征得同意**：

| 情形      | 说明                                          |
| ------- | ------------------------------------------- |
| 编译必需    | 新方法被调用方需要同步加 import；接口签名变更导致实现类必须同步         |
| 常量/枚举新增 | 新增枚举值后，`switch` 必须补分支（且只能是 `default` 或新增分支） |
| 配置注册    | 新类需要在注册表 / 数组 / 映射中登记                       |

即便如此，也只能做**最小必要改动**，不得借机整理该文件。

---

## 2. 如何读取 SVN 改动（无需 svn.exe）

TortoiseSVN 只装了图形界面，命令行 `svn.exe` 未安装。因此用脚本直接读工作副本数据库：

```powershell
# 一条命令生成审查包
& python E:\rules\ai_code_review_files\tools\precommit_audit.py
```

或直接双击 / 运行：

```text
E:\rules\ai_code_review_files\tools\run-audit.cmd
```

### 2.1 原理

```text
.svn/wc.db  (SQLite)
   ├─ NODES        所有版本化文件 + 校验和 + 原始 mtime/size
   │    ├─ op_depth = 0   基线文件
   │    └─ op_depth > 0   本地新增(已 add) / 删除
   └─ ACTUAL_NODE  属性修改 / 冲突 / changelist

.svn/pristine/   基线文件内容（按 SHA-1 分目录存放）

判定流程：
  1. 对 NODES 中每个 op_depth=0 的文件
  2. 先比 mtime + size（快路径，SVN 自己也这么做）
  3. 不一致则算磁盘文件 SHA-1，与 NODES.checksum 比对（慢路径）
  4. 不等 → 已修改(M)
  5. 文件不存在 → 缺失(!)
  6. 未在 NODES 中 → 未纳管(?)
  7. diff = pristine 内容 vs 磁盘内容
```

### 2.2 输出

| 文件                         | 内容                             |
| -------------------------- | ------------------------------ |
| `reports/status.txt`       | 类 `svn status` 清单（M/A/D/!/?/C） |
| `reports/diff.patch`       | 统一 diff，含新增文件全文                |
| `reports/review-packet.md` | **给审查 AI 的完整审查包**（自包含，可直接粘贴）   |
| `reports/status.json`      | 机器可读结果                         |

退出码：`0` 干净 / `1` 有改动 / `2` 有冲突 / `3` 出错。

### 2.3 常用参数

```powershell
python precommit_audit.py --include java,xml      # 只看指定后缀
python precommit_audit.py --max-diff 800000       # 放大单文件 diff 上限
python precommit_audit.py --wc D:\other\path      # 指定工作副本
python precommit_audit.py --quiet                 # 只输出摘要
```

---

## 3. 标准工作流

```text
① 人改代码（或让 AI 改）
        ↓
② 跑审计：python precommit_audit.py
        ↓
③ 得到变更集 + review-packet.md
        ↓
④ 审查 AI 读 review-packet.md + REVIEW_RULES.md + 对应语言档案 + projects/x_main.md
        ↓
⑤ 出结论：BLOCK / PASS_WITH_NOTES / PASS
        ↓
⑥ 若有 P0/P1 → 只在变更集范围内修
        ↓
⑦ 重新跑审计（变更集会变化，必须重新确认范围）
        ↓
⑧ PASS → TortoiseSVN 提交
```

### 3.1 对 AI 的硬性动作要求

**接受任务时的第一件事**：读变更集，向用户复述"本次将要改动哪几个文件"，确认后再动手。

**写完之后的最后一件事**：重新跑审计，确认：

- 变更集没有意外扩大（没有碰到清单外文件）
- 新增文件已 `svn add`（否则不会进版本库）
- 无冲突

### 3.2 提交前自检

- [ ] `status.txt` 里没有预期外的文件
- [ ] 新增文件状态是 `A` 而不是 `?`（`?` 意味着没 add，提交不会带上）
- [ ] 没有 `!`（缺失）
- [ ] 没有 `C`（冲突）
- [ ] diff 里没有纯空格/换行/FORMAT 噪音（避免污染代码审查）

---

## 4. 与审查规则的关系

| 场景                   | 依据                     |
| -------------------- | ---------------------- |
| 审查只审 diff 变更行        | `REVIEW_RULES.md` §1.1 |
| 审查范围外问题标 `[范围外]`，不阻塞 | `REVIEW_RULES.md` §1.3 |
| AI 只改变更集内文件          | **本文件 §1.1**           |
| 修改必须符合架构约束           | `projects/x_main.md`   |

**本文件管"改哪里"，`REVIEW_RULES.md` 管"怎么评"，`languages/<语言>.md` 管"这门语言什么算缺陷"，`projects/x_main.md` 管"为什么不能那样改"。**

---

## 5. 已知限制

| 限制                     | 说明                                                          |
| ---------------------- | ----------------------------------------------------------- |
| 无 `svn.exe`            | 所有 SVN 操作只能靠脚本读 `wc.db`，或 TortoiseSVN 图形界面                  |
| 不可 `svn update/commit` | 脚本只读，不写版本库；提交仍需 TortoiseSVN 或安装命令行客户端                       |
| 合并信息不解析                | `svn:mergeinfo` 只做记录，不做合并来源分析                               |
| 外部依赖                   | `externals` 不跟进                                             |
| 编码                     | 项目源码混用 UTF-8 / GBK，脚本按 UTF-8 → GB18030 依次解码，diff 以 UTF-8 输出 |
| 二进制文件                  | 只标记"已修改"，不生成 diff                                           |

---

## 6. 目录结构

```text
E:\rules\ai_code_review_files\
├─ PROMPT.md                审查指令模板（复制粘贴用）
├─ REVIEW_RULES.md          审查规范（分级/举证/豁免/格式）
├─ languages/<语言>.md      语言档案（惯用法 / 缺陷 / 误报）
├─ projects/x_main.md       项目架构约束
├─ SVN_WORKFLOW.md          本文件：改动范围规则
├─ tools\
│  ├─ precommit_audit.py    改动读取 + 审查包生成
│  └─ run-audit.cmd         一键运行
└─ reports\                 生成的审查包（可随时重新生成）
```
