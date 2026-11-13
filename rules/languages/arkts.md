# 鸿蒙 ArkTS 语言档案（L1）

> 配套 `../REVIEW_RULES.md`（L0 通用方法论）。
> 适用：HarmonyOS NEXT 应用/元服务，ArkTS + ArkUI，`.ets` 源文件。

---

## 1. 适用范围与版本约束

| 要确认 | 从哪看 | 影响什么 |
|---|---|---|
| API 版本 | `build-profile.json5` 的 `compatibleSdkVersion` | API 9/10/11/12 的组件、状态装饰器、路由能力差别很大 |
| 工程模型 | 有无 `module.json5`、`oh-package.json5` | Stage 模型（新）vs FA 模型（旧），API 完全不同 |
| 包管理 | `oh-package.json5` | ohpm 依赖，不是 npm |
| 是否纯 ArkTS | 有无混用 `.ts` | ArkTS 是 TS 的**受限子集** |

**最要紧的一条：ArkTS 在编译期禁用了一批 TS 写法。** 建议里出现 `any`、动态属性、结构化类型断言，等于给了一个编译不过的方案。

---

## 2. 语言惯用法（判断"像不像问题"的前提）

- **状态驱动 UI**：`@State` / `@Prop` / `@Link` / `@Provide` / `@Consume` 决定谁刷新谁。
- **组件是 `@Component` 修饰的 struct**，不是 class。
- **`@Builder` 构建局部 UI**，`@Styles` / `@Extend` 复用样式。
- **页面跳转用 `router` 或 `Navigation`**，不是 URL。
- **ArkTS 禁止**：`any`/`unknown` 作类型、`obj[key]` 动态属性访问、`as` 任意类型断言、`eval`、`Function` 构造、原型修改。

---

## 3. 常见确定性缺陷

### 3.1 状态不刷新（最高频）
- `@State` 只能观察到**自身引用变化**。改对象内部字段（`this.obj.a = 1`）**不会触发刷新**，除非嵌套对象被 `@Observed` + `@ObjectLink` 观察。
- 数组 `push` 在新版能触发，但**替换元素**、深层字段修改仍可能不刷新。

### 3.2 生命周期
- `aboutToAppear` 里做同步耗时操作（读大文件、同步网络）→ 首帧卡顿。
- 异步回调在页面 `aboutToDisappear` 之后还在改状态 → 更新已销毁组件。
- 注册的监听（`emitter`、传感器、定时器）忘记在 `aboutToDisappear` 里注销。

### 3.3 并发与线程
- UI 更新必须在主线程；`TaskPool` / `Worker` 里直接改状态会抛错。
- `@Sendable` 约束：跨线程传递的对象必须可序列化。

### 3.4 类型与互操作
- 用 `ESObject`/`any` 绕过类型（编译期报错，或埋运行时坑）。
- 调用 NAPI（C++ 侧）返回的指针/句柄未释放。

---

## 4. 误报清单（★ 最常被误提的）

- ❌ **"建议用 React/Vue 的 hooks 思路"** → ArkUI 是声明式但 API 完全不同。
- ❌ **"建议加 `any` 绕过去"** → **ArkTS 编译期不允许**，这个建议给出来就是错的。
- ❌ **"建议用 `obj[key]` 动态访问"** → ArkTS 禁止动态属性，需改用 `Map` 或显式分支。
- ❌ **"建议用 Node.js 的 `fs`/`path`"** → 鸿蒙没有 Node 运行时，用 `@ohos.file.fs`。
- ❌ **"建议用 npm 装包"** → 用 ohpm。
- ❌ **"`@State` 改成普通字段性能更好"** → 反了，普通字段不触发刷新。
- ❌ **"建议把 struct 改成 class"** → 组件必须是 `@Component struct`。
- ❌ **"建议加 try/catch 兜住所有异步"** → 需指出具体失败点与后果。
- ❌ **"建议用 CSS 那套样式思路"** → ArkUI 有自己的样式体系。

---

## 5. 提交前自检

- [ ] 改的是对象内部字段吗？外层是 `@Observed` + `@ObjectLink` 吗？
- [ ] `aboutToAppear` 里有没有同步耗时操作？
- [ ] 异步回调有没有可能在页面销毁后才回来改状态？
- [ ] 注册的监听 / 定时器在 `aboutToDisappear` 里注销了吗？
- [ ] 有没有用到 `any`、动态属性、跨类型断言（ArkTS 不允许）？
- [ ] 跨线程传的对象满足 `@Sendable` 吗？
