# Study Clinic V2 首轮真实使用定向修复

2026-10-12。范围仅为课程准备调用链、教学深度与资料页顶部。现有真实数据库只读检查；没有解密用户凭据、调用付费模型、修改用户配置、清理数据或 commit/push。

## 1. 课程准备的首个实际失败位置

只读证据来自 `data/clinic-v2-real-a16.sqlite`，详见 [existing-evidence.json](../output/architecture-implementation/first-real-use/existing-evidence.json)。

| 时间（北京时间） | 操作 | 事实 |
| --- | --- | --- |
| 14:30:35 → 14:34:35 | `operation_6782017d-0376-4539-8a02-6462e8215f3c` | 首次提取调用约 240,012 ms 后超时；没有响应头或用量。 |
| 16:30:47 → 16:34:47 | `operation_52726834-1746-44c4-a387-eb970f8999db` | 0/214 片段，首次提取调用约 240,030 ms 后超时；没有响应头或用量。 |
| 16:36:52 → 16:38:12 | `operation_520f85ee-4032-4b52-8aaf-603d508b1a05` | 同一提取路径约 80,028 ms 后取消；不是成功或自动重试。 |

三次逻辑调用均为 `extractCourseKnowledge`，记录的 Provider 均为 `moma`、模型 `glm-5.3`，端点身份一致，匹配已保存 MoMA API base。每个操作只有一次物理尝试，状态为 `outcome_unknown`。没有有效缓存或知识清单。

执行链核查：

1. `ClinicWorkspace` → `clinicApi.prepare` → `POST /course-plan/prepare` 创建 queued 操作。
2. `CourseOperationRunner.start()` 捕获所选实例，微任务执行 queued → running；本次记录证明任务已领取，已进入知识提取。
3. `CourseGeneration.stage()` 持久化模型/端点/运行身份；现有记录明确排除 Fake 结果和未调度。
4. `HttpCourseProvider.invoke()` 的预算预检通过，构造约 **79,965 bytes** 请求，`max_tokens=64,000`；记录标记请求发起，随后调用 `fetch`。
5. **首个已证实的失败是 HTTP 等待响应头超时**，发生在候选解析、教学校验和持久化之前。`headersReceived=false`、`bodyReadCompleted=false`、`httpStatus=null`、`usage=null`；没有错误 JSON 或错误状态转换被当作完成。
6. 前端的 0/214 是“已返回、通过校验并保存”的数量，并不是发出请求数量。原界面只显示提取阶段，缺少请求状态，容易误判没有调用。

**证据边界：** 请求发起记录不等于上游已接收、完成或计费。当前服务已经停止，历史连接探测没有持久化请求快照；不能反推当时草稿探测的全部参数。代码与本机 HTTP 验证证明已保存配置下的连接测试和正式准备使用同一 API 路径/模型，并证明运行中的操作保持自己的实例。现有记录无法确定 MoMA 网关/推理服务为什么没有返回响应头，不能把未知用量写成零，也不能声称上游问题已被离线验收解决。

### 已修复的源码缺陷与最小改动

原知识分包按 `outputCap * 1.5` 的 UTF-8 字节容量装包，与实际 HTTP 的消息、合同、可见输出和推理预算使用不同估算。该教材 214 片段全部装入一个包：可见目标 **59,383** ＋软推理估计 **20,000** 大于 64,000；请求仍按 64,000 发出。这个容量缺陷可确定复现，但不能据此证明它是历史超时的唯一网络/上游原因。

- `courseProvider.ts` 将知识包预判与实际 HTTP 预算共用相同消息、合同和计算；`courseKnowledge.ts` 按这个结果拆分完整结构单元。
- 本教材离线预算重放从 **214** 改为 **161 + 53**。可见目标分别为 43,990、15,715；加推理估计后的请求预算为 63,990、35,715，均在用户现有 64,000 配置内。包合并后的顺序、文本、跨度与来源 ID 完全一致。
- 不新增固定片段数/字符数上限，不缩减来源。20k 保持软估计；完整单元不因推理软估计本身被拒绝。实际输入/输出超过上下文的不可分单元仍明确失败。没有盲目扩大 timeout、关闭思考、换模型、绕过校验或新增重试循环。
- `CourseGeneration` 随已有 operation payload 保存非秘密的模型请求信息；`ClinicPreparationStatus` 展示 Provider、模型、请求已发起/响应已到、配置等待时间及真实已保存数量。旧的“模型仍在处理”推断改为“暂未收到完整结果”。
- 请求诊断补充 `visibleTarget`。更新的运行身份防止改过深度合同的生成候选错误命中旧语义缓存；已经接受的课程资产、来源提取有效包与历史仍保留。

## 2. 四档与三档的独立源码比较

原版依据：保护快照中的 `packages/shared/src/domain/learningContract.ts`、`apps/server/src/llm/prompts.ts::lessonDepthContract`、`teachingCapsule.ts`、`lessonPedagogyEvaluator.ts`、`services/formalProgression.ts`、`acceptedCoursePlan.ts` 与 `AgentCourseWorkspace.tsx`。

| 原版档位/内部值 | 原版真实教学行为 | V2 三档的损失 | 本轮四档 |
| --- | --- | --- | --- |
| 基础理解 / `pass_oriented` | 直观图景、基本事实、简单具体例子、识别/复述。 | 大体保留。 | `introductory`：基础理解。 |
| 熟练运用 / `working_fluency` | 机制与因果关系；新案例预测、诊断、边界、缺失条件或取舍推理。旧版 Lesson/Practice 还检查有待学生推断的推理动作。 | `standard` 的关系条件/使用方法保留，但 UI“深入理解”淡化应用意图；本地目标对除 procedure 外的知识多数停在 understand。 | `standard`：熟练运用，机制与新案例推理；原则/步骤/条件/例外可要求 apply。 |
| 高水平表现 / `high_performance` | 熟练运用之上增加失败诊断、两个交互条件、竞争约束和边界/取舍；旧审查检查多种推理操作。 | 被并入 advanced，失去“同领域高水平诊断与取舍”这一独立需求。 | 新增 `proficient`：高水平表现，机制/步骤目标可到 evaluate，其余为 analyze。 |
| 深入迁移 / `deep_transfer` | 继承高水平表现，增加相邻知识、陌生情境、设计与有依据的取舍。 | 三档 advanced 主要是条件变化与迁移分析，和高水平表现混在一起；原深度映射没有 design 区别。 | `advanced`：深入迁移，机制/步骤可到 design，条件/例外可到 evaluate，纯概念保留 analyze，避免伪造设计权威。 |

四档变三档发生在**整体架构精简实施**：V2 新建 `course.ts` 的 LessonDepthSchema（P1 合同）及 P3 服务端深度映射/Provider；施工前快照仍是四档。后续课程准备 UI 恢复沿用了这三档并改成“基础学习 / 深入理解 / 迁移应用”。冻结施工文档要求映射既有 DesiredDepth 到真实教学需求，没有发现要求必须压缩为三档的产品裁决。

本轮判断：同领域的诊断/边界/取舍，与跨情境综合/设计存在有价值的教学差别；用一个新增枚举和既有确定性映射即可支持，恢复四档合理。保留三个现有内部值，新增中间档，不迁移历史数据、不修改已确认版本。四档进入 Plan/Lesson 的真实 Prompt 和输入合同；深度调整同步目标及冻结蓝图，Practice/Formal 继续依据这些目标与 demand 选题。新增离线检查证明四档输入、正文夹具和过程性目标不同，目标与蓝图同步。

旧版深度还改变完成分数阈值（0.6/0.7/0.75）、证据数量、综合迁移考试及完成门；这些是已退役业务机制，**不恢复**。V2 的学生主动完成、独立可选 Formal、可信服务端评分、固定正式通过合同不变。不要求每个定义都达到设计层级、不增加整课模型 Review；真实模型是否充分落实高水平教学意图仍须实测。

## 3. 资料页与真实浏览器

`ClinicMaterials.tsx` 删除无资料时带 Logo 的“从第一份资料开始”整块卡片；顶部收敛为“教材与讲义 / 课程资料 / 添加与管理这门课程的学习资料”。保留上传区、来源身份、编辑标题、资料管理与品牌样式，不重做页面。

Playwright 在独立 **localhost HTTP Mock** 后端与独立 `output/architecture-implementation/first-real-use/browser.sqlite` 检查；未连接用户数据库/密钥。1440×1000 与 390×844 均无横向溢出。检查四档选择 → 请求等待 → 规划 → 逐课深入迁移调整 → 确认 → 直接打开后面的 Lesson → 主动完成；浏览器控制台没有错误。

截图：[资料页桌面](../output/playwright/first-real-use/materials-desktop.png)、[资料页窄屏](../output/playwright/first-real-use/materials-mobile.png)、[四档设置](../output/playwright/first-real-use/depth-four-desktop.png)、[请求等待](../output/playwright/first-real-use/request-wait-desktop.png)、[逐课深度窄屏](../output/playwright/first-real-use/plan-depth-mobile.png)、[按需 Lesson](../output/playwright/first-real-use/lesson-depth-desktop.png)。截图中标有“本机 HTTP Mock”的课程属于离线夹具，正文不代表 MoMA 产品质量。

## 4. 验证与用户真实复测

- 全部 workspace 单元/集成测试：**257 通过**（shared 20、server 198、web 39）。
- 前后端/shared 构建、lint、离线主流程回归通过。
- `scripts/verify-course-http.mjs` 仅允许自己的临时 localhost 端点，验证保存配置优先级、同模型连接测试/prepare、Runner 调度、请求等待持久化、运行中配置隔离、完整 HTTP → 合同校验 → 规划保存/确认；还复现不返回响应头的 timeout，验证 failed/outcome_unknown 和不自动重发。
- 知识请求测试覆盖大集合分包、较大真实容量允许较大包、共同 context 预算、完整结构单元超限、推理软估计；四档测试覆盖服务端目标/蓝图与教学输入差别。
- 3,142 个保护快照文件及 Git HEAD 校验通过。真实主库/WAL、原 UI 配置与凭据文件哈希与调查起点一致。详细日志与 evidence 在 `output/architecture-implementation/first-real-use/`。

用户复测：重启实际使用的 V2 服务，核对仍使用 `clinic-v2-real-a16.sqlite` 和原保存配置；不要误启本轮离线预览。保留资料与旧操作记录，显式继续/重试或重新准备已有课程。界面将显示真实请求等待状态，分包依据当前配置；默认 240 秒与现有输出 cap 未被本轮自动修改。如果再次未收到响应头，请记录新 operation/call 的诊断，并结合上游请求 ID/日志确认网关是否收到请求、模型等待/推理耗时及实际资源限制；按已知模型能力在设置中明确调整长任务等待时间或 context，不连续重复购买整课。

尚需真实验证：MoMA 实际成功响应、完整教材提取/规划、四档 Lesson 的真实教学差异及题目质量。本轮不宣称这些已经通过，不用 HTTP Mock 成功替代真实验收。
