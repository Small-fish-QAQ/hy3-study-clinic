# 评测数据与脚本

[设计与评估报告](../docs/REPORT.md)负责解释实验问题和结果，[验证与复现](../docs/VERIFICATION.md)提供统一检查步骤。本目录保存方法、输入、原始输出和重算工具。

## 目录分工

| 位置                                                   | 内容与用途                                                |
| ------------------------------------------------------ | --------------------------------------------------------- |
| [studyeval](studyeval/METHOD.md)                       | 冻结的 StudyEval v2.0 方法、rubric、提示词和运行实现      |
| [studyeval-validation](studyeval-validation/README.md) | 冻结后验证的样本、构造参考、人类对齐、全部观察和校验器    |
| [final-showcase](final-showcase/README.md)             | 20 课产品运行的完整结果、控制回答、失败和归档             |
| [final-evaluation](final-evaluation/README.md)         | 2026-09-12 的 v1.5 历史方法、数据、独立模型比较与人类答卷 |
| [fixtures](fixtures)与[labels](labels)                 | 小型接口和结构检查的资料、对齐、评分与概念参考            |
| `reports/`                                             | 本地生成的报告，被 Git 忽略                               |

目录中的 `final` 是原实验命名。当前 StudyEval 验证与 20 课产品运行回答不同问题；历史 v1.5 不并入当前成绩。保存的产品例子集中在[演示与案例](../docs/DEMO.md#保存的学习案例)。

冻结协议、数据、运行时与原始分析保持原字节。首页、主报告及未纳入冻结清单的目录 README 可以更新导航与解释。历史 `final-evaluation/README.md` 自身受哈希保护，保留原文；不能通过改写冻结文件修正实验结果。

## 只读复核

```bash
node eval/studyeval-validation/scripts/verify.mjs
node eval/final-showcase/publication/verify.mjs
```

这些命令检查保存结果，不请求模型。需要重新执行原 SQLite 审计或在线推断时，使用对应证据包 README 的准备步骤，输出写入新的目录。

历史机器结果与人类原答卷另用：

```bash
node eval/final-evaluation/scripts/verify-publication.mjs
python eval/final-evaluation/scripts/verify-human.py
```

历史包公开全部 209 个冻结输入、279 次观察、匿名对应关系、模型 CSV 和六份人类答卷副本。公开副本保留答案 XML 内容，排除识别性文档元数据；原始供应商与数据库归档有另外的公开边界，详见该包说明。

## Fake 结构评估

```bash
npm run build
npm run eval:fake
```

该脚本启动进程内的实际服务与内存 SQLite，使用 FakeProvider，不加载根目录 `.env`，不需要网络或密钥。如果终端设置了视觉配置，应保证 `VISUAL_PROVIDER=disabled`；两种结构评估脚本都会在 Provider 工作开始前拒绝启用视觉路径的配置。

检查范围包括：

- 资料块位置、概念来源、异常文本处理和原文引用的逐字核对。
- 对齐的规范化、语义合并提案、未经允许的修改和来源图保留。
- 跨文档出题范围与客户端答案隔离。
- Tutor 调用预算、检索边界、工作区隔离和注入样本文本后的状态变化。
- 误解状态转换、固定时钟下的复习调度、掌握边界与数据库外键。
- 可执行活动、重复提交、已失效题目以及课内教学不授予学习状态的约束。
- 长资料分节、概念参考召回和增量加深时保留既有概念记录。

这些检查验证具体的结构和状态行为，不给真实教学质量打分。Fake 的同输入操作可以确定执行，但完整流程仍可能生成新 ID 和后续输入，因此不承诺全文与排序逐次相同。报告输出到 `eval/reports/eval-fake.json` 和 `eval-fake.md`。

## 真实 Hy3 接口评估

按[运行指南](../docs/SETUP.md)显式配置 `HY3_BASE_URL`、`HY3_API_KEY`、`HY3_MODEL` 和 `VISUAL_PROVIDER=disabled` 后，可另行运行：

```bash
npm run build
npm run eval:hy3
```

脚本读取根目录 `.env`；没有真实凭证时直接失败，不回退到 Fake。它不在 CI 中执行。

这是一组小型接口评估，检查首次结构化输出、有界修复、来源接受、对齐与评分参考一致、跨文档证据、Tutor 首步、调用数和延迟，不实现 StudyEval 的六维质量评估。

六个兼容必需操作分别为资料 A 概念提取、资料 B 概念提取、对齐、评分、跨文档测评和 Tutor 首步。可选的 `semantic_recall` 检查长文档概念召回，`lesson_generation` 检查教学卡片与引用；它们一旦出现也必须成功。概念提取数量不代表图关系数量，完成可选操作也不代表百分之百召回或教学正确。

原始报告记录提交、分支、工作区是否干净、实际 Provider 与模型、无 Fake 回退、接口主机名、运行环境、请求及用量。接口路径、查询参数和凭证不进入公开身份。

## 发布接口评估摘要

成功的新运行需要在干净工作区完成，随后可发布经清理的摘要：

```bash
npm run eval:hy3
npm run eval:evidence
```

`export-evidence.mjs` 从被忽略的原始 JSON 生成 `docs/evidence/hy3-online-verification.json` 与同名 Markdown。它检查真实 Provider、Git 身份、操作完整性、参考比较和跨文档证据，并校验结构、敏感值和精确渲染一致性。配置中的密钥只用于检查，不会打印匹配值。

公开摘要只保留允许的聚合字段，排除逐样本 detail、提示词、学生与模型正文、接口路径和本地路径。发布命令会修改跟踪文件和生成时间，不能用于日常只读验证。[公开证据测试](../apps/server/src/eval/publishedEvidence.test.ts)检查 JSON 与 Markdown 的对应关系。

## 参考标签与范围

结构夹具的 `labels/*.json` 标记为作者手写参考，其中有四个对齐标签、三个评分答案以及长文档必须识别的概念列表。这些少量参考与 StudyEval 的构造标签、人类评分各自独立，不能混为通用金标准。

已有[真实调用摘要](../docs/evidence/hy3-online-verification.md)记录的是 2026-07-31 的早期提交 `46d34f2`，早于当前课程与教学层。它的六项操作结果不能替代当前完整课程评估。其他历史背景见[历史索引](../docs/HISTORY.md)。
