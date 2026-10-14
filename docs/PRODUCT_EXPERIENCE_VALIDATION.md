# 课堂体验完善与真实单元验收

2026-10-13。本轮保留 V2 简单内核、连续阅读和成熟松绿/象牙视觉；未恢复 Detail、Coverage Mapping、默认多轮Review、强制先修/补救/考试、独立 Risk 或 Red Team 工作流。没有commit/push。

## 旧版调查与实际改动

阅读保护快照的 `StudySessionView.tsx`、`LessonExecutionPanel.tsx`、`StudyTutorSurface.tsx`、`TutorPanel.tsx`、`styles.css`、`studio.css`、Formal/CoverageRisks/MasteryRedTeam实现和截图04/07/08/13/15。旧版的可复用价值是近选区入口、独立引用气泡、Enter发送/Shift+Enter换行、安静阅读层级、单元考核与诚实未验证提示。旧版引用却绑定Lesson execution版本/段落学习状态，风险与挑战也有独立生命周期，本轮没搬回这些依赖。

原/当前CSS的纸面token其实同有纯白 raised surface，旧截图柔和还来自字体、绿色墨色、背景/辅区层级和阅读宽度；不能简单断言原纸面都是黄色透明。正文改为温和的 `#fffdf7`、墨色 `#2e4035`、字重400，保留原字体/插画/边框，Tutor使用邻近暖色。真实浏览器确认引用卡宽与正文相同（693px），仍默认折叠。窄屏真值表自身可横向滚动，整篇讲解/学习容器不横向溢出。

主要源码：

| 范围 | 修改文件 | 行为 |
| --- | --- | --- |
| 选区/引用 | `apps/web/src/components/useLessonSelection.ts`、`ClinicClassroom.tsx`、`ClinicWorkspace.tsx`、`clinicApi.ts` | 在可见选区旁出入口；跨段仅提取教学文字；滚动/resize重新定位；打开Tutor保留自由问题；引用和问题分别显示/保存；窄屏仍为可关闭、圈定焦点的Tutor层 |
| 服务端引用 | shared `CourseTutorAnchorSchema`、`normalizeLessonSelection`；server `courseLessons.ts`、routes | 课文版本/连续段落/文字匹配先校验，伪造引用在模型前拒绝；完整上下文发送；旧完成课堂新问题进入revisit，不写原turn |
| 可选课堂思考 | shared `lessonInteraction.ts`、`LessonReflectionSchema`；server `lessonReflections.ts`、schema5；web `ClinicReflection.tsx` | 只有明确optional_prompt有任务；已发布正文仅识别明确“作为练习性的思考（可选）”标记，例题/问句不普遍变按钮。保存/延后/跳过/返回有版本保护，不需模型、不写分数、不阻塞完成；Tutor可提示/检查/参考思路 |
| Lesson作者意图 | `coursePrompts.ts`、`courseContract.ts`、`courseLessons.ts` | 解决“可选互动”与“不要练习题”的冲突：单独可选段落、少量自然任务、示范仍为正文，任务不充当coverage；局部修订保留偏好 |
| 单元 Formal | `unitAssessment.ts`、`courseQuestions.ts`、`courseGrading.ts`、routes；web `ClinicFormal.tsx`、Plan/Classroom/Records | 从确认map投影模块目标/知识，保留cells等级/权重/代表规则，服务端重新限定范围。quiz与grade保存scope；学完单元给自愿建议，未学也可自测；综合卷仍共存；不新增规划模型调用 |
| Risk/Red融合 | `clinic.ts`、`ClinicRecords.tsx`、`courseQuestions.ts`、Prompts | 展示未学/未实测/延期/诊断/资料疑点；直接利用现有记录。作者收到真实深度/目标/诊断，可公平考条件变化/错误/反例/迁移；准入沿用独立盲解/rubric，不增加挑战调用链 |
| 实际数学排版 | `StudyText.tsx`、`clinic.css` | 真值表紧贴前后解释也渲染表格；内容依然escaped React文字；修复grid内部最小宽度使手机正文不被表格撑宽 |

思考是**学习备忘与答疑**，没有另造一套考试系统。服务端不接受客户端对课堂任务写“评分/掌握”。主观检查由Tutor提供形成性反馈，只有已有可信Practice/Retest/Formal准入及评分能更新相应诊断/正式证据。

## 工程与真实验证

全量 **284测试通过**：shared20、server219、web45；后续跨段选区调整的6个相关测试再次通过。shared/server/web生产构建、eslint/prettier、离线golden主流程、localhost HTTP Mock均通过。HTTP Mock覆盖本轮引用/自由问题/思考保存/模块Formal及评分证据，外部URL全部禁止；不能用该结果证明真实模型能力。

真实验收通过生产HTTP接口，MoMA / glm-5.3原配置，隔离库 `output/product-experience-validation/real.sqlite`。完整资料/83K/14课map复用前轮已验证成果和21个物理准备调用，保留normalizedDocument和214来源块，未购买新整课。新的代表单元“真值表法”两课均真实生成和局部核查；2次Tutor、思考操作、Practice、Repair/Retest、单元Formal、评分/证据以及冷重启均完成。

Practice故意错误答案16.7%；Retest正确答案100%；单元Formal1题含3小问，真实评分100%。这是模拟学习者，**不是用户成绩或无辅助真人学习效果**。Formal实际测了2K，单元另5K/全课程81K未实测。其他12节未生成，三档非standard未分别付费试教；原PDF扫描字节未核对。

成本：新增23物理请求，22用量已知；input128,003/output35,846/reasoning10,121（内含于output）。一次404用量未知，金额/币种未知。坏Formal结构和重复Retest各仅局部替换一次；404后仅恢复同一评分，不再买整卷。详见 [教学质量评审](real-course-evaluation/TEACHING_QUALITY_REVIEW.md) 与完整账本。

证据文件在 `output/product-experience-validation/`：`acceptance-audit.json`、`call-ledger.json`、`candidate-rejections.json`、`depth-verification.json`、`history-before-restart.json` / `history-after-restart.json`、各阶段原请求/结果、测试与构建日志。冷重启hash核实课堂/成绩/证据/思考/诊断一致。

## 浏览器截图

真实浏览器检查1440×1000、1024×768、390×844；选择/引用、窄屏Tutor/Escape、任务返回、考核范围选择、冻结作答回看；页面控制台无产品错误。下面均为本地实际页面，标题明确隔离模拟学习者。

- [原快照课堂](../output/architecture-implementation/source-snapshot/docs/media/screenshots/04-structured-teaching.webp)、[改动前V2](../output/playwright/product-experience/before-reading.png)。
- [就近选区入口](../output/playwright/product-experience/selection-near-text.png)、[引用与自由输入](../output/playwright/product-experience/tutor-quoted-composer.png)、[展开来源对齐](../output/playwright/product-experience/source-notes-aligned.png)。前三张使用原真实内容的离线界面库，仅UI检查。
- [本轮真实连续课文](../output/playwright/product-experience/real-reading-desktop.png)、[手机阅读](../output/playwright/product-experience/real-reading-mobile.png)、[平板阅读](../output/playwright/product-experience/real-reading-tablet.png)。
- [真实可选课堂思考](../output/playwright/product-experience/real-reflection-desktop.png)、[引用后等待发送](../output/playwright/product-experience/real-reflection-quote.png)、[手机Tutor](../output/playwright/product-experience/real-tutor-mobile.png)。
- [单元Formal入口](../output/playwright/product-experience/unit-formal-desktop.png)、[单元入口手机](../output/playwright/product-experience/unit-formal-mobile.png)、[真实试卷与作答](../output/playwright/product-experience/real-formal-result-desktop.png)、[窄屏作答回看](../output/playwright/product-experience/real-formal-result-mobile.png)。入口图是离线UI检查，实际出卷/评分图来自MoMA验收。

## 数据与工作区保护

3,142个快照文件hash一致，Git HEAD未改变，源码未回退；原模型配置与加密key字节不变。原main数据库文件hash不变，但**不能声称原DB/WAL整体零变化**：用户原8787 tsx服务监听源码重载，自动进行了V2 schema4→5的新增表初始化；原库WAL因此变化，空 `lesson_reflections` 表新增，没有删改原教材/课程/配置/成绩。旧8788学习库main文件hash保持、schema仍4，WAL也有变化（基线对照时打开已有课文及运行服务的bookkeeping），未覆盖用户学习记录。准确保护证据见 `protection-final.json`。

测试库、前轮验收、用户体验库与源码快照全部保留。没有清理现有真实库、重建旧架构、修改原凭据、commit/push。临时8790离线服务与8791验收服务结束后按PID/启动命令确认停止；原5173/8787/8788服务不停止。

## 继续学习入口

另有干净学习库 `output/product-experience-validation/learner.sqlite`：完整确认map、原教材83K、模块02两节真实课文；**未复制模拟对话、思考答案、提交、正式成绩或Repair**。

打开 <http://127.0.0.1:8792/#workspace=workspace_09597a75-9857-4a64-a71d-e987c5bbfdba>，展开模块02“真值表法”，已有两课阅读不需重新购买。新Tutor提问、其他未准备Lesson或出题等主动操作会调用真实模型。设置写独立文件，原配置只读。

服务关闭后在仓库根目录运行：

```powershell
node output/product-experience-validation/serve.mjs --allow-paid --database output/product-experience-validation/learner.sqlite --port 8792 --request-limit 40
```

这是本地受控体验服务的40请求保护，不是产品的课程/学习/题目上限。用尽后先核对记录再明确提高，源产品不受这段验收脚本约束。教学内容全文与严格评分评审已交付；真人教学效果、其余深度/课程与真实货币费用边界仍需用户进一步判断。
