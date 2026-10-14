import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

describe('localhost HTTP 课程准备', () => {
  it('在仅允许本机测试端点的独立进程验证保存配置、Runner、HTTP、持久化与确认', async () => {
    const script = fileURLToPath(
      new URL('../../../../scripts/verify-course-http.mjs', import.meta.url),
    );
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', script]);
    const result = JSON.parse(stdout.trim());
    expect(result.passed).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        'saved-provider-priority',
        'runner-dispatch',
        'HTTP-to-localhost',
        'timeout-persisted-with-unknown-upstream-outcome',
        'no-automatic-paid-retry',
        'free-question-and-validated-tutor-anchor-over-HTTP',
        'optional-reflection-durable-without-completion-gate',
        'module-formal-frozen-scope-grading-and-evidence-over-HTTP',
      ]),
    );
    expect(result.requests.every((request: { model: string }) => request.model === 'glm-5.3')).toBe(
      true,
    );
  });
});
