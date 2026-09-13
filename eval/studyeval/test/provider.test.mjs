import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStageRunner } from '../provider.mjs';
const config = {
  temperature: 0,
  maxTokens: 100,
  truncationMaxTokens: 200,
  timeoutMs: 2000,
  maxTransportAttempts: 2,
  maxOutputAttempts: 3,
  responseFormat: 'json_object',
};
const credentials = () => ({
  model: 'test-model',
  baseUrl: 'https://unit.invalid/v1',
  apiKey: 'test-only-secret',
});
const output = (content, finish = 'stop', model = 'test-model') =>
  new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content }, finish_reason: finish }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }),
    { status: 200 },
  );
test('truncation causes a bounded fresh request with larger budget; both attempts remain auditable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyeval-transport-test-'));
  let calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (_, opts) => {
    calls.push(JSON.parse(opts.body));
    return calls.length === 1 ? output('{"value":', 'length') : output('{"value":7}');
  };
  try {
    const stage = createStageRunner({
      directory: dir,
      task: { caseId: 'synthetic', runId: 'synthetic-r1' },
      config,
      credentials,
      identityHash: 'test',
    });
    const r = await stage('check', { value: 'input' }, 'test', (x) => x);
    assert.equal(r.value, 7);
    assert.deepEqual(
      calls.map((x) => x.max_tokens),
      [100, 200],
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, 'stages/synthetic-r1/check.json'), 'utf8'),
    );
    assert.equal(saved.attempts.length, 2);
    assert.equal(saved.attempts[0].contractError, 'TRUNCATED_OUTPUT');
    assert.equal(
      fs.readFileSync(path.join(dir, 'physical.jsonl'), 'utf8').includes('test-only-secret'),
      false,
    );
  } finally {
    globalThis.fetch = old;
  }
});
test('model identity mismatch is a transport failure, never a fabricated score', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyeval-identity-test-'));
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return output('{"value":7}', 'stop', 'wrong-model');
  };
  try {
    const stage = createStageRunner({
      directory: dir,
      task: { caseId: 'synthetic', runId: 'synthetic-r1' },
      config,
      credentials,
      identityHash: 'test',
    });
    const r = await stage('check', {}, 'test', (x) => x);
    assert.equal(r.status, 'JUDGE_INVALID');
    assert.equal(r.reason, 'RETURNED_MODEL_MISMATCH');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = old;
  }
});
test('a rejected preflight guard prevents every physical request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyeval-guard-test-'));
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw Error('must not call');
  };
  try {
    const stage = createStageRunner({
      directory: dir,
      task: { caseId: 'synthetic', runId: 'synthetic-r1' },
      config,
      credentials,
      identityHash: 'test',
      beforeRequest: () => {
        throw Error('RESERVED');
      },
    });
    await assert.rejects(
      stage('check', {}, 'test', (x) => x),
      /RESERVED/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = old;
  }
});
test('an object-valued dimensions field is retried as a schema failure without crashing the repair handler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyeval-shape-test-'));
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return output(calls === 1 ? '{"dimensions":{}}' : '{"dimensions":[]}');
  };
  try {
    const stage = createStageRunner({
      directory: dir,
      task: { caseId: 'synthetic', runId: 'synthetic-r1' },
      config,
      credentials,
      identityHash: 'test',
    });
    const r = await stage('check', { view: {} }, 'test', (raw) => {
      if (!Array.isArray(raw.dimensions)) throw Error('dimensions array required');
      return raw;
    });
    assert.deepEqual(r.dimensions, []);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = old;
  }
});
