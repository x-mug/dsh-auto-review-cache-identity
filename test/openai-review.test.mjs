import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../index.js';

const { rewriteOpenAIBody, rewriteResponseBody, rewriteReviewRequest } = _internal;
const URL = 'http://127.0.0.1:3425/v1/chat/completions';
const POLICY = [
  'REVIEW_POLICY',
  'You are the final authorization reviewer for exactly one pending tool call. Your decision replaces human approval for this call.',
  'Return exactly one JSON object and no other text.'
].join('\n');
const HISTORY = [
  { kind: 'tool-call', name: 'read', arguments: '{"path":"fixtures/a.txt"}' },
  { kind: 'tool-call', name: 'read', arguments: '{"path":"fixtures/b.txt"}' }
];

function reviewText(history, action) {
  return [
    'ENVIRONMENT', JSON.stringify({ cwd: 'C:/synthetic/project' }, null, 2),
    'PROJECT_INSTRUCTIONS', JSON.stringify([{ path: 'AGENTS.md', content: 'synthetic fixture' }], null, 2),
    'FILTERED_HISTORY', JSON.stringify(history, null, 2),
    'PENDING_ACTION', JSON.stringify(action, null, 2)
  ].join('\n\n');
}

function chatBody(text, plain = true) {
  return {
    model: 'group/synthetic-review',
    max_tokens: 128,
    temperature: 0,
    messages: [
      { role: 'system', content: POLICY },
      { role: 'user', content: plain ? text : [{ type: 'text', text }] }
    ]
  };
}

const ACTION_A = { name: 'read', arguments: { path: 'fixtures/a.txt' } };
const ACTION_B = { name: 'write', arguments: { path: 'fixtures/c.txt' } };

test('review chat request becomes one message per history entry plus the action', () => {
  const original = chatBody(reviewText(HISTORY, ACTION_A));
  const snapshot = JSON.stringify(original);
  const rewritten = rewriteOpenAIBody(original, 'auto-review:synthetic-session');
  assert.ok(rewritten);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(rewritten.messages[0].role, 'system');
  assert.equal(rewritten.messages[0].content, POLICY);
  const parts = rewritten.messages.slice(1).map(message => message.content);
  assert.ok(parts.length >= 4);
  assert.equal(parts.join(''), reviewText(HISTORY, ACTION_A));
  assert.ok(parts[0].startsWith('ENVIRONMENT'));
  assert.ok(parts[0].endsWith('['));
  assert.ok(parts.at(-1).includes('PENDING_ACTION'));
  assert.ok(!parts.slice(0, -1).some(part => part.includes('PENDING_ACTION')));
  assert.equal(rewritten.max_tokens, original.max_tokens);
  assert.equal(rewritten.temperature, original.temperature);
});

test('the leading message and cache key survive history growth and a changed action', () => {
  const first = rewriteOpenAIBody(chatBody(reviewText(HISTORY, ACTION_A)), 'auto-review:session-a');
  const second = rewriteOpenAIBody(chatBody(reviewText(HISTORY.concat([{ kind: 'tool-call', name: 'write' }]), ACTION_B)), 'auto-review:session-a');
  assert.equal(first.messages[1].content, second.messages[1].content);
  assert.equal(first.prompt_cache_key, second.prompt_cache_key);
  assert.match(first.prompt_cache_key, /^auto-review-[0-9a-f]{48}$/);
  assert.ok(first.prompt_cache_key.length <= 64);
  assert.equal(second.messages.length, first.messages.length + 1);
  assert.equal(second.messages[2].content, first.messages[2].content);
  const other = rewriteOpenAIBody(chatBody(reviewText(HISTORY, ACTION_A)), 'auto-review:session-b');
  assert.notEqual(other.prompt_cache_key, first.prompt_cache_key);
});

test('a developer-role policy message is recognised like a system one', () => {
  const body = chatBody(reviewText(HISTORY, ACTION_A));
  body.messages[0] = { role: 'developer', content: POLICY };
  const rewritten = rewriteOpenAIBody(body, 'auto-review:session-a');
  assert.ok(rewritten);
  assert.equal(rewritten.messages[0].role, 'developer');
  assert.equal(rewritten.messages[0].content, POLICY);
  assert.equal(rewritten.messages.slice(1).map(message => message.content).join(''), reviewText(HISTORY, ACTION_A));
  assert.ok(rewritten.prompt_cache_key);
});

test('array content keeps its shape when split', () => {
  const rewritten = rewriteOpenAIBody(chatBody(reviewText(HISTORY, ACTION_A), false), 'auto-review:session-a');
  assert.ok(Array.isArray(rewritten.messages[1].content));
  assert.deepEqual(Object.keys(rewritten.messages[1].content[0]), ['type', 'text']);
  assert.equal(rewritten.messages[1].content[0].type, 'text');
});

test('non-review chat requests and unknown shapes pass through untouched', () => {
  assert.equal(rewriteOpenAIBody(chatBody('hello there', true), 'auto-review:session-a'), undefined);
  assert.equal(rewriteOpenAIBody({ model: 'm', messages: [{ role: 'user', content: POLICY }] }, 'auto-review:s'), undefined);
  assert.equal(rewriteOpenAIBody({ messages: [] }, 'auto-review:s'), undefined);
  assert.equal(rewriteOpenAIBody(null, 'auto-review:s'), undefined);
  const review = rewriteOpenAIBody(chatBody(reviewText(HISTORY, ACTION_A)), undefined);
  assert.ok(review);
  assert.equal(review.prompt_cache_key, undefined);
});

test('responses requests gain a stable cache key and keep everything else', () => {
  const body = { model: 'group/synthetic-review', instructions: POLICY, input: [{ role: 'user', content: [{ type: 'input_text', text: reviewText(HISTORY, ACTION_A) }] }], temperature: 0 };
  const snapshot = JSON.stringify(body);
  const rewritten = rewriteResponseBody(body, 'auto-review:session-a');
  assert.equal(JSON.stringify(body), snapshot);
  assert.equal(rewritten.instructions, POLICY);
  assert.deepEqual(rewritten.input, body.input);
  assert.equal(rewritten.prompt_cache_key, rewriteResponseBody(body, 'auto-review:session-a').prompt_cache_key);
  assert.equal(rewriteResponseBody({ instructions: 'not a review' }, 'auto-review:s'), undefined);
});

test('the fetch dispatcher rewrites chat and responses calls only for review traffic', async () => {
  const chatInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': 'synthetic' }, body: JSON.stringify(chatBody(reviewText(HISTORY, ACTION_A))) };
  const chat = await rewriteReviewRequest(URL, chatInit, new Map(), 'auto-review:session-a');
  assert.equal(chat.init.method, 'POST');
  assert.equal(chat.init.headers.get('content-type'), 'application/json');
  const sent = JSON.parse(chat.init.body);
  assert.ok(sent.messages.length > 3);
  assert.equal(sent.messages.slice(1).map(message => message.content).join(''), reviewText(HISTORY, ACTION_A));
  assert.equal(JSON.parse(chatInit.body).messages.length, 2);
  const response = await rewriteReviewRequest('http://127.0.0.1:3425/v1/responses', { method: 'POST', body: JSON.stringify({ instructions: POLICY, input: [] }) }, new Map(), 'auto-review:session-a');
  assert.ok(response.init.body.includes('prompt_cache_key'));
  const ordinary = await rewriteReviewRequest('http://127.0.0.1:3425/v1/chat/completions', { body: JSON.stringify(chatBody('hi')) }, new Map(), 'auto-review:session-a');
  assert.equal(ordinary, undefined);
  assert.equal(await rewriteReviewRequest('http://127.0.0.1:3425/v1/embeddings', { body: '{}' }, new Map(), 'auto-review:s'), undefined);
});

test('a Request-shaped chat call is rewritten from a clone', async () => {
  const text = JSON.stringify(chatBody(reviewText(HISTORY, ACTION_A)));
  const input = new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-extra': 'kept' }, body: text });
  const result = await rewriteReviewRequest(input, undefined, new Map(), 'auto-review:session-a');
  assert.ok(result);
  assert.equal(input.bodyUsed, false);
  assert.equal(await input.text(), text);
  const effective = new Request(input, result.init);
  assert.equal(effective.headers.get('x-extra'), 'kept');
  const sent = JSON.parse(result.init.body);
  assert.ok(sent.messages.length > 3);
  assert.equal(sent.messages.slice(1).map(message => message.content).join(''), reviewText(HISTORY, ACTION_A));
});