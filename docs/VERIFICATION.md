# 验证与复现

[项目首页](../README.md) · [结果解释](REPORT.md) · [运行指南](SETUP.md)

本文区分重算保存结果、检查本地实现和重新发起模型实验。前两类可以不配置真实模型；新的在线结果必须单独保留，不能替换已经发布的观察。

## 快速核验

只想了解完成度，可以先看[演示视频](DEMO.md)和[一次正式作答](DEMO.md#核对一次正式作答)，再看[全部 20 课结果](REPORT.md#产品运行与实际失败)。这条路径不需要安装应用。

要核对数字，下载或检出仓库，准备 Node.js 24 后运行下面两条命令；无需安装 npm 依赖或配置模型密钥。要自己点界面，则按本页的[固定样例操作](#固定样例操作)进行。两者分别检查保存的实验结果和当前应用操作。

## 重算当前保存结果

推荐 Node.js 24，在仓库根目录执行：

```bash
node eval/studyeval-validation/scripts/verify.mjs
node eval/final-showcase/publication/verify.mjs
```

两条命令都应以退出码 0 结束，并输出 `"passed": true`。关键字段如下，字段名与输出一致：

| 命令           | 应看到的关键结果                                                                                                                | 对应含义                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| StudyEval 校验 | `verifiedObservations: 207`；`fresh.controlled: { matched: 70, total: 72 }`；`fresh.strictTriplets: { matched: 22, total: 24 }` | 207 次观察含新样本的 126 次与人类案例的 81 次；三档材料等级与排序符合报告                              |
| 产品运行校验   | `courses: 20`；`funnel.completeJourney: 15`；`contentAudit.noMaterialDefectCompleteJourneys: 12`；`controls.credited: 0`        | 20 课中 15 课完成首个正式作答，后续助手复核有 12 课未发现实质缺陷；30 个实际提交的反例回答均未记为通过 |

这是保存记录的校验结果，`passed` 不表示 20 课全部成功。2026-10-01 在本地 Windows、Node.js 24.14.1 上，两条命令分别约 0.4 秒和 0.9 秒完成；不包含下载仓库或安装 Node.js 的时间。

它们不发起模型请求，不修改保存结果，也不证明判断的语义正确。产品校验引用原运行的持久化检查记录；要重新执行冷开 SQLite 与来源绑定检查，需要下载完整归档并使用冻结分析器。

归档、下载哈希、在线复现的准备步骤分别见 [StudyEval 证据包](../eval/studyeval-validation/README.md#reproduce-the-saved-results)与[产品运行证据包](../eval/final-showcase/README.md#freeze-and-reproduction)。模型别名和服务端随机性可能变化，新运行应使用新的输出目录。

## 固定样例操作

先按[运行指南](SETUP.md#环境与安装)安装依赖、构建，再用[独立 Fake 配置](SETUP.md#确保体验过程使用-fake)启动。打开终端打印的前端地址，确认侧栏显示“本地模拟模式”。这段操作不需要密钥，也不会调用真实模型。

使用仓库已有的[认知负荷测试材料](../eval/fixtures/cognitive-load-zh.md)。用文本编辑器打开，复制全文，包括 Markdown 标题；无需另找资料。

| 步骤 | 操作                                                                                                 | 应看到的结果                                                    |
| ---- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1    | 在“所有课程”中，新课程名称填“文档验收示例”，点击“创建课程”                                           | 进入该课程，有“主页”“课程资料”等入口                            |
| 2    | 打开“课程资料”，标题填“认知负荷与工作记忆”，粘贴测试材料全文，点击“添加文本资料”                     | 1 份资料、5 个引用片段，资料可用于学习                          |
| 3    | 回到“主页”，点击“设置课程”；全局学习深度选“基础理解”，保留默认资料、不填可选重点，点击“开始准备课程” | 准备完成后提示“课程准备需要你的决定”                            |
| 4    | 点击“检查课程结构”，审阅后点击“接受课程结构”，再回到“主页”                                           | 显示“学习路线已启用”，路线完成数为 0/2                          |
| 5    | 依次点击“继续学习”“开始学习”，等待讲解准备完毕，再点击“开始本节讲解”                                 | 出现讲解、来源按钮和“非正式检查 · 不计入正式进展”的选择题       |
| 6    | 点击“暂停”，刷新页面，随后点击“继续”                                                                 | 刷新后仍为“已暂停”，保留安排 1/2；继续后保留已呈现的第 1 段讲解 |
| 7    | 打开“问 Tutor”，发送“间隔重复为什么要分散到多天？”，收到回复后展开“参考资料”                         | 对话出现回复，引用可展开原文                                    |
| 8    | 不提交题目，打开“进展”                                                                               | “有正式通过证据的目标”为 0/1；阅读与追问没有自动授予通过        |

上述路径于 2026-10-01 在本地 Windows、Node.js 24.14.1 上逐步操作通过。Fake 使用预设模板，标题、目标和回复可能含模板文字；这条路径检查操作与状态。真实生成和评分请看[已保存的正式作答](DEMO.md#核对一次正式作答)。

使用内存数据库时，浏览器刷新保留记录，停止服务后记录消失。完成体验后，在启动终端按 Ctrl+C 停止服务；安装与启动所需时间取决于本地环境。

## 检查本地实现

安装依赖后，可运行标准检查：

```bash
npm run build
npm run lint
npm test
npm run eval:fake
git status --short --branch
git diff --check
```

构建覆盖 shared/server TypeScript 和 web TypeScript/Vite；lint 包含 ESLint 与默认格式检查；测试覆盖各 workspace。`eval:fake` 使用 FakeProvider 和内存 SQLite，不需要密钥，也不读取实际学习数据库。生成报告保存在被忽略的 `eval/reports/`。

`eval:fake` 要求 `VISUAL_PROVIDER` 未设置或为 `disabled`。如需覆盖终端变量，PowerShell 使用 `$env:VISUAL_PROVIDER = 'disabled'`，macOS / Linux 使用 `VISUAL_PROVIDER=disabled npm run eval:fake`。

[CI](../.github/workflows/ci.yml)覆盖 Linux Node 20/24 与 Windows Node 24，并校验冻结证据。首页徽章显示远端状态，尚未推送的改动以本地检查为准。历史检查通过记录见[历史索引](HISTORY.md)，不代表当前检出已自动重新通过全部测试。

如果本地完整测试出现 Vitest worker 的 `Timeout calling "onTaskUpdate"`，先核对是否还有断言失败。可在 PowerShell 中限制 worker 并发，再运行完整 `npm test`；测试范围和断言保持原样：

```powershell
$env:VITEST_MAX_FORKS = '4'
$env:VITEST_MIN_FORKS = '1'
$env:VITEST_MAX_THREADS = '4'
$env:VITEST_MIN_THREADS = '1'
npm test
```

这些变量只对当前终端及其子进程生效。记录复测结果时同时说明首次失败与并发设置，不能把带 worker 错误的运行计为通过。

## 按模块检查实现

| 修改的边界                | 已有检查入口                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 课程准备、来源与结构      | [coursePreparation.test.ts](../apps/server/src/services/coursePreparation.test.ts)、[curriculumMaterialization.test.ts](../apps/server/src/services/curriculumMaterialization.test.ts)                               |
| 证据支持与能力资格        | [objectiveAuthoritySemanticSupport.test.ts](../apps/server/src/services/objectiveAuthoritySemanticSupport.test.ts)、[formalConstructAuthority.test.ts](../apps/server/src/services/formalConstructAuthority.test.ts) |
| 正式进度与掌握            | [formalProgression.test.ts](../apps/server/src/services/formalProgression.test.ts)、[共享规则测试](../packages/shared/src/domain/formalProgression.test.ts)                                                          |
| 教学界面                  | [LessonExecutionPanel.test.tsx](../apps/web/src/components/LessonExecutionPanel.test.tsx)                                                                                                                            |
| 配置与 Fake 隔离          | [providerRuntime.test.ts](../apps/server/src/services/providerRuntime.test.ts)、[config.test.ts](../apps/server/src/config.test.ts)                                                                                  |
| 公开证据与源码卫生        | [publishedEvidence.test.ts](../apps/server/src/eval/publishedEvidence.test.ts)、[sourceHygiene.test.ts](../apps/server/src/sourceHygiene.test.ts)                                                                    |
| StudyEval 契约与 Provider | [评估器测试](../eval/studyeval/test)                                                                                                                                                                                 |

例如检查公开证据与已跟踪文件：

```bash
npm run test -w @hy3-clinic/server -- src/eval/publishedEvidence.test.ts src/sourceHygiene.test.ts
node --test eval/studyeval/test/*.test.mjs
```

`npm run demo:offline` 是无需端口的核心 API 烟测。`demo:http`、`demo:graph`、`demo:adaptive` 需要运行中的 Fake API；这些较低层流程不等于当前课程界面的完整教学验收。使用前按[独立 Fake 配置](SETUP.md#确保体验过程使用-fake)隔离真实模型设置。

## 文档检查

仓库默认格式检查忽略 Markdown，当前说明文档可单独检查：

```bash
npx prettier --check --ignore-path .gitignore README.md "docs/*.md" eval/README.md
git diff --check
```

合并或迁移文档后，检查相对路径、标题锚点、图片、视频与代码入口；核对主报告中数字的测量对象、分母和原始来源。文档分工见[维护约定](README.md#文档维护约定)。

冻结证据和媒体清单不做批量格式化。`docs/evidence/hy3-online-verification.md` 由 JSON 与生成器精确对应，保留原格式；展示媒体的来源与哈希保留在相应 manifest 中。

维护清理前，按[数据分类](../eval/README.md#数据保留与归档)检查文档、源码、测试、CI、verifier 导入和哈希清单中的引用。当前正式核验依赖的文件继续原位保留；只属于历史版本的数据，在证明完整快照可恢复并更新导航后，可以退出 main。`docs/evidence/` 中的 7 月 JSON 与 Markdown 仍受当前公开证据测试约束，不能作为普通旧文档搬走。

整理后运行全部标准检查、两个当前 verifier、CI 中的 `node --test eval/studyeval/test/*.test.mjs`、Fake 评估与离线烟测。核对相对路径、Markdown 锚点、媒体哈希、报告数字与 Git 跟踪文件，确认没有意外删除；历史 tag 的对象和提交指向、Release 正文与附件都应保持不变。若迁移当前证据，另需比较迁移前后的 verifier 输出和文件完整性。

## 历史结果的复核

2026-09-12 的 v1.5 包与旧发布审计已退出当前 main，完整材料保留在 `task1-final-2026-09-14-r2`（`df7bbd0`）和[对应 Release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/task1-final-2026-09-14-r2)。

按[历史检出步骤](HISTORY.md#进入历史版本)进入独立的历史工作树，再遵循该版本自带的 [README](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/task1-final-2026-09-14-r2/eval/final-evaluation/README.md)与执行协议使用其校验器。该版本公开全部 209 个冻结输入、279 次观察和六份匿名人类答卷，保留原分数、分歧与公开边界。

最新 main 的核验职责是当前 StudyEval v2.0、Candidate 23、产品测试和固定 Fake 流程。旧实验的命令与依赖属于对应历史版本，不要求它们持续在最新 main 下运行；历史路径和发布材料从[历史索引](HISTORY.md)进入。

## 新的模型实验与发布

`npm run eval:hy3` 需要显式 Hy3 配置，是小型接口与结构评估，不是 StudyEval 的六维质量评估。它不在 CI 中运行；操作范围和样本见[评测目录](../eval/README.md)。

`npm run eval:evidence` 会改写跟踪的公开证据，属于发布操作。核对已有文档时使用只读校验器。新的实验应另存来源、样本、版本、参数、失败和原始输出，明确范围后再发布。

真实教学生成、评估器验证、模型之间一致、人工评分和工程检查回答不同问题；学习效果需要另外设计实验。
