import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { CONFIG } from './prompts.mjs';
import { assert, parseJson, sha } from './util.mjs';
import { PUBLIC, append, assertFreeze, exists, read, write, guarded } from './storage.mjs';

export function credentials() {
  const req = createRequire(path.join(PUBLIC, 'package.json'));
  const dotenv = req('dotenv');
  const envPath = path.join(PUBLIC, '.env');
  const env = { ...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
  const storePath = path.resolve(PUBLIC, env.PROVIDER_CONFIG_PATH || 'data/provider-config.json');
  const saved = fs.existsSync(storePath) ? JSON.parse(fs.readFileSync(storePath, 'utf8')) : {};
  const completeEnv = !!(env.HY3_BASE_URL && env.HY3_MODEL && env.HY3_API_KEY);
  const selected = completeEnv ? { baseUrl: env.HY3_BASE_URL, model: env.HY3_MODEL, apiKey: env.HY3_API_KEY } : saved;
  assert(selected.baseUrl && selected.model && selected.apiKey, 'HY3_CONFIG_INCOMPLETE');
  const url = new URL(selected.baseUrl);
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'UNSAFE_ENDPOINT');
  return { baseUrl: selected.baseUrl, model: selected.model, apiKey: selected.apiKey,
    safe: { requestedModel: selected.model, endpointHost: url.hostname, endpointIdentityHash: sha(selected.baseUrl), timeoutMs: CONFIG.timeoutMs,
      immutableWeightsVerified: false, responseCache: false, credentialSource: completeEnv ? 'complete_environment_or_dotenv' : 'complete_saved_provider_store' } };
}

const safeFailure = error => ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.cause?.code)
  ? error.cause.code : ['TimeoutError', 'AbortError'].includes(error?.name) ? error.name : 'TRANSPORT_OR_CAPTURE_FAILURE';

async function send({ messages, context, config }) {
  const request = { model: config.model, messages, temperature: CONFIG.temperature, max_tokens: CONFIG.maxTokens };
  const body = JSON.stringify(request), physicalId = 'call_' + crypto.randomUUID();
  assert(!body.includes(config.apiKey), 'REQUEST_CREDENTIAL_ECHO_BLOCKED');
  const prefix = 'raw/physical/' + physicalId;
  write(prefix + '.request.json', body);
  append('ledgers/physical.jsonl', { event: 'request_started', physicalId, ...context, requestedModel: config.model, endpointHost: config.safe.endpointHost,
    requestHash: sha(body), requestPath: prefix + '.request.json' });
  const start = performance.now();
  let responseRecorded = false;
  try {
    const response = await fetch(config.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.apiKey }, body, signal: AbortSignal.timeout(CONFIG.timeoutMs),
    });
    const text = await response.text();
    assert(!text.includes(config.apiKey), 'RESPONSE_CREDENTIAL_ECHO_BLOCKED');
    write(prefix + '.response.txt', text);
    let envelope; try { envelope = JSON.parse(text); } catch { envelope = null; }
    append('ledgers/physical.jsonl', { event: 'request_completed', physicalId, ...context, status: response.status,
      elapsedMs: Math.round(performance.now() - start), responsePath: prefix + '.response.txt', responseHash: sha(text),
      returnedModel: envelope?.model ?? null, systemFingerprint: envelope?.system_fingerprint ?? null, usage: envelope?.usage ?? null,
      finishReason: envelope?.choices?.[0]?.finish_reason ?? null });
    responseRecorded = true;
    if (!response.ok) return { transportFailure: true, retryable: response.status === 429 || response.status >= 500, reason: 'HTTP_' + response.status, physicalId };
    assert(envelope?.model === config.model, 'RETURNED_MODEL_MISMATCH');
    return { content: envelope?.choices?.[0]?.message?.content, physicalId, finishReason: envelope?.choices?.[0]?.finish_reason ?? null };
  } catch (error) {
    if (!responseRecorded) append('ledgers/physical.jsonl', { event: 'request_failed', physicalId, ...context, elapsedMs: Math.round(performance.now() - start),
      errorCode: safeFailure(error), outcome: 'unknown_if_inference_completed', usage: null });
    if (responseRecorded) return { transportFailure: true, retryable: false, reason: 'RESPONSE_IDENTITY_OR_CAPTURE_FAILURE', physicalId };
    return { transportFailure: true, retryable: true, reason: safeFailure(error), physicalId };
  }
}

function interpret(response, validate) {
  if (response.finishReason === 'length') return { status: 'JUDGE_INVALID', category: 'output_contract', reason: 'TRUNCATED_OUTPUT' };
  try { return validate(parseJson(response.content)); }
  catch (error) { return { status: 'JUDGE_INVALID', category: 'output_contract', reason: error instanceof SyntaxError ? 'MALFORMED_JSON' : error.message }; }
}

export function createStageRunner(task, { development = false, replay = false, candidateHash } = {}) {
  return async function stage(name, input, prompt, validate) {
    const base = (development ? 'development' : 'regression') + '/stages/' + task.runId + '/' + name;
    const inputIdentity = sha({ input, prompt, config: CONFIG });
    if (exists(base + '.json')) {
      const saved = read(base + '.json');
      assert(saved.inputIdentity === inputIdentity, 'SAVED_STAGE_INPUT_CHANGED');
      if (replay && saved.responsePath) {
        const response = read(saved.responsePath);
        const envelopeText = fs.readFileSync(guarded('raw/physical/' + response.physicalId + '.response.txt'), 'utf8');
        assert(sha(envelopeText) === saved.envelopeHash, 'REPLAY_RAW_RESPONSE_CHANGED');
        const envelope = JSON.parse(envelopeText);
        const original = { content: envelope.choices?.[0]?.message?.content ?? null, finishReason: envelope.choices?.[0]?.finish_reason ?? null };
        assert(sha({content:response.content,finishReason:response.finishReason}) === sha(original), 'REPLAY_CAPTURE_CHANGED');
        const fresh = interpret(original, validate);
        assert(sha(fresh) === sha(saved.result), 'REPLAY_STAGE_RESULT_CHANGED');
        return fresh;
      }
      return saved.result;
    }
    assert(!replay, 'REPLAY_STAGE_MISSING');
    if (!development) assertFreeze();
    const config = credentials();
    if (!development) assert(sha(config.safe) === sha(read('freeze/candidate.json').provider), 'FROZEN_PROVIDER_CHANGED');
    const inputPath = base + '.input.json';
    if (!exists(inputPath)) write(inputPath, { inputIdentity, input, prompt, config: CONFIG });
    else assert(read(inputPath).inputIdentity === inputIdentity, 'INTERRUPTED_STAGE_INPUT_CHANGED');
    const messages = [{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}];
    const attempts = [];
    let response;
    for (let transportAttempt=1; transportAttempt<=CONFIG.maxTransportAttempts; transportAttempt++) {
      response=await send({messages,config,context:{runId:task.runId,caseId:task.caseId,stage:name,population:task.population,development,candidateHash,transportAttempt}});
      attempts.push({physicalId:response.physicalId,transportAttempt,reason:response.reason ?? null});
      if (!response.transportFailure || !response.retryable) break;
    }
    if (response.transportFailure) {
      const result={status:'JUDGE_INVALID',category:'provider_transport',reason:response.reason};
      write(base+'.json',{inputIdentity,inputPath,attempts,result});
      append('ledgers/stages.jsonl',{event:'stage_invalid',runId:task.runId,stage:name,development,result,path:base+'.json'});
      return result;
    }
    const responsePath=base+'.response.json';
    write(responsePath,{content:response.content ?? null,physicalId:response.physicalId,finishReason:response.finishReason});
    const result=interpret(response,validate);
    const envelopeHash=sha(fs.readFileSync(guarded('raw/physical/'+response.physicalId+'.response.txt')));
    write(base+'.json',{inputIdentity,inputPath,attempts,responsePath,envelopeHash,result});
    append('ledgers/stages.jsonl',{event:result.status==='JUDGE_INVALID'?'stage_invalid':'stage_completed',runId:task.runId,stage:name,development,resultHash:sha(result),path:base+'.json'});
    return result;
  };
}
