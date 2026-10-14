# Study Clinic — Phase 4 实施报告

实施日期：2026-10-10（Asia/Shanghai）。当前分支：`main`。开始时 Git 工作区干净。

已完成 MoMA 优先的统一 OpenAI-compatible Chat Completions 配置功能。全部生成继续经过现有 Provider 接口和 Phase 1–3 教学政策。没有引入运行时依赖，没有提交或推送。

## 1. 实现摘要与文件清单

Phase 4 初次实施涉及 54 个新增或修改文件；独立审查收尾另修改 README 与 app.test.ts，当前共 56 个。范围为模型服务配置、必要身份传播、缓存、安全存储、最小数据库约束迁移、离线测试和使用文档。

| 文件 | 职责 |
| --- | --- |
| [.env.example](C:/Users/smallfish/open-source/hy3-study-clinic/.env.example) | MoMA 默认配置、显式 Fake 和内部输出上限说明。 |
| [.gitignore](C:/Users/smallfish/open-source/hy3-study-clinic/.gitignore) | 忽略默认配置对应的本机加密密钥文件。 |
| [README.md](C:/Users/smallfish/open-source/hy3-study-clinic/README.md) | 独立审查 N2：说明默认未配置 MoMA，以及显式离线 Fake 启用方式和保存配置优先级。 |
| [apps/server/src/app.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/app.ts) | 保护全部配置接口；增加草稿模型发现与带真实平台身份的最小探测；统一安全错误日志。 |
| [apps/server/src/app.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/app.test.ts) | 独立审查 N4：验证 500 故障位置、日志敏感信息过滤、诊断数量上限及安全前端响应。 |
| [apps/server/src/config.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/config.test.ts) | 验证默认值、显式离线模式、旧环境变量与视觉配置。 |
| [apps/server/src/config.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/config.ts) | 解析四种 Provider 身份、未配置 MoMA 默认值、环境来源及内部输出上限。 |
| [apps/server/src/db/migrate.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/db/migrate.ts) | v49 扩展 Formal 成绩与 Repair Provider 约束，保留唯一成绩索引和不可修改触发器。 |
| [apps/server/src/db/modelServiceMigration.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/db/modelServiceMigration.test.ts) | 检查从 v48 升级后所有相关索引、触发器及外键完整性。 |
| [apps/server/src/eval/curriculumPolicyComparison.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/eval/curriculumPolicyComparison.ts) | 为所有真实 Provider 保留实际模型元数据。 |
| [apps/server/src/llm/compatibleEndpoint.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/compatibleEndpoint.test.ts) | 验证路径、不同 endpoint 隔离、HTTPS 和 loopback HTTP 约束。 |
| [apps/server/src/llm/compatibleEndpoint.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/compatibleEndpoint.ts) | 规范 URL、拼接 models/completions 路径，并生成不含凭据的 endpoint 摘要。 |
| [apps/server/src/llm/compositionalTeachingProvider.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/compositionalTeachingProvider.test.ts) | 离线验证 JSON mode 回退、严格校验、低输出上限、文本分段及真实平台诊断身份。 |
| [apps/server/src/llm/errors.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/errors.ts) | 区分未授权、权限、路径/模型、限流、上游故障及网络问题，避免原始错误内容回显。 |
| [apps/server/src/llm/factory.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/factory.ts) | 沿用 Hy3Provider 构造真实平台实例；不将不完整真实配置转换为 Fake。 |
| [apps/server/src/llm/hy3Provider.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/hy3Provider.ts) | 复用传输与严格教学校验，增加真实平台身份、endpoint、兼容回退和凭据反射保护。 |
| [apps/server/src/llm/provider.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/provider.ts) | 扩展真实 Provider 与诊断身份类型，沿用原有接口。 |
| [apps/server/src/llm/structuredOutputDiagnostics.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/llm/structuredOutputDiagnostics.ts) | 诊断使用实际 Provider 身份，历史默认仍为 Hy3。 |
| [apps/server/src/repositories/visualDerivations.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/repositories/visualDerivations.ts) | 对齐语言/视觉 Provider 的身份类型；不增加新视觉传输。 |
| [apps/server/src/routes/modelService.integration.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/routes/modelService.integration.test.ts) | 使用真实 loopback HTTP Mock 验证配置接口、模型发现、探测、错误、超时、遥测及访问保护。 |
| [apps/server/src/services/courseActionLaunch.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/courseActionLaunch.ts) | 将模型元数据判断扩展到全部真实平台，沿用既有业务调用链。 |
| [apps/server/src/services/curriculum.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/curriculum.test.ts) | 验证新平台 Review 缺失或失败时停止接受，不产生课程完成证据。 |
| [apps/server/src/services/curriculum.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/curriculum.ts) | 将必要 Review 的真实模型判断扩展到 MoMA/兼容平台，保持原有接受门槛。 |
| [apps/server/src/services/generationStages.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/generationStages.test.ts) | 验证平台、endpoint、模型分别隔离，以及同连接合法复用。 |
| [apps/server/src/services/generationStages.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/generationStages.ts) | 缓存身份增加 endpoint 与运行时输出配置，避免同模型 ID 跨上游复用。 |
| [apps/server/src/services/graph.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/graph.ts) | 将模型元数据判断扩展到全部真实平台，沿用既有业务调用链。 |
| [apps/server/src/services/learnerAssessmentsConcurrency.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/learnerAssessmentsConcurrency.test.ts) | 为四种身份验证实际 Formal/Repair 持久化，保留并发成绩保护测试。 |
| [apps/server/src/services/lessons.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/lessons.ts) | 将模型元数据判断扩展到全部真实平台，沿用既有业务调用链。 |
| [apps/server/src/services/providerRuntime.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/providerRuntime.test.ts) | 验证重启、加密、密钥丢失、保存失败、平台切换、过期请求和在途 endpoint 快照。 |
| [apps/server/src/services/providerRuntime.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/providerRuntime.ts) | 服务器草稿解析、保存优先级、原子启用、加密重载、模型发现、缺配置明确报错及快照一致性。 |
| [apps/server/src/services/providerSecrets.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/providerSecrets.ts) | AES-256-GCM；Windows 使用 DPAPI CurrentUser 保护本机加密密钥，其余平台使用 0600 文件。 |
| [apps/server/src/services/repair.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/repair.ts) | 补救生成缓存加入 Provider、Model 与 endpoint，保留原有补救流程。 |
| [apps/server/src/services/studyPlansAgent.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/studyPlansAgent.ts) | 所有真实平台保留实际模型身份。 |
| [apps/server/src/services/teachingBriefPreparation.test.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/teachingBriefPreparation.test.ts) | 对 Hy3/MoMA/兼容平台运行相同的独立教学审查与完成证据断言。 |
| [apps/server/src/services/teachingBriefPreparation.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/teachingBriefPreparation.ts) | 所有真实平台执行既有教学编辑、独立 Review、Practice 与准备质量政策。 |
| [apps/server/src/services/tutor.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/tutor.ts) | 将模型元数据判断扩展到全部真实平台，沿用既有业务调用链。 |
| [apps/web/src/App.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/App.tsx) | 应用状态支持实际平台身份。 |
| [apps/web/src/api.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/api.ts) | 增加严格解析的模型发现和草稿探测客户端。 |
| [apps/web/src/styles.css](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/styles.css) | 复用现有视觉样式，补充模型选择和窄屏按钮布局。 |
| [apps/web/src/views/AgentCourseShell.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/AgentCourseShell.tsx) | 侧栏如实显示当前平台。 |
| [apps/web/src/views/AgentCourseWorkspace.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/AgentCourseWorkspace.tsx) | 课程空间接受扩展的平台类型。 |
| [apps/web/src/views/CourseHomeView.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/CourseHomeView.tsx) | 错误恢复入口使用当前模型服务设置名称。 |
| [apps/web/src/views/CurriculumView.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/CurriculumView.tsx) | 恢复提示使用统一模型服务设置名称。 |
| [apps/web/src/views/ModelServiceSettings.test.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/ModelServiceSettings.test.tsx) | 验证默认草稿、恢复、历史身份、新平台切换、手输、取消、失败、保存及浏览器不存 Key。 |
| [apps/web/src/views/ModelServiceSettings.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/ModelServiceSettings.tsx) | 两种平台、官方默认 URL、密码输入、模型发现/手输、草稿测试与保存启用。 |
| [apps/web/src/views/QuizHistoryView.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/QuizHistoryView.tsx) | 保留历史身份，并显示 MoMA/兼容平台判分来源。 |
| [apps/web/src/views/SettingsView.test.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/SettingsView.test.tsx) | 保留课程管理与偏好测试；旧模型配置断言由新区域行为测试覆盖。 |
| [apps/web/src/views/SettingsView.tsx](C:/Users/smallfish/open-source/hy3-study-clinic/apps/web/src/views/SettingsView.tsx) | 接入模型服务区域，保留课程管理、偏好与删除对话框。 |
| [docs/PHASE4_IMPLEMENTATION.md](C:/Users/smallfish/open-source/hy3-study-clinic/docs/PHASE4_IMPLEMENTATION.md) | 本次实施报告、全部文件清单、实际验证和首次真实 API 指南。 |
| [docs/SETUP.md](C:/Users/smallfish/open-source/hy3-study-clinic/docs/SETUP.md) | 更新设置入口、首次接入、配置优先级、存储边界及离线启动指南。 |
| [packages/shared/src/domain/attempt.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/attempt.ts) | 允许真实 MoMA/兼容平台身份；旧 Fake、Hy3 和既有历史数据保持可读。 |
| [packages/shared/src/domain/formalAssessment.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/formalAssessment.ts) | 允许真实 MoMA/兼容平台身份；旧 Fake、Hy3 和既有历史数据保持可读。 |
| [packages/shared/src/domain/masteryRedTeam.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/masteryRedTeam.ts) | 允许真实 MoMA/兼容平台身份；旧 Fake、Hy3 和既有历史数据保持可读。 |
| [packages/shared/src/domain/providerConfig.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/providerConfig.ts) | 四种身份、显式 Secret 动作、版本保护、模型列表和草稿测试响应契约。 |
| [packages/shared/src/domain/repair.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/repair.ts) | 允许真实 MoMA/兼容平台身份；旧 Fake、Hy3 和既有历史数据保持可读。 |
| [packages/shared/src/domain/visual.ts](C:/Users/smallfish/open-source/hy3-study-clinic/packages/shared/src/domain/visual.ts) | 允许真实 MoMA/兼容平台身份；旧 Fake、Hy3 和既有历史数据保持可读。 |

## 2. 实际用户体验

在“设置 → 模型服务”选择平台。新配置默认 MoMA，Key 和 Model ID 空白。MoMA 默认 API Base URL 为 `https://zhenze-huhehaote.cmecloud.cn/v1`，可直接编辑。

该默认值已于 2026-10-10 核对[移动云官方 API 调用接口总览](https://ecloud.10086.cn/op-help-center/doc/article/98330)。总览对多数文本模型推荐呼和浩特 zhenze 入口，同时列有 `https://moma.cmecloud.cn/v1`、`/v2`、Coding Plan 等不同入口。本实现不声称一个 URL 支持全部 MoMA 模型，不绑定固定模型。

用户在密码输入框填写 Key，点击“获取模型”后选择实际 Model ID，或直接手动填写。“获取模型”只请求 GET /models；不支持、无权限、空列表或失败时仍可手输。“测试连接”使用当前草稿，用户主动点击才发送最小 Chat Completions 请求。成功只说明这份组合的小请求可用，不代表课程大请求或教学质量已通过真实验证。

“保存并启用”由服务端验证、持久化并激活，后续新任务使用新连接。打开页面、保存、服务器启动均不发送付费模型请求。已保存 Key 只显示配置状态，留空保留；替换或清除需要保存。清除后仍保留真实平台身份，任务明确报缺配置，课程记录和 checkpoint 保留。

新选“其他兼容平台”时 URL、Key、Model ID 都为空；填写自己的三项信息后测试并保存。切换选项只修改草稿。切回当前已启用平台时恢复其已保存配置；没有跨平台复制已保存 Key。历史 Hy3 配置保持 Hy3 身份，用户可以显式创建其他兼容平台连接。

## 3. Provider、缓存和安全实现

复用原有 Node fetch、Bearer Key、messages、temperature、max_tokens、JSON 提取、Zod Schema、候选校验、有界修复、遥测、取消及 checkpoint 机制。新平台仍由同一 Hy3Provider 传输实现承载，但实例与诊断身份分别是 hy3、moma 或 compatible；Fake 保持明确的离线身份。

原先把“真实模型”限定为 name === hy3 的 Curriculum/TeachingBrief 等判断改为 name !== fake。MoMA/兼容平台进入相同的编辑、覆盖检查和独立审查；Review 不可用或失败时停止接受。没有新增伪造 Review、放宽 Schema 或降低质量门槛的分支。Formal 成绩与补救包的数据库约束扩展了平台身份，历史 payload 和归属不改写；唯一当前成绩索引、补救包不可修改触发器及外键保护完整保留。

生成缓存、补救缓存分别加入规范化 endpoint 摘要，继续包含 Provider 与 Model。Key 既不进入明文缓存标识，也不进入 endpoint 摘要。历史课程记录仍可读取；旧缓存不会误用于新 endpoint。沿用 AsyncLocalStorage 的请求快照：已开始任务保留原 Provider 实例、endpoint 和 generation，新请求才切换，迟到结果沿用原归属。既有租约和取消保护保持有效。

只有明确的 400/422 参数错误表明 JSON mode 不支持时，才有界回退到已有 JSON 提示与严格解析。明确的较低 max_tokens 上限被记住并用于后续请求和截断恢复；内部 `MODEL_MAX_OUTPUT_TOKENS` 可按模型文档调低。保留 Hy3 原有模型回显检查与恢复预算；新兼容平台允许模型别名/版本回显及标准 text 内容分段，缺少 Usage 保持 unknown，未捏造费用或 Token。错误正文不回显；响应反射 Key 时在候选留存前拒绝。

UI 保存 Key 使用 AES-256-GCM。Windows 加密密钥由 DPAPI CurrentUser 保护；其他平台为独立 0600 文件。写入原子替换，保存失败不改活动配置，v1 本地配置在读取时加密升级。配置损坏或配套密钥丢失明确报错。已保存配置始终优先于旧环境变量，包括主动清除 Key 的禁用配置；没有有效真实连接时不转 Fake。只有显式离线配置使用 Fake。

全部配置读写、模型发现与探测接口限制 loopback IP、本机 Host、可信本机 Origin，并拒绝跨站 Fetch。开发 Origin 精确白名单允许 HTTP/HTTPS 的 localhost、127.0.0.1、[::1] 在 5173/5174 的来源，以及服务端自身同源页面；其他开发端口不放行。外部重定向被拒绝，避免转发 Bearer Key。意外 500 日志只保留请求 ID、方法、注册路由、固定错误类型和最多 8 个已存在的项目代码位置，不记录原始错误消息、函数名、cause 或上游响应体；前端仍返回通用安全错误，浏览器 localStorage 不持久化 Key。

## 4. 测试与验证

独立审查前的标准全量：**4200/4200 PASS**，共 212 个测试文件。shared 288，server 3380，web 532；均无失败。收尾改动的针对性验证单独记录如下，不将此前全量结果当作本轮重跑结果。

| 检查 | 实际命令 | 结果 |
| --- | --- | --- |
| 标准全量 | `npm test` | PASS：288 + 3380 + 532 = 4200；27 + 150 + 35 = 212 个文件 |
| 类型检查与构建 | `npm run build`（shared/server tsc，web tsc --noEmit + Vite） | PASS |
| 最新前端构建 | `npm run build -w @hy3-clinic/web` | PASS |
| Lint 与格式 | `npm run lint` | PASS：0 errors；保留 1 个既有 Hook warning，Prettier 全部通过 |
| Diff 空白检查 | `git diff --check` | PASS |

定向验证均为离线。已执行：

- 在 apps/server：`npx vitest run src/services/curriculum.test.ts src/services/teachingBriefPreparation.test.ts src/llm/compositionalTeachingProvider.test.ts`，486/486。
- 在 apps/server：`npx vitest run src/services/providerRuntime.test.ts src/services/learnerAssessmentsConcurrency.test.ts src/db/modelServiceMigration.test.ts src/services/repair.test.ts src/llm/structuredOutputCompatibility.test.ts src/routes/modelService.integration.test.ts`，124/124。
- 在 apps/server：`npx vitest run src/routes/modelService.integration.test.ts src/llm/hy3Provider.test.ts src/llm/compositionalTeachingProvider.test.ts src/llm/structuredOutputCompatibility.test.ts src/services/rejectedArtifactCapture.test.ts`，170/170。
- 在 apps/server：`npx vitest run src/config.test.ts src/services/providerRuntime.test.ts`，36/36。
- 在 apps/web：`npx vitest run src/views/ModelServiceSettings.test.tsx src/views/SettingsView.test.tsx src/views/AgentCourseViews.test.tsx src/views/CurriculumView.test.tsx`，实际匹配 3 个测试文件，91/91。

不将以上重叠执行次数累加成独立测试总数。初次全量回归发现迁移遗漏唯一成绩索引和 Repair 不可修改触发器，以及历史 Hy3 的内容形状契约被误扩展；均已修复并通过定向回归。未增大全局测试超时，也未绕过教学校验使测试通过。

使用 [Playwright 技能](C:/Users/smallfish/.codex/skills/playwright/SKILL.md) 检查了桌面和 390px 窄屏。独立临时服务器强制将所有模型请求限制到 `127.0.0.1:9876` Mock 上游，使用虚构测试 Key，拒绝全部真实上游。实际检查包含模型获取、选择、草稿测试、保存、Key 清空、页面重开、服务重启、平台草稿切换和移动端按钮。截图仅为本机 Mock UI，不是 MoMA 接入证据。

最终日志：[全量测试](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-verification.log)、[构建](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-final-build.log)、[最新前端构建](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-web-final-build.log)、[Lint](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-verification-lint.log)。截图：[桌面](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/phase4-settings-desktop.png)、[窄屏操作](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/phase4-settings-mobile-actions.png)。

### 独立审查收尾验证（2026-10-10）

仅实现 N1、N2、N4。精确可信 5173/5174 Origin 覆盖全部配置接口；localhost:9001、其他未授权端口、远端 IP、外部 Host、跨站 Fetch 和含路径/凭据的伪 Origin 均被拒绝，拒绝时没有上游请求。意外 500 保留真实项目代码位置；API Key、原始上游正文、请求参数和原始错误字段未进入错误诊断日志，前端仍返回通用错误。

- 针对性回归：在 `apps/server` 执行 `npx vitest run src/app.test.ts src/routes/modelService.integration.test.ts src/config.test.ts src/services/providerRuntime.test.ts`，**99/99 PASS**，4 个文件（24 + 39 + 11 + 25）。仅使用 Fake、Mock 或 loopback HTTP 上游。
- 构建：`npm run build` PASS；保留既有较大 bundle 提示。
- Lint 与格式：`npm run lint` PASS，0 errors；保留既有 GraphWorkspaceView Hook warning。
- Diff 检查：`git diff --check` PASS；改动限于 app.ts、app.test.ts、modelService.integration.test.ts、README.md、SETUP.md 和本报告。

本轮日志：[针对性回归](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-followup-tests.log)、[构建](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-followup-build.log)、[Lint](C:/Users/smallfish/open-source/hy3-study-clinic/output/phase4-followup-lint.log)。未重跑此前 4200 项全量，未调用真实付费 API，未 commit / push。

## 5. 剩余风险与验证边界

离线验证覆盖连接契约、HTTP 状态、格式、超时、安全回显、加密重载、缓存、在途状态及原有完整教学回归。没有真实第三方或 MoMA Key，没有发送任何真实付费模型请求，因此不宣称真实 MoMA 接入或教学表现验证通过。

仍需真实资源验证：账号权限、具体入口是否支持 /models、模型 JSON 输出行为、Token/推理预算、课程长请求、取消与恢复，以及真实平台费用和教学质量。不同资源池或套餐的 URL 必须按官方实际接入指引调整。极小探测可能不足以验证推理模型长输出；它不能替代后续课程 Smoke Test。

本机加密不防御能运行同一用户代码的进程。Windows DPAPI 绑定当前用户，跨机器/用户恢复需重新填写 Key；macOS/Linux 同机密钥与配置一起被获取后可解密。当前配置接口为单用户本机部署设计，远程管理需要可信访问层；不得把 loopback 配置路由直接通过公开无鉴权代理暴露。自定义存储文件名需自行忽略对应配置和 .key 文件。

Lint 的 GraphWorkspaceView React Hook 依赖 warning 属既有未改文件；构建仍提示较大 bundle。本轮未进行无关重构。

## 6. 第一次真实 API 测试指南

仅在独立审查及授权之后：

1. 用正常本地环境启动 `npm run dev`，进入“设置 → 模型服务”。
2. 选择 MoMA 或其他兼容平台，按官方模型接入指引填写 URL；Key 只填应用密码输入框，不发送到聊天或报告。
3. 获取模型并选择，或手动填实际 Model ID。主动点击“测试连接”，确认反馈。
4. 点击“保存并启用”，用小型课程依次核对 Curriculum Review、教学准备、Practice、Repair/Retest、Tutor 和 Formal 的真实调用、状态与来源；发现截断时按文档调整内部输出上限。
5. 保留真实遥测和独立评估证据，只有实际 MoMA 调用才可作为 MoMA 证据。完成真实验收后才能 CLOSED。

## 7. Git 状态与停止边界

当前 `main`，所有变更未提交。48 个已跟踪文件修改、8 个新增文件，共 56 个；未改 package.json/package-lock.json，未添加网关或 SDK，未 commit、未 push，也未启动 Phase 5–7。本机 output、截图和测试日志被忽略，未读取或打印用户 .env Key。

Fable 5.1 独立审查结论为 ACCEPT WITH NOTES。本次仅收尾 N1、N2、N4；N3、N5、N6 暂未扩展。离线 Mock 验证服务已停止，用户真实数据和已保存配置未被 QA 环境覆盖。停止实施，等待用户亲自进行真实 API Smoke Test；Phase 4 尚未 CLOSED。

PHASE 4 IMPLEMENTED — READY FOR REAL API SMOKE TEST

