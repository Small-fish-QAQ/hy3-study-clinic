# Study Clinic V2 课程准备与规划体验恢复

本轮范围：资料导入/管理、课程准备设置、生成状态、完整规划、深度调整与确认。继续使用 V2 业务内核；没有恢复旧 Detail、Coverage Mapping、课程 Review、规划型 Tutor 或强制练习/考试。使用原品牌、插画、纸面纹理和字体，其他业务页面保持原有实现。

## 旧版调查与判断

主要依据为保护快照 `output/architecture-implementation/source-snapshot/`，并对照 `docs/media/screenshots/02-course-materials.webp`、`03-course-structure.webp`。

| 旧版事实 | 本轮处理 |
| --- | --- |
| `CourseMaterialsView.tsx` 使用来源类型文件标记、标题/页数/引用片段、解析提示、折叠“处理版本与来源”、折叠导入区与回主页入口。 | 复用这些页面层级与原 CSS。补齐 V2 已有来源信息，恢复可编辑阅读标题，上传后明确导入，再进入课程准备。 |
| `AgentCourseWorkspace.tsx` 内 `ContractEditor` 是三段课程设计表单：资料、整体深度、可选关注主题。并非仅有配色或装饰。 | 恢复三段表单与各项说明。资料始终完整提取；深度、重点进入原有 Course Map 组织请求，并随规划保存、传给按需 Lesson。 |
| 旧版准确名称是“基础理解 / 熟练运用 / 高水平表现 / 深入迁移”。`desiredDepth` 与 `focusRequest` 会影响课程结构、教学目标和教学设计。最高档还绑定独立综合迁移检验及单元完成条件。 | 对齐 V2 既有三档 `introductory / standard / advanced`，呈现为“基础学习 / 深入理解 / 迁移应用”。分别说明直观概念、关系条件、条件变化和迁移判断；保留学习者的基线、模型建议和逐课选择。取消最高档的强制考试及完成门。 |
| `CoursePreparationStatus.tsx` 展示当前工作、已用时、已保存结果、中断/继续与同步错误；阶段来自当时的多阶段准备系统。 | 保留这些体验，阶段改为 V2 的知识提取、课程与路线组织、本地检查、用户确认。公开已有操作 payload 上的真实进度，不增加模型请求或任务图。 |
| `CurriculumView.tsx` 先展示完整结构统计与主要部分，再展开学习单元、目标和来源。旧主页与 StudyPlan 还有各自的接受入口。 | 合并为统一完整规划：模块 → Lesson → 折叠目标/知识，先修仅提醒，考核要求可展开。深度保存后同步目标与冻结考核要求；完整安排底部一次确认，随后按需开课。 |
| `ImportView.tsx` 曾有独立资料库历史、重命名、检索；课程资料页保留原始文件名和解析版本。 | 当前只恢复课程范围内的标题管理与来源披露，不重新引入旧资料库或用途治理系统。 |

为对照无既有截图的准备表单与生成状态，从快照原样抽取原 `AgentCourseShell`、`ContractEditor`、`CoursePreparationStatus` 及原 CSS，以合成课程资料渲染展示参照。这个临时参照不运行旧服务端，不接旧库、不发生模型请求；文件在本轮 evidence 目录，快照未修改。其原有样式/文案没有被作为 V2 业务合同。

## 编码文件名调查

旧 `CourseMaterialsView.addFile()` / `ImportView` 将 `File.name` 原样传给服务端，没有文件名 URL 解码。旧 `services/materials.ts` 对文本及可解析的 PDF/DOCX/PPTX 优先调用 `deriveTitle(normalized.content)`；原始文件名另存为 `originalFilename`。没有正文时才回退文件名。`deriveTitle()` 读取首个有效标题/首行，既不解码也不调用模型。

恢复前 V2 的上传控制器明确传 `title: file.name`，所以文件本身若叫 `%E7...pdf`，标题显示同样的字符串是这条回退/覆盖路径的结果，不能据此断言程序错误编码了原文件。

现在上传前给出可编辑阅读标题：对有效 URL 编码只解码一次，保留 `+`、不完整编码以及含控制字符/路径字符的原字符串；去掉展示标题的扩展名。请求中的 `filename` 仍是原始 `File.name`，服务端来源身份、revision 和 hash 不变。用户留空标题时由正文提取。已有同名标题只做显示处理，不批量改写已存数据。来源详情始终显示原始文件名，标题编辑不新建 revision、不改变 scope hash、不重新调用模型。

真实浏览器上传了一个**文件本身就采用编码名称**的测试 PDF，检查了友好标题、2 页/2 片段、原始编码名称、编辑标题和窄屏换行。它是公开测试夹具的副本，不是用户教材；没有读取现有真实数据库。

## 实现与必要取舍

- 新增展示组件 `ClinicMaterials`、`ClinicPreparation`、`ClinicPlan`。`ClinicCourse` 保留正式考核展示，转出统一规划组件。`ClinicWorkspace` 继续使用 `clinicApi`，负责课程隔离、查询、显式操作和恢复。
- `coursePreparation.css` 复用快照的资料卡片、课程设计表单、进度和结构样式，限定在本轮页面，添加 V2/窄屏适配。原 37 个 public 资产没有修改。
- `CoursePreferences` 随原 `curriculum_versions.payload` 保存；进度与冻结设置随原 `agent_operations.payload` 保存。不增表、不增迁移、不接旧用户数据。新增/修改的 API 是只读资料摘要、课程内重命名、prepare 的设置字段。
- 深度选择沿用 V2 的本地目标/蓝图需求调整。知识提取不受浅深度影响；关注主题进入既有规划与 Lesson 请求，不能缩减全部必学知识或虚构来源。真实模型对这些要求的教学质量仍需用户验收。
- 新设置复用已保存知识和符合当前设置的有效生成缓存。改重点产生待确认规划，Lesson 语义缓存包含重点，避免错误复用旧重点的正文；旧课堂/对话保留。回到之前的设置也能形成可见的待确认版本，无需重新购买相同有效规划生成。
- 原多轮准备阶段没有恢复。进度公开已保存的来源片段、知识和课数，无估算百分比、假进度或额外 Review。完成记录默认收起，让完整路线成为主内容。缺资料、生成中、停止、失败、重载和显式重试均有对应反馈。
- 浏览器发现并修复了 queued→running 后立即停止携带旧版本的时序问题；取消前读取最新操作，并处理恰好完成的情况。停止后继续使用冻结设置；较旧失败不会覆盖较新的完成操作。
- 不提供任意重排、旧 Detail 编辑、用途确认链和自动迁移考试。正式考核仍独立，先修不锁 Lesson，学习完成继续由学生主动确认。

## 浏览器与工程验收

本轮使用 Codex In-app Browser 检查 1600×900、1440×900、1024×768、390×844；截图在 `output/playwright/preparation-restoration/`。各尺寸均读取实际 `innerWidth` 核对，临时 viewport 在交付前恢复。

真实 UI 验收包括：Markdown 文件导入；粘贴正文；编码 PDF 上传与标题编辑、原名/版本查看；移除说明、取消和移出隔离样本；三档整体深度/可选重点；生成进度、失败、重试、重载、立即停止及继续；逐课深度与目标/考核同步；模块与知识折叠；完整确认；直接打开第二课并主动完成；独立正式考核入口。

浏览器服务使用独立 `output/architecture-implementation/preparation-restoration/clinic.sqlite` 和 Fake Provider，外部 fetch 明确禁止。专用预览脚本只在 evidence 目录给 Fake 添加短暂延迟及一次显式超时，以检查等待/恢复界面；生产代码没有演示故障逻辑。不能以离线界面或测试通过宣称真实模型语义成功。

工程日志保存在 `output/architecture-implementation/preparation-restoration/`。最终检查结果及本轮精确文件清单见 `verification.json`。单元/集成测试覆盖资料身份与 GET 纯读、权限、深度/重点实际传递、全集与考核保持、变更后缓存隔离、停止 fencing、重连恢复、旧失败隔离和前端交互。

| 最终检查 | 结果 |
| --- | --- |
| 全量单元/集成测试 | 32 个文件、252 项通过（shared 20 / server 194 / web 38）；最后前端修正后 38 项再次通过。 |
| shared/server/web 构建 | TypeScript 与 Vite 通过；最终前端再次构建通过。 |
| ESLint / Prettier | 全部通过。 |
| `npm run eval:fake` | 合同回归通过，外部请求 0。 |
| `git diff --check` | 通过。 |
| 来源保护 | 3,142 个快照文件、37 个原 public 资产完全一致，HEAD 未变，无源码删除。 |
| 退役依赖扫描 | 生产源码违规 0。 |
| 最终新开预览标签控制台 | error 0、warning 0。 |

本轮精确变更为 22 个源码/测试/样式文件和本文；源码清单与哈希保存在 `integrity-final.json`。预览为 `http://127.0.0.1:5174/#workspace=workspace_975ce05f-4a46-48db-b994-60f69248cd7b`，使用隔离 Fake 库；停在完整规划待审阅状态，原已完成课堂保留于学习记录。

没有调用付费模型、修改 `.env`、修改/清理真实库、commit 或 push。当前工作树包含前两轮大量未提交架构和 UI 成果；本轮文件清单来自施工前哈希对照，不能将整个 Git diff 归因于本次修复。

## 视觉证据与边界

| 证据 | 文件 |
| --- | --- |
| 旧资料页 / 本轮恢复 | `materials-comparison.png` |
| 原快照准备表单 / V2 三档适配 | `preparation-settings-comparison.png` |
| 原快照进度 / V2 真实操作进度 | `preparation-progress-comparison.png` |
| 旧结构页 / V2 统一完整规划 | `plan-comparison.png` |
| 桌面资料 / 设置 / 规划 | `materials-desktop.jpg`、`preparation-settings-desktop.jpg`、`plan-draft-desktop.jpg` |
| 目标、深度和确认 | `plan-lesson-detail-desktop.jpg`、`plan-confirm-desktop.jpg` |
| 手机设置、重点、规划 | `preparation-settings-mobile.jpg`、`preparation-depth-focus-mobile.jpg`、`plan-mobile.jpg` |
| 编码 PDF 及来源 | `encoded-pdf-upload-tablet.jpg`、`encoded-pdf-identity-tablet.jpg`、`encoded-pdf-identity-mobile.jpg` |
| 等待、中断、停止、重载恢复 | `preparation-progress-desktop.jpg`、`preparation-failure-mobile.jpg`、`preparation-stopped-mobile.jpg` |

对照图上旧下新。旧静态截图原始尺寸 2560×1440，等比缩至 1600×900；历史截图的原 CSS viewport/DPR 未记录。快照参照用相同 CSS viewport 渲染，输入为合成内容。两代产品的阶段、课程内容和导航文案有意不同，不声称像素完全一致。截图对照用于核对品牌、纸面、组件、比例与层级；未宣称完整无障碍合规。手机软键盘只做桌面 viewport 检查，没有真实设备结论。

真实 MoMA/GLM 与教材验收仍由用户在正常 V2 环境执行，参照 [CLINIC_V2.md](CLINIC_V2.md#真实模型-a16)。本轮增加的关注主题应人工检查是否合理影响规划/课文，并确认基础深度没有漏教、迁移深度没有伪造来源；不把离线夹具当最终教学质量结论。
