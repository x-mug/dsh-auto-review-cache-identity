# Auto 审查缓存身份（@x-mug/dsh-auto-review-cache-identity）

给 DeepSeek Harness 内置 Auto 审查单独指定模型，并帮助支持的接口复用审查输入缓存。

本文对应 **1.2.2**。使用 DSH Desktop **0.2.2-rc.1** 或更新版本时，请把插件更新到 **1.2.2**。旧版 DSH 的单消息审查也能识别。

## 为什么需要它

内置 Auto 审查默认沿用主会话的模型。安装插件后，可以在设置页指定另一组供应商和模型。审查请求匹配后，插件保留 DSH 提供的会话 ID 和请求内容，只覆盖所配置的供应商与模型。

DSH 0.2.2-rc.1 起，审查带上 `purpose: 'auto-review'` 和 `sessionId`，历史也可以拆成多条消息。插件 1.2.1 会跳过这类请求，设置页即使显示了固定模型，审查也可能照旧沿用主会话。1.2.2 支持新版请求。

## 功能

- **独立审查缓存**。支持的审核接口可以使用按会话生成的缓存键。DSH 自带的 `sessionId` 保持原值。
- **可选固定审查模型**：设置页里选供应商与模型；留空跟随主对话。
- **Anthropic 历史缓存**：按历史条目分块，保留前一轮与当前轮的显式断点；完整文本、角色和顺序不变，待审动作不打标。
- **异常回退原请求**：插件失败时仍执行原有审核，不改变审核的拒绝行为。
- **设置页**：导出 schemastery `Config` 后自动生成表单；另有一个自定义分区「Auto 审查模型」，用实时模型目录做下拉。

## 安装

在 DSH 的「插件 → 添加插件 → 安装第三方插件」中输入：

```text
github:x-mug/dsh-auto-review-cache-identity
```

固定到 1.2.2 可填写 `github:x-mug/dsh-auto-review-cache-identity#v1.2.2`，也可用 Release 压缩包直链。已有安装用插件管理器更新。安装后按提示重载，并在设置页打开「Auto 审查模型」。开发期间用过本地来源的，发布后切回远程安装，核对实际版本与锁定记录。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

## 配置

bundle 默认值只有两项，其余都留给设置页或 profile 补丁：

```yml
- insert:
    - id: local-auto-review-cache-identity
      name: '@x-mug/dsh-auto-review-cache-identity'
      config:
        enabled: true      # 关掉等于没装
        scope: session     # session：按会话；cwd：按工作目录（只给 A/B）
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后监听器直接放过所有请求。 |
| `scope` | `session` | 默认按发起者会话计算缓存身份。`cwd` 按审查环境里的工作目录计算，仅用于对照实验。 |
| `reviewProvider` | 空 | 审查固定使用的供应商 id，空 = 跟随主对话。 |
| `reviewModel` | 空 | 审查固定使用的模型 id，空 = 跟随主对话。 |

同时选择供应商和模型后，下一笔审查使用当前设置。一项留空时沿用原请求的模型。比如要走 FastLight，可在供应商 `magpie` 的模型目录里选 `group/fastlight`。

**profile 用户层按条目 id 覆盖 `config`，是整体替换、不是深合并。** 删掉用户层某个字段不会回落到 bundle 默认值，而是回落到 schema 默认值。要么只保留一层配置，要么两层始终写全。

### 诊断选项

两个只从 profile 补丁读、不进设置页表单的选项，默认都不开：

| 字段 | 默认 | 说明 |
|---|---|---|
| `log` | `false` | 每次注入打一行 info：`injected=<累计> key=<键> identityMisses=<累计>`。 |
| `trace` | 不设 | 一个**本机绝对路径**。记录身份、路由、挂载和缓存断点的元数据，不记录正文或凭据。 |

`trace` 不写进仓库默认值：绝对路径是某台机器的本地残留，装到别人机器上只会静默写失败。需要定位时在自己的 profile 补丁里显式给出路径，用完删掉。

## 设置页

两条路径都可以用：

- **自动表单**：插件导出 `Config` 并调用 `ctx.settings.configure()`，设置页会为四个字段生成原生表单，改动写回 profile 的 `cordis.patch.yml`。适合改 `enabled` / `scope`。
- **自定义分区「Auto 审查模型」**：供应商、模型两个下拉框，数据来自实时的模型目录；点「保存」写入同一份 profile 补丁。适合给审查换模型。

三点行为需要知道：

1. 设置页保存只写 volatile 字段，**不会重新 apply 插件**。插件每次处理审查时现读配置，所以保存后立即生效、无需重启。
2. 写入是 CAS：客户端用读到的 revision 提交，过期会被拒绝并提示保存失败，重新打开设置页再存即可。
3. **表单依赖随插件安装。** `@deepseek-ai/schemastery` 是必装依赖，本地 link 源码目录也需要安装依赖。缺少依赖时插件加载会明确报错，不再静默丢失表单。

自定义分区的「原始信息」显示宿主提供的表单状态。宿主未注册表单，或配置不可读写时，页面会禁用下拉和保存按钮。

### 核对实际审查模型

「Auto 审查模型」下可展开最近 20 条核对，查看发送时选用的供应商和模型。插件把请求发出前的最终选择与审查开始时的设置对照。发现新偏差时，打开的页面会弹出提示。跟随主对话时只显示选用的模型。记录只保留在内存，重载插件后从头开始。

核对覆盖提供 `llm-pi-ai/request-headers` 事件的发送通道，例如当前 DSH 0.2.2-rc.3 的 Magpie。记录说明发送前选了什么模型。网关最终调用的模型要查网关记录。

1. 打开正在运行的 profile，在插件管理器确认安装版本至少为 1.2.2。如果曾用本地源码或覆盖过安装文件，通过插件管理器从远程重新安装，让安装文件和锁定记录一致。
2. 在「Auto 审查模型」保存供应商和模型，然后触发一次实际的自动审查。
3. 对照插件 trace 里的 `provider` / `model` 和网关的审查请求。仅有 `mounted` 记录表示插件已加载。改写记录及网关收到的模型与当前设置相符，才能验证固定模型已生效。

## Anthropic 缓存断点

原生 `anthropic-messages` 通道（例如 `magpie-anthropic`）使用旧版单消息审查正文时，插件会添加下列缓存断点。新版多消息请求沿用适配器的内容边界，审查模型仍可单独配置。

- 使用独立的异步 fetch 调度器，支持普通参数和 desktop HTTP 跟踪器生成的 `Request`；请求正文只读副本，跟踪器照常工作。
- 用异步作用域把缓存处理限制到内置审核流；普通模型请求不解析正文，会话头插件继续独立工作。
- 在适配器完成序列化后，将 `FILTERED_HISTORY` 数组的每个顶层对象保留为独立 text block。所有块拼接后与原文本完全相同。
- 缓存工程上下文与当前最后一条历史；同一身份追加历史时，也保留上一轮已校验的前缀断点。待审动作和数组结束符留在末尾普通块中。
- 发送 `X-Magpie-Cache-Marks: client`，使用 Magpie 已有的客户端缓存标记能力，不修改 Magpie。
- 只在内存中保存最近 256 个身份的断点索引与 SHA-256，不保存历史正文；卸载时清空。
- 不改审核策略、角色、内容和顺序，不修改审查选项原对象，不重试请求，不改模型回复。
- 默认沿用适配器的缓存 TTL，缺省为 `ephemeral`（5 分钟）。

2026-11-03 经本机 Magpie 0.1.2838 → LiteLLM Haiku 的合成集成测试：首次写入 15,819 token；追加一条历史后读取 15,819 token，仅新增写入 34 token。1.1.0 的此项合成验证未覆盖 desktop 外层 HTTP 跟踪器。1.1.1 已补相同调用链的回归测试；本机 desktop 真实审核在 21:17:06 读取 166,894 token、写入 2,931 token、未缓存输入 3,874 token，读取占总输入约 96.08%。单笔结果不代表所有会话或账号的长期命中率。

## 回退到原审查

| 情况 | 行为 |
|---|---|
| 插件内部抛错（识别、解析、摘要任一环） | 吞掉，走 `next()` 派发原始请求 |
| 认不出是审查 | 走 `next()` |
| 拿不到发起者会话 | 仍可覆盖已配置的审查模型。也拿不到缓存身份且未配置模型时，沿用原请求。 |
| 旧形状请求已带 `sessionId` | 沿用原请求。新版带有审查标记的请求仍参与模型选择。 |
| 已由本插件改写并重新派发 | 跳过重复改写，继续使用已选模型。 |
| 配置的档位名不认识 | 启动时 warn，整插件不注入 |
| 拿不到 `llm` 服务 | 插件保持惰性 |

重新派发用的是 `ctx.llm.stream(newCall)`，**不是** `next(newOptions)`：cordis 的 `next` 在原始参数上闭包，传入的新参数会被静默丢弃。`next()` 靠 `cbs.shift()` 前进，任何路径都只能调用一次。

## 识别判据与顺序

两种请求都要满足 `temperature === 0`。`system` 必须以 `REVIEW_POLICY\n` 开头，且含固定句 `You are the final authorization reviewer for exactly one pending tool call.`。

- 新版请求带 `purpose: 'auto-review'`，可以有多条消息和 DSH 提供的 `sessionId`。
- 兼容旧版请求时，检查一条 `user` 消息中的单个文本块。正文以 `ENVIRONMENT\n` 开头，且含 `PROJECT_INSTRUCTIONS` 与 `PENDING_ACTION` 段。

```text
检查是否启用 → 排除已处理请求和主对话 → 验证审查标记和策略
             → 读取发起者会话 → 计算缓存身份 → 应用当前模型设置
```

`currentInitiator()` 每次都是真读 AsyncLocalStorage，所以放在确认是审查之后。另有一道独立护栏：`@deepseek-ai/dsh-llm` 导出的 `isAgentLoopRequest(options)`，它只标记 agent loop 的正常对话请求；拿不到这个导出时自动退化为上面的弱护栏。

会话身份直接读 DSH 自己的发起者作用域，不另建一套：

```js
ctx.get('agents')?.currentInitiator()?.session?.id
```

审查发生在 `tools/pre-execute` 的监听器里、`ctx.llm.stream` 之前，同一条 await 链，所以读到的就是发起这次工具调用的会话。服务被 dispose 后 `currentInitiator()` 会抛，读取必须包 `try`。

会话档按发起者会话区分缓存。同目录的会话也能独立。工作目录档在显式选择 `cwd` 时使用。发起者会话缺失时，已配置的模型仍可覆盖。在支持缓存键的接口上，可用请求自带的会话 ID 作为后备。

## OpenAI 审核路径

- `/v1/chat/completions` 识别 `system` 或 `developer` 中的策略。匹配旧版正文时，把历史拆分成消息并按缓存身份设置 `prompt_cache_key`。新版多消息沿用 DSH 生成的请求体。
- `/v1/responses` 从 `instructions` 识别策略，沿用原输入分段。有缓存身份时设置 `prompt_cache_key`。

## 已知限制

1. 缓存处理取决于接口和请求格式。固定模型的选择发生在发请求前，也支持新版多消息审查。
2. 审核模型需遵守内置判决协议。解析失败时由内置审核拒绝。
3. DSH 适配器会过滤 `onPayload`，因此缓存标记在发送请求时添加。
4. 缓存要求相同的前缀、兼容的缓存 TTL、有效期和上游缓存分区。切换账号、改写历史或过期仍可能未命中。
5. `scope: cwd` 用于对照实验。长期使用可选默认的会话档。
6. 保存模型设置后，下一笔审查读取新值。更新插件版本后，按宿主提示重载。

## 回退

把 `enabled` 设成 `false` 即可恢复内置审查的模型选择。

## 开发

使用 **Node.js 24**。先安装依赖，再运行检查。

```powershell
npm install --ignore-scripts
npm test
npm run check
```

等价的直接检查命令为：

```powershell
node --test --test-isolation=none test/*.test.mjs
node --check index.js
node --check client.js
```

离线测试覆盖新版审查使用当前设置的路由、设置保存后下一笔审查跟随新值、留空时保留原模型以及保持 `sessionId`。也覆盖旧版识别、缓存处理和卸载。桌面验收用当前 profile 的设置触发一次真实审查，再比对网关记录。

客户端部分不需要构建：`client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` 工厂函数，React 由 loader 注入，直接 `require('react')`。宿主部分（`index.js`）只读配置、挂 `llm/stream`，没有编译产物。

插件形态与发布后恢复远程安装的流程见 [DSH 插件开发经验](https://github.com/x-mug/dsh-plugins/blob/main/docs/PLUGIN-DEVELOPMENT.md)。
