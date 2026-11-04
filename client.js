// 设置页通过宿主共享表单读写审查模型。
window.__ModuleLoader__.load({
  id: '@x-mug/dsh-auto-review-cache-identity',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement
    const NS = 'local-auto-review-cache-identity'
    const dictionaries = {"en":{"meta":{"title":"Auto review cache identity","description":"Give built-in Auto review calls a stable prompt-cache identity, and optionally run them on a fixed model."},"title":"Auto review cache identity","subtitle":"Pin the model Auto review uses; leave empty to follow the main conversation.","provider":"Provider","model":"Model","followMain":"Follow main conversation","save":"Save","saved":"Saved","raw":"Raw details","readFailed":"Read failed: {message}","saveFailed":"Save failed: {message}","sectionTitle":"Auto review model","loading":"Loading configuration…","unavailable":"Configuration unavailable","readOnly":"Configuration is read-only","saving":"Saving…","saveRejected":"The host rejected the changes.","catalogRejected":"The host rejected the model catalog request."},"zh":{"meta":{"title":"Auto 审查缓存身份","description":"给内置 Auto 审查补稳定缓存身份，并可固定审查使用的模型。"},"title":"Auto 审查缓存身份","subtitle":"固定 Auto 审查使用的模型；留空则跟随主对话。","provider":"供应商","model":"模型","followMain":"跟随主对话","save":"保存","saved":"已保存","raw":"原始信息","readFailed":"读取失败：{message}","saveFailed":"保存失败：{message}","sectionTitle":"Auto 审查模型","loading":"正在读取配置…","unavailable":"配置不可用","readOnly":"配置为只读","saving":"正在保存…","saveRejected":"宿主拒绝了改动。","catalogRejected":"宿主拒绝了模型目录请求。"}}

    // 完整打印原始数据，不截断。
    const pretty = (value) => {
      try {
        return JSON.stringify(value, (key, item) => item instanceof Map ? Object.fromEntries(item) : item, 2)
      } catch {
        return String(value)
      }
    }

    const groupsOf = (catalog, rejected) => {
      if (catalog?.ok === false) throw new Error(catalog.error?.message ?? catalog.error ?? catalog.message ?? rejected)
      const data = catalog?.ok === true ? catalog.value : catalog
      const list = Array.isArray(data) ? data
        : data?.groups ?? data?.providers ?? data?.value?.groups ?? data?.value?.providers ?? []
      return (Array.isArray(list) ? list : []).map((group, index) => {
        const isText = typeof group === 'string'
        const id = isText ? group : group?.id ?? group?.provider ?? group?.name ?? `#${index}`
        return {
          id: String(id),
          name: String(isText ? group : group?.name ?? group?.label ?? id),
          models: (isText ? [] : group?.models ?? group?.children ?? []).map((model) => typeof model === 'string'
            ? { id: model, name: model }
            : { id: String(model?.id ?? model?.name ?? model), name: String(model?.name ?? model?.label ?? model?.id ?? model) })
        }
      })
    }

    const UNAVAILABLE = { status: 'unavailable', writable: false }
    const routeOf = (value) => ({
      reviewProvider: typeof value?.reviewProvider === 'string' ? value.reviewProvider : '',
      reviewModel: typeof value?.reviewModel === 'string' ? value.reviewModel : ''
    })
    const withFallback = (items, id) => id && !items.some((item) => item.id === id)
      ? [...items, { id, name: id }] : items

    const row = (label, control) => h('label', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
      h('span', { style: { width: '84px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' } }, label),
      control)

    // createElement 的包装必须把 children 转发出去，否则 option 全被吞掉。
    const select = (props, ...children) => h('select', props, ...children)

    // 原生弹层默认白底，选项要自己带主题色。
    const OPTION = { background: 'var(--dsw-alias-bg-l2, #1b1c1e)', color: 'var(--dsw-alias-label-primary, #f7f8f8)' }

    function Picker({ remote, form, t }) {
      const source = react.useMemo(() => ({
        subscribe: (listener) => form?.subscribe(listener) ?? (() => {}),
        getSnapshot: () => form?.getSnapshot() ?? UNAVAILABLE
      }), [form])
      const snapshot = react.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
      const [groups, setGroups] = react.useState([])
      const [draft, setDraft] = react.useState(null)
      const [status, setStatus] = react.useState('')
      const [catalogError, setCatalogError] = react.useState('')
      const [saving, setSaving] = react.useState(false)
      const pending = react.useRef(false)

      react.useEffect(() => {
        let live = true
        const load = async () => {
          try {
            const catalog = await remote.session.modelCatalog()
            const next = groupsOf(catalog, t('catalogRejected'))
            if (live) { setGroups(next); setCatalogError('') }
          } catch (error) {
            if (live) setCatalogError(t('readFailed', { message: error?.message ?? error }))
          }
        }
        load()
        return () => { live = false }
      }, [remote, t])

      const ready = snapshot.status === 'ready'
      const actual = routeOf(snapshot.value)
      const current = draft ?? { value: actual, revision: snapshot.revision }
      const editable = ready && snapshot.writable && !saving
      const canSave = editable && draft !== null && current.revision != null
      const placeholder = t(snapshot.status === 'loading' ? 'loading' : 'unavailable')
      const providers = ready ? withFallback(withFallback(groups, actual.reviewProvider), current.value.reviewProvider) : []
      let models = groups.find((group) => group.id === current.value.reviewProvider)?.models ?? []
      if (actual.reviewProvider === current.value.reviewProvider) models = withFallback(models, actual.reviewModel)
      models = ready ? withFallback(models, current.value.reviewModel) : []
      const change = (value) => {
        if (!editable || pending.current) return
        // 草稿保留开始编辑时的版本。
        setDraft({ value, revision: current.revision })
        setStatus('')
      }
      const save = async () => {
        if (!canSave || pending.current) return
        pending.current = true
        setSaving(true)
        setStatus('')
        try {
          const accepted = await form.mutate([
            { op: 'set', path: ['reviewProvider'], value: current.value.reviewProvider },
            { op: 'set', path: ['reviewModel'], value: current.value.reviewModel }
          ], current.revision)
          setStatus(accepted === true ? t('saved') : t('saveFailed', { message: t('saveRejected') }))
        } catch (error) {
          setStatus(t('saveFailed', { message: error?.message ?? error }))
        } finally {
          setDraft(null)
          setSaving(false)
          pending.current = false
        }
      }
      const hint = saving ? t('saving') : !ready ? placeholder : !snapshot.writable ? t('readOnly') : status

      const S = {
        card: { display: 'flex', flexDirection: 'column', gap: '14px', boxSizing: 'border-box', width: '100%', maxWidth: '100%', padding: '20px 24px',
          background: 'transparent', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))', borderRadius: '10px' },
        title: { margin: 0, fontSize: '16px', fontWeight: 600, letterSpacing: '-0.2px', color: 'var(--dsw-alias-label-primary, inherit)' },
        sub: { margin: 0, fontSize: '13px', lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        label: { width: '84px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, inherit)' },
        field: { width: '280px', boxSizing: 'border-box', height: '32px', padding: '0 8px', fontSize: '13px', color: 'inherit',
          background: 'var(--dsw-alias-bg-l1, rgba(127,127,127,0.08))', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.3))',
          borderRadius: '6px', outline: 'none' },
        button: { height: '32px', padding: '0 14px', fontSize: '13px', fontWeight: 500, color: '#ffffff',
          background: '#5e6ad2', border: '1px solid #5e69d1', borderRadius: '6px', cursor: 'pointer' },
        status: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        details: { marginTop: '2px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))' },
        summary: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))' },
        pre: { margin: '10px 0 0', padding: '12px', maxHeight: '320px', overflow: 'auto', fontSize: '11px',
          lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-secondary, rgba(127,127,127,0.9))',
          background: 'rgba(127,127,127,0.08)', border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.22))', borderRadius: '8px' }
      }

      return h('div', { style: S.card },
        h('h3', { style: S.title }, t('sectionTitle')),
        h('p', { style: S.sub }, t('subtitle')),
        row(t('provider'), select({
          style: S.field,
          disabled: !editable,
          value: ready ? current.value.reviewProvider : '',
          onChange: (event) => change({ reviewProvider: event.target.value, reviewModel: '' })
        }, h('option', { value: '', style: OPTION }, ready ? t('followMain') : placeholder),
          providers.map((group) => h('option', { key: group.id, value: group.id, style: OPTION }, group.name ?? group.id)))),
        row(t('model'), select({
          style: S.field,
          disabled: !editable,
          value: ready ? current.value.reviewModel : '',
          onChange: (event) => change({ ...current.value, reviewModel: event.target.value })
        }, h('option', { value: '', style: OPTION }, ready ? t('followMain') : placeholder),
          models.map((model) => h('option', { key: model.id, value: model.id, style: OPTION }, model.name ?? model.id)))),
        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', paddingTop: '2px' } },
          h('button', {
            type: 'button',
            style: canSave ? S.button : { ...S.button, opacity: 0.5, cursor: 'not-allowed' },
            disabled: !canSave,
            onClick: save
          }, t('save')),
          h('span', { style: S.status, role: 'status' }, hint)),
        status && status !== hint && h('p', { style: S.status, role: 'status' }, status),
        catalogError && h('p', { style: S.status, role: 'alert' }, catalogError),
        h('details', { style: S.details },
          h('summary', { style: S.summary }, t('raw')),
          h('pre', { style: S.pre }, pretty(snapshot))))
    }

    const inject = ['slots', 'locale', 'remote', 'remote.session', 'configForms']

    function apply(ctx) {
      ctx.effect(() => {
        try { ctx.locale.register('@x-mug/dsh-auto-review-cache-identity', dictionaries) } catch {}
      });
      const t = ctx.locale.bind('@x-mug/dsh-auto-review-cache-identity');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'auto-review-cache-identity',
        order: 60,
        label: () => t('sectionTitle'),
        inject: () => ({ remote: ctx.remote, form: ctx.configForms.get(NS), t })
      }, Picker), 'auto-review-cache-identity: settings section')
    }

    return { apply, inject }
  }
})
