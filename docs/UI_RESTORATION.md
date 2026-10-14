# Study Clinic V2 UI 恢复

2026-10-12 完成本次 UI 修复。深松绿导航、暖象牙纸面、原本地字体、开书插画、白色阅读文档及独立 Tutor 已恢复；完整 V2 功能继续使用 `clinicApi` 和当前服务端合同。

视觉来源为 `output/architecture-implementation/source-snapshot/apps/web/src/`。复用原 `AgentCourseShell` 纯布局、`styles.css` / `studio.css` 的展示规则以及现有 `public/brand`、`public/backgrounds`、`public/fonts`。没有恢复旧业务组件、数据库、Review、强制 Practice/Repair/Formal 或旧掌握度写入。

## 文件范围

| 文件 | 本次作用 |
| --- | --- |
| `apps/web/src/views/ClinicWorkspace.tsx` | 保留 V2 控制器，组合成熟展示；补齐切课程异步结果隔离，导入正文使用课程讲义标题。 |
| `ClinicShell.tsx` | 原品牌导航、课程选择、折叠侧栏、窄屏抽屉和焦点管理，仅持有布局状态。 |
| `ClinicCourse.tsx` | 完整规划、知识折叠、深度、主动确认、Lesson 导航和独立正式考核蓝图。 |
| `ClinicClassroom.tsx` | 完整阅读、Tutor、来源披露、历史/回看、Practice/Retest/Formal 作答与补救。 |
| `ClinicRecords.tsx` | 学习完成、日常/正式证据、复习、所有成绩和作答明细、补救与操作恢复。 |
| `apps/web/src/components/StudyText.tsx` | 安全 React 文本阅读排版：标题、段落、列表、表格、代码和引用；不执行 HTML。 |
| `apps/web/src/styles.css`、`studio.css`、`clinic.css`、`main.tsx` | 恢复原设计基础与响应式，并添加 V2 必要展示适配。 |
| `ModelServiceSettings.tsx` | 保留完整模型连接功能，接入资源设置卡片样式。 |
| `apps/web/src/clinicApi.ts` | Classroom 来源引文 DTO 和 Tutor 来源/拓展标识。 |
| `apps/server/src/services/courseLessons.ts` | 课堂 GET 返回属于当前课程的精确来源引文；不改 schema、不写 DB、不添加模型调用。 |
| `ClinicWorkspace.test.tsx`、`ClinicPresentation.test.tsx`、`StudyText.test.tsx`、`apps/web/src/test/clinicRoom.ts` | UI 接入、历史/草稿恢复、revisit、迟到响应、焦点/键盘和安全文字回归。 |
| `apps/server/src/routes/clinicSecurity.integration.test.ts` | 来源精确性、跨课程权限与 GET 不写库检查。 |
| `design-qa.md`、本文 | 本次设计复验、证据索引和边界。 |

此表区分本轮 UI 修复与之前已授权的 V2 工程；当前 Git 中大量删除/修改来自前一轮架构实施，不能全部算成本次 UI 修复。

## 业务接入与浏览器验证

新建课程与文本导入、完整规划、深度/确认、任意 Lesson、Tutor、主动完成、历史只读、独立 revisit、按需 Practice、草稿恢复、提示记录、可靠评分、主动 Repair/一次 Retest、独立 Formal 新卷与重考、全部历史成绩、日常/正式证据分离、主动复习、模型设置与恢复入口均可从恢复后的界面使用。

真实 Codex In-app Browser 检查了 1600 × 900、1440 × 900、1024 × 768、390 × 844。通过界面创建访谈课程，导入 6 段教材，完成两课、Tutor、Practice 错答、Repair/Retest、两次正式卷（100% 与 0% 分别保存）和主动复习；正式失败后学习仍为 2/2 完成。模型设置只检查草稿与资源面板，没有连接测试或外部请求。

使用 `scripts/start-offline-clinic.mjs` 与 `output/architecture-implementation/browser/clinic.sqlite`，Provider 为 CourseFakeProvider，外部 fetch 禁止。浏览器为真实运行的 V2 应用，Fake 结果不证明真实模型教学质量。没有接触现有真实库、`.env`、付费 Key 或 commit/push。

设计 QA 和截图对照详见 [design-qa.md](../design-qa.md)。所有截图在 `output/playwright/ui-restoration/`，对照图上旧下新、局部左旧右新。原图 2560 × 1440 等比缩为 1600 × 900；原 CSS viewport/DPR 未记录，课程数和动态内容不同，不宣称逐像素一致。

## 最终工程验证

| 检查 | 结果 |
| --- | --- |
| `npm run test` | 30 个测试文件、241 项通过：shared 20、server 190、web 31。 |
| `npm run build` | shared/server TypeScript 和 web TypeScript/Vite 全通过。 |
| `npm run lint` | ESLint 与 Prettier 全通过。 |
| `npm run eval:fake` | 离线合同回归通过，外网请求 0。 |
| `git diff --check` | 通过。 |
| `scripts/verify-clinic-integrity.mjs` | 3,142 个快照文件哈希全部一致，HEAD 未变，退役生产依赖 0。 |
| 浏览器 | 主要页面/动作及四种尺寸通过；最终控制台 error 0、warning 0。 |

本次日志、资产哈希核对、截图清单和机器可读报告在 `output/architecture-implementation/ui-restoration/`。最初 UI 测试发现的断言/测试夹具问题已修正并重跑；一次离线回归与 `pretest` 同时运行导致 shared/dist 暂时不存在，已按依赖顺序重跑通过，没有删减检查或修改正确性标准。

## 本地预览与真实模型验收

离线预览地址：`http://127.0.0.1:5174/`，当前课程 URL 为 `http://127.0.0.1:5174/#workspace=workspace_e41bc456-02ab-415a-bb21-ae280c2e3699`。服务保持运行，使用隔离 Fake 预览库。

真实 MoMA/GLM 验收由用户另行执行：[CLINIC_V2.md](CLINIC_V2.md#真实模型-a16) 与 [A16 操作卡](architecture-simplification-plan/MIGRATION_AND_ACCEPTANCE.md) 说明独立新库、连接配置、正常教材与原失败教材的完整学习/考试验收及分层语义抽审。应在正常 V2 运行环境连接真实模型；离线预览服务明确禁止外部模型请求。

没有遗留的已知阻断 UI 修复问题。真实模型质量、实际大教材内容和真实手机软键盘表现没有在本轮冒称通过。
