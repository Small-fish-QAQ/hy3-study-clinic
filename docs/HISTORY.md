# 历史结果与发布记录

[当前设计与评估报告](REPORT.md) · [验证与复现](VERIFICATION.md)

本页定位过去版本、原人类评分和发布过程。当前结论集中在主报告；历史实验在对应 tag / commit 下阅读与复现，main 不复制完整旧实验包或旧报告。


## 当前V2与阶段原件

2026-10-14的已验收产品基线为9ec6bde693455eac3df00e33984d9e0e0d9d8c93。当前[产品与研究](REPORT.md)、[架构](ARCHITECTURE.md)、[运行](SETUP.md)、[验证](VERIFICATION.md)和[CHANGELOG](../CHANGELOG.md)分别维护V2入口。拟议第三个Tag为v2.0-mobile-cloud-cup-2026，尚待A/B/C成品整合与最终审阅，未创建。

Phase4、精简实施、UI／准备恢复、首轮真实修复、MoMA集成、单元Formal、Goal A/B研究和最终真人验收按各自日期保留。旧schema／预算／A16待执行等文字是当时状态，不覆盖现行源码。阶段完整研究见[RELIABILITY_AND_REASONING_STUDY](RELIABILITY_AND_REASONING_STUDY.md)，最终验收见[FINAL_HUMAN_ACCEPTANCE_20261014](FINAL_HUMAN_ACCEPTANCE_20261014.md)。

整理前的[README](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/9ec6bde693455eac3df00e33984d9e0e0d9d8c93/README.md)、[REPORT](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/9ec6bde693455eac3df00e33984d9e0e0d9d8c93/docs/REPORT.md)、[ARCHITECTURE](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/9ec6bde693455eac3df00e33984d9e0e0d9d8c93/docs/ARCHITECTURE.md)、SETUP与VERIFICATION可从同一固定Commit恢复；该Commit目前只在本地，正常Push后这些GitHub链接才可访问。

历史Hy3／StudyEval指标不计入当前MoMA结果。下面原历史索引、Tag指向和维护审计保留。

## 长期维护与历史快照

`main` 是唯一长期开发主线。后续活动继续在同一仓库演进；短期分支合并后，确认没有独有提交、重要检查点已由固定快照保留，再移除分支。已完成的比赛版本通过 Git tag 与 GitHub Release 固定，不依靠长期分支。

| Tag                                                                                                                    | 固定提交  | 用途                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| [issue-4-final](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/issue-4-final)                         | `c67ac6d` | 2026-07-31 实战交付，已发布 Release                            |
| `pre-dogfood-complete`                                                                                                 | `e906937` | 早期功能与体验检查点，本地 tag                                 |
| `post-red-team-correctness`                                                                                            | `9a78904` | 正确性修复检查点，本地 tag                                     |
| `pre-dogfood-correctness`                                                                                              | `0407bb8` | 后续体验前的正确性检查点，本地 tag                             |
| `pre-v2-upgrade`                                                                                                       | `e096066` | v2 升级前检查点，本地 tag                                      |
| `pre-v2-implementation`                                                                                                | `b828ec1` | v2 实现前检查点，本地 tag                                      |
| [task1-final-2026-09-14-r2](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/task1-final-2026-09-14-r2) | `df7bbd0` | 2026-09-14 最终 Task 1 交付，已发布 Release 与完整产品审计归档 |

五个本地检查点 tag 尚未发布到远端。当前两个正式证据包仍在 main；最终 Task 1 tag 同时固定了当时的完整产品、v1.5 历史材料、StudyEval v2.0 验证与 Candidate 23 运行。归档以 Git 快照中的实际文件为准；Release 附件中的产品审计 ZIP 不代替 v1.5 包。

## 历史实验与材料

下表的原路径均位于 `task1-final-2026-09-14-r2`，固定提交为 `df7bbd04ee03fcbadaf3e790351a2f23c55fdc52`，发布入口为[最终 Task 1 Release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/task1-final-2026-09-14-r2)。它们不再作为当前结果的证据分母。

| 日期 / 版本                 | 历史材料                                                                                                                                                                                                                                                        | 当时的用途                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 2026-09-12 / StudyEval v1.5 | [完整证据包](https://github.com/Small-fish-QAQ/hy3-study-clinic/tree/task1-final-2026-09-14-r2/eval/final-evaluation)、[评估报告](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/EVALUATION_RESULTS.md)                 | 209 个冻结输入、279 次观察、旧 evaluator、模型比较、失败、基线与成本 |
| 2026-09-12 / 原人类评分     | [标注分析](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/HUMAN_VALIDATION.md)、[六份公开答卷及对应关系](https://github.com/Small-fish-QAQ/hy3-study-clinic/tree/task1-final-2026-09-14-r2/eval/final-evaluation/human) | 保留 68 条原评分、理由与分歧；与当前 v2.0 的重新比较区分             |
| 2026-09-12 / 事后诊断       | [证据诊断](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/EVIDENCE_DIAGNOSTICS.md)                                                                                                                                      | 分解旧结果的失败，不修改原分数                                       |
| 2026-09-12 / 中期发布       | [中期发布审计](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/evidence/interim-final-publication-audit.md)                                                                                                              | 当时的人类评分待完成、部分数据暂缓公开状态                           |
| 2026-09-12 / 完整发布       | [最终发布审计](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/evidence/final-publication-audit.md)                                                                                                                      | 原人类评分整合、完整输入公开与隐私边界                               |
| 2026-09-14 / Task 1 交付    | [交付审计](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/docs/evidence/submission-audit-2026-09-14.md)                                                                                                                      | 当时的归档、截图、运行环境与发布检查                                 |

六份报告后来迁入 `docs/history/` 的版本，保留在已发布提交 [`98f01d7164b5b4efdcb5daeae4719328889e33c6`](https://github.com/Small-fish-QAQ/hy3-study-clinic/tree/98f01d7164b5b4efdcb5daeae4719328889e33c6/docs/history)。查原实验使用上表的 tag 与原路径；查文档迁移状态使用该 commit。

[7 月真实调用摘要](evidence/hy3-online-verification.md)与 JSON 仍由当前公开证据测试共同核验，故留在 main。其运行固定于 `46d34f2bdacb9dc0b1671bbb9e12cb33249161da`，归属 [issue-4-final Release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/issue-4-final)，不代表当前完整课程可用率。

## 进入历史版本

在仓库根目录为旧实验建立独立的工作树，避免覆盖当前未提交改动：

```bash
git worktree add --detach ../hy3-study-clinic-task1-history task1-final-2026-09-14-r2
cd ../hy3-study-clinic-task1-history
```

选择一个尚不存在的目录。若新克隆中没有该 tag，先运行 `git fetch origin tag task1-final-2026-09-14-r2`，再核对 `git rev-parse HEAD` 等于 `df7bbd04ee03fcbadaf3e790351a2f23c55fdc52`。随后遵循该版本自带的 [README](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/eval/final-evaluation/README.md)、协议与 verifier；旧实验的命令和依赖不属于最新 main 的核验契约。

历史报告、冻结协议、输入、输出与公开答卷保持原内容。当前 v2.0 已保留自己使用的人类评分规范化副本与映射；从原 DOCX 重新提取旧评分时使用上述历史工作树。冻结说明中的原研究路径和当时状态仅记录来源，不能据此把旧实验混入当前结果或重新评分。

## 维护审计与暂缓事项

2026-10-06 第一轮审计移除了已完全进入 main、且被最终 Task 1 tag 覆盖的 15 个本地分支（10 个 `claude/*`、3 个 `codex/*`、2 个 `feat/*`）。两个远端 `feat/*` 也被 `issue-4-final` 覆盖，没有 PR、未完成 CI 或保护规则，已移除。第二轮核对旧包全部 594 个文件与最终 tag 逐字节一致后，移除了 main 中的 v1.5 副本及六份旧报告，历史入口集中于本页。

`backup/ui-proof-identity` 保留，独有提交 `da38455` 尚未被 tag 覆盖。它主要是旧视觉主题、品牌图片与 Manrope 字体；其中 Escape 菜单修复已在 main 的 `b6cd73e` 独立移植并扩大测试。建议不整包合并；若希望长期保留设计实验，可经人工决定另建 archive tag 后处理分支。本次不创建 tag 或删除该分支。

已有 detached worktree、仓库外研究材料和被忽略的 `eval/reports/eval-hy3.*` 暂缓清理，尚未证明其独有内容已有可靠归档。本次未改动 tag、Release 或提交历史。
