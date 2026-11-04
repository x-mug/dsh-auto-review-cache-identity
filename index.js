/** 为内置审核补稳定身份，并保留原生 Anthropic 请求的历史缓存边界。 */
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

/** Cordis 插件名，bundle patch 用同一个 id 挂载。 */
export const name = 'auto-review-cache-identity'

/** 没有硬依赖：agents / llm / settings 都按可选服务访问。 */
export const inject = []

/** 表单依赖随插件安装，加载失败时由宿主报告原始错误。 */
export const Config = await configSchema()

/** 配置表单使用插件自己的必装依赖。 */
async function loadSchemastery() { return Schema }

/** 声明设置页字段，并保留可注入的离线验证入口。 */
async function configSchema(load = loadSchemastery) {
  const z = await load()
  return z.object({
    enabled: z.boolean().default(true).volatile().description('给 Auto 审查补稳定缓存身份'),
    scope: z.union(['session', 'cwd']).default('session').volatile().description('缓存身份按会话还是按工作目录'),
    reviewProvider: z.string().default('').volatile().description('Auto 审查固定使用的供应商，留空跟随主对话'),
    reviewModel: z.string().default('').volatile().description('Auto 审查固定使用的模型 id，留空跟随主对话')
  })
}

/** 审查策略的固定首行。 */
const POLICY_HEAD = 'REVIEW_POLICY\n'
/** 审查策略的固定句，确认首行不是别家的同名前缀。 */
const POLICY_MARK = 'You are the final authorization reviewer for exactly one pending tool call.'
/** 审查正文的环境段开头。 */
const ENVIRONMENT_HEAD = 'ENVIRONMENT\n\n'
/** 审查正文的工程指令段分隔符。 */
const PROJECT_SECTION = '\n\nPROJECT_INSTRUCTIONS\n\n'
/** 审查正文的待审动作段分隔符。 */
const ACTION_SECTION = '\n\nPENDING_ACTION\n\n'
/** 注入键的命名空间，避免和真实会话 id 撞车。 */
const KEY_PREFIX = 'auto-review:'
/** 摘要截断长度，加上命名空间仍远低于后端 64 字符上限。 */
const HASH_LENGTH = 32
/** 本插件自己造的调用，重新派发时直接放过。 */
const OWN_CALLS = new WeakSet()

// dsh-llm 会标记 agent loop 的正常对话请求，这条判据能把主对话整类排除。
let isAgentLoopRequest
try {
  const llm = await import('@deepseek-ai/dsh-llm')
  isAgentLoopRequest = typeof llm.isAgentLoopRequest === 'function' ? llm.isAgentLoopRequest : undefined
} catch {
  isAgentLoopRequest = undefined
}

// 异步调度器保留外层跟踪器，并等待审核请求副本的读取。
const FETCH_DISPATCHER = Symbol.for('auto-review-cache-identity#fetch-dispatcher@1')

/** 历史条目的块边界不会随下一条追加而变化。 */
function reviewBlocks(text) {
  const marker = '\n\nFILTERED_HISTORY\n\n'
  const start = text.indexOf(marker) + marker.length
  const action = text.lastIndexOf(ACTION_SECTION)
  if (start < marker.length || action < start) return undefined
  const raw = text.slice(start, action)
  const history = JSON.parse(raw)
  if (!Array.isArray(history) || history.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) return undefined
  const ends = []
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') {
      depth -= 1
      if (ch === '}' && depth === 1) ends.push(start + i + 1)
    }
  }
  if (ends.length !== history.length) return undefined
  const blocks = [text.slice(0, start + 1)]
  let from = start + 1
  for (const end of ends) {
    blocks.push(text.slice(from, end))
    from = end
  }
  blocks.push(text.slice(from))
  return blocks
}

/** 缓存工程上下文和最后一条历史，待审动作保持为普通用户内容。 */
function rewriteAnthropicBody(body) {
  if (body === null || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length !== 1) return undefined
  const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(block => block.text ?? '').join('\n') : undefined
  if (typeof system !== 'string' || !system.includes(POLICY_HEAD) || !system.includes(POLICY_MARK)) return undefined
  const message = body.messages[0]
  if (message?.role !== 'user') return undefined
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') return undefined
  const block = content[0]
  if (typeof block.text !== 'string' || !block.text.startsWith(ENVIRONMENT_HEAD) || !block.text.includes(PROJECT_SECTION)) return undefined
  const texts = reviewBlocks(block.text)
  if (texts === undefined) return undefined
  const { cache_control: cacheControl = { type: 'ephemeral' }, ...plain } = block
  const blocks = texts.map(text => ({ ...plain, text }))
  blocks[0].cache_control = cacheControl
  if (blocks.length > 2) blocks[blocks.length - 2].cache_control = cacheControl
  return { ...body, messages: [{ ...message, content: blocks }] }
}

/** 只改写发往 Messages 端点的审核 JSON，其他流量不解析正文。 */
function rewriteAnthropicFetch(input, init, checkpoints, contextIdentity) {
  try {
    if (typeof init?.body !== 'string') return undefined
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
    if (new URL(raw).pathname !== '/v1/messages') return undefined
    const body = rewriteAnthropicBody(JSON.parse(init.body))
    if (body === undefined) return undefined
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const identity = contextIdentity ?? headers.get('x-session-id') ?? body.metadata?.user_id
    if (checkpoints !== undefined && typeof identity === 'string' && identity !== '') {
      const key = body.model + ':' + identity
      const blocks = body.messages[0].content
      const last = blocks.length - 2
      const previous = checkpoints.get(key)
      const prefixHash = index => {
        const hash = createHash('sha256').update(JSON.stringify(body.system))
        for (let i = 0; i <= index; i += 1) hash.update(blocks[i].text)
        return hash.digest('hex')
      }
      if (previous !== undefined && previous.index > 0 && previous.index < last && prefixHash(previous.index) === previous.hash) {
        blocks[previous.index].cache_control = blocks[last].cache_control
        const systemMarks = Array.isArray(body.system) ? body.system.filter(block => block.cache_control !== undefined).length : 0
        if (systemMarks + blocks.filter(block => block.cache_control !== undefined).length > 4) delete blocks[0].cache_control
      }
      checkpoints.delete(key)
      checkpoints.set(key, { index: last, hash: prefixHash(last) })
      if (checkpoints.size > 256) checkpoints.delete(checkpoints.keys().next().value)
    }
    headers.set('X-Magpie-Cache-Marks', 'client')
    headers.delete('content-length')
    return { init: { ...init, headers, body: JSON.stringify(body) } }
  } catch {
    return undefined
  }
}

/** HTTP 跟踪器会合并参数，正文只读取 Request 的副本。 */
async function rewriteAnthropicRequest(input, init, checkpoints, identity) {
  try {
    if (typeof init?.body === 'string') return rewriteAnthropicFetch(input, init, checkpoints, identity)
    if (!(input instanceof Request) || init?.body !== undefined || input.bodyUsed) return undefined
    if (new URL(input.url).pathname !== '/v1/messages') return undefined
    if (init?.signal?.aborted || input.signal.aborted) return undefined
    const body = await input.clone().text()
    return rewriteAnthropicFetch(input, { ...init, body }, checkpoints, identity)
  } catch {
    return undefined
  }
}

/** 多个实例共用异步入口，外层仍引用时保留空调度器。 */
function registerFetchHook(id, hook) {
  let registry = globalThis[FETCH_DISPATCHER]
  if (registry === undefined) {
    const original = globalThis.fetch
    const hooks = new Map()
    const dispatcher = async (input, init) => {
      let currentInput = input
      let currentInit = init
      for (const registered of hooks.values()) {
        let next
        try {
          next = await registered(currentInput, currentInit)
        } catch {
          continue
        }
        if (next !== null && typeof next === 'object') {
          if ('input' in next) currentInput = next.input
          if ('init' in next) currentInit = next.init
        }
      }
      return Reflect.apply(original, globalThis, [currentInput, currentInit])
    }
    registry = { original, dispatcher, hooks }
    globalThis[FETCH_DISPATCHER] = registry
    globalThis.fetch = dispatcher
  }
  registry.hooks.set(id, hook)
  return () => {
    registry.hooks.delete(id)
    if (registry.hooks.size === 0 && globalThis.fetch === registry.dispatcher) {
      globalThis.fetch = registry.original
      delete globalThis[FETCH_DISPATCHER]
    }
  }
}

/** 审核流的每次推进和取消都携带同一身份。 */
function reviewStreamScope(stream, storage, identity) {
  const context = { identity }
  const iterator = storage.run(context, () => stream[Symbol.asyncIterator]())
  return {
    [Symbol.asyncIterator]() { return this },
    next(value) { return storage.run(context, () => iterator.next(value)) },
    return(value) { return storage.run(context, () => iterator.return?.(value) ?? Promise.resolve({ value, done: true })) },
    throw(error) { return storage.run(context, () => iterator.throw?.(error) ?? Promise.reject(error)) }
  }
}

/**
 * 读当前执行上下文里的发起会话。
 *
 * 服务被 dispose 后 currentInitiator 会抛，这里按"拿不到"处理。
 *
 * @param ctx - Cordis 插件上下文。
 * @returns 会话 id，不在任何发起者作用域内时为 undefined。
 */
function currentSessionId(ctx) {
  try {
    const sessionId = ctx.get('agents')?.currentInitiator()?.session?.id
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
  } catch {
    return undefined
  }
}

/**
 * 判断一次 llm 调用是不是 Auto 审查。
 *
 * @param options - waterfall 上拿到的原始请求。
 * @returns 是否命中审查特征。
 */
function isReview(options) {
  if (options === null || typeof options !== 'object') return false
  if (options.temperature !== 0) return false
  const system = options.system
  if (typeof system !== 'string') return false
  if (!system.startsWith(POLICY_HEAD) || !system.includes(POLICY_MARK)) return false
  const messages = options.messages
  if (!Array.isArray(messages) || messages.length !== 1) return false
  const message = messages[0]
  if (message === null || typeof message !== 'object' || message.role !== 'user') return false
  const content = message.content
  if (!Array.isArray(content) || content.length !== 1) return false
  const block = content[0]
  if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return false
  const text = block.text
  return text.startsWith(ENVIRONMENT_HEAD) && text.includes(PROJECT_SECTION) && text.includes(ACTION_SECTION)
}

/**
 * 读审查正文的唯一文本块。
 *
 * @param options - 已判定为审查的请求。
 * @returns 拼好的四段正文。
 */
function reviewText(options) {
  return options.messages[0].content[0].text
}

/**
 * 从环境段读出工作目录。
 *
 * @param text - 审查正文。
 * @returns 工作目录，段缺失或不是合法 JSON 时为 undefined。
 */
function reviewCwd(text) {
  const body = text.slice(ENVIRONMENT_HEAD.length)
  const end = body.indexOf(PROJECT_SECTION)
  if (end < 0) return undefined
  let value
  try {
    value = JSON.parse(body.slice(0, end))
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  return typeof value.cwd === 'string' && value.cwd !== '' ? value.cwd : undefined
}

/**
 * 把一段作用域文本压成定长摘要。
 *
 * @param text - 作用域文本。
 * @returns 十六进制摘要。
 */
function digest(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, HASH_LENGTH)
}

/** 作用域档位：决定哪些审查共用同一条缓存。 */
const SCOPES = {
  // 只认发起者会话，读不到就不注入，不退回 cwd。
  session: (options, sessionKey) => sessionKey,
  // 工作目录档，只给 A/B 显式用。
  cwd: (options) => reviewCwd(reviewText(options))
}

/**
 * 算出审查的稳定缓存身份。
 *
 * 加一档新作用域只需在这里加一个读函数，调用方不用改。
 *
 * @param options - 已判定为审查的请求。
 * @param scope - 设置里的档位名。
 * @param sessionKey - 当前执行上下文里的会话 id。
 * @returns 身份键，档位未知或作用域为空时为 undefined。
 */
function resolveIdentity(options, scope, sessionKey) {
  const read = SCOPES[scope]
  if (read === undefined) return undefined
  const value = read(options, sessionKey)
  if (value === undefined) return undefined
  return KEY_PREFIX + digest(value)
}

/**
 * 换入稳定身份，只加 sessionId。
 *
 * dsh-llm-pi-ai 把这一个字段翻成 pi-ai 的 sessionId，
 * 再由 pi-ai 写到 prompt_cache_key；其它字段逐字节带走。
 *
 * @param options - 原始审查请求。
 * @param identity - 稳定身份键。
 * @param override - 审查固定路由，未配置时为 undefined。
 * @returns 冻结的新请求。
 */
function rewrite(options, identity, override) {
  const next = { ...options }
  if (identity !== undefined) next.sessionId = identity
  if (override !== undefined) {
    next.provider = override.provider
    next.model = override.model
  }
  return Object.freeze(next)
}

/**
 * 决定这次调用要不要改写。
 *
 * 廉价判据先跑，确认是审查之后才去读会话身份。
 *
 * @param options - waterfall 上拿到的原始请求。
 * @param settings - 已解析的设置。
 * @param readSessionKey - 取会话 id 的函数，只在确认是审查后调用。
 * @returns 改写后的新请求，不动时为 undefined。
 */
function plan(options, settings, readSessionKey) {
  if (settings.enabled !== true) return undefined
  if (options === null || typeof options !== 'object') return undefined
  // 主闸：注入成功后 sessionId 非空，二次进入必然不再匹配。
  if (options.sessionId !== undefined) return undefined
  if (OWN_CALLS.has(options)) return undefined
  if (isAgentLoopRequest?.(options) === true) return undefined
  if (!isReview(options)) return undefined
  const sessionKey = settings.scope === 'session' ? readSessionKey() : undefined
  const identity = resolveIdentity(options, settings.scope, sessionKey)
  const override = reviewRoute(settings)
  if (identity === undefined && override === undefined) return undefined
  return rewrite(options, identity, override)
}

/**
 * 读设置，缺项落回默认值。
 *
 * @param config - bundle patch 送进来的配置。
 * @returns 冻结的设置快照。
 */
function settingsOf(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return Object.freeze({
    enabled: plain(source.enabled) !== false,
    scope: typeof plain(source.scope) === 'string' && plain(source.scope) !== '' ? plain(source.scope) : 'session',
    log: plain(source.log) === true,
    // 诊断用：设成文件路径后，每次注入追加一行 JSON。默认配置不带它。
    trace: typeof plain(source.trace) === 'string' && plain(source.trace) !== '' ? plain(source.trace) : undefined,
    // 审查固定路由；设置页写的是扁平两字段，也兼容嵌在 review 段里的写法。
    review: routeOf({ provider: plain(source.reviewProvider), model: plain(source.reviewModel) }) ?? routeOf(source.review)
  })
}

/**
 * 取出可变配置的真值。
 *
 * volatile 字段传进来是 cosmokit 引用，必须解引用才拿得到值。
 *
 * @param value - 配置原始值。
 * @returns 解引用后的值。
 */
function plain(value) {
  return value !== null && typeof value === 'object' && Symbol.for('cosmokit.volatile.write') in value ? value.get() : value
}

/**
 * 校验一次路由覆盖，两个字段都非空才算数。
 *
 * @param value - 配置里的 review 段。
 * @returns 冻结的 provider/model，字段不全时为 undefined。
 */
function routeOf(value) {
  if (value === null || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' && value.provider !== '' ? value.provider : undefined
  const model = typeof value.model === 'string' && value.model !== '' ? value.model : undefined
  return provider === undefined || model === undefined ? undefined : Object.freeze({ provider, model })
}

/**
 * 审查当前的固定路由。
 *
 * @param settings - 已解析的设置。
 * @returns 冻结的 provider/model，未配置时为 undefined。
 */
function reviewRoute(settings) {
  return settings.review
}

/**
 * 挂到 llm/stream 上，只动审查请求。
 *
 * @param ctx - Cordis 插件上下文。
 * @param config - bundle patch 送进来的配置。
 */
export function apply(ctx, config) {
  // 设置页改值走运行期写引用，不重启也不重新 apply，必须每次现读。
  const readSettings = () => settingsOf(config)
  const initial = readSettings()
  if (initial.trace !== undefined) {
    try {
      appendFileSync(initial.trace, JSON.stringify({ at: new Date().toISOString(), event: 'mounted', transport: 'async-fetch' }) + '\n')
    } catch {}
  }
  if (SCOPES[initial.scope] === undefined) {
    ctx.logger?.warn(`[auto-review-cache-identity] unknown scope "${initial.scope}"; injection stays off`)
    return
  }
  ctx.logger?.info(`[auto-review-cache-identity] mounted (enabled=${initial.enabled}, scope=${initial.scope}, review=${initial.review === undefined ? 'inherit' : `${initial.review.provider}/${initial.review.model}`}, form=${Config === undefined ? 'off' : 'on'})`)

  let injected = 0
  let identityMisses = 0
  let identityMissLogged = false
  const noteIdentityMiss = () => {
    identityMisses += 1
    if (identityMissLogged) return
    identityMissLogged = true
    ctx.logger?.warn('[auto-review-cache-identity] Auto review has no initiator session; this call was left untouched')
  }

  const declareSettings = (scope) => {
    try {
      // 声明本插件参与自动配置表单；同一个 fiber 只能声明一次。
      scope.effect(() => scope.settings.configure({}, scope.fiber))
    } catch {
      // 没有设置表单的宿主照常工作。
    }
  }
  try {
    if (ctx.get('settings') !== undefined) declareSettings(ctx)
    else ctx.inject(['settings'], declareSettings)
  } catch {
    // 设置表单是可选项，取不到就算了。
  }

  ctx.inject(['llm'], (scope) => {
    const hookId = 'auto-review-cache-identity#anthropic-breakpoint#' + randomUUID()
    const checkpoints = new Map()
    const reviewContext = new AsyncLocalStorage()
    const disposeFetch = registerFetchHook(hookId, async (input, init) => {
      const context = reviewContext.getStore()
      if (context === undefined) return undefined
      const settings = readSettings()
      if (!settings.enabled) return undefined
      const result = await rewriteAnthropicRequest(input, init, checkpoints, context.identity)
      if (result !== undefined && settings.trace !== undefined) {
        try {
          const content = JSON.parse(result.init.body).messages[0].content
          appendFileSync(settings.trace, JSON.stringify({ at: new Date().toISOString(), event: 'anthropic-cache', transport: input instanceof Request ? 'request' : 'init', blocks: content.length, marks: content.filter(block => block.cache_control !== undefined).length }) + '\n')
        } catch {}
      }
      return result
    })
    scope.effect(() => () => {
      disposeFetch()
      checkpoints.clear()
      reviewContext.disable()
    })
    // 处理器必须同步返回流：返回 Promise 会让调用方直接 TypeError。
    scope.on('llm/stream', (options, next) => {
      // 只有确认是审查才去读发起者会话，主对话、压缩、标题不付这个开销。
      let asked = false
      let sessionKey
      const readSessionKey = () => {
        asked = true
        sessionKey = currentSessionId(ctx)
        return sessionKey
      }
      let call
      let settings
      try {
        settings = readSettings()
        call = plan(options, settings, readSessionKey)
      } catch {
        call = undefined
      }
      if (call === undefined) {
        if (asked && sessionKey === undefined) noteIdentityMiss()
        return next()
      }
      OWN_CALLS.add(call)
      // next() 靠 cbs.shift() 前进，任何路径都只能调一次；重放会跳过后续监听器。
      let stream
      try {
        stream = reviewStreamScope(scope.llm.stream(call), reviewContext, call.sessionId)
      } catch {
        return next()
      }
      injected += 1
      if (settings?.trace !== undefined) {
        try {
          appendFileSync(settings.trace, `${JSON.stringify({
            at: new Date().toISOString(),
            key: call.sessionId,
            provider: call.provider,
            model: call.model
          })}\n`)
        } catch {
          // 诊断写入失败不影响审查。
        }
      }
      if (settings?.log) {
        ctx.logger?.info(`[auto-review-cache-identity] injected=${injected} key=${call.sessionId} identityMisses=${identityMisses}`)
      }
      return stream
    }, { global: true, prepend: true })
  })
}

/** 离线验证复用协议解析与拦截入口。 */
export const _internal = { isReview, reviewText, reviewCwd, resolveIdentity, rewrite, plan, currentSessionId, routeOf, reviewRoute, settingsOf, SCOPES, loadSchemastery, configSchema, reviewBlocks, rewriteAnthropicBody, rewriteAnthropicFetch, rewriteAnthropicRequest, registerFetchHook, reviewStreamScope }
