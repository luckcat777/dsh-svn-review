# C# 语言档案（languages/csharp.md）

> **L1 语言档案。** 适用条件：代码是 C#（.NET Framework 4.x 或 .NET 6/8/9）。
>
> 三层分工与优先级同 `java.md` 开头：**L2 项目约定 > 本文件 > L0 默认判断**。

---

## 1. 适用范围与版本约束

**先确认四件事**：

1. **运行时**：.NET Framework 4.x 还是 .NET（Core）6/7/8？决定可用 API（如 `Span<T>`、`System.Text.Json`、`DateOnly`）。
2. **C# 语言版本**：`record` 需 C# 9，`file-scoped namespace` 需 C# 10，`required` 需 C# 11。
3. **可空引用类型是否启用**：`<Nullable>enable</Nullable>`。**启用后大量"可能为 null"的提示已由编译器给出**，人工再提多为重复。
4. **是否有 `SynchronizationContext`**：WinForms/WPF/ASP.NET（非 Core）下有；这决定 `.Result` 是否会死锁。

---

## 2. 语言惯用法（审查前必须理解）

| 惯用法 | 含义 | 审查含义 |
|---|---|---|
| `?.` / `??` / `??=` | 空值传播是常规写法 | 已用这些的地方，别再提"可能空引用" |
| `async`/`await` 全链路 | 异步是默认 I/O 模型 | 同步阻塞调用才是缺陷 |
| `IDisposable` + `using` | 资源生命周期约定 | 未 `using` 的 `IDisposable` 是确定缺陷 |
| LINQ 延迟执行 | 查询在枚举时才跑 | 多次枚举 = 多次执行，可能是性能缺陷 |
| `struct` 是值类型 | 赋值即复制 | 大 `struct` 传参会复制；可变 `struct` 是陷阱 |

**C# 的判据是"确定性异常 / 确定资源泄漏 / 死锁"，不是"是否符合某家公司风格"。**

---

## 3. 常见确定性缺陷（P1 候选）

### 3.1 异步

| 模式 | 后果 |
|---|---|
| `async void`（非事件处理器） | 异常无法被捕获，直接崩溃进程 |
| 在同步上下文里 `.Result` / `.Wait()` / `.GetAwaiter().GetResult()` | WinForms/WPF/旧 ASP.NET 下**必死锁** |
| `Task` 不 `await`（fire-and-forget） | 异常静默丢失 |
| `Task.Run` 包住纯 CPU 计算却期望提速 | 只是换了线程池线程 |
| `await` 后未 `ConfigureAwait(false)`（库代码） | 可能因上下文捕获而死锁 |
| 并发 `Task.WhenAll` 中一个失败 | 其余异常被吞，只看到第一个 |

### 3.2 资源

| 模式 | 后果 |
|---|---|
| `IDisposable`（`FileStream`、`DbConnection`、`HttpClient` 误用）未 `using` | 句柄泄漏，最终耗尽 |
| `new HttpClient()` 每次新建 | socket 耗尽（TIME_WAIT） |
| 事件 `+=` 订阅后不 `-=` | 发布者持有订阅者，泄漏 |
| `static` 事件订阅实例对象 | 同上，且永不回收 |

### 3.3 集合与 LINQ

| 模式 | 后果 |
|---|---|
| 枚举中修改集合 | `InvalidOperationException` |
| 同一 `IEnumerable` 多次枚举 | 每次重新执行查询（可能查库 N 次） |
| LINQ 查询捕获了后续会变的变量 | 延迟执行拿到的是**最终值** |
| `List<T>` 在大循环里 `Remove` | O(n²) |
| `Dictionary` 用可变对象作 key | 改字段后取不出 |
| `ToArray()` / `ToList()` 遗漏后又多次枚举 | 见上 |

### 3.4 数值

| 模式 | 后果 |
|---|---|
| 金额用 `double` / `float` | 精度丢失，应 `decimal` |
| 整数除法当小数 | 静默截断 |
| `int` 溢出（默认不抛） | 静默变负；应 `checked` 或换 `long` |
| `DateTime.Now` 做逻辑比较 | 受时区/DST 影响，应 `UtcNow` |
| `DateTime` 做耗时计算 | 受系统时间调整影响，应 `Stopwatch` |

### 3.5 异常与空值

| 模式 | 后果 |
|---|---|
| `catch (Exception ex) { throw ex; }` | **丢失原始堆栈**，应用 `throw;` |
| `catch` 后吞掉且无日志 | 问题不可排查 |
| 可空引用未启用却假设非空 | `NullReferenceException` |
| `as` 转换后未判空 | `NullReferenceException` |
| `?.` 链末端调用返回 `void` 的方法 | 空时静默不执行 |

### 3.6 并发

| 模式 | 后果 |
|---|---|
| `lock(this)` / `lock(typeof(T))` / `lock("字符串")` | 外部可锁定同一对象 → 死锁 |
| `lock` 内 `await` | 编译不过（这是好事），但改用 `SemaphoreSlim` 时易漏释放 |
| 非线程安全集合在多线程写 | 数据损坏 |
| `volatile` 当作锁用 | 不保证原子性 |

---

## 4. 误报清单（不得提出的意见）

### 4.1 版本与语言特性

- ❌ 建议 `record`、`init`、`required`、文件作用域命名空间、主构造函数
  → 取决于 C# 版本，先确认。
- ❌ 建议升级 .NET 版本 / 迁移到 .NET 8
  → 不是本次 diff 的事。
- ❌ 「建议启用可空引用类型」
  → 项目级决策，会引发全库告警，不是一次 diff 能做的。

### 4.2 风格伪装成缺陷

- ❌ 「建议用 `var`」或「建议不要用 `var`」
  → 纯团队风格，P3，不进报告。
- ❌ 「建议给类加 `sealed`」
  → 设计偏好，P3。
- ❌ 「建议用 `StringBuilder`」
  → 少量拼接由编译器/运行时优化；只有**循环内**拼接才成立，且 P2。
- ❌ 「建议把 `for` 改成 LINQ」
  → 热路径上 LINQ 往往更慢；无实测就是噪音。
- ❌ 「建议 `ToList()` 一下」
  → 有时正是为了延迟执行才不 `ToList()`；需说明**为什么要物化**。
- ❌ 「建议加 `try-catch`」
  → 需指出具体异常类型与来源行；泛泛而谈不成立。

### 4.3 异步

- ❌ 「建议全面改成 `async`」
  → 纯 CPU 计算改成 `async` 没有收益，还引入状态机开销。
- ❌ 「建议加 `ConfigureAwait(false)`」
  → 只在**库代码**里有意义；应用层加了会破坏 UI 上下文回归。
- ❌ 「`async void` 不好」
  → 事件处理器**必须**是 `async void`，这是规范写法。

### 4.4 并发

- ❌ 「建议加锁保证线程安全」
  → 必须先证明存在并发访问。ASP.NET 请求作用域、单线程服务里加锁是错误建议。
- ❌ 「建议用 `Interlocked` / `volatile`」
  → 同上；且 `volatile` 不提供原子性。

---

## 5. 提交前自检项

- [ ] 有没有非事件处理器的 `async void`？
- [ ] 有没有 `.Result` / `.Wait()`（可能死锁）？
- [ ] 所有 `IDisposable` 是否 `using` / `await using`？
- [ ] 事件订阅是否有对应的取消订阅？
- [ ] `catch` 里是否 `throw ex`（丢堆栈）而非 `throw`？
- [ ] 同一 `IEnumerable` 是否被枚举多次？
- [ ] 枚举期间是否修改了集合？
- [ ] 金额是否为 `decimal`？整数运算是否可能溢出？
- [ ] 时间是否用了 `UtcNow` / `Stopwatch`？
- [ ] `lock` 的对象是否私有且不可变？
- [ ] 有没有提议超出目标 C# 版本的语法？（有就删掉）
