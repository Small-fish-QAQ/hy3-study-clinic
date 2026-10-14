# Study Clinic 整体精简改造实施与验收

实施日期：2026-10-12（Asia/Shanghai）。施工依据为 [IMPLEMENTATION_HANDOFF.md](architecture-simplification-plan/IMPLEMENTATION_HANDOFF.md) 引用的冻结资产，实施授权为本次用户指令；资产中“尚未实施/仅文档授权”的文字是冻结时的历史状态。

**P0–P8 的工程工作已完成，A01–A15 离线工程验收通过。A16 的真实 MoMA/GLM 与教材验收尚未执行，由用户后续完成。** 离线 Fake、注入错误输出和 HTTP Mock 证明软件合同、拒绝规则与恢复行为，不证明真实模型的教材语义覆盖或教学质量。

## 1. 交付与源码保护

主入口已经切为 `index.ts → app.ts → createClinic → routes/clinic.ts`，前端为 `ClinicWorkspace.tsx`。正常运行只有一套新版课程合同、准入、评分和页面，没有旧 Map/Detail/Coverage 多阶段或旧课程解码分派。核心 Provider 提供冻结合同中的 11 个能力；MoMA、Hy3 和 compatible 使用真实 HTTP 实现，Fake 也经过同一组产品 validator。

开始施工时 HEAD 是 `14c11569dd24aabf29d942e2b070dc97785f6673`，没有 checkout/reset/commit/push。包含未提交 Phase 4 的 3,142 个原文件已按原字节保存在 `output/architecture-implementation/source-snapshot/`，哈希与原 Git 状态在 `baseline.json`。最终 `verify-clinic-integrity.mjs` 核对全部快照匹配、HEAD 未变，并检查 67 个生产 TS/TSX 文件不存在指定的旧调用依赖。

相对施工基线，apps/packages 原有文件中 497 个退役、34 个修改、70 个不变；退役包括旧业务模块、旧合同与相关测试，不是丢失原始 Phase 4。新源码、脚本及文档另列于 `implementation-changes.json`。完整差异与 Git 状态在 `source-integrity-final.json`。旧功能与测试退出理由在 `retired-files.json` / `retired-shared.json`；安全、可信评分和新版本持久化断言已迁到新版测试。

原真实数据库和真实 `.env` 未打开、未修改、未清理。所有工程验证使用内存库、临时文件库或 `output/architecture-implementation/browser/clinic.sqlite`。公开评测归档未改写。

## 2. P0–P8 完成情况

| 阶段 | 最终实现与工程判断 | 验证 |
| --- | --- | --- |
| P0 | 保存 dirty 工作树、Phase 4 和源码哈希；独立库夹具；保留旧缺陷的观察性基线 | 原 13 文件/314 项基线全通过；快照完整性另核验 |
| P1 | 当前 shared 合同、独立 SQLite schema、归属/FK/不可变 trigger；关闭 Grade/Evidence/raw accept 等低层写口；public 题面去答案与 rubric | schema、Security、Drafts、Restart |
| P2 | 六种固定进程内操作、202/status/retry/cancel、命令幂等、lease/heartbeat/fence；完整候选先私有保管；统一预算和覆盖响应 body 的 deadline | Recovery、Restart、Provider、Runtime、Config |
| P3 | 完整原文工作包、K/disposition、一次组织完整 Plan；超单请求才 outline/subplan/compact join；局部异常检查；确定性深度调整与确认 | Capacity、Journey、Recovery、UI |
| P4 | 所有用途共用 questionAdmission；客观盲解比较答案，主观再核 rubric；每 slot 原题加一次局部替换；逐题评分持久，完整集合才签发正式总成绩 | Safety、Formal、Representative、Security、Drafts |
| P5 | Lesson 与 Practice 分开；一作者、本地正文锚点与必要局部风险验证；主动完成、后课可选、Tutor 一回复、只读旧课堂与独立 revisit | Safety、Journey、Capacity、UI、浏览器 |
| P6 | 无累计上限的主动 Repair 轮次和一次 Retest；失败可另开，pending 评分可恢复或原子结束另开；独立代表性 Formal、新卷和追加成绩 | Journey、Recovery、Formal、Representative、Safety |
| P7 | 默认折叠知识、深度/确认、自由 Lesson 导航、独立考试、日常与正式状态分开、历史题目/答案/补救/操作可回看；移除旧图谱依赖与测试支架 | Web 测试、桌面/390px/键盘浏览器验证、源码检查 |
| P8 | 新库冷重启、所有新版学习历史、局部恢复、完整测试/构建/lint/离线回归和公开证据只读校验；运行文档与真实验收入口 | 下表 A01–A15；A16 留用户执行 |

采用直接新版 schema，当前 schema version 为 4；1→4 是本次开发形成的新版库增量，不是旧产品迁移。默认 `data/clinic-v2.sqlite`；误指旧 schema 在只读预检时拒绝，不自动重建。答案草稿和服务端提示曝光使用两张必要的小表，逐题评分、课堂和复习沿用简化存储；没有 TaskGraph、outbox、独立 worker 或全局求解器。

模型设置保留 Phase 4 的 Provider/模型/Key 保存、加密、显式连通测试及配置 generation；保存配置的凭据处理与课程数据库解码是不同责任。运行参数只约束资源：文件和文本默认各 10 MiB，Provider 并发 2，lease/heartbeat 初值 90/20 秒；没有字符/块/知识/Lesson/目标/教学时长/累计 200 步的业务总量门。20k 推理是软估计，没有正文 4096 floor、固定 +12000/32000 或配置 64000/300 秒硬 max。

## 3. 最终验证

| 检查 | 结果 | 保存证据 |
| --- | --- | --- |
| shared 全量 | 3 文件，20/20，0 跳过 | `final-shared-tests.json` / `.log` |
| server 全量 | 23 文件，190/190，0 跳过 | `final-server-tests.json` / `.log` |
| web 全量 | 2 文件，23/23，0 跳过 | `final-web-tests.json` / `.log` |
| 前后端与 shared 构建 | 通过；先清 dist，不遗留已删旧 JS | `final-build.log` |
| ESLint / Prettier | 通过 | `final-lint.log` |
| `eval:fake` | 7/7，0 网络请求 | `offline-regression.json` / `final-offline.log` |
| StudyEval 原测试 | 22/22，0 跳过 | `studyeval-tests.log` |
| 公开 StudyEval / 产品归档 verify | 两者 passed；分别核对 1,805 / 394 文件 | `studyeval-verification.log` / `publication-verification.log` |
| 浏览器 | 文件上传到规划/深度/课堂/Tutor/练习/Repair/正式交卷；最新历史与窄屏回归通过，最终冷载 console 0 error / 0 warning | `browser-qa.json`，`output/playwright/` 截图与 `.playwright-cli/` snapshots |
| Git / 源码完整性 | `diff --check` 通过，快照匹配，HEAD 不变，旧依赖检查零命中 | `source-integrity-final.json` / `implementation-changes.json` |

证据目录均为仓库本地的 `output/architecture-implementation/`，不替换公开评测数字。当前产品测试总数是 **233**；归档的 22 项测试独立报告，不叠加多次针对性复跑的数量。

测试默认阻断 fetch/http/net/tls 外网；Provider 测试注入 HTTP 响应，API 测试使用 Fastify inject。客户端 Vite 不加载真实 `.env`。离线浏览器仅连接本机服务，模型请求被阻断。没有真实付费请求或连接探测。

调用合同的最后一次离线样例：extract 1、plan 1、两课各 author 1、条件风险 verify 1、正式题作者 1、两题 blind solve 各 1、客观评分 0。另有低风险 Lesson 1 author/0 verify、主观不异常 1 次与异常最多 2 次、65 轮 Tutor 不重生 Lesson、回看零生成、画像/FSRS 零额外模型断言。

容量夹具完整解析 20,001 短段、408,909 字符、968,937 字节，保留尾段并超过旧 100k/2k/20k 门；最终实测时间及 heap delta 留在 server 日志。heap delta 不是峰值内存保证。另一夹具实际完成超过 200 个提取工作包；当前 DTO 与 validator 接受 121 个区域、1,001 个 Lesson/目标；300 个必学 K、5 个核心 cell 实际用 5 题完成正式组卷和重考代表轮换，未考 K 保持未实测。

人工黄金分母预先固定为 6 条命题，涵盖定义、条件、例外、程序、表格、跨章关系；测试保存 source/K/Plan/实际教学锚点对照，6 条均提取、分配、定位且保留命题。它是离线夹具的有限语义证据，不能外推为真实教材 100% 语义覆盖。

施工失败与修复也保留在本次会话证据：一次全量出现同毫秒独立提交排序断言失败，后按冻结时间+稳定 ID 校正，并实现 Retest 前件优先、展示与调度同序，增加同毫秒 Again→Good/幂等用例；新增 UI 回归夹具曾有类型错误，按当前合同修正后重建；lint 的 prefer-const 已修。浏览器热更新期间客户端先加载新进度字段、旧隔离服务未重建导致临时异常，重建服务后冷载归零。历史试卷重开、Retest 答案回填和 Lesson 残留补救状态已修复并有新 UI 回归。没有跳过失败用例或抑制 worker 错误。

## 4. A01–A16 验收对照

下文测试代号均指真实执行的当前测试文件：J=[Journey](../apps/server/src/services/clinicJourney.integration.test.ts)，C=[Capacity](../apps/server/src/services/clinicCapacity.test.ts)，S=[Safety](../apps/server/src/services/clinicSafety.test.ts)，R=[Recovery](../apps/server/src/services/clinicRecovery.test.ts)，N=[Restart](../apps/server/src/services/clinicRestart.test.ts)，F=[Formal](../apps/server/src/services/clinicFormal.test.ts)，B=[Representative](../apps/server/src/services/clinicRepresentative.test.ts)，H=[Security](../apps/server/src/routes/clinicSecurity.integration.test.ts)，D=[Drafts](../apps/server/src/routes/clinicDrafts.test.ts)，U=[UI](../apps/web/src/views/ClinicWorkspace.test.tsx)，P=[Provider](../apps/server/src/llm/courseProvider.test.ts)。模型设置另由 [Runtime](../apps/server/src/services/providerRuntime.test.ts) 与 [Settings](../apps/web/src/views/ModelServiceSettings.test.tsx) 覆盖。

| ID | 结论与具体证据 |
| --- | --- |
| A01 | 通过：dirty 基线、314 项原测试、3,142 文件快照、最终完整变更清单与哈希验证 |
| A02 | 通过工程合同：C 的 20,001 段、>200 工作包、121 区域/1,001 项、黄金 6 条四层对照、大 K 少 cell；真实语义质量待 A16 |
| A03 | 通过：J/U 深度与确认零生成、不提前购 Lesson、默认 details 折叠；C 先修/核心目标降格负例；无 reorder API/UI |
| A04 | 通过：S 的低风险 1+0、本地算式、错误推导/漏讲/标题/泛锚点拒绝、局部验证；J 主动完成/后课；C 条件分段 |
| A05 | 通过：J 的 65 Tutor turn、旧历史只读、revisit 新 session、无 Lesson 再生或正式证据写入；浏览器旧对话读回 |
| A06 | 通过：S 错 key/盲解无 key/零有效题、F 保留好兄弟/局部丢题；J/S 可靠 Practice 影响日常，Formal 无新增 |
| A07 | 通过：J 第 4/10 轮结束、R failed 直接新开且并发唯一；F/J/S 评分技术失败/pending 与真实错答区分，旧成绩保留 |
| A08 | 通过：B 实际 300 K/5 cell/5 题、换代表重考、未考 K；F 缺覆盖不开放、同 slot 不重置额度；C demand 降格拒绝 |
| A09 | 通过：H 客户端 score/issuer/跨课程/低层 URL 拒绝；F 主客观混卷、逐题恢复/固定权重；S 不确定不记 Again、辅助观察不调 FSRS |
| A10 | 通过：schema 合成旧库零修改、重复新库初始化；J/N file SQLite 冷开、历史 hash/FK/immutable；D 草稿和提示持久化 |
| A11 | 通过：R/N 同 scope 合并、lease/owner/cancel/late/source 变化、候选保管、重启显式恢复；F 局部评分续作；S 投影失败保留可靠分数 |
| A12 | 通过：P 的 reasoning-only/截断/429/兼容共享重发、软 20k、cap 下降、小响应、600 秒与 body deadline；Settings 超时/cap 编辑 |
| A13 | 通过：H/D public 与归属负例、GET 无写；U 恢复历史和补救/导航；浏览器桌面、390px、键盘 details、无横向溢出及最终零错误 |
| A14 | 通过：当前单一准入与签发；旧写 URL 自然 404；旧业务文件/依赖退出，原字节受保护；67 生产文件旧依赖搜索及历史读回 |
| A15 | 通过：233 项当前产品全量测试、22 项独立归档测试、build/lint/offline/diff/integrity/公开 verify；失败修复如上记录 |
| A16 | **未执行**：由用户对真实 MoMA/GLM、原失败教材和正常教材完成产品验收；本轮不替代、不宣称真实模型成功 |

## 5. R01–R46 覆盖

每项均已交付工程实现；涉及自然语言正确性、完整性和模型实际表现的最终产品结论仍遵守 A16 边界。

| 要求 | 当前实现 | 验证关联 |
| --- | --- | --- |
| R01 | 完整来源→K→Plan→实质正文锚点，支持合讲 | C/S/J；A02/A04/A16 |
| R02 | Plan 一次组织、先修 DAG、顺序与深度 | C/J/U；A03 |
| R03 | 教材外拓展标识、来源精确验证，必考不隐藏拓展依赖 | coursePlanning/lessonDelivery/questionAdmission；C/S/H；A02/A08/A16 |
| R04 | 完整规划确认屏障，课文按需 | J/U/offline；A03/A04 |
| R05 | 知识默认折叠、可键盘展开 | U/浏览器；A13 |
| R06 | 深度本地 patch，确认零模型 | J/U；A03 |
| R07 | 无任意重排写口和按钮 | H/U/源码核验；A03/A14 |
| R08 | Tutor/Repair 个性化不自动重建课程 | J/R；A05/A14 |
| R09 | 完整提取+一次课程组织，异常才局部核查 | C/J/offline；A02/A12 |
| R10 | 点击生成并完整准入独立 Lesson | J/S/C；A04 |
| R11 | 一作者、本地与必要局部验证，无默认整课 Review | S/P/offline；A04/A12/A16 |
| R12 | 一次自然 Tutor 回复，过滤不可信引用 | courseLessons/J；A05/A16 |
| R13 | Tutor 不写分数/掌握或正式证据 | J/H；A05/A09 |
| R14 | 主动完成 Lesson 事实，独立于考试 | J/U；A04 |
| R15 | 后课自由学习，先修仅提醒 | J/U/浏览器；A04/A13 |
| R16 | 原课堂/旧对话只读读回 | J/N/U/浏览器；A05/A10 |
| R17 | 新问题写独立 revisit session | J/浏览器；A05 |
| R18 | Lesson 失败可局部恢复、其他 Lesson 可用 | R/S/C；A04/A11 |
| R19 | Tutor/游标不改变内容身份或课程路线 | courseLessons/J；A05/A11 |
| R20 | Lesson 后按需 Practice，允许跳过或以后练习 | J/U/浏览器；A06 |
| R21 | 统一盲解/条件/来源/答案与主观 rubric 准入 | S/F；A06/A09/A16 |
| R22 | 每 slot 一次局部替换，好题保留 | S/F/B；A06/A11 |
| R23 | 实际题数诚实，少题可用、零题失败 | S/F/offline；A06 |
| R24 | 错题持久、Repair 主动可选、后课自由 | J/U/浏览器；A07 |
| R25 | 一轮补救与一次 Retest | J/R/U；A07 |
| R26 | 正整数 ordinal，无终身次数门，failed 可直接新轮 | shared/J/R/schema；A07/A10 |
| R27 | 系统失败/pending 不算答错或 Again | S/F/R；A07/A09/A11 |
| R28 | 薄弱通过 Tutor/Lesson/Repair，不加正式课程 | J/R/生产调用核验；A07/A14 |
| R29 | typed 日常事件与 FSRS，正式证据单列 | S/J/F/FSRS；A06/A07/A09/A10/A13 |
| R30 | Lesson 分母定义路线完成，Formal 独立 | J/offline/浏览器；A04/A08 |
| R31 | 同蓝图新卷，代表轮换，旧成绩追加 | B/J/F；A08/A11 |
| R32 | 必教全 K，必考核心 cell，未抽 K 未实测 | C/B/F/offline；A02/A08/A09 |
| R33 | Formal 统一盲解和主观 rubric 核查，无第三 challenge | S/F/P；A08/A09/A16 |
| R34 | 客观本地，主观一次、异常最多一次复核 | S/F/P/offline；A09/A12 |
| R35 | 数据库完整逐题集合服务端签发，客户端不能授信 | H/F/N；A09/A13 |
| R36 | 不保留旧弱题/Review receipt 写旁路 | H/S/源码核验；A09/A14 |
| R37 | 新版全部学习与考试历史不覆盖，换教材显示历史来源 | J/N/D/F/U；A10 |
| R38 | 来源/归属/准入/哈希/fence/immutable 的真实边界 | H/S/F/R/N；A09/A13 |
| R39 | 业务总量门删除，资源保护可配，DTO/API/UI 同步 | C/shared/config/P；A02/A04/A12 |
| R40 | 实际 cap 与软推理估计，配置 timeout 覆盖完整 body | P/Runtime/Settings/R；A11/A12/A16 |
| R41 | 必要数组批次、六种小 runner，无通用任务图 | C/R/N/源码核验；A10/A11 |
| R42 | 技术恢复与内容额度分开，第三次显式 retry 可成功 | R/S/F/P；A07/A11/A12 |
| R43 | 局部安全失败，不阻塞无关学习，不伪成功 | R/S/F/J；A11 |
| R44 | 短 K ID、来源去重、scope 缓存、逐包/题/评分复用 | C/R/F/S/J；A11/A12 |
| R45 | 单一新版 DB/shared/API/Provider/UI，正常持久化 | schema/H/N/U/build；A10/A14/A15 |
| R46 | 完整离线工程验收、真实模型操作卡和受控入口 | 全量及 [CLINIC_V2](CLINIC_V2.md)；A15/A16 |

## 6. 用户接续与剩余验证边界

运行与资源配置见 [CLINIC_V2.md](CLINIC_V2.md)。用户先使用独立新版数据库，保留旧路径；设置中选择实际 MoMA/GLM/compatible 的端点、模型、思考配置和合理超时/cap。没有正式用户数据迁移任务。

A16 使用原 MoMA/GLM 失败教材与一份正常教材，从完整 K/Plan 检查、深度确认，到按需课堂、Tutor、可选 Practice/Repair、独立 Formal、新卷重考与冷重启历史。生成前固定分层抽审样本和分母，包含普通低风险解释、条件/例外、核心能力与例题；人工核查来源、实质讲解、可解性、答案/替代答案、rubric、考试代表性。真实请求延迟、reasoning-only、预算共享及大型特殊文档表现只可由真实运行确认。

UI 是完整 A16 的入口；`npm run eval:hy3 -- --allow-paid --materials "教材路径" --database "独立验收库路径"` 可先生成规划供审查。继续已有课程时传同一 `--database` 和 `--workspace ID`，不重复传 materials，复用保存规划；用户已审查后可加 `--continue-after-plan-review` 生成课文，仍不自动完成 Lesson 或替学生答题。脚本没有 `--allow-paid` 会在请求前停止，Fake 会被拒绝作为 A16 证据。

目前没有已知未解决的工程阻断。**未作出的结论**包括真实模型端到端成功、真实教材完整语义覆盖、真实 MoMA 推理预算行为和任意规模资源保证；这些属于明确留给用户的 A16，而不是以 Mock 代替完成。发现实质语义缺陷后保留输出和教材 scope，修复对应提取/教学/题目准入范围并回归，维持已冻结的简化流程。
