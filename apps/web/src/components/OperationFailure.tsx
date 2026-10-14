import type { CourseOperation } from '@hy3-clinic/shared';
export function OperationFailure({ operation }: { operation: CourseOperation }) {
  if (!operation.error) return null;
  const message = operation.error.message;
  const correctness = operation.error.code === 'GROUNDING_FAILED';
  const summary =
    operation.error.retryable === false
      ? message
      : correctness
        ? message.includes('quote')
          ? '讲解的引用定位未通过，需要修正对应段落。'
          : message.includes('局部修订')
            ? '局部修订的段落合并未通过，原候选已保存。'
            : '部分内容未通过正确性检查，已完成的有效成果会保留。'
        : operation.error.code === 'PROVIDER_TIMEOUT'
          ? '模型请求超时，已保存完整结果会在恢复时复用。'
          : message;
  return (
    <div className="clinic-operation-failure">
      <p>{summary}</p>
      {summary !== message && (
        <details>
          <summary>失败详情</summary>
          <p>{message}</p>
          <small>
            操作：{operation.id} · {operation.error.code}
          </small>
        </details>
      )}
    </div>
  );
}
