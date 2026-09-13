/* global setTimeout */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseJson, semanticFingerprint, normalizeReferences, sha } from './contracts.mjs';
import { FORMAT_REPAIR } from './prompts.mjs';
const write = (p, x) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n', {
    flag: 'wx',
  });
};
const append = (p, x) =>
  fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...x }) + '\n');
const safeError = (e) =>
  ['TimeoutError', 'AbortError'].includes(e?.name)
    ? e.name
    : ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(e?.cause?.code)
      ? e.cause.code
      : 'TRANSPORT_FAILURE';
let nextRequestAt = 0,
  cooldownUntil = 0;
async function waitForRequestSlot(config) {
  if (!config.requestsPerMinute) return;
  const spacing = 60000 / config.requestsPerMinute;
  for (;;) {
    const slot = Math.max(Date.now(), nextRequestAt, cooldownUntil);
    nextRequestAt = slot + spacing;
    const wait = slot - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (Date.now() >= cooldownUntil) return;
  }
}
export function createStageRunner({
  directory,
  task,
  config,
  credentials,
  identityHash,
  beforeRequest = () => {},
}) {
  return async (name, input, prompt, validate) => {
    const base = path.join(directory, 'stages', task.runId, name),
      inputIdentity = sha({ input, prompt, config });
    const savedPath = base + '.json';
    if (fs.existsSync(savedPath)) {
      const saved = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
      if (saved.inputIdentity !== inputIdentity) throw new Error('SAVED_STAGE_INPUT_CHANGED');
      return saved.result;
    }
    if (!fs.existsSync(base + '.input.json'))
      write(base + '.input.json', { inputIdentity, input, prompt, config });
    const original = [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(input) },
    ];
    let messages = original,
      maxTokens = config.maxTokens,
      lockedFingerprint = null,
      result = null;
    const attempts = [];
    for (let outputAttempt = 1; outputAttempt <= config.maxOutputAttempts; outputAttempt++) {
      let response = null;
      for (
        let transportAttempt = 1;
        transportAttempt <= config.maxTransportAttempts;
        transportAttempt++
      ) {
        await waitForRequestSlot(config);
        beforeRequest();
        const c = credentials(),
          physicalId = crypto.randomUUID(),
          prefix = path.join(directory, 'raw', physicalId);
        const body = JSON.stringify({
          model: c.model,
          messages,
          temperature: config.temperature,
          max_tokens: maxTokens,
          ...(config.responseFormat ? { response_format: { type: config.responseFormat } } : {}),
        });
        if (body.includes(c.apiKey)) throw new Error('CREDENTIAL_ECHO_BLOCKED');
        write(prefix + '.request.json', body);
        const ctx = {
          physicalId,
          caseId: task.caseId,
          runId: task.runId,
          stage: name,
          outputAttempt,
          transportAttempt,
          identityHash,
        };
        append(path.join(directory, 'physical.jsonl'), {
          event: 'started',
          ...ctx,
          requestHash: sha(body),
          requestPath: path.relative(directory, prefix + '.request.json'),
          requestedModel: c.model,
        });
        const started = performance.now();
        let captured = false;
        try {
          const r = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.apiKey },
            body,
            signal: AbortSignal.timeout(config.timeoutMs),
          });
          const text = await r.text();
          if (text.includes(c.apiKey)) throw new Error('CREDENTIAL_ECHO_BLOCKED');
          write(prefix + '.response.txt', text);
          let envelope;
          try {
            envelope = JSON.parse(text);
          } catch {
            /* Preserve the captured non-JSON response for audit. */
          }
          append(path.join(directory, 'physical.jsonl'), {
            event: 'completed',
            ...ctx,
            status: r.status,
            elapsedMs: Math.round(performance.now() - started),
            responseHash: sha(text),
            responsePath: path.relative(directory, prefix + '.response.txt'),
            usage: envelope?.usage ?? null,
            returnedModel: envelope?.model ?? null,
            systemFingerprint: envelope?.system_fingerprint ?? null,
            finishReason: envelope?.choices?.[0]?.finish_reason ?? null,
          });
          captured = true;
          const retryAfter = r.headers.get('retry-after');
          const retryAfterMs = retryAfter
            ? /^[0-9.]+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now())
            : 0;
          if (r.status === 429)
            cooldownUntil = Math.max(
              cooldownUntil,
              Date.now() + Math.min(60000, Math.max(15000, retryAfterMs || 0)),
            );
          response = !r.ok
            ? {
                failure: 'HTTP_' + r.status,
                retryable: r.status === 429 || r.status >= 500,
                retryAfterMs: retryAfterMs || 0,
              }
            : envelope?.model !== c.model
              ? { failure: 'RETURNED_MODEL_MISMATCH', retryable: false }
              : {
                  content: envelope?.choices?.[0]?.message?.content,
                  finishReason: envelope?.choices?.[0]?.finish_reason,
                };
          attempts.push({
            ...ctx,
            finishReason: response.finishReason,
            failure: response.failure ?? null,
          });
          if (!response.failure || !response.retryable) break;
        } catch (e) {
          if (!captured)
            append(path.join(directory, 'physical.jsonl'), {
              event: 'failed',
              ...ctx,
              errorCode: safeError(e),
              elapsedMs: Math.round(performance.now() - started),
              usage: null,
            });
          response = { failure: safeError(e), retryable: true };
          attempts.push({ ...ctx, failure: response.failure });
        }
        if (transportAttempt < config.maxTransportAttempts)
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(
                60000,
                Math.max(
                  response.retryAfterMs || 0,
                  (config.retryBaseMs || 1000) * 2 ** (transportAttempt - 1),
                ),
              ),
            ),
          );
      }
      if (response.failure) {
        result = {
          status: 'JUDGE_INVALID',
          category: 'provider_transport',
          reason: response.failure,
        };
        break;
      }
      let raw = null,
        error = null;
      if (response.finishReason === 'length') error = 'TRUNCATED_OUTPUT';
      else
        try {
          raw = parseJson(response.content);
          if (lockedFingerprint && semanticFingerprint(raw) !== lockedFingerprint)
            throw new Error('FORMAT_REPAIR_CHANGED_SEMANTICS');
          const prepared = normalizeReferences(input.view, raw);
          attempts.at(-1).referenceRepairs = prepared.repairs;
          result = validate(prepared.output);
          if (prepared.repairs.length) result.referenceRepairs = prepared.repairs;
        } catch (e) {
          error = e instanceof SyntaxError ? 'MALFORMED_JSON' : e.message;
        }
      attempts.at(-1).contractError = error;
      if (!error) break;
      result = null;
      if (outputAttempt === config.maxOutputAttempts) {
        result = { status: 'JUDGE_INVALID', category: 'output_contract', reason: error };
        break;
      }
      if (error === 'TRUNCATED_OUTPUT') {
        maxTokens = config.truncationMaxTokens;
        messages = original;
        lockedFingerprint = null;
      } else if (
        Array.isArray(raw?.dimensions) &&
        raw.dimensions.length > 0 &&
        raw.dimensions.every(
          (d) =>
            [0, 1, 2, 'U'].includes(d.level) &&
            Array.isArray(d.defects) &&
            Array.isArray(d.missing),
        ) &&
        !error.startsWith('Ordinal/') &&
        error !== 'FORMAT_REPAIR_CHANGED_SEMANTICS'
      ) {
        lockedFingerprint = semanticFingerprint(raw);
        messages = [
          ...original,
          { role: 'assistant', content: response.content },
          { role: 'user', content: FORMAT_REPAIR + '\n错误：' + error },
        ];
      } else {
        // Fresh bounded inference for unusable syntax/shape; never select among valid scores.
        lockedFingerprint = null;
        messages = [
          ...original,
          {
            role: 'user',
            content:
              '上一请求未产生可用的输出契约。本次重新按原始材料返回指定的短JSON对象。结构错误：' +
              error,
          },
        ];
      }
    }
    write(savedPath, { inputIdentity, attempts, result });
    return result;
  };
}
