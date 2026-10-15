# Study Clinic 验证与复现

适用版本：V2（2.0.0）。

[运行指南](SETUP.md) · [结果与边界](REPORT.md) · [文档导航](README.md)

本地工程验证、保存结果核查、重新发起模型请求分别回答不同问题。以下工程命令不需要真实Key；使用干净检出与隔离目录，避免运行会写原验收基线的历史审计脚本。

## 当前工程命令

推荐Node.js 24。在只包含公开Git文件的新目录中：

```bash
npm ci
npm run build
npm run lint
npm test
npm run eval:fake
npm run verify:http
node --test eval/studyeval/test/*.test.mjs
node eval/studyeval-validation/scripts/verify.mjs
node eval/final-showcase/publication/verify.mjs
```

build先shared后server/web；npm test的pretest会重建shared，因此不要与依赖dist的回归并行执行。eval:fake使用内存库及CourseFakeProvider并阻断外网。verify:http通过本机HTTP替身检查Provider配置、派发、恢复、Tutor锚点与正式评分合同；不是MoMA真实请求。

这些命令可以写独立检出中的dist、测试临时目录和output。不会提供生产数据库或真实凭据。公开仓库不包含原用户库、完整实验账本或Key。

## 代表测试入口

| 范围                   | 当前测试                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 初始化、迁移与旧库保护 | [schema.test](../apps/server/src/db/schema.test.ts)                                                                                                                                                    |
| 黄金教学与恢复         | [Journey](../apps/server/src/services/clinicJourney.integration.test.ts)、[Recovery](../apps/server/src/services/clinicRecovery.test.ts)、[Restart](../apps/server/src/services/clinicRestart.test.ts) |
| 正确性、题目与Formal   | [Safety](../apps/server/src/services/clinicSafety.test.ts)、[Formal](../apps/server/src/services/clinicFormal.test.ts)、[Representative](../apps/server/src/services/clinicRepresentative.test.ts)     |
| 局部课文恢复与健康成果 | [lessonRevision](../apps/server/src/services/lessonRevision.test.ts)                                                                                                                                   |
| 成绩权限与归属         | [Security](../apps/server/src/routes/clinicSecurity.integration.test.ts)、[workspaceManagement](../apps/server/src/services/workspaceManagement.test.ts)                                               |
| Provider、auto与兼容   | [courseProvider](../apps/server/src/llm/courseProvider.test.ts)、[providerRuntime](../apps/server/src/services/providerRuntime.test.ts)                                                                |
| 当前界面与导航         | [ClinicWorkspace](../apps/web/src/views/ClinicWorkspace.test.tsx)、[FinalNavigation](../apps/web/src/views/FinalNavigation.test.tsx)                                                                   |

服务端测试加载已跟踪的[no-network](architecture-simplification-plan/tools/no-network.mjs)，替换fetch/http/net/tls外网入口。网络替身验证只证明HTTP合同，Fake验证只证明软件行为。

2026-10-14最终验收记录为363项（20/295/48），构建／类型、lint、离线与HTTP通过。当前正式整理的独立检出结果见[evidence摘要](evidence/v2/engineering-verification.json)。原日志留在本地，不以反复复跑累加测试数。

## 当前CI状态

CI配置覆盖Ubuntu Node20/24、Windows Node24的软件检查，以及两个历史证据verifier。2026-10-15，提交a86731732505e7d5018ec41705e90ab52b4b6f4f的[GitHub Actions运行](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/runs/38692121698)四个Job全部成功。该结果对应已推送V2业务版本，不依赖旧Hy3的CI。

正式里程碑的最终Commit、对应CI运行链接及四项Job结果随[Release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/v2.0-mobile-cloud-cup-2026)和release-verification.json附件记录。本次发布仅同步文档和公开素材，教学源码、Prompt与Schema保持冻结基线；仍以最终SHA的真实CI结果确认发布，不借用此前通过状态。

## 核对公开研究摘要

[metrics-summary.json](evidence/v2/metrics-summary.json)区分研究580次发送、103次受控实验、27请求冷启动、后续最终Lesson恢复和工程检查。[provenance.json](evidence/v2/provenance.json)记录源文件SHA256、冻结身份与摘要字段出处。

受控组完整输入／Prompt／Schema／模型／预算／deadline保持，low/high只在组内比较；不同freeze修复后的组分开。原始候选、失败与评价修订保留本地，公开摘要不提供私人教材全文。详细解释见[REPORT](REPORT.md)、[研究记录](RELIABILITY_AND_REASONING_STUDY.md)和[协议](REASONING_EXPERIMENT_PROTOCOL.md)。

## 界面体验

按[SETUP](SETUP.md)显式选择Fake或保存自己的真实连接。新建课程、载入原创示例或导入可授权材料，准备知识清单与Course Map，检查后确认；选择Lesson、追问Tutor、按需Practice，错答后可主动Repair/Retest；Formal自愿参加。重载后检查原课文、对话、答案草稿和记录。

真实模型会消耗用量，不作为本轮工程回归的一部分。已有课文只读查看不需要重新生成；不要为了验证持久化重新购买整课。

## 重新运行真实模型验收

真实实验应使用新的数据库和输出目录，记录provider/endpoint/model、完整参数、输入与版本身份、分母、用量、失败及内容评价。可使用已有脚本：

```powershell
npm run eval:hy3 -- --allow-paid --materials 'C:/authorized/material.md' --database 'C:/StudyClinicEvaluation/clinic-v2.sqlite' --output 'C:/StudyClinicEvaluation/run-01'
```

eval:hy3是保留的历史命令名，当前执行validate-real-course.mjs并使用实际生效Provider。没有--allow-paid会在发送前停止。先保存规划供人工检查；继续时使用相同绝对database与workspace。--continue-after-plan-review可能生成所有规划Lesson，不应当作轻量连接测试。

本次发布整理不重新运行此实验。正式工程验收不能代替教材语义审查，模拟答题成绩不能代替真实学生学习研究。

## 犀牛鸟历史证据

StudyEval v2.0历史verifier检查207次已保存观察与冻结方法；Candidate23 verifier检查20课历史Hy3流程及内容审查记录。这些保存结果保持原件，属于历史版本，不能替代V2 MoMA验收。原命令与完整归档见[历史索引](HISTORY.md)。

scripts/verify-clinic-integrity.mjs和本地研究／真人验收保护脚本依赖当时baseline与HEAD，属于历史保护工具，不纳入新用户默认检查；不要为让其通过而重建基线或覆盖旧日志。
