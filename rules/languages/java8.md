# Java 8 语言档案（languages/java8.md）

> **L1 语言档案。** 适用条件：代码是 Java，且目标运行时是 **Java 8**（`sourceCompatibility = 1.8`）。
>
> 三层分工：
> - `../REVIEW_RULES.md`（L0）定方法论：分级、举证责任、输出格式、裁决流程
> - **本文件（L1）** 定"在 Java 8 里什么算缺陷、什么算误报"
> - `../projects/<项目>.md`（L2）定项目约定
>
> **优先级：L2 项目约定 > 本文件 > L0 默认判断。** 三者冲突时按此顺序裁决。

---

## 1. 适用范围与版本约束

- **可用**：lambda、方法引用、Stream、`Optional`、`CompletableFuture`、`default` 方法、`java.time`。
- **不可用**（建议即误报）：`var`、`record`、`List.of` / `Map.of`、`switch` 表达式、文本块、`instanceof` 模式匹配、`Optional.isEmpty`、`Stream.toList`。
- **模块系统**：无 `module-info`。
- **测试**：`junit 4.12`，`@Test` 来自 `org.junit.Test`（不是 Jupiter）。

> 版本不确定时，先看 `build.gradle` / `pom.xml` 的 `sourceCompatibility` / `<source>`，不要凭"Java 现在都 17 了"假设。

---

## 2. 语言惯用法（审查前必须理解）

在 Java 里，**`null` 是默认的失败信号**，不是异常情况。这和 Rust/Go 把"没有值"编码进类型系统完全不同：

| 惯用法 | 含义 | 审查含义 |
|---|---|---|
| 返回 `null` | 「没找到」的正常表达 | 调用方链式取值必然要判空 |
| 返回 `false` | 「这个操作没做成」 | 不附带原因，靠日志 |
| `catch (Exception e)` + log | 故障隔离 | 不等于"吞异常" |
| 集合返回空集合而非 `null` | 契约 | 对空集合 `.get(0)` 依然越界 |

**举证责任（L0 §3④「现有防护为何失效」）在 Java 里通常落在这几处**：`if (x != null)` 判空、`Optional`、`Objects.requireNonNull`、配置文件里的开关、上游已做的校验。指不出这些，就不构成 P1。

---

## 3. 常见确定性缺陷（P1 候选）

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

### 3.5 资源

| 模式 | 后果 |
|---|---|
| `InputStream` / `Connection` / `ResultSet` 未 `try-with-resources` | 异常路径泄漏，最终句柄耗尽 |
| `close()` 写在 `try` 里而非 `finally` | 中途抛异常则不执行 |
| 静态 `SimpleDateFormat` | 非线程安全，并发下解析出错乱数据 |

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

- ❌ 建议 `var`、`record`、`List.of()`、`Map.of()`、`switch` 表达式、文本块、`Optional.isEmpty()`
  → Java 8 不支持，编译不过。
- ❌ 建议升级到 Java 11/17/21
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

### 4.3 并发

- ❌ 「这里非线程安全，建议加锁 / 加 `volatile` / 换 `ConcurrentHashMap`」
  → **必须先证明存在跨线程访问**。单线程上下文（actor 队列、事件循环、请求作用域）里加锁是错误建议，且会引入死锁。
- ❌ 「建议改成异步」
  → 同样需要先证明当前是阻塞瓶颈。

### 4.4 异常

- ❌ 「`catch` 里只打日志，建议重新抛」
  → 需要证明"重新抛"不会打断主流程；多数业务隔离场景是故意吞。
- ❌ 「多个 `try-catch` 太啰嗦，建议合并」
  → 合并会扩大隔离边界，是倒退。
- ❌ 「这里没有异常处理」
  → 需指出**具体哪个异常**、在哪一行抛、后果是什么，否则不成立。

### 4.5 测试与工程

- ❌ 「建议补充单元测试」
  → 需先确认项目有测试基建。Java 8 项目常常只有 `junit` 依赖而无 `src/test`，此时不可执行。
- ❌ 建议引入 Lombok / MapStruct / Guava / Apache Commons
  → 新依赖不在 diff 审查范围。

---

## 5. 提交前自检项

审 Java 8 改动时，按顺序过一遍：

- [ ] 新增的链式调用，每一环的返回是否可能为 `null`？
- [ ] 集合 `.get(0)` / 数组下标，是否确认非空？
- [ ] `Integer`/`Long` 是否用了 `==`？是否可能为 `null` 后被拆箱？
- [ ] 遍历中是否删除了元素？
- [ ] `switch` 是否有 `default`？`case` 是否都 `break`/`return`？
- [ ] 新增的流/连接/`ResultSet` 是否 `try-with-resources`？
- [ ] 金额/经验值是否用了 `double`？乘法是否可能溢出？
- [ ] 是否有静态可变共享对象（`SimpleDateFormat`、`Random`、缓存 `Map`）？
- [ ] 有没有提议 Java 9+ 语法？（有就删掉）
