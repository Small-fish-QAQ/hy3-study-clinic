import { z } from 'zod';

/** Local performance contract, separate from the source's truth authority. */
export const TransferTaskSchema = z.object({
  version: z.literal('unit-transfer-v1'),
  presentedExamples: z.array(z.string()).max(100),
  priorResponses: z.array(z.string()).max(100),
});
export type TransferTask = z.infer<typeof TransferTaskSchema>;

export const TransferPerformanceSchema = z.object({
  novelScenario: z.boolean(),
  sourcePrincipleApplied: z.boolean(),
  changedConditionExplained: z.boolean(),
  sourceBounded: z.boolean(),
  rationale: z.string().min(1).max(1000),
});
export type TransferPerformance = z.infer<typeof TransferPerformanceSchema>;

export const TRANSFER_CRITERIA = {
  novelScenario: '构造信息完整的新情境，不照搬课堂或之前作答',
  sourcePrincipleApplied: '把原文支持的概念、关系或规则用于情境并解释判断',
  changedConditionExplained: '改变关键条件，比较前后判断并解释原因',
  sourceBounded: '区分假设与原文事实，正确说明资料支持的边界',
} as const;
export const TransferCriterionSchema = z.enum([
  'novelScenario',
  'sourcePrincipleApplied',
  'changedConditionExplained',
  'sourceBounded',
]);

export function transferPerformancePassed(result: TransferPerformance | undefined): boolean {
  return Boolean(
    result?.novelScenario &&
    result.sourcePrincipleApplied &&
    result.changedConditionExplained &&
    result.sourceBounded,
  );
}

export function unitTransferPrompt(objective: string, round: number): string {
  return (
    `综合迁移检查：${objective}\n` +
    (round > 0 ? '请换一个与之前作答不同的情境，重新完成以下任务。\n' : '') +
    '1. 自己构造一个课堂示例之外的具体新情境，写清已知条件和需要作出的判断。\n' +
    '2. 结合资料说明你如何把这个目标涉及的概念、关系或规则用于该情境，并解释判断依据。\n' +
    '3. 改变一个关键条件，比较改变前后的判断及理由；资料不足以推出结论时，明确说明边界。\n' +
    '新情境是假设，不是资料中的事实。只复述原文、替换例子名称或写出结论而不解释，不能通过。'
  );
}
