import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const locale = Object.fromEntries(['en', 'zh'].map((lang) => [lang,
  JSON.parse(readFileSync(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'))]))
const NS = 'local-auto-review-cache-identity'
const route = (reviewProvider, reviewModel) => ({ reviewProvider, reviewModel })
const ready = (value, revision = 'revision-1', writable = true, extra = {}) => ({
  status: 'ready', value, revision, writable, base: {}, user: {}, ...extra
})

function makeForm(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    calls: [],
    getSnapshot() { return snapshot },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    update(next) { snapshot = next; for (const listener of listeners) listener() },
    async mutate(ops, revision) { this.calls.push({ ops, revision }); return true },
    get listenerCount() { return listeners.size }
  }
}

function sameDeps(left, right) {
  return left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
}

function makeRenderer() {
  const hooks = []
  let index = 0
  let effects = []
  let component, props, tree, scheduled = false, disposed = false
  const commit = () => {
    index = 0
    effects = []
    tree = component(props)
    for (const effect of effects) effect()
    return tree
  }
  const schedule = () => {
    if (scheduled || disposed || !component) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!disposed) commit()
    })
  }
  const react = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity) } },
    useState(initial) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], (value) => {
        const next = typeof value === 'function' ? value(hooks[slot]) : value
        if (!Object.is(next, hooks[slot])) { hooks[slot] = next; schedule() }
      }]
    },
    useRef(initial) {
      const slot = index++
      if (!(slot in hooks)) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useMemo(factory, deps) {
      const slot = index++
      if (!hooks[slot] || !sameDeps(hooks[slot].deps, deps)) hooks[slot] = { deps, value: factory() }
      return hooks[slot].value
    },
    useEffect(effect, deps) {
      const slot = index++
      if (!hooks[slot] || !sameDeps(hooks[slot].deps, deps)) effects.push(() => {
        hooks[slot]?.cleanup?.()
        hooks[slot] = { deps, cleanup: effect() }
      })
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const [, setVersion] = react.useState(0)
      react.useEffect(() => subscribe(() => setVersion((value) => value + 1)), [subscribe])
      return getSnapshot()
    }
  }
  return {
    react,
    render(nextComponent, nextProps) { component = nextComponent; props = nextProps; return commit() },
    current() { return tree },
    unmount() { disposed = true; for (const hook of hooks) hook?.cleanup?.() }
  }
}

function setup({ form, catalog = { ok: true, value: { groups: [] } } } = {}) {
  const renderer = makeRenderer()
  let plugin
  let registration
  let registeredDictionaries
  const context = {
    window: { __ModuleLoader__: { load(module) { plugin = module.factory((name) => {
      assert.equal(name, 'react')
      return renderer.react
    }) } } }
  }
  vm.runInNewContext(client, context, { filename: 'client.js' })
  const remote = { session: { modelCatalog: async () => catalog } }
  plugin.apply({
    remote,
    configForms: { get(id) { assert.equal(id, NS); return form } },
    locale: {
      register(id, dictionaries) { registeredDictionaries = dictionaries },
      bind() { return (key, args = {}) => Object.entries(args).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)), locale.en[key]) }
    },
    effect(callback) { callback() },
    slots: { inject(name, callback) { assert.equal(name, 'settings.section'); callback() },
      register(options, component) { registration = { options, component } } }
  })
  const props = registration.options.inject()
  const view = () => renderer.render(registration.component, props)
  return { plugin, view, current: () => renderer.current(), unmount: () => renderer.unmount(), dictionaries: registeredDictionaries }
}

const walk = (node, result = []) => {
  if (node && typeof node === 'object' && node.type) {
    result.push(node)
    for (const child of node.children) walk(child, result)
  }
  return result
}
const elements = (tree, type) => walk(tree).filter((node) => node.type === type)
const textOf = (node) => typeof node === 'string' || typeof node === 'number' ? String(node)
  : node?.children?.map(textOf).join('') ?? ''
const selectValue = (tree, index) => elements(tree, 'select')[index].props.value
const optionValues = (tree, index) => elements(elements(tree, 'select')[index], 'option').map((node) => node.props.value)
const select = (tree, index, value) => elements(tree, 'select')[index].props.onChange({ target: { value } })
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('missing, unavailable and loading forms never claim to follow the main conversation', async () => {
  for (const form of [undefined, makeForm({ status: 'unavailable', writable: false }), makeForm({ status: 'loading', writable: false })]) {
    const ui = setup({ form })
    let tree = ui.view()
    await tick()
    tree = ui.view()
    const expected = form?.getSnapshot().status === 'loading' ? 'Loading configuration…' : 'Configuration unavailable'
    assert.match(textOf(tree), new RegExp(expected))
    assert.doesNotMatch(textOf(tree), /Follow main conversation/)
    assert.ok(elements(tree, 'select').every((node) => node.props.disabled))
    assert.equal(elements(tree, 'button')[0].props.disabled, true)
    ui.unmount()
    if (form) assert.equal(form.listenerCount, 0)
  }
})

test('renders effective saved route with missing catalog options and full snapshot details', async () => {
  const actual = route('magpie-anthropic', 'litellm-hypergryph/claude-haiku-5-5')
  const form = makeForm(ready(actual, 'r1', true, { user: route('wrong-provider', 'wrong-model'), base: { extra: 'base' } }))
  const ui = setup({ form, catalog: { ok: true, value: { groups: [{
    id: actual.reviewProvider, name: 'Anthropic', models: [{ id: 'other-model', name: 'Other model' }]
  }] } } })
  ui.view(); await tick()
  const tree = ui.view()
  assert.equal(selectValue(tree, 0), actual.reviewProvider)
  assert.equal(selectValue(tree, 1), actual.reviewModel)
  assert.ok(optionValues(tree, 0).includes(actual.reviewProvider))
  assert.ok(optionValues(tree, 1).includes(actual.reviewModel))
  assert.ok(optionValues(tree, 1).includes('other-model'))
  assert.match(textOf(elements(tree, 'pre')[0]), /wrong-provider/)
  assert.match(textOf(elements(tree, 'pre')[0]), /base/)
  assert.ok(ui.plugin.inject.includes('configForms'))
  assert.deepEqual(JSON.parse(JSON.stringify(ui.dictionaries)), locale)
  ui.unmount()
})

test('uses one atomic mutation with the draft revision across unrelated updates', async () => {
  const form = makeForm(ready(route('old', 'old-model'), 'r1'))
  const ui = setup({ form, catalog: { ok: true, value: { groups: [{ id: 'new', name: 'New', models: [{ id: 'new-model', name: 'New model' }] }] } } })
  ui.view(); await tick()
  select(ui.view(), 0, 'new')
  select(ui.view(), 1, 'new-model')
  form.update(ready(route('external', 'external-model'), 'r2'))
  let tree = ui.view()
  assert.equal(selectValue(tree, 0), 'new')
  assert.equal(selectValue(tree, 1), 'new-model')
  let resolve
  form.mutate = (ops, revision) => {
    form.calls.push({ ops, revision })
    return new Promise((done) => { resolve = done })
  }
  const saving = elements(tree, 'button')[0].props.onClick()
  tree = ui.view()
  assert.ok(elements(tree, 'select').every((node) => node.props.disabled))
  assert.equal(elements(tree, 'button')[0].props.disabled, true)
  await elements(tree, 'button')[0].props.onClick()
  assert.equal(form.calls.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(form.calls[0])), { ops: [
    { op: 'set', path: ['reviewProvider'], value: 'new' },
    { op: 'set', path: ['reviewModel'], value: 'new-model' }
  ], revision: 'r1' })
  form.update(ready(route('new', 'new-model'), 'r3'))
  resolve(true)
  await saving
  tree = ui.view()
  assert.equal(selectValue(tree, 0), 'new')
  assert.match(textOf(tree), /Saved/)
  assert.equal(elements(tree, 'button')[0].props.disabled, true)
  ui.unmount()
})

test('rejected and thrown saves never report success and return to actual values', async () => {
  for (const outcome of ['false', 'throw']) {
    const form = makeForm(ready(route('old', 'old-model'), 'r1'))
    const ui = setup({ form })
    ui.view(); await tick()
    select(ui.view(), 0, 'draft')
    form.mutate = async () => {
      form.update(ready(route('actual', 'actual-model'), 'r2'))
      if (outcome === 'throw') throw new Error('network problem')
      return false
    }
    await elements(ui.view(), 'button')[0].props.onClick()
    const tree = ui.view()
    assert.equal(selectValue(tree, 0), 'actual')
    assert.equal(selectValue(tree, 1), 'actual-model')
    assert.match(textOf(tree), /Save failed:/)
    assert.doesNotMatch(textOf(tree), /Saved/)
    if (outcome === 'throw') assert.match(textOf(tree), /network problem/)
    ui.unmount()
  }
})

test('live updates refresh clean values and permissions while preserving dirty drafts', async () => {
  const form = makeForm(ready(route('one', 'm1'), 'r1'))
  const ui = setup({ form })
  ui.view(); await tick()
  assert.equal(form.listenerCount, 1)
  form.update(ready(route('two', 'm2'), 'r2'))
  await tick()
  assert.equal(selectValue(ui.current(), 0), 'two')
  assert.equal(selectValue(ui.current(), 1), 'm2')
  select(ui.view(), 0, 'draft')
  form.update(ready(route('three', 'm3'), 'r3', false))
  let tree = ui.view()
  assert.equal(selectValue(tree, 0), 'draft')
  assert.ok(elements(tree, 'select').every((node) => node.props.disabled))
  assert.equal(elements(tree, 'button')[0].props.disabled, true)
  assert.match(textOf(tree), /read-only/)
  form.update({ status: 'unavailable', writable: false })
  tree = ui.view()
  assert.doesNotMatch(textOf(tree), /Follow main conversation/)
  assert.ok(elements(tree, 'select').every((node) => node.props.disabled))
  form.update(ready(route('four', 'm4'), 'r4'))
  assert.equal(selectValue(ui.view(), 0), 'draft')
  assert.equal(elements(ui.view(), 'button')[0].props.disabled, false)
  ui.unmount()
  assert.equal(form.listenerCount, 0)
})

test('explicit model catalog failure is displayed without losing the configured route', async () => {
  const actual = route('magpie', 'group/deepseek-flash-1017')
  const form = makeForm(ready(actual))
  const ui = setup({ form, catalog: { ok: false, error: { message: 'catalog denied' } } })
  ui.view(); await tick()
  const tree = ui.view()
  assert.match(textOf(tree), /Read failed: catalog denied/)
  assert.equal(selectValue(tree, 0), actual.reviewProvider)
  assert.equal(selectValue(tree, 1), actual.reviewModel)
  assert.ok(optionValues(tree, 1).includes(actual.reviewModel))
  ui.unmount()
})

test('failure remains visible when recovery makes the form unavailable', async () => {
  const form = makeForm(ready(route('saved', 'model'), 'r1'))
  const ui = setup({ form })
  ui.view(); await tick()
  select(ui.view(), 0, 'draft')
  form.mutate = async () => {
    form.update({ status: 'unavailable', writable: false })
    return false
  }
  await elements(ui.view(), 'button')[0].props.onClick()
  const tree = ui.view()
  assert.match(textOf(tree), /Configuration unavailable/)
  assert.match(textOf(tree), /Save failed:/)
  assert.doesNotMatch(textOf(tree), /Saved/)
  ui.unmount()
})

test('a later failed save clears the earlier success message', async () => {
  const form = makeForm(ready(route('initial', 'model'), 'r1'))
  const ui = setup({ form })
  ui.view(); await tick()
  select(ui.view(), 0, 'success')
  form.mutate = async () => { form.update(ready(route('success', ''), 'r2')); return true }
  await elements(ui.view(), 'button')[0].props.onClick()
  assert.match(textOf(ui.view()), /Saved/)
  select(ui.view(), 0, 'rejected')
  form.mutate = async () => false
  await elements(ui.view(), 'button')[0].props.onClick()
  const tree = ui.view()
  assert.match(textOf(tree), /Save failed:/)
  assert.doesNotMatch(textOf(tree), /Saved/)
  assert.equal(selectValue(tree, 0), 'success')
  ui.unmount()
})
