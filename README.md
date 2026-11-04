# Auto 审查缓存身份（@x-mug/dsh-auto-review-cache-identity）

给内置 Auto 审查（`@deepseek-ai/dsh-experimental-auto-review`）的模型调用补一个稳定的缓存身份，让审查请求的 prompt 前缀能跨调用复用；同时可以在设置页里给审查单独指定一个模型。

版本 **1.2.0**，插件包名为 `@x-mug/dsh-auto-review-cache-identity`。兼容基线为 **DeepSeek Harness Desktop 0.2.1-rc.5 / Cordis 4.0.5**。插件依赖 DSH 内部的服务钩子与客户端槽位，其他版本需要重新验证。

## 为什么需要它

Auto 预设下每个工具调用都要先过一次 LLM 审查。审查请求由 `classifyRisk` 构造，只有 `provider / model / system / messages / temperature / signal`，**没有 sessionId**。

缺少会话身份会影响网关的请求归组与路由。对 Anthropic 而言，还需要稳定的内容块边界和显式 `cache_control`；身份本身不能替代缓存断点。

本插件在 `llm/stream` 上补稳定的 `sessionId`。会话头插件使用这个身份；pi-ai 是否发送 `prompt_cache_key` 由所选 API 与兼容配置决定。原生 Anthropic 审核请求在发送前再补历史缓存断点。

## 功能

- **稳定身份**：`"auto-review:" + sha256(会话 id)[:32]`，原始会话 id 不出现在请求里。
- **可选固定审查模型**：设置页里选供应商与模型；留空跟随主对话。
- **Anthropic 历史缓存**：按历史条目分块，保留前一轮与当前轮的显式断点；完整文本、角色和顺序不变，待审动作不打标。
- **异常回退原请求**：插件失败时仍执行原有审核，不改变审核的拒绝行为。
- **设置页**：导出 schemastery `Config` 后自动生成表单；另有一个自定义分区「Auto 审查模型」，用实时模型目录做下拉。

## 安装

在 DSH 的「插件 → 添加插件 → 安装第三方插件」中输入：

```text
github:x-mug/dsh-auto-review-cache-identity
```

本仓库根目录就是插件包；也可使用本机源码目录，或使用已发布版本的 Release 压缩包。安装后按提示重启或重载，并在设置页确认「Auto 审查模型」分区。固定版本可在版本 tag 发布后使用 `github:x-mug/dsh-auto-review-cache-identity#v<版本>`。升级时先移除旧版本，再安装新版本。变更记录见 [CHANGELOG.md](./CHANGELOG.md)。

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
| `scope` | `session` | `session`：键 = `sha256(会话 id)`，读不到会话则本次不注入；`cwd`：键 = `sha256(cwd)`，完全不读发起者作用域，只用于 A/B 对照。 |
| `reviewProvider` | 空 | 审查固定使用的供应商 id，空 = 跟随主对话。 |
| `reviewModel` | 空 | 审查固定使用的模型 id，空 = 跟随主对话。 |

`reviewProvider` / `reviewModel` 两个字符串都非空才会覆盖路由；只填一个等于没填。

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

自定义分区下方有「原始信息」，展开可查看宿主提供的表单状态。宿主没有注册表单、配置不可读或不可写时，下拉和保存按钮会禁用，不把读取失败伪装成「跟随主对话」。

## Anthropic 缓存断点

审核供应商需选择原生 `anthropic-messages` 通道，例如本机 `magpie-anthropic`。Chat Completions 和 Responses 请求不经过此正文改写。

- 使用独立的异步 fetch 调度器，支持普通参数和 desktop HTTP 跟踪器生成的 `Request`；请求正文只读副本，跟踪器照常工作。
- 用异步作用域把缓存处理限制到内置审核流；普通模型请求不解析正文，会话头插件继续独立工作。
- 在适配器完成序列化后，将 `FILTERED_HISTORY` 数组的每个顶层对象保留为独立 text block。所有块拼接后与原文本完全相同。
- 缓存工程上下文与当前最后一条历史；同一身份追加历史时，也保留上一轮已校验的前缀断点。待审动作和数组结束符留在末尾普通块中。
- 发送 `X-Magpie-Cache-Marks: client`，使用 Magpie 已有的客户端缓存标记能力，不修改 Magpie。
- 只在内存中保存最近 256 个身份的断点索引与 SHA-256，不保存历史正文；卸载时清空。
- 不改审核策略、角色、内容和顺序，不修改审查选项原对象，不重试请求，不改模型回复。
- 默认沿用适配器的缓存 TTL，缺省为 `ephemeral`（5 分钟）。

2026-11-03 经本机 Magpie 0.1.2838 → LiteLLM Haiku 的合成集成测试：首次写入 15,819 token；追加一条历史后读取 15,819 token，仅新增写入 34 token。1.1.0 的此项合成验证未覆盖 desktop 外层 HTTP 跟踪器。1.1.1 已补相同调用链的回归测试；本机 desktop 真实审核在 21:17:06 读取 166,894 token、写入 2,931 token、未缓存输入 3,874 token，读取占总输入约 96.08%。单笔结果不代表所有会话或账号的长期命中率。

## 失败即放行

| 情况 | 行为 |
|---|---|
| 插件内部抛错（识别、解析、摘要任一环） | 吞掉，走 `next()` 派发原始请求 |
| 认不出是审查 | 走 `next()` |
| 拿不到发起者会话 | 不注入，走 `next()`（计数并在日志里说明一次） |
| `agents` 服务缺失、被 dispose、不在发起者作用域内 | 同上 |
| 已有 `sessionId`（另一个实例注入过） | 不再改写 |
| 配置的档位名不认识 | 启动时 warn，整插件不注入 |
| 拿不到 `llm` 服务 | 插件保持惰性 |

重新派发用的是 `ctx.llm.stream(newCall)`，**不是** `next(newOptions)`：cordis 的 `next` 在原始参数上闭包，传入的新参数会被静默丢弃。`next()` 靠 `cbs.shift()` 前进，任何路径都只能调用一次。

## 识别判据与顺序

必须同时满足，任何一条不满足都不算审查：

1. `temperature === 0`
2. `system` 以 `REVIEW_POLICY\n` 开头，且含固定句
   `You are the final authorization reviewer for exactly one pending tool call.`
3. `messages` 恰好 1 条，role 为 `user`
4. 该消息恰好 1 个 `type: "text"` 块
5. 正文以 `ENVIRONMENT\n\n` 开头，且含 `\n\nPROJECT_INSTRUCTIONS\n\n` 与 `\n\nPENDING_ACTION\n\n`

主对话、压缩（`purpose: "compaction"`）、标题（`purpose: "session-title"`）、subagent、以及 approve-for-me 自己的审查（`>>> APPROVAL REQUEST START`，system 不同）都不满足 2-5。

判定顺序是为了让热路径不付钱：

```text
enabled → options.sessionId 已存在 → OWN_CALLS → isAgentLoopRequest → isReview
        → 这时才 currentInitiator() → resolveIdentity → reviewRoute
```

`currentInitiator()` 每次都是真读 AsyncLocalStorage，所以放在确认是审查之后。另有一道独立护栏：`@deepseek-ai/dsh-llm` 导出的 `isAgentLoopRequest(options)`，它只标记 agent loop 的正常对话请求；拿不到这个导出时自动退化为上面的弱护栏。

会话身份直接读 DSH 自己的发起者作用域，不另建一套：

```js
ctx.get('agents')?.currentInitiator()?.session?.id
```

审查发生在 `tools/pre-execute` 的监听器里、`ctx.llm.stream` 之前，同一条 await 链，所以读到的就是发起这次工具调用的会话。服务被 dispose 后 `currentInitiator()` 会抛，读取必须包 `try`。

**读不到会话就不注入，原样放过。** 不退回 cwd：同一目录下几十个互不相干的会话和子代理会塌成同一个身份，把几十条审查链塞进一条缓存，还让它们长期共用一个账号——"稳定地错"比"没有"危险，而且从日志和命中率上都看不出来。

## OpenAI 审核路径

`/v1/chat/completions` 与 `/v1/responses` 的审核请求同样改写：按历史条目拆成多条消息，稳定头部单独成段，待审动作留在末尾，并补 `prompt_cache_key` 固定缓存分区。策略消息既可能是 `system` 也可能是 `developer`，两种都识别。

## 已知限制

1. 缓存断点只作用于本插件识别的原生 Anthropic 审核流；不接管普通对话和其他 API。
2. 审核模型仍须遵守内置判决协议，解析失败由内置审核拒绝；本插件不降低审核要求。
3. `onPayload` 会被当前 DSH 适配器的选项白名单丢弃，因此缓存标记在最终 fetch 请求上添加。
4. 缓存要求相同的前缀、兼容的缓存 TTL、有效期和上游缓存分区；切换账号、改写历史或过期仍可能未命中。
5. `scope: cwd` 仅用于对照实验；长期使用应按会话区分身份。
6. 设置页的 volatile 配置实时生效；代码和包版本的加载状态以 desktop 实际重载结果为准。

## 回退

把 `enabled` 设成 `false`，或从 `dsh.profile.bundles` 里移除后重启。两种回退都不影响已经保存的设置值。

## 开发

需要 **Node.js 24**，核心测试不需要第三方依赖，无需执行 `npm install`：

```powershell
npm test
npm run check
```

等价的直接命令为：

```powershell
node --test --test-isolation=none test/*.test.mjs
node --check index.js
node --check client.js
```

离线测试用迷你 cordis 复刻 waterfall 语义、真实 AsyncLocalStorage 模拟发起者作用域，覆盖审查识别、身份推导、并发不串号、volatile 配置解引用、运行期改设置、失败放行、卸载恢复，覆盖缓存前缀、并发身份和共享钩子的回归项。自动化测试不代表真实 GUI 验收；设置分区、下拉框和保存按钮还需要在应用里点一遍。

客户端部分不需要构建：`client.js` 是手写的 `window.__ModuleLoader__.load({ id, factory })` 工厂函数，React 由 loader 注入，直接 `require('react')`。宿主部分（`index.js`）只读配置、挂 `llm/stream`，没有编译产物。

插件形态、配置读取、`llm/stream` 拦截、设置分区等通用注意事项见 [DSH 插件开发经验](../../docs/PLUGIN-DEVELOPMENT.md)。
