// Explicit user-run A16 entry. No request is sent unless --allow-paid is present.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../apps/server/dist/app.js';
import { loadConfig } from '../apps/server/dist/config.js';
import { openDatabase } from '../apps/server/dist/db/database.js';
import { acquireDatabaseLock } from '../apps/server/dist/db/processLock.js';
import {
  ProviderRuntime,
  JsonProviderConfigStore,
} from '../apps/server/dist/services/providerRuntime.js';
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (!argv.includes('--allow-paid'))
  throw new Error('真实模型验收需由用户明确执行 --allow-paid。当前没有发出模型请求。');
const materials = flag('--materials')?.split(';').filter(Boolean) ?? [];
const existingWorkspaceId = flag('--workspace');
if (!materials.length && !existingWorkspaceId)
  throw new Error(
    '首次验收请用 --materials "教材路径;其他资料路径" 指定完整教材；继续已保存课程请用 --workspace ID 和同一 --database。',
  );
const output = resolve(flag('--output') ?? 'output/real-clinic-acceptance');
mkdirSync(output, { recursive: true });
const database = resolve(flag('--database') ?? `${output}/clinic-v2.sqlite`);
const config = loadConfig(
  { ...process.env, DATABASE_PATH: database },
  { allowIncompleteProvider: true },
);
const release = acquireDatabaseLock(database);
const db = openDatabase(database);
const runtime = new ProviderRuntime({
  startup: config,
  store: new JsonProviderConfigStore(config.providerConfigPath),
});
if (runtime.providerName === 'fake') {
  db.close();
  release();
  throw new Error('A16必须选择真实模型；Fake不能作为真实模型验收。');
}
const app = buildApp({ db, provider: runtime.provider, providerRuntime: runtime });
const c = app.clinic;
const cmd = () => {
  const id = randomUUID();
  return { commandId: id, idempotencyKey: id };
};
const report = {
  mode: 'real-model',
  startedAt: new Date().toISOString(),
  workspaceId: null,
  steps: [],
  paidAuthorization: true,
  semanticAcceptance: 'PENDING_USER_AUDIT',
};
let workspaceId;
async function settle(op) {
  await c.operations.idle(op.id);
  const final = c.operations.get(workspaceId, op.id);
  report.steps.push({ kind: final.kind, status: final.status, error: final.error });
  if (final.status !== 'completed') throw new Error(final.error?.message ?? 'Operation incomplete');
  return final;
}
try {
  const workspace = existingWorkspaceId
    ? c.repo.workspace(existingWorkspaceId)
    : c.sources.createWorkspace(flag('--title') ?? '真实教材验收');
  workspaceId = workspace.id;
  report.workspaceId = workspaceId;
  for (const file of materials) {
    const bytes = readFileSync(resolve(file));
    const text = ['.md', '.txt', '.ts', '.js', '.py', '.cpp', '.java', '.html'].includes(
      extname(file).toLowerCase(),
    );
    await c.sources.import(
      workspaceId,
      text
        ? { title: basename(file), filename: basename(file), content: bytes.toString('utf8') }
        : { title: basename(file), filename: basename(file), dataBase64: bytes.toString('base64') },
    );
  }
  const sourceScopeHash = c.sources.scopeHash(workspaceId);
  let draft = c.planning.get(workspaceId);
  if (!draft || c.planning.inventory(draft).sourceScopeHash !== sourceScopeHash) {
    await settle(
      c.operations.start(workspaceId, cmd(), 'preparePlan', 'plan', 'curriculum', {
        sourceScopeHash,
      }),
    );
    draft = c.planning.get(workspaceId);
  } else {
    report.steps.push({ kind: 'preparePlan', status: 'reused', resourceId: draft.id });
  }
  if (!draft) throw new Error('完整规划尚未保存，请恢复对应准备操作。');
  writeFileSync(
    `${output}/planning-for-user-review.json`,
    JSON.stringify({ plan: draft, inventory: c.planning.inventory(draft) }, null, 2),
  );
  if (!argv.includes('--continue-after-plan-review')) {
    report.nextAction =
      '先人工检查完整K、目标、先修、深度和代表性蓝图。通过后在UI确认并继续课堂；此脚本不会把结构成功当语义通过。';
  } else {
    const plan =
      draft.status === 'accepted'
        ? draft
        : c.planning.confirm(workspaceId, draft.id, draft.version);
    for (const lesson of plan.lessons) {
      await settle(
        c.operations.start(workspaceId, cmd(), 'prepareLesson', `lesson:${lesson.id}`, 'lesson', {
          curriculumId: plan.id,
          lessonId: lesson.id,
        }),
      );
    }
    report.nextAction =
      '课文已生成并经过服务器检查，请在UI人工抽审后主动完成Lesson，再执行Practice、Repair和Formal真实作答。不要用自动答案代替学生/人工评分验收。';
  }
} catch (error) {
  report.failure = error instanceof Error ? error.message : '未完成';
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  report.calls = c.repo
    .rows(
      'SELECT id,method,status,provider_snapshot,payload FROM llm_calls WHERE workspace_id=?',
      workspaceId ?? '',
    )
    .map((row) => ({
      ...row,
      provider_snapshot: JSON.parse(row.provider_snapshot),
      payload: JSON.parse(row.payload),
    }));
  report.physical = c.repo
    .rows(
      'SELECT p.id,p.logical_call_id,p.status,p.payload FROM llm_physical_attempts p JOIN llm_calls c ON c.id=p.logical_call_id WHERE c.workspace_id=?',
      workspaceId ?? '',
    )
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  writeFileSync(`${output}/real-run-metadata.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        workspaceId: report.workspaceId,
        report: `${output}/real-run-metadata.json`,
        semanticAcceptance: report.semanticAcceptance,
        failure: report.failure ?? null,
      },
      null,
      2,
    ),
  );
  await app.close();
  db.close();
  release();
}
