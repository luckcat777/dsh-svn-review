# Kotlin 语言档案（L1）

> 配套 `../REVIEW_RULES.md`（L0 通用方法论）。本文件只管"在 Kotlin 里什么算缺陷、什么算误报"。

---

## 1. 适用范围与版本约束

| 要确认 | 从哪看 | 影响什么 |
|---|---|---|
| Kotlin 版本 | 构建文件里 kotlin 插件版本 | 1.5 的 sealed/值类行为、1.9 的 `data object`、2.0 的 K2 编译期检查都不同 |
| JVM target | `jvmTarget` / `kotlinOptions` | 决定能用哪些 JDK API |
| Android or 后端 | 有无 `android { }` 块 | Android 的 `Context` 生命周期问题只在这边成立 |
| 协程 | 有无 `kotlinx-coroutines` | 决定 `suspend` 相关意见是否成立 |

---

## 2. 语言惯用法（判断"像不像问题"的前提）

- **空安全是类型系统的一部分**：`String` 非空、`String?` 可空。`?.`、`?:`、`let` 是标准写法。
- **`!!` 是有意断言**，不是"忘了判空"。要看它断言的**不变量**成不成立。
- **`lateinit` 用于框架注入**（ViewBinding、DI），在初始化完成前访问会抛异常。
- **`data class` 自动生成 equals/hashCode**，不要建议手写。
- **协程用 `suspend` 表达挂起**，不该用线程阻塞来等。

---

## 3. 常见确定性缺陷

### 3.1 空值
- `!!` 落在**外部输入**驱动的路径上（网络/DB/JSON 字段）。
- **平台类型**：调用 Java 方法返回的类型是 `T!`，Kotlin 不知道它能不能为空 → 未判空直接使用。
- `lateinit` 字段在 `onCreate`/`aboutToAppear` 之前被访问。

### 3.2 协程
- `GlobalScope.launch` → 生命周期不受控，容易泄漏。
- `suspend` 函数里调用阻塞 API（`Thread.sleep`、同步 IO、`runBlocking`）。
- `runBlocking` 出现在协程内部 → 死锁或浪费线程。
- 协程里更新已销毁 UI（Android 的 `Activity` 销毁后）。

### 3.3 集合与并发
- `mutableListOf` 跨线程共享且无保护。
- `HashMap` 遍历时修改 → `ConcurrentModificationException`。

---

## 4. 误报清单（★ 最常被误提的）

- ❌ **"建议用 `Optional`"** → Kotlin 的空安全已在类型系统里，`Optional` 是 Java 的东西。
- ❌ **"建议加 `synchronized`"** 用在协程场景 → 应使用 `Mutex`；而且先证明有并发。
- ❌ **"这个字段应该写 getter/setter"** → Kotlin 有属性语法，Java 风格是倒退。
- ❌ **"`!!` 很危险，建议改成 `?.let`"** → 若该处不变量已由上游保证，`!!` 是正确表达意图的写法。
- ❌ **"建议改成 Java 风格 for 循环"** → 集合操作符是惯用法。
- ❌ **"建议用 `var` 而不是 `val`"** → 反了，`val` 优先。
- ❌ **"扩展函数用太多不好"** → 设计偏好。
- ❌ **"建议加 `@JvmStatic`"** → 只在特定互操作场景需要。

---

## 5. 提交前自检

- [ ] 新增的 `!!` 断言的路径，外部输入能不能让它为空？
- [ ] 调 Java 方法拿到的返回值（平台类型），判空了吗？
- [ ] 协程里有没有阻塞调用 / `runBlocking`？
- [ ] `GlobalScope` 用了吗？作用域该不该跟着生命周期走？
- [ ] 共享的可变集合，有保护吗？
