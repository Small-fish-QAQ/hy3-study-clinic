# Study Clinic 新版运行与验收

新版入口是 `apps/server/src/index.ts` → `app.ts` → `services/clinic.ts`，客户端入口是 `ClinicWorkspace.tsx`。旧 Map → Detail → Coverage Mapping、整课多轮 Review、规划型 Tutor、强制 Practice/Repair/Formal 推进和客户端成绩写口已退出生产。

[完整实施与验收报告](ARCHITECTURE_SIMPLIFICATION_IMPLEMENTATION.md) 记录 P0–P8、R01–R46、A01–A16 的工程覆盖与证据边界。

## 运行

使用 Node.js 24，执行 `npm ci`、`npm run build`、`npm run dev`。新版默认数据库为 `data/clinic-v2.sqlite`，从空库独立初始化。已有 `.env` 如果仍写 `DATABASE_PATH=./data/clinic.sqlite`，请改为新版独立路径；应用会拒绝旧 schema，保留原文件，不自动升级、清空或导入。

首次安装默认 MoMA 尚未配置。在“设置”保存 API Base URL、API Key、Model ID。设置可调整普通请求、长任务超时与输出 cap；连接测试仅由用户主动触发。服务端本地加密凭据，浏览器不保存 Key。GLM 推理储备为软估计，正文为零、截断或不确定仍会明确失败。未知费用/usage 保持未知。

真实 MoMA 集成记录见 [REAL_MOMA_INTEGRATION.md](REAL_MOMA_INTEGRATION.md)。当前通过流式响应接收完整正文与用量，未完成流不能发布。MoMA / glm-5.3 的知识提取、规划和题目作者使用实测的低推理强度，Lesson、独立解题、rubric核查和评分保留高强度；显式推理配置保持优先级。该端点行为经过真实调用验证，不代表所有兼容服务都支持该参数。

离线模式使用独立路径和显式配置：

```powershell
$env:LLM_PROVIDER='fake'
$env:VISUAL_PROVIDER='disabled'
$env:AUTOMATION_EXPECT_PROVIDER='fake'
$env:DATABASE_PATH='./data/clinic-v2-offline.sqlite'
$env:PROVIDER_CONFIG_PATH='./data/clinic-v2-offline-provider.json'
npm run dev
```

保存的 UI 模型配置优先于环境。Fake 只演示离线行为，不代表真实模型能力。`npm run eval:fake` 在内存库、禁止外网的环境验证当前新版合同；结果写 `output/architecture-implementation/offline-regression.json`，不改公开评测归档。

## 用户流程

1. 新建课程，导入完整教材或讲义。支持文本层 PDF、DOCX、PPTX、Markdown、HTML 与源码。扫描/OCR 和不能可靠提取的图表需要用户补充文字，不能视为已完整读懂。
2. 准备完整知识清单与课程规划。知识默认折叠，可调整 Lesson 深度后确认；不提前生成所有课文，也没有任意重排操作。
3. 点击任意 Lesson 才生成正文。正文的每个必学知识与目标必须定位到实质讲解；计算、推导、条件变化和疑似漏讲按需局部验证。先修是提醒，可以先学后课再回来。
4. Tutor 正常一次答疑。主动完成 Lesson 后可以直接选择下一课，也可以按需练习。回看保留原课文和对话；新问题进入独立 revisit 对话，不改旧课堂。
5. 所有题统一准入。客观题独立盲解且服务端比较答案，主观题再联合核查 rubric/来源。坏题仅局部替换一次；零有效题失败，正式卷缺核心覆盖保持 draft。提示曝光由服务端记录，答案草稿可以保存。
6. 错题可主动发起一轮补救与一次 Retest；本轮结束后可以以后再做，没有终身三次上限。Retest 更新日常诊断与复习建议，保留原错题和原正式成绩。
7. Formal 可在规划确认后独立自测，每次新卷按冻结核心能力与代表集合准备。客观本地判分、主观一次判分，异常最多一次复核；逐题持久后服务端签发总成绩。只给实际被测知识写正式证据，未抽到的知识仍未实测。
8. 所有 Lesson 主动完成即学习路线完成。Formal 未参加或失败不会撤销这一事实。学习记录保存课堂、聊天、作答、补救和每次正式考试；重启后继续读回。

Formal 草稿耗尽某题的内容替换额度后，可在学习记录中主动选择“补齐缺失题目”。该动作只为缺失能力建立新 slot，保留旧候选、错误、好题、蓝图和权重；同一命令不重复购买。技术恢复仍只补原候选的未完成核查，不能重置内容额度。未达到全部必需覆盖的草稿不能开考。

## 资源与恢复

`IMPORT_FILE_BYTES` 和 `IMPORT_TEXT_BYTES` 默认各 10 MiB，保留解析、解压、XML 与图像内存保护。没有全课程字符数、块数、知识数、Lesson 数、目标数或累计转移次数业务门。20,001 短段夹具实测约 0.2 秒解析，完整保留末段；峰值需结合目标机器与实际文档继续观察。

`HY3_TIMEOUT_MS` 默认 30,000；`LONG_TASK_TIMEOUT_MS` 默认 240,000，均可配置，240 秒不是固定上限。`MODEL_MAX_OUTPUT_TOKENS` 默认 64,000 仅为未知模型回退；`MODEL_CONTEXT_TOKENS` 可填写已知上下文。`MODEL_REASONING_ESTIMATE` 可覆盖软估计。`PROVIDER_CONCURRENCY=2`、`OPERATION_LEASE_MS=90000`、`OPERATION_HEARTBEAT_MS=20000` 为资源初值，heartbeat 必须小于 lease。

长操作返回 202。HTTP 离开不取消服务端工作，重载可查询操作。取消只通过明确命令；late 完整候选可私有保管，不能发布。重启标记 interrupted，不自动购买模型恢复。用户重试只处理未完成范围，成功提取包、课文、准入题和评分保留。上游已发出但结果不明记录 outcome_unknown，不承诺上游计费 exactly once。

## 真实模型 A16

本轮代码验证不调用真实付费 API。工程完成后由用户使用新版独立库重新导入原 MoMA/GLM 失败教材和一份正常教材，执行冻结施工资产 [MIGRATION_AND_ACCEPTANCE.md](architecture-simplification-plan/MIGRATION_AND_ACCEPTANCE.md) 的 A16 操作卡。

在检查输出前固定分层抽样规则、样本 ID 和分母：章节、核心能力、条件/例外、计算/例题，以及风险选择器没有标异常的普通解释。核实 source→K→Plan→实际教学锚点，并人工核查事实、解题条件、答案、替代答案、rubric 与代表性考核。结构集合 100% 和 Mock 成功均不证明教材语义全集。

记录实际 provider/endpoint/model、预算与有效 deadline、每阶段调用数、等待时间、input/output/reasoning、可见正文和成功/失败次数；不公开 Key 或私人教材。发现问题按失败 scope 修复并复验，不恢复默认整课 Review。至少原失败教材和正常教材完成全过程且抽审无实质缺陷后，才能报告真实模型产品验收结论。

也可由用户主动执行 `npm run eval:hy3 -- --allow-paid --materials "C:\path\textbook.pdf" --database "C:\path\clinic-v2-acceptance.sqlite" --output "output/real-clinic-acceptance"`。该命令先生成完整规划供人工审查，保存非秘密调用 metadata；不会自动替学生作答或宣称语义通过。UI 是完整 A16 教学与考试验收入口。没有 `--allow-paid` 时命令在任何模型请求前停止。

继续同一验收课程时，传同一 `--database` 与生成报告中的 `--workspace ID`，无需再次传 `--materials`，会复用保存的规划。人工审查规划后可加 `--continue-after-plan-review` 确认并按需复用/生成课文；该选项不会完成 Lesson 或自动答题。
