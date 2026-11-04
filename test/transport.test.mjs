import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { apply, _internal } from '../index.js';

const { rewriteAnthropicRequest, registerFetchHook, reviewStreamScope } = _internal;
const DISPATCHER = Symbol.for('auto-review-cache-identity#fetch-dispatcher@1');
const URL = 'https://review.invalid/v1/messages';
const POLICY = [
  'REVIEW_POLICY',
  'You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call.',
  'Evaluate the pending action against the user request and the supplied project instructions.',
  'Return exactly one JSON object with decision and reason, and no other text.'
].join('\n');
const HISTORY = [
  { role: 'user', text: 'Inspect the synthetic transport fixture and explain its behavior.' },
  { role: 'assistant', tool: { name: 'read', arguments: { file_path: 'fixtures/example.txt' } }, result: { text: 'Synthetic fixture only.' } },
  { role: 'user', text: 'Append a regression test for the fixture.' }
];
const ACTION = { mode: 'native', name: 'read', arguments: JSON.stringify({ file_path: 'fixtures/example.txt' }) };

function reviewText(history = HISTORY, action = ACTION) {
  return [
    'ENVIRONMENT', JSON.stringify({ cwd: 'C:/synthetic/review-project', platform: 'win32', shell: 'pwsh' }, null, 2),
    'PROJECT_INSTRUCTIONS', JSON.stringify([{ path: 'AGENTS.md', content: 'Use synthetic fixtures and keep transport behavior intact.' }], null, 2),
    'FILTERED_HISTORY', JSON.stringify(history, null, 2),
    'PENDING_ACTION', JSON.stringify(action, null, 2)
  ].join('\n\n');
}

function reviewCall(history = HISTORY, action = ACTION) {
  return {
    provider: 'synthetic-anthropic',
    model: 'synthetic-review-model',
    system: POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text: reviewText(history, action), cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
    temperature: 0
  };
}

function anthropicBody(call = reviewCall()) {
  return {
    model: call.model,
    max_tokens: 128,
    stream: true,
    system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
    messages: call.messages,
    metadata: { user_id: 'synthetic-shared-provider-user' }
  };
}

function isolateFetch(t, underlying) {
  const savedFetch = globalThis.fetch;
  const savedRegistry = Object.getOwnPropertyDescriptor(globalThis, DISPATCHER);
  const cleanups = [];
  delete globalThis[DISPATCHER];
  globalThis.fetch = underlying;
  t.after(() => {
    try {
      for (const cleanup of cleanups.reverse()) cleanup();
    } finally {
      globalThis.fetch = savedFetch;
      if (savedRegistry) Object.defineProperty(globalThis, DISPATCHER, savedRegistry);
      else delete globalThis[DISPATCHER];
    }
  });
  return (id, hook) => {
    const cleanup = registerFetchHook(id, hook);
    cleanups.push(cleanup);
    return cleanup;
  };
}

function mountRuntime(t, adapter) {
  const initiators = new AsyncLocalStorage();
  const listeners = [];
  const disposers = [];
  const ctx = {
    fiber: { uid: 'synthetic-transport-test' },
    settings: { configure: () => () => {} },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => initiators.getStore() };
      if (name === 'settings') return ctx.settings;
    },
    effect(callback) {
      const cleanup = callback();
      if (typeof cleanup === 'function') disposers.push(cleanup);
      return cleanup;
    },
    on(name, callback) {
      assert.equal(name, 'llm/stream');
      listeners.push(callback);
      const cleanup = () => {
        const index = listeners.indexOf(callback);
        if (index !== -1) listeners.splice(index, 1);
      };
      disposers.push(cleanup);
      return cleanup;
    },
    inject(names, callback) {
      assert.deepEqual(names, ['llm']);
      callback(ctx);
    },
    llm: {
      stream(options) {
        let index = 0;
        const next = () => index < listeners.length ? listeners[index++](options, next) : adapter(options);
        return next();
      }
    },
    runAs(sessionId, callback) {
      return initiators.run({ session: { id: sessionId } }, callback);
    }
  };
  apply(ctx, { enabled: true, scope: 'session' });
  t.after(() => { for (const dispose of disposers.reverse()) dispose(); });
  return ctx;
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('outer HTTP tracker passes a bare Request and preserves the previous history mark on append', async (t) => {
  const received = [];
  const tracked = [];
  const dispatched = [];
  const controllers = [];
  const register = isolateFetch(t, async (input, init) => {
    const request = new Request(input, init);
    received.push({ request, body: JSON.parse(await request.text()) });
    return new Response('synthetic response');
  });
  register('synthetic-observer', (input, init) => { dispatched.push({ input, init, bodyUsed: input.bodyUsed }); });
  const ctx = mountRuntime(t, call => (async function* () {
    await Promise.resolve();
    const controller = new AbortController();
    controllers.push(controller);
    const response = await globalThis.fetch(URL, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-synthetic-trace': 'transport-fixture', 'x-session-id': 'synthetic-shared-header' },
      body: JSON.stringify(anthropicBody(call))
    });
    yield await response.text();
  })());
  const inner = globalThis.fetch;
  const registry = globalThis[DISPATCHER];
  assert.ok(registry.hooks instanceof Map);
  assert.equal(inner, registry.dispatcher);
  // The Desktop tracker merges input and init before calling its captured fetch.
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    tracked.push(request);
    return inner(request);
  };
  const firstCall = reviewCall(HISTORY.slice(0, 1));
  const nextCall = reviewCall(HISTORY, { ...ACTION, name: 'write' });
  const firstStream = ctx.runAs('synthetic-session-a', () => ctx.llm.stream(firstCall));
  assert.equal(firstStream.then, undefined);
  assert.deepEqual(await drain(firstStream), ['synthetic response']);
  const nextStream = ctx.runAs('synthetic-session-a', () => ctx.llm.stream(nextCall));
  assert.deepEqual(await drain(nextStream), ['synthetic response']);
  assert.equal(received.length, 2);
  assert.equal(tracked.length, 2);
  assert.equal(dispatched.length, 2);
  for (const [index, { input, init, bodyUsed }] of dispatched.entries()) {
    assert.equal(input, tracked[index]);
    assert.ok(input instanceof Request);
    assert.equal(init, undefined);
    assert.equal(bodyUsed, false);
  }
  const firstContent = received[0].body.messages[0].content;
  const content = received[1].body.messages[0].content;
  assert.ok(firstContent[1].cache_control);
  assert.deepEqual(content[1].cache_control, firstContent[1].cache_control);
  assert.deepEqual(content[3].cache_control, firstContent[1].cache_control);
  assert.equal(content[4].cache_control, undefined);
  assert.deepEqual(content.slice(0, 2).map(block => block.text), firstContent.slice(0, 2).map(block => block.text));
  for (const [index, { request, body }] of received.entries()) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), 'application/json');
    assert.equal(request.headers.get('x-synthetic-trace'), 'transport-fixture');
    assert.equal(request.headers.get('x-session-id'), 'synthetic-shared-header');
    assert.equal(request.headers.get('x-magpie-cache-marks'), 'client');
    assert.equal(body.messages[0].content.map(block => block.text).join(''), [firstCall, nextCall][index].messages[0].content[0].text);
    assert.equal(tracked[index].bodyUsed, false);
    assert.deepEqual(JSON.parse(await tracked[index].text()), anthropicBody([firstCall, nextCall][index]));
    controllers[index].abort('synthetic cancellation');
    assert.equal(request.signal.aborted, true);
    assert.equal(request.signal.reason, 'synthetic cancellation');
  }
});

test('request helper accepts string init bodies and keeps explicit identities separate from shared headers', async () => {
  const checkpoints = new Map();
  const controller = new AbortController();
  const init = { method: 'POST', signal: controller.signal, headers: { 'x-session-id': 'synthetic-shared-header', 'x-extra': 'retained' }, body: JSON.stringify(anthropicBody(reviewCall(HISTORY.slice(0, 1)))) };
  const original = JSON.stringify(init);
  const first = await rewriteAnthropicRequest(URL, init, checkpoints, 'synthetic-identity-a');
  assert.equal(first.init.method, 'POST');
  assert.equal(first.init.signal, controller.signal);
  assert.equal(first.init.headers.get('x-extra'), 'retained');
  assert.equal(first.init.headers.get('x-magpie-cache-marks'), 'client');
  assert.equal(JSON.stringify(init), original);
  const appended = { ...init, body: JSON.stringify(anthropicBody()) };
  const other = await rewriteAnthropicRequest(URL, appended, checkpoints, 'synthetic-identity-b');
  assert.equal(JSON.parse(other.init.body).messages[0].content[1].cache_control, undefined);
  const same = await rewriteAnthropicRequest(URL, appended, checkpoints, 'synthetic-identity-a');
  assert.ok(JSON.parse(same.init.body).messages[0].content[1].cache_control);
  assert.deepEqual([...checkpoints.keys()].sort(), ['synthetic-review-model:synthetic-identity-a', 'synthetic-review-model:synthetic-identity-b']);
});

test('request helper reads a clone and retains bare Request transport fields', async () => {
  const controller = new AbortController();
  const originalBody = JSON.stringify(anthropicBody());
  const input = new Request(URL, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-extra': 'request-header' }, body: originalBody });
  const rewritten = await rewriteAnthropicRequest(input, undefined, new Map(), 'synthetic-request-identity');
  assert.ok(rewritten);
  assert.equal(input.bodyUsed, false);
  const effective = new Request(rewritten.input ?? input, rewritten.init);
  assert.equal(effective.method, 'POST');
  assert.equal(effective.headers.get('x-extra'), 'request-header');
  assert.equal(effective.headers.get('content-type'), 'application/json');
  assert.equal(effective.headers.get('x-magpie-cache-marks'), 'client');
  assert.equal(input.bodyUsed, false);
  assert.equal(await input.text(), originalBody);
  controller.abort('synthetic abort');
  assert.equal(effective.signal.aborted, true);
  assert.equal(effective.signal.reason, 'synthetic abort');
});

test('dispatcher awaits every hook in order and calls its underlying fetch once', async (t) => {
  const events = [];
  const response = new Response('synthetic response');
  const register = isolateFetch(t, async (input, init) => {
    events.push('fetch');
    assert.equal(input, URL + '?synthetic=rewritten');
    assert.equal(new Headers(init.headers).get('x-async-hook'), 'complete');
    return response;
  });
  register('synthetic-first', async (input, init) => {
    events.push('first:start');
    await Promise.resolve();
    events.push('first:end');
    return { input: input + '?synthetic=rewritten', init: { ...init, headers: { 'x-first': 'retained' } } };
  });
  register('synthetic-failure', async () => {
    events.push('failed-hook');
    throw new Error('synthetic hook failure');
  });
  register('synthetic-second', async (input, init) => {
    events.push('second:start');
    assert.equal(input, URL + '?synthetic=rewritten');
    assert.equal(new Headers(init.headers).get('x-first'), 'retained');
    await Promise.resolve();
    const headers = new Headers(init.headers);
    headers.set('x-async-hook', 'complete');
    events.push('second:end');
    return { init: { ...init, headers } };
  });
  assert.equal(await globalThis.fetch(URL, { method: 'POST', body: '{}' }), response);
  assert.deepEqual(events, ['first:start', 'first:end', 'failed-hook', 'second:start', 'second:end', 'fetch']);
});

test('ordinary fetch calls bypass Request cloning and body access without a review ALS store', async (t) => {
  const received = [];
  isolateFetch(t, async (...args) => { received.push(args); return new Response('ordinary'); });
  mountRuntime(t, () => (async function* () {})());
  const input = new Request(URL, { method: 'POST', body: JSON.stringify(anthropicBody()) });
  let clones = 0;
  input.clone = () => { clones += 1; throw new Error('ordinary request must not be cloned'); };
  await globalThis.fetch(input);
  let bodyReads = 0;
  const init = { get body() { bodyReads += 1; throw new Error('ordinary body must not be parsed'); } };
  await globalThis.fetch(URL, init);
  assert.equal(clones, 0);
  assert.equal(bodyReads, 0);
  assert.equal(input.bodyUsed, false);
  assert.equal(received.length, 2);
  assert.equal(received[0][0], input);
  assert.equal(received[0][1], undefined);
  assert.equal(received[1][0], URL);
  assert.equal(received[1][1], init);
});

test('disposal preserves a foreign outer wrapper and remount reuses its empty dispatcher', async (t) => {
  const phases = [];
  const underlying = async (input, init) => {
    phases.push(new Request(input, init).headers.get('x-synthetic-phase'));
    return new Response('synthetic response');
  };
  const register = isolateFetch(t, underlying);
  let oldCalls = 0;
  let newCalls = 0;
  const off = register('synthetic-remount', async () => { oldCalls += 1; return { init: { headers: { 'x-synthetic-phase': 'old' } } }; });
  const registry = globalThis[DISPATCHER];
  const inner = globalThis.fetch;
  const outer = async (input, init) => inner(new Request(input, init));
  globalThis.fetch = outer;
  await globalThis.fetch(URL);
  off();
  assert.equal(globalThis.fetch, outer);
  assert.equal(globalThis[DISPATCHER], registry);
  assert.equal(registry.hooks.size, 0);
  await globalThis.fetch(URL);
  const offRemount = register('synthetic-remount', async () => { newCalls += 1; return { init: { headers: { 'x-synthetic-phase': 'remounted' } } }; });
  assert.equal(globalThis.fetch, outer);
  assert.equal(globalThis[DISPATCHER], registry);
  assert.equal(registry.dispatcher, inner);
  assert.equal(registry.hooks.size, 1);
  await globalThis.fetch(URL);
  offRemount();
  assert.equal(globalThis.fetch, outer);
  assert.equal(globalThis[DISPATCHER], registry);
  assert.equal(registry.hooks.size, 0);
  assert.deepEqual(phases, ['old', null, 'remounted']);
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
  globalThis.fetch = inner;
  const offFinal = register('synthetic-final', () => undefined);
  offFinal();
  assert.equal(globalThis.fetch, underlying);
  assert.equal(globalThis[DISPATCHER], undefined);
});

test('scoped iterator preserves identity and arguments across awaited next, return and throw methods', async () => {
  const storage = new AsyncLocalStorage();
  const identity = 'synthetic-iterator-identity';
  const observations = [];
  const failure = new Error('synthetic iterator error');
  const iterator = {};
  for (const method of ['next', 'return', 'throw']) {
    iterator[method] = async function (value) {
      assert.equal(this, iterator);
      observations.push([method, 'before', storage.getStore()?.identity, value]);
      await Promise.resolve();
      observations.push([method, 'after', storage.getStore()?.identity, value]);
      if (method === 'throw') throw value;
      return { value, done: method === 'return' };
    };
  }
  const stream = {
    [Symbol.asyncIterator]() {
      assert.equal(this, stream);
      assert.deepEqual(storage.getStore(), { identity });
      return iterator;
    }
  };
  const scoped = reviewStreamScope(stream, storage, identity);
  assert.equal(scoped.then, undefined);
  assert.equal(scoped[Symbol.asyncIterator](), scoped);
  assert.equal(storage.getStore(), undefined);
  const nextValue = { synthetic: 'next' };
  const returnValue = { synthetic: 'cancelled' };
  assert.deepEqual(await scoped.next(nextValue), { value: nextValue, done: false });
  assert.deepEqual(await scoped.return(returnValue), { value: returnValue, done: true });
  await assert.rejects(scoped.throw(failure), error => error === failure);
  assert.deepEqual(observations, [
    ['next', 'before', identity, nextValue], ['next', 'after', identity, nextValue],
    ['return', 'before', identity, returnValue], ['return', 'after', identity, returnValue],
    ['throw', 'before', identity, failure], ['throw', 'after', identity, failure]
  ]);
  assert.equal(storage.getStore(), undefined);
});

test('breaking a scoped stream keeps identity in asynchronous generator cleanup', async () => {
  const storage = new AsyncLocalStorage();
  const observations = [];
  const stream = (async function* () {
    try {
      await Promise.resolve();
      observations.push(['next', storage.getStore()?.identity]);
      yield 'synthetic chunk';
      assert.fail('cancelled stream must not advance');
    } finally {
      observations.push(['cleanup:before', storage.getStore()?.identity]);
      await Promise.resolve();
      observations.push(['cleanup:after', storage.getStore()?.identity]);
    }
  })();
  for await (const chunk of reviewStreamScope(stream, storage, 'synthetic-cancel-identity')) {
    assert.equal(chunk, 'synthetic chunk');
    assert.equal(storage.getStore(), undefined);
    break;
  }
  assert.deepEqual(observations, [
    ['next', 'synthetic-cancel-identity'],
    ['cleanup:before', 'synthetic-cancel-identity'],
    ['cleanup:after', 'synthetic-cancel-identity']
  ]);
  assert.equal(storage.getStore(), undefined);
});

test('scoped streams propagate the original generator error without retaining review identity', async () => {
  const storage = new AsyncLocalStorage();
  const failure = new Error('synthetic stream failure');
  const stream = reviewStreamScope((async function* () {
    yield 'synthetic chunk';
    await Promise.resolve();
    assert.deepEqual(storage.getStore(), { identity: 'synthetic-error-identity' });
    throw failure;
  })(), storage, 'synthetic-error-identity');
  assert.deepEqual(await stream.next(), { value: 'synthetic chunk', done: false });
  await assert.rejects(stream.next(), error => error === failure);
  assert.equal(storage.getStore(), undefined);
});

test('parallel scoped streams keep independent identities while their awaited work interleaves', async () => {
  const storage = new AsyncLocalStorage();
  const gates = [deferred(), deferred()];
  const observations = [];
  const makeStream = (identity, gate) => reviewStreamScope((async function* () {
    try {
      observations.push([identity, 'before', storage.getStore()?.identity]);
      await gate.promise;
      observations.push([identity, 'after', storage.getStore()?.identity]);
      yield storage.getStore()?.identity;
    } finally {
      await Promise.resolve();
      observations.push([identity, 'return', storage.getStore()?.identity]);
    }
  })(), storage, identity);
  const streams = [makeStream('synthetic-stream-a', gates[0]), makeStream('synthetic-stream-b', gates[1])];
  const pending = streams.map(stream => stream.next());
  assert.equal(storage.getStore(), undefined);
  gates[1].resolve();
  assert.deepEqual(await pending[1], { value: 'synthetic-stream-b', done: false });
  assert.equal(storage.getStore(), undefined);
  gates[0].resolve();
  assert.deepEqual(await pending[0], { value: 'synthetic-stream-a', done: false });
  await Promise.all(streams.map(stream => stream.return()));
  assert.equal(observations.length, 6);
  for (const [expected, , actual] of observations) assert.equal(actual, expected);
  assert.equal(storage.getStore(), undefined);
});
