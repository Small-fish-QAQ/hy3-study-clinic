/** Convert provider/planner prose into concise learner-facing language. */
export function learnerPlanText(value: string): string {
  const normalized = value.trim();
  const exact: Record<string, string> = {
    Foundations: '基础',
    Application: '应用练习',
    'Continue Bayes foundations': '继续学习 Bayes 基础',
    'It is prerequisite-valid and fits the available time.': '已满足先修条件，也符合当前时间安排。',
    'Follow prerequisites before transfer practice.': '先学习必要基础，再练习综合运用。',
    'Build the prerequisite model first.': '先建立必要基础。',
    'Apply the rule to representative cases.': '用典型例题练习这条规则。',
    'Keep all accepted topics.': '保留当前学习范围，但需要更多时间。',
    'Only optional content is eligible.': '这项建议只涉及可选或补充内容。',
    'Preserve the accepted deadline.': '保留当前目标日期。',
    'Prioritize repair before new material.': '先修复已有问题，再学习新内容。',
  };
  if (exact[normalized]) return exact[normalized];
  if (/^Advance the accepted objective set\b/i.test(normalized)) return '按当前学习目标继续推进。';
  if (/^Follow prerequisites first\b/i.test(normalized))
    return '先完成必要基础，再继续后面的学习。';
  if (/^Connect the course foundations\b/i.test(normalized)) return '把课程基础内容串联起来。';
  if (/^The proposed route explicitly defers\b/i.test(normalized)) {
    return '这份路线建议把部分可选内容放到后面学习，是否接受由你决定。';
  }
  return normalized;
}
