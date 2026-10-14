# Study Clinic V2 · 2026-10-14 真人复测交付

本轮 P0 和导航、课程管理、课堂布局已完成。冻结生产代码后，从原失败数据库的独立副本，通过普通页面 **只点击一次手动恢复**，64.6 秒完成实际失败 Lesson。服务重启后仍能读取同一份已验证课文，未新增模型调用。原用户数据库、模型配置、Key、历史实验成果保持不变；没有 commit 或 push。

## 实际 Lesson 失败与修复

实际课程为已确认的「离散数学」，8 个模块、17 个 Lesson、35 个必学知识点、39 个目标。失败的第一课是「有效结论与论证的基本概念」。

| 身份 | 真实记录 |
| --- | --- |
| Workspace | `workspace_c56b74df-4a4a-473d-8e14-0417bf0c6ac4` |
| 已确认规划 | `curriculum_da23438341c567985076cbb2b3305d72` |
| Lesson | `lesson_2787499e444cc08f76dae1ccc91d324a` |
| 首次失败 Operation | `operation_f21684aa-1833-4813-b6b9-44981344a602` |
| 原完整作者调用 | `call_20980586-9199-45b2-a323-0aad38604bed` |
| 原局部修订调用 | `call_cd8cfe19-55cc-47be-9c4d-9e2fd0365493` |
| 最后一次原手动重试 | `operation_77d7dd42-d39b-44dc-9fc4-77d91b733323` |

已证实的原因：原作者为 `seg_1` 中知识点 `knowledge_fbfd2df8008b8550966dbbe9e1967a6d` 提供的教学定位引文，与实际正文不一致。局部修订返回了修订后的 `seg_1` 和新增示例／思考段落，其局部 `seg_2`、`seg_3` 与原完整课文的健康段落 ID 冲突。旧合并代码把新增局部段落识别为改写健康段落，因此拒绝。局部候选的定位引文还以句号结尾，而实际对应正文随后使用冒号。

用户的 **20 次手动重试均创建并执行了新 Operation**，约 45–70 毫秒再次失败，且没有新模型发送。这些操作反复命中了同一份未正确标记为拒绝的局部缓存候选。错误统一被标为可重试，前端因此持续提供无法推进的按钮。没有证据表明系统自行进行无限自动重试；原现象的主要原因是候选生命周期与局部合并合同，而非 API 超时或请求预算耗尽。

修复由现有局部恢复路径承担：新增局部段落若撞上健康兄弟段落 ID，确定性赋予局部作用域 ID；原健康段落的正文、引用及范围外覆盖保持字节一致。被拒绝的局部候选保留内容和定位原因，用于下一次有界修订，不再作为成功缓存重放。定位引文先作精确匹配，必要时仅去除末尾标点后要求唯一精确匹配；缺词、多处匹配、错误知识／目标身份仍拒绝。来源真实性、必要正确性和原有局部核查继续执行。

连续两份局部候选仍失败时，服务端明确设置 `retryable=false`，显示已保存成果、失败详情和资料修正／联系维护者的下一步。前端及服务端均阻止无效重试。整个修复没有全量再生成 Lesson，也没有新增正常路径的模型审核。

代码主要位于 [lessonRevision.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/lessonRevision.ts)、[courseLessons.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/courseLessons.ts)、[lessonDelivery.ts](C:/Users/smallfish/open-source/hy3-study-clinic/apps/server/src/services/lessonDelivery.ts) 和现有 Operation 恢复路径。

## 证据与真实调用

离线隔离回放复现了 63 毫秒失败、0 次模型请求；局部回放验证了 5 个健康段落、来源及覆盖被保留。离线模型替身只证明工程合同。

探索调试阶段首次真实局部修订仍遇到定位标点不一致；随后修复定位合同，复用该候选并通过原有核查。这次中途改代码的结果仅作为调试证据。正式验收重新从未经修复的原失败副本开始，冻结 104 个生产文件，运行过程中没有修改源码、候选或数据。

正式验收 Operation：`operation_825f3799-7e2b-4557-b44c-8ff5c9aee0b1`，耗时 **64,633 毫秒**，普通页面手动恢复 1 次，最终完成。局部作者耗时 56,626 毫秒，原有核查 7,863 毫秒；没有重新购买完整作者。原 `seg_2` 至 `seg_6`、来源引用及错误范围以外的教学覆盖全部保留。重启后的 9 张相关业务表哈希一致，读取已保存课文无需再次调用模型。

| 本轮 MoMA / glm-5.3 用量 | 结果 |
| --- | --- |
| 探索 + 冻结验收真实请求 | 4 次：局部作者 2 次、原有必要核查 2 次 |
| 已报告 Input | 8,406 Tokens |
| 已报告 Output | 4,953 Tokens |
| Input + Output 合计 | **13,359 Tokens** |
| 冻结版实际失败 Lesson 恢复 | 1/1 完成；2 次调用；6,608 Input + Output Tokens |
| 探索阶段失败 | 1 次局部作者候选仍不满足定位合同；已保留失败记录 |
| 费用 | 用户已确认该端点／模型适用免费额度；API 未返回账单或货币费用，实际扣款无法由本地确认 |

完整证据：[原失败记录](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/p0-original-evidence.json)、[离线复现](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/replay-before.json)、[冻结版真实恢复](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/frozen-p0-acceptance.json)、[重启持久化检查](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/final-persistence.json)。

## 导航、课程管理与界面

“学习中心”直接复用原 **学习与复习、学习记录、课程资料** 完整组件和回调，顶部三个标签切换。统计、复习建议、知识状态、补救轮次、可恢复操作、正式成绩与 Evidence、上传和来源身份均保留。旧 `view=progress/records/materials` 地址仍兼容；历史地址重载、浏览器返回和课程身份已验证，没有业务数据迁移。

课程卡片使用已有状态、Lesson 进度、最近活动和资料摘要，无新增模型调用。管理课程支持多选及明确确认，未选中时不能删除。单课和批量删除共用同一归属删除实现：先验证所有课程身份，再取消／隔离正在运行的操作，并事务删除所选课程的资料、学习记录、成绩、Evidence 等；补齐原遗漏的课堂思考归属删除。晚到模型结果不能重建已删除课程。

普通页面实际批量删除了隔离库中两门临时课程；原六门未选课程及其所有归属表保持一致，外键检查通过。完整成绩／Evidence／课堂思考删除、混入不存在课程时零副作用、运行操作取消与晚到结果均有工程测试。[实际删除证据](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/delete-real-ui-audit.json)。

课堂空状态只保留一个按模块组织的选课入口。实际 17-Lesson 课程在桌面和 390 像素窄屏检查通过，8 个模块及全部 Lesson 可见；选择已有课堂后回到正常课文和 Tutor 布局，课程导航保留跳课、当前课／完成状态和历史课堂入口。四档课程深度、逐 Lesson 调整与特别关注语义按本次决定保留，未修改其 Prompt 或数据合同。

| 原截图 | 本次处理 |
| --- | --- |
| 1 · 091051 | 课程卡片真实摘要；安全批量管理／删除 |
| 2 · 091251 | MoMA API 地址说明改为准确文案，连接与模型身份保持原值 |
| 3 · 091945 | 准备失败展示简明原因、保存成果、恢复动作和可展开详情 |
| 4 · 092214 | 同上；保留已经能恢复的知识提取／规划流程和必要核查 |
| 5 · 092424 | 深度与关注机制按本次决定保留；没有重新引入 focused Unit |
| 6 · 092451 | 确认区复用深绿品牌和已有植物资产，突出确认按钮 |
| 7 · 092525 | 保留逐课四档深度及现有课程设计 |
| 8 · 092719 | 移除重复巨大空状态，直接显示模块选课入口 |
| 9 · 092739 | 17 课按 8 个模块分组，适配长标题及窄屏 |
| 10 · 092833 | 知识关系主容器宽度、居中和响应式边距统一 |
| 11 · 092932 | 原学习与复习完整内容置于学习中心标签 |
| 12 · 092946 | 原学习记录完整内容置于标签；保留补救和恢复操作 |
| 13 · 093021 | 原课程资料完整内容置于标签；资料身份和操作保留 |
| 14 · 093219 | 实际 Lesson 无效手动恢复阻断已修复并真实验收 |

截图：[实际恢复课文](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/frozen-p0-restored.png)、[学习中心](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/learning-center.png)、[学习记录](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/center-records.png)、[课程资料](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/center-materials.png)、[桌面课堂选课](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/classroom-selector.png)、[窄屏课堂选课](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/mobile-classroom-selector.png)、[Tutor 正常布局](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/active-lesson-tutor.png)、[课程卡片](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/library.png)、[删除确认](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/delete-confirm.png)、[知识关系](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/knowledge-layout.png)、[设置文案](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/settings-copy.png)。

[课程确认品牌截图](C:/Users/smallfish/open-source/hy3-study-clinic/output/playwright/final-ui-20261014/confirmation-brand-preview.png) 是 **样式预览**：仅在浏览器中把 GET 返回的已确认状态临时显示为草稿，未改数据库、未点击确认；不能作为新草稿实际确认流程的验收证据。拦截已移除。

## 工程检查与数据保护

363 项测试通过（shared 20、server 295、web 48）；完整构建／类型检查、lint、离线课程合同和 HTTP 集成检查通过。HTTP 检查使用本地替身，不计入真实 MoMA 请求。新增关键回归覆盖局部段落合并／唯一定位／拒绝与有界恢复、课程归属删除／运行取消，以及学习中心和删除确认交互。

最终检查以本轮新基线比对原库 32 张表、Provider 配置与加密密钥、`.env`、Git HEAD 和此前 3,145 份受保护非数据成果；原内容均保持一致。所有实际恢复及删除测试都在隔离副本上进行。最终生产文件与冻结验收时的 104 文件哈希一致。

日志：[测试](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/final-tests.log)、[构建](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/build.log)、[最终 lint](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/final-lint.log)、[数据保护](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/protection-final.json)、[最终代码与用量检查](C:/Users/smallfish/open-source/hy3-study-clinic/output/final-ui-20261014/final-checks.json)。两份隔离验收库均无运行中或排队的操作。

## 今天的最后一次真人验收

已运行的隔离新版：[课程预览](http://127.0.0.1:8794/#workspace=workspace_c56b74df-4a4a-473d-8e14-0417bf0c6ac4)、[冻结验收副本](http://127.0.0.1:8795/#workspace=workspace_c56b74df-4a4a-473d-8e14-0417bf0c6ac4)。两份都已恢复第一课，可以直接查看界面、课文和学习中心。此后主动生成新课、提问或出题仍使用真实模型；页面查看不新增调用。临时预览服务保持运行，旧验收服务未被重启。

原用户库没有被代替执行恢复，原 Lesson 在其中仍保留失败状态。若要在原库复测，请用原启动方式重启服务并刷新页面；务必继续使用 `data/clinic-v2-real-a16.sqlite` 和 `data/clinic-v2-a16-provider.json`，避免默认 `.env` 指向旧库。当前构建已准备好。也可在仓库的 PowerShell 中明确指定原路径再启动开发入口：

```powershell
$env:DATABASE_PATH = 'C:\Users\smallfish\open-source\hy3-study-clinic\data\clinic-v2-real-a16.sqlite'
$env:PROVIDER_CONFIG_PATH = 'C:\Users\smallfish\open-source\hy3-study-clinic\data\clinic-v2-a16-provider.json'
npm run dev
```

以上是复测时的启动方法，本轮未执行该命令去写原库或重启用户服务。

1. 打开原来已确认的 17-Lesson 课程和第一课，**手动恢复一次**；无需重新准备教材或确认课程。真实验收参考用时约 65 秒，期间可以看到正在准备状态。
2. 阅读恢复后的课文及来源，打开／收起 Tutor 和课程导航，检查模块选课；必要时刷新验证已保存课堂。
3. 进入学习中心，切换三个标签，查看原学习统计、补救／可恢复操作、成绩和课程资料。
4. 查看同名课程卡片摘要；批量删除仅用临时测试课程，确认弹窗中的课程名和数量后操作。
5. 确认四档深度、特别关注设置仍符合已选设计，再开始录制 Demo 和整理参赛材料。

本轮停止扩展。证据覆盖这条实际失败 Lesson 与代表性界面路径，不能推断所有教材和模型输出都不会失败；后续真实候选仍须通过必要检查。连续局部修订无法满足合同会明确停止并保留证据，不会以全量重复生成或降低正确性要求换取通过。
