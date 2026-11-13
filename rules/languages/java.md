# Java 语言档案（languages/java.md）

> **L1 语言档案。适用条件：代码是 Java，任意版本。**
>
> 版本由插件从构建文件探测（`build.gradle` 的 `sourceCompatibility` / `pom.xml` 的
> `maven.compiler.source`、`maven.compiler.release`、`<java.version>`）。本文件分三块：
>
> - **§1 版本矩阵** —— 先对号入座，决定"这条建议越不越界"
> - **§2–§3 通用部分** —— 与版本无关，任何 Java 版本都成立
> - **§4 误报清单** —— 提了就是误报，记入 L0 附录 A
>
> **版本没探测出来时**：只套 §2–§3 的通用判据，并在报告里注明
> "未取到目标版本，未套用版本层建议与豁免"。
>
> 三层分工：
> - `../REVIEW_RULES.md`（L0）定方法论：分级、举证责任、输出格式、裁决流程
> - **本文件（L1）** 定"在 Java 里什么算缺陷、什么算误报"
> - `../projects/<项目>.md`（L2）定项目约定
>
> **优先级：L2 项目约定 > 本文件 > L0 默认判断。** 三者冲突时按此顺序裁决。

---

## 1. 版本矩阵

> 判据只看**构建文件里声明的目标版本**，不看"这台机器装的是 JDK 几"。
> 声明 `1.8` / `8` 就是 8；`release 17` 就是 17；只有 `<java.version>21</java.version>`
> 而没有 compiler 配置时按 21 处理。

| 档 | 可用的语言特性（建议这些不算越界） | 不可用（建议即误报） |
|---|---|---|
| **8** | lambda、方法引用、Stream、`Optional`、`CompletableFuture`、`default` 方法、`java.time` | `var`、`List.of`/`Map.of`/`Set.of`、`Optional.isEmpty`、`Optional.stream`、`Stream.toList`、`switch` 表达式、文本块、`record`、`instanceof` 模式匹配、`sealed`、`module-info`、`Files.readString`、`String.isBlank/strip/repeat` |
| **11** | 上一档全部 + `var`(10)、`List.of`/`Set.of`/`Map.of`(9)、`Optional.isEmpty`、`Optional.or`、`String.isBlank/strip/repeat/lines`、`Files.readString/writeString`、`HttpClient`、`Predicate.not` | `record`、`sealed`、`switch` 表达式、文本块、`instanceof` 模式匹配、`Stream.toList`(16)、`RandomGenerator`(17) |
| **17** | 上一档全部 + `switch` 表达式(14)、文本块(15)、`instanceof` 模式匹配(16)、`record`(16)、`sealed`(17)、`Stream.toList`(16)、`RandomGenerator`(17)、`HexFormat` | 虚拟线程(21)、`record` 模式(21)、`switch` 模式匹配(21)、`SequencedCollection`(21)、`String templates`(21 仍 preview) |
| **21** | 上一档全部 + 虚拟线程、`record` 模式、`switch` 模式匹配、`SequencedCollection` 的 `getFirst/getLast/reversed`、`Math.clamp` | `String templates`（21 是 preview，编译要 `--enable-preview`，建议即误报）、未命名变量（21 是 preview） |
| **≥22** | 21 的全部，外加该版本已转正的特性 | 未在构建文件里声明的语法一律不建议；先确认 `release`/`sourceCompatibility` 再开口 |

### 1.1 各档特有的审查提醒

- **8**：`HashMap` 在并发写下的死循环是这个版本特有的（JDK 8 的 resize 实现）。`SimpleDateFormat` 静态共享必炸。**没有** `var`，代码里出现 `var` 说明目标版本不是 8，先质疑版本探测结果而不是报缺陷。
- **11**：`HttpClient` 取代 `HttpURLConnection` 时注意它是异步的，别因为"没加超时"就报——先看有没有 `.timeout(...)`。
- **17**：`record` 的 `equals`/`hashCode`/`toString` 由编译器生成，**不要建议补写**；`record` 不能继承类，看到 `extends` 要确认是不是普通类。`sealed` 的 `permits` 是编译期约束，不构成运行时校验。
- **21**：虚拟线程下 `synchronized` 会 pin 住载体线程——**只有代码明确跑在虚拟线程上时才成立**，普通线程池里提这个就是误报。`SequencedCollection.getFirst()` 在空集合上仍抛 `NoSuchElementException`，与 `list.get(0)` 同性质。

---

## 2. 语言惯用法（审查前必须理解，与版本无关）

在 Java 里，**`null` 是默认的失败信号**，不是异常情况。这和 Rust/Go 把"没有值"编码进类型系统完全不同：

| 惯用法 | 含义 | 审查含义 |
|---|---|---|
| 返回 `null` | 「没找到」的正常表达 | 调用方链式取值必然要判空 |
| 返回 `false` | 「这个操作没做成」 | 不附带原因，靠日志 |
| `catch (Exception e)` + log | 故障隔离 | 不等于"吞异常" |
| 集合返回空集合而非 `null` | 契约 | 对空集合 `.get(0)` 依然越界 |

**举证责任（L0 §3④「现有防护为何失效」）在 Java 里通常落在这几处**：`if (x != null)` 判空、`Optional`、`Objects.requireNonNull`、配置文件里的开关、上游已做的校验。指不出这些，就不构成 P1。

---

## 3. 常见确定性缺陷（P1 候选，与版本无关）

以下是 Java 里**可以由代码证明**的缺陷。注意：能列进这张表不等于自动成立，仍须按 L0 §3 给出 ①②③④。

### 3.1 空值

| 模式 | 为什么必然出错 |
|---|---|
| `a.getB().getC()` 未判空 | `getB()` 返回 `null` 时立即 NPE，且发生在链的中间，调用方无法防御 |
| `Map.get(k)` 后直接调方法 | `get` 未命中返回 `null`，不是抛异常 |
| `Integer` 拆箱为 `int` | 变量为 `null` 时 NPE，编译器不报 |
| `list.get(0)` / `arr[0]` | 配置缺失时集合为空 → `IndexOutOfBoundsException` |
| `equals` 调用在可能为 `null` 的一侧 | `null.equals(x)` 必 NPE；应写 `x.equals(null-safe)` 或用常量在前 |

### 3.2 集合

| 模式 | 后果 |
|---|---|
| 遍历中 `list.remove(o)` | `ConcurrentModificationException`；应走 `Iterator.remove()` 或收集后批量删 |
| `HashMap` 在多线程下并发写 | JDK 8 可能丢数据 / 死循环（需有并发证据才成立） |
| 可变对象作 `HashMap` 的 key | 修改字段后 `hashCode` 变化，key 再也取不出来 |
| `subList` 后改原 list | `ConcurrentModificationException` |
| `Arrays.asList(int[])` | 返回 `List<int[]>` 而非 `List<Integer>`，长度 1 |
| `List.of(...)` 后调 `add` | 不可变集合，抛 `UnsupportedOperationException`（9+ 才有这个 API） |

### 3.3 相等与装箱

| 模式 | 后果 |
|---|---|
| `Integer` 用 `==` 比较 | `-128..127` 命中缓存返回 true，超出返回 false —— 小数据测试通过、线上出错 |
| `String` 用 `==` 比较 | 同上，取决于常量池 |
| 重写 `equals` 未重写 `hashCode` | 放进 `HashSet`/`HashMap` 后查不到 |
| `equals` 入参未判类型 | `instanceof` 缺失时强转抛 `ClassCastException` |

### 3.4 控制流

| 模式 | 后果 |
|---|---|
| `switch` 缺 `default` 且用返回值 | 未知输入返回 `null`/`0`，继续流入业务 |
| `case` 缺 `break` | 落到下一个分支，重复执行 |
| 循环内重复计算不变的值 | P2，性能 |
| `finally` 里有 `return` | 吞掉异常与返回值 |
| 21+ 的 `switch` 模式匹配未覆盖全部类型 | 若没有 `default`，编译器对 sealed 层次会报错；对非 sealed 仍是运行时漏处理 |

### 3.5 资源

| 模式 | 后果 |
|---|---|
| `InputStream` / `Connection` / `ResultSet` 未 `try-with-resources` | 异常路径泄漏，最终句柄耗尽 |
| `close()` 写在 `try` 里而非 `finally` | 中途抛异常则不执行 |
| 静态 `SimpleDateFormat` | 非线程安全，并发下解析出错乱数据（11+ 可换 `DateTimeFormatter`） |

### 3.6 数值

| 模式 | 后果 |
|---|---|
| 整数除法当小数用 | `5/2 == 2`，静默截断 |
| 整数除零 | `ArithmeticException`（浮点是 `Infinity`，不抛） |
| 大数乘法溢出 | `long` 溢出静默变负，金额/经验值算错 |
| `double` 表示金额 | 精度丢失，`0.1+0.2 != 0.3` |
| `Math.abs(Integer.MIN_VALUE)` | 仍是负数 |

---

## 4. 误报清单（不得提出的意见）

> 这一节是本文件最有价值的部分。以下建议在 Java 语境里**听起来很对但没有意义**，提出即视为误报，记入 L0 附录 A。

### 4.1 版本越界

- ❌ 建议目标版本不支持的语法
  → 具体以 **§1 版本矩阵的"不可用"列**为准。典型：对 8 建议 `var`/`record`/`List.of`/`switch` 表达式/文本块/`Optional.isEmpty`/`Stream.toList`；对 17 建议虚拟线程；对 21 建议 `String templates`。
- ❌ 建议升级 JDK 到更高版本
  → 不是本次 diff 的事。

### 4.2 风格重构伪装成缺陷

- ❌ 「建议改成 `Optional` 链式」
  → 只是把判空换个写法，不解决 L0 §3①③；且 `Optional` 作字段/参数本身是反模式。
- ❌ 「建议用 Stream 替代这个 for 循环」
  → P3 偏好。含 `break`/`continue`/`return` 的循环改成 Stream 往往更难读。
- ❌ 「建议用 `Objects.requireNonNull`」
  → 只是换一种崩法（把静默 NPE 变成显式 NPE），不解决可达性。
- ❌ 「建议拆分成更小的方法」
  → P3，且不得夹带在缺陷意见里（L0 §5 硬性约束 2）。
- ❌ 「建议加 `final` 修饰参数/局部变量」
  → 纯风格，不进报告。
- ❌ 「建议用 `StringBuilder` 替代 `+`」
  → 少量拼接由编译器优化；只有**循环内**拼接才成立，且是 P2。
- ❌ 「建议把魔法数字提取成常量」
  → 若值来自配置表，它本来就该是数据（见 L2 项目档案）；纯代码常量属 P3。
- ❌ 「建议用 `record` 替代这个 DTO」
  → 17+ 才可用，且要确认该类是否可变、是否被框架反射实例化。属 P3 偏好。

### 4.3 并发

- ❌ 「这里非线程安全，建议加锁 / 加 `volatile` / 换 `ConcurrentHashMap`」
  → **必须先证明存在跨线程访问**。单线程上下文（actor 队列、事件循环、请求作用域）里加锁是错误建议，且会引入死锁。
- ❌ 「建议改成异步」
  → 同样需要先证明当前是阻塞瓶颈。
- ❌ 「虚拟线程里用了 `synchronized`，建议全换 `ReentrantLock`」
  → 只有代码确实运行在虚拟线程上才成立；且不是所有 `synchronized` 都会长期 pin。

### 4.4 异常

- ❌ 「`catch` 里只打日志，建议重新抛」
  → 需要证明"重新抛"不会打断主流程；多数业务隔离场景是故意吞。
- ❌ 「多个 `try-catch` 太啰嗦，建议合并」
  → 合并会扩大隔离边界，是倒退。
- ❌ 「这里没有异常处理」
  → 需指出**具体哪个异常**、在哪一行抛、后果是什么，否则不成立。

### 4.5 测试与工程

- ❌ 「建议补充单元测试」
  → 需先确认项目有测试基建。常有项目只有 `junit` 依赖而无 `src/test`，此时不可执行。
- ❌ 建议引入 Lombok / MapStruct / Guava / Apache Commons
  → 新依赖不在 diff 审查范围。

---

## 5. 提交前自检项

审 Java 改动时，按顺序过一遍（前 3 条按 §1 的档取用）：

- [ ] 先确认目标版本，再看 diff 里有没有用到该档之外的语法（有就说明版本判断错了，回头查构建文件）
- [ ] 目标版本 ≥ 17 时，`record` 是否被当成可变对象用？`sealed` 是否被当成运行时校验？
- [ ] 目标版本 = 8 时，有没有顺手建议 `var`/`List.of`/`switch` 表达式？
- [ ] 新增的链式调用，每一环的返回是否可能为 `null`？
- [ ] 集合 `.get(0)` / 数组下标，是否确认非空？
- [ ] `Integer`/`Long` 是否用了 `==`？是否可能为 `null` 后被拆箱？
- [ ] 遍历中是否删除了元素？
- [ ] `switch` 是否有 `default`？`case` 是否都 `break`/`return`？
- [ ] 新增的流/连接/`ResultSet` 是否 `try-with-resources`？
- [ ] 金额/经验值是否用了 `double`？乘法是否可能溢出？
- [ ] 是否有静态可变共享对象（`SimpleDateFormat`、`Random`、缓存 `Map`）？
