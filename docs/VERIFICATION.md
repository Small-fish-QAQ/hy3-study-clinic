# 验证与复现

[返回首页](../README.md) · [文档导航](README.md) · [运行指南](SETUP.md)

本页是 **Reproduction / Verification** 的统一入口。以下命令读取已保存证据，不重新运行模型实验。

| 要核查的结论           | 权威材料                                                                                                            | 只读命令                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 正式 Task 1 评估       | [StudyEval v2.0](../eval/studyeval-validation/README.md)：样本、判别力、人类对齐和一致性                            | `node eval/studyeval-validation/scripts/verify.mjs`          |
| 产品展示选集的原始依据 | [Product Showcase](PRODUCT_SHOWCASE.md)与[原内容审计](../eval/final-showcase/analysis/scored-01/content-audit.json) | 下项验证器重算 12 条符合原审计条件的完整旅程；不是新语义审查 |
| 补充端到端可靠性审计   | [Candidate 23 全部 20 课](../eval/final-showcase/README.md)：全部结果、负例、失败、重放与持久化                     | `node eval/final-showcase/publication/verify.mjs`            |

使用 Node.js 24，在仓库根目录执行：

```bash
node eval/studyeval-validation/scripts/verify.mjs
node eval/final-showcase/publication/verify.mjs
```

前者核对 207 次观察及原文件哈希，重算 StudyEval 参考匹配、排序、人类共识与 kappa；后者从全部 20 课保存的状态和快照重算流程与证据结果。两者不调用 Hy3，也不把结构一致当作语义真值。

完整 Candidate 23 SQLite 数据库、报文和冻结运行库位于[当前 Task 1 release](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/task1-final-2026-09-14-r2)的审计 ZIP；[归档哈希](../eval/final-showcase/publication/ARCHIVE.json)与[准备/重算步骤](../eval/final-showcase/README.md#freeze-and-reproduction)可直接核查。StudyEval 的[新在线复现步骤](../eval/studyeval-validation/README.md#reproduce-the-saved-results)只适用于另一次独立运行，不能替换已保存分数。

产品保持 Candidate 23 `84b3c2fbce7e6523e43a8fa66df42bb6e37fa149`；评估器保持 StudyEval v2.0 `64fdbc4d5fdcfffc3e10132f5881dec334803b8f`。冻结前的 2,878 项产品测试、22 项评估器测试及[三平台 CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/runs/34834786860)是该版本的工程证据。当前提交的 CI 徽章与工作流记录反映文档发布检查，不意味着重新执行评分实验。

## 历史机器证据的只读复核

[评测材料](../eval/final-evaluation/README.md)发布全部 209 个原始案例、279 次观察、327 条维度结果和冻结的八个方法模块。人类原件冻结后，全部来源/题目映射、逐题模型意见及人类去元数据答卷已经公开。运行：

```bash
node eval/final-evaluation/scripts/verify-publication.mjs
python eval/final-evaluation/scripts/verify-human.py
```

两个脚本分别使用 Node.js 内置模块和 Python 标准库，无网络或第三方依赖，不导入评估器。前者核对全部文件/输入/观察身份，重算机器指标、长度基线、产品可用率与成本；后者从六份 DOCX 副本逐格解析 68 条人类评分及原理由，核对原模型 CSV 后重算所有人工比较和歧义重合。已完成的 279 次原始响应重放有独立冻结凭据；公开脚本不重跑该历史重放或模型推断。

早期机器、人类和发布核验记录集中在[历史证据索引](HISTORY.md)。这些带日期的原记录不描述当前提交的发布状态。

## 历史在线验证（2026-07-31）

[历史 Hy3 在线记录](evidence/hy3-online-verification.md)及其 [JSON](evidence/hy3-online-verification.json)对应提交 `46d34f288d6c619d396ee5f39e12cb33249161da`，完成 6/6 项小样本操作，包含概念分析、对齐、语义评分、跨文档出题和 Tutor 首步。它早于当前课程准备与教学层，**不属于 2026-09-12 冻结最终 campaign**，不计入最终分母，也不代表当前完整课程链路的可用率或 StudyEval 成绩。原始日期、提交、计数和证据文件保持不变。

## 文档与媒体检查记录

以下检查是较早提交上的历史记录，保留其原始范围。

2026-09-12（Asia/Shanghai），在 Windows / Node.js 24.14.1 上完成了文档与媒体提交 `c3939c4b35f92b9bb735b0b82abf6af6d3ee3706` 的检查；产品代码基线为 `325dfa1051c6efa8e5f5617955b34683d516c144`。当次整理文档、示例配置和媒体，并为已有源码卫生检查声明 MP4 二进制类型。

| 检查                                           | 结果                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run build`                                | 通过；保留已有的大体积前端 chunk 提示。                                                       |
| `npm run lint`                                 | 通过；保留已有的一项 React Hook 依赖警告。                                                    |
| 公开证据、源码卫生、配置和 Provider 运行时测试 | 4 个测试文件、35 项通过；这是针对本次改动的检查范围。                                         |
| `npm run eval:fake`                            | 50/50 项结构检查通过；没有真实模型请求。                                                      |
| `npm run dev`                                  | 使用隔离的内存库与 Fake 保护配置启动成功；5173 页面、8787 API 及前端 API 代理均返回正常响应。 |
| 文档与媒体                                     | 相对链接及锚点核验、Markdown 格式检查、媒体哈希核验与敏感路径扫描通过。                       |
| 浏览器预览                                     | 本地 GFM/样式预览检查桌面与手机宽度，图集可展开、图片完整加载，MP4 可播放。                   |

原始视频已完整解码检查，公开副本与最终视频哈希一致。上述结果支持仓库呈现与本地复现，不是最终新样本教学评估或人工一致性实验。

## 本地标准检查

推荐 Node.js 24，在仓库根目录执行：

```bash
npm ci
npm run build
npm run lint
npm test
npm run eval:fake
git diff --check
```

`eval:fake` 要求 `VISUAL_PROVIDER` 未设置或为 `disabled`。若终端设置了其他值，PowerShell 先执行 `$env:VISUAL_PROVIDER = 'disabled'`，macOS / Linux 使用 `VISUAL_PROVIDER=disabled npm run eval:fake`。

构建覆盖 shared/server TypeScript 和 web TypeScript/Vite；lint 包含 ESLint 与仓库格式检查；测试覆盖各 workspace。`eval:fake` 使用 FakeProvider 和内存 SQLite，不需要密钥，也不会读取实际学习数据库。生成的报告留在被忽略的 `eval/reports/`。

仓库格式配置默认忽略 Markdown；文档修改可单独检查：

```bash
npx prettier --check --ignore-path .gitignore README.md "docs/*.md" eval/README.md
```

[CI 配置](../.github/workflows/ci.yml)覆盖 Linux Node 20/24 与 Windows Node 24。首页徽章显示远端工作流状态；未推送的本地提交应以本地检查为准。

生成的 `docs/evidence/` 文件由公开证据测试校验，保留生成器的原格式，不纳入上述文档排版命令。

## 有针对性的复核入口

| 想核对的边界                     | 现有测试                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 课程准备、来源分配与结构         | [coursePreparation.test.ts](../apps/server/src/services/coursePreparation.test.ts)、[curriculumMaterialization.test.ts](../apps/server/src/services/curriculumMaterialization.test.ts)                               |
| 证据支持与构念资格               | [objectiveAuthoritySemanticSupport.test.ts](../apps/server/src/services/objectiveAuthoritySemanticSupport.test.ts)、[formalConstructAuthority.test.ts](../apps/server/src/services/formalConstructAuthority.test.ts) |
| 正式证据与进度                   | [formalProgression.test.ts](../apps/server/src/services/formalProgression.test.ts)                                                                                                                                   |
| 教学执行                         | [LessonExecutionPanel.test.tsx](../apps/web/src/components/LessonExecutionPanel.test.tsx)                                                                                                                            |
| 配置与 Fake 隔离                 | [providerRuntime.test.ts](../apps/server/src/services/providerRuntime.test.ts)、[config.test.ts](../apps/server/src/config.test.ts)                                                                                  |
| 公开证据未泄露敏感信息且渲染一致 | [publishedEvidence.test.ts](../apps/server/src/eval/publishedEvidence.test.ts)                                                                                                                                       |
| 已跟踪源码卫生                   | [sourceHygiene.test.ts](../apps/server/src/sourceHygiene.test.ts)                                                                                                                                                    |

例如运行公开证据与源码卫生检查：

```bash
npm run test -w @hy3-clinic/server -- src/eval/publishedEvidence.test.ts src/sourceHygiene.test.ts
```

`npm run demo:offline` 是无需端口的核心 API 烟测。`demo:http`、`demo:graph`、`demo:adaptive` 需要正在运行的 Fake API，它们是较低层的历史流程检查，并不等于当前课程界面的端到端教学验收。运行前应使用[独立 Fake 配置](SETUP.md#确保体验过程使用-fake)。

## 真实请求与发布边界

`npm run eval:hy3` 需要显式 Hy3 凭证；它不在 CI 或测试中运行。它仍是小型接口评估，不是最终 StudyEval，也不是浏览器或人工验收。具体操作和分母见 [eval/README.md](../eval/README.md)。

`npm run eval:evidence` 会更新跟踪的公开证据，属于发布操作，不是只读校验。本次文档检查保留既有证据文件。新结果应在来源、样本、版本和适用范围都可核对后单独发布。

2026-09-12 的历史机器实验、两位独立模型审阅和人类标注已完成并保留；当前正式评估是冻结后的 StudyEval v2.0 验证。六份答卷缺少时间及外部帮助说明，原样保留此项限制。历史小型检查的失败结论保持不变，详见[当前评估状态](EVALUATION.md#当前状态)。机器或人类实验完成、模型一致、测试通过和演示成功均不能推导学习效果提升。
