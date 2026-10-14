# Study Clinic V2 可靠性与推理策略研究

更新于2026-10-14。使用用户已配置的MoMA / glm-5.3，所有新增数据在隔离研究库中，作答者为模拟学习者。没有commit或push。旧阶段报告保存在 output/reliability-study/report-before-consolidation.md；历史错误、候选和成绩均保留。

Goal A：**PASS**；Goal B：**PASS**；Normal User Cold Start：**PASS**；Failure Recovery：**PASS**；Essential Correctness：**PASS**；Reasoning Strategy：**IMPLEMENTED**。最终生产源码为冻结31，验收门槛保存在 `output/reliability-study/goal-a-acceptance-gate.json`。已完成真实多次对照、全部内容评估、任务策略实现与真实复验。

这些PASS表示代表性用户路径、持久化恢复及必要正确性机制已验收，不保证每个模型候选或每句话都正确。完整教材冷启动在冻结24完成；后续局部合同、Lesson核查、推理偏好、空考核标注与偏好身份规范改动分别复验，再在最终版本读取原成果并冷重启。没有把这个过程写成冻结31重新从零生成了全部课程。

## 授权与数据保护

用户追加授权允许自主提高此前264请求/400万Token限制，约2000万免费Token可用。内部研究护栏最终为800请求/1200万已报告Input+Output，可依据进展调整；这不是消耗目标。赠送额度覆盖当前端点与模型由用户文字确认，未独立查询账户。实际金额和币种未知，保持null。Input+Output采用平台报告的合计；reasoning单独记录，不再相加，其分项偶有与实际推理流不一致的现象。真实收费、异常失控消耗或长期无实质进展时暂停。

原数据库data/clinic-v2-real-a16.sqlite及原Workspace完整保留。原模型配置/加密Key、3158保护文件、源码快照与Git HEAD保持不变。各次原始失败未抹除；新知识、题目、课堂和成绩都有隔离物理出处。protection-final.json核对文件及原数据库逻辑行内容，baseline.mjs未重跑。

## 工程根因与修复

| 根因 | 最小充分修复 | 实际恢复边界 |
| --- | --- | --- |
| 泛化校验错误扩大成全课作者 | PlanIssue定位Lesson/目标/领域/cell/知识；专用局部修订含只读外部引用 | 仅处理受影响对象，健康Lesson和有效蓝图成员保留；真正越界成员仍可移除 |
| 未通过候选与可丢弃结果混淆 | 持久不可变course_plan_candidates，parent/hash/物理出处/失败原因 | 最新同来源、偏好、Provider身份候选恢复；取消可保管但不能发布 |
| 新auto偏好表示与旧隐式默认使用不同缓存身份 | 把语义相同的implicit/explicit auto规范为原身份 | 冻结31真实旧提取候选原call/hash零请求零写入复用；Tutor档位和核查合同仍各自限定身份，不清空缓存 |
| 索引、长ID、重复来源登记由模型承担 | 知识localRef、规划短ID、核查K/O短ID；来源归属由实际引文派生 | 不猜错别ID；知识未解释且无合法排除的正文仍拒绝；重复登记漏项可本地恢复 |
| 知识分包范围变成长期教材事实 | 提取合同区分当前分包与完整资料；核查target分知识/课堂 | 精确知识更正另存不可变新版本，旧inventory/课文/成绩不重写 |
| 局部知识补丁被当作整包候选 | 指定localRefs并合并同包健康知识；真实定位来自既有核查 | 修一个K不丢其他K与关系，不新加审核轮数 |
| 知识kind被误用为目标认知等级 | 保留作者在选定深度下写出的实际目标demand，同步蓝图 | 完成证明仍为apply，解释目标可为understand，不按类别一刀切降格 |
| 同一内容重查随机通过抹掉已知错误 | 原完整负面证据继续约束；更正必须改变被拒内容/来源/不确定性 | freeze19原草稿不列为纠正成功，freeze20实际更正才计入 |
| 核查ID拼写错误被算成题目错误 | accepted核查合同先验证身份；技术恢复复用作者和独立解 | 历史耗尽slot仅有完整匹配坏核查才可重新核查，不重置内容额度 |
| Lesson坏引文被误当资源404 | 来源错误带段落定位，进入已有一次局部修订 | 不猜测ID，不买整篇课文；同一K的其他段与coverage保持 |
| 局部修订不知道健康cell已占用的身份 | 在references中补只读全局领域/cell/目标/代表集合身份 | 冻结26真实原失败范围1请求、4.4秒修复；未修改健康Lesson或cell，真实考核目标仍完整 |
| Lesson长ID和重构整段引文易错 | 精确K/O/S/R短别名，来源使用短原文引句 | 只翻译结构身份，不改正文或猜测引用；结构成功不等于内容正确 |
| 核查只看例题数值和teachingQuote，漏掉正文错误推广 | 既有必要Lesson核查检查全部实质断言，并携带已接受直接先修知识与来源 | 冻结27高推理拒绝“速度不变号则路程等于带符号位移”；只更换坏段落，4健康段保留，没有新增核查层 |
| Formative携带不适用Formal标注 | 服务端清空未使用coverage，独立解题/rubric仍保留 | 恢复保留题目，Formal实际覆盖不放宽 |
| 独立解题也生成不适用的空cell标注 | expectedCells=[]时coverage由服务端归一为[] | 保留歧义、答案、来源和实际知识严格检查；真实Formal cell仍严格；已完整响应17ms/0请求恢复 |
| 作者答案、隐藏评分要求与错误等价答案 | 发布独立解题的可信参考；所有计分项由公开题面支撑；既有核查检查原替代答案等价性 | 错等价项剔除，不增加独立审核；历史错rubric判分保持uncertain，不能算学生错 |
| 同一次判分重复生成criterion理由与总评，互相矛盾 | 模型只生成criterion结论与理由；服务端按rubric顺序组成公开反馈 | 分数仍由服务端计算；旧成绩/反馈保留，不增加评审模型 |
| 全部资料和输出预算不反映执行时间 | 知识/证明完整语义分包、模式速率隔离、join仅补先修 | 保留真实deadline/取消；未知结果不盲目重发，不靠无限输出或重试 |

主要改动在apps/server/src/services/coursePlanning.ts、courseKnowledge.ts、coursePlanCandidates.ts、coursePlanRevision.ts、courseLessons.ts、courseQuestions.ts、questionAdmission.ts、courseGrading.ts及llm/courseProvider.ts、courseContract.ts、knowledgeWire.ts、knowledgeAccounting.ts、knowledgeRevision.ts、lessonWire.ts、questionReviewWire.ts。配置改动沿用shared/domain/providerConfig.ts、ProviderRuntime和现有设置界面。Schema6→7允许同来源知识清单保留多个不可变版本；迁移事务保留旧行/FK/不可写约束。没有新TaskGraph、路由Agent或默认多轮Review。

## 真实验收证据

教材是原库逐字一致的7187字符/214块可检索正文，SHA256 77e656982cbbc4cbae968c55bd066d223b3a3686cdd2d6a194ce8fbcf4e4061a。原扫描PDF字节未获得，不能宣称核对PDF原图。疑似习题4b保留箭头与条件，不自动改题或伪证。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 原离散教材冻结24正常入口 | 一次Operation成功；UI新建/导入/默认熟练运用/无重点/确认；27请求/562226ms | freeze24-cold-operation.json，goal-a-source-freeze-24.json |
| 同包正确性局部恢复 | 只改1K，12健康兄弟不变，原75来源块/14K保持 | freeze23-packet-recovery-audit.json |
| 来源登记恢复 | 复用原39块/10K完整候选，0新提取请求，保持25健康K | freeze22-bookkeeping-recovery-audit.json；knowledge-accounting-replay.json |
| 完整清单局部更正 | 2请求只改1K，45K与23Lesson不变，旧版本保留 | freeze20-knowledge-recovery-audit.json |
| 一维运动普通入口 | 12块/10K/6Lesson规划确认；按需Lesson、Tutor、Practice/错误诊断通过 | normal-cold-map.json，normal-verified-lesson.json，normal-tutor.json，normal-practice-submit.json |
| 逻辑代表教学 | 真值表4/8行与CP例题正确；CP Tutor给出合法反例，说明仅能解除D | renewed-truth-table-lesson.json，renewed-cp-lesson.json，renewed-cp-scope-tutor.json |
| Repair/Retest | 新公开题面独立计算；-12、-27、路程27，转向2s、路程12、平均0/3均正确，100% | corrected-repair.json，corrected-retest-before-reference.json，corrected-retest-submit.json |
| 隐藏标准/等价错误 | 旧未问解释要求被真实拒绝；历史冲突评分uncertain；负位移与路程的错误替代剔除 | hidden-rubric-real-audit.json，hidden-rubric-safe-grade.json，signed-rubric-equivalence-audit.json |
| 已保存Formal | 复用旧试卷，2次主观评分，3题100%，1正式成绩/4Evidence | renewed-formal-submit.json，renewed-formal-evidence.json |
| 运动学单元Formal | 2题8子问准入；ID故障仅重做1次rubric，无新作者/盲解；2次评分100%，1成绩/5Evidence | freeze20-formal-public.json，freeze20-formal-answers.json，freeze20-formal-evidence-audit.json |
| 取消/冷重启 | 排队取消0新请求/0课文；成绩/证据/修订/历史15表hash不变，0新模型请求 | renewed-cancel-check.json，freeze21-formal-persistence-after.json，freeze21-knowledge-persistence-after.json |
| 冻结30冷重启 | 原冷课程与运动学Formal库15表hash均不变，读取历史0模型请求；1正式成绩/5Evidence保留 | freeze30-cold-persistence-after.json，freeze30-formal-persistence-after.json，freeze30-restored-history.json |
| 最终冻结31冷重启及旧缓存 | 原课堂、独立回看、Formal与Evidence完整读取；两个Workspace15表hash不变，0模型请求；旧提取缓存原身份命中 | freeze31-cold-persistence-after.json，freeze31-formal-persistence-after.json，freeze31-restored-history.json，freeze31-auto-cache-acceptance.json |

Formal模拟作答从公开题面数学推导后提交；同一开发环境曾读过候选，不能称为无辅助真人学习成绩。Evidence只授权实际被题目检验的知识，剩余知识仍未实测。最终冷课程已由UI确认，其CP Lesson、Tutor、主动完成和冷重启也通过。

冻结25的CP恢复复用218秒完整作者响应，只修seg_example6_setup：五个健康段落与其coverage不变，34条来源引文有效，新增一次作者局部修订与一次已有必要核查，59秒完成。Tutor正确解释仅撤销临时D，给出A/B/D真、C假的有效反例。重启后15表hash不变、零模型调用，历史课文、对话与完成状态可读。证据为freeze25-cold-cp-recovery-audit.json及freeze25-cold-persistence-after.json；旧freeze24持久化before是教学完成前的中间快照，已由freeze25完整快照替代。

保留失败：freeze18因分包缺失陈述失败；freeze20准备完成但本地目标等级降格，未确认；freeze21最后包因重复登记错误失败；freeze22真等价式错误被核查拒绝，局部作者合同误解导致失败。这些不是同一冻结版本下的统计重复。已获得的健康结果用于恢复验证，另作全新冻结版冷启动。

复杂嵌套CP Tutor在生产120秒deadline下曾仅推理、无完整正文，结果未知且未自动重发。普通Tutor、CP边界问题通过；复杂证明在Goal B用240秒一致对照评估，最终自动策略在原120秒生产期限内33.7秒完成同类复杂证明。不能从这一失败推断平台总稳定性。Practice一次判分反馈文字有已记录数值矛盾，旧分数不改；后续可信评分逐criterion核对，最终反馈从这些理由派生。

## Goal B协议与评价

仅在goal-a-acceptance-gate.json的GoalA/冷启动/必要正确性全部PASS后发送真实实验。阶段起点累计464请求、2953499已报告Input+Output。实验揭示必要Lesson核查缺陷时，先恢复Goal A的实际正确性，再继续受影响基线。历史门槛及各次freeze保留。

13类代表样本覆盖教材提取（物理/逻辑）、完整/局部规划、必要来源目标核查、Lesson、普通/复杂Tutor、独立解题、错误rubric拒绝、部分/正确主观判分与Formal作者。low/high同组保持model、完整输入、Prompt/Schema、实际max_tokens24000、temperature0.2、deadline240秒一致；交叉顺序，普通任务每档2次，复杂证明/部分评分每档3次。主对照56请求，加medium和非法档位探针2次。协议与理由在docs/REASONING_EXPERIMENT_PROTOCOL.md。

脚本保存输入hash/请求不变量、物理用量/耗时、技术失败与完整候选；结果未知停止，不自动重发。代码检查来源、结构、公式/criterion黄金答案；盲化输出按事实条件准确、任务完整、讲解清楚、教学帮助四维0–2评估，保存理由。Schema通过不自动得高分，实质错误独立失败，效率不能抵消错误。评价由同一助手承担，承认小样本与自评偏差，不新增生产质量模型请求。

最终共103次实验真实发送：98次内容对照、5次能力探针。冻结25为58次；冻结26补充28次；原Lesson核查对照2次；冻结27补充12次；最终能力核验3次。98份内容结果均有专业评估，其中1次有完整正文但结构失败，仍计失败。两次误复用旧Lesson缓存的记录有0发送，已显式标记excludedFromComparison并保留；后续新发low/high样本才进入分母。执行器缓存范围补入样本hash与sourceFreeze，最终重新离线计算全部比较。

冻结25原始数据、逐份评分与汇总分别在 `reasoning-results.json`、`reasoning-professional-review.json`、`reasoning-evaluation.json`。后续同名文件使用reasoning26、verification26、reasoning27、capability27前缀。`reasoning-review-amendments.json`保留了初始Lesson评分过于宽松的纠正；`reasoning-evaluation-source-note.json`解释离散抽样中旧习题1d不能倒归给后面的习题2。不同freeze的结果分别比较，没有把Prompt/合同修复造成的收益归给推理档位。

## 实际控制能力

接口为用户配置的 `https://zhenze-huhehaote.cmecloud.cn/v1` / `glm-5.3`，没有换模型。low、high的匹配重复对照呈现不同耗时/输出特征；max成功一次普通Tutor，53.4秒、3964 Input/2632 Output、2010报告Reasoning。medium和非法值均返回HTTP400，实际正文为 `reasoning_effort must be one of low, high, or max.`，两阶段各保留一次负探针。

max只有一例，不能推荐为默认，也没有把字段被接受当成任何任务质量都更好的证明。部分low结果报告的reasoning几乎等于output，实际reasoning流却为空；所以报告同时保留reasoningBytes、正文bytes、首正文时间和平台分项，不能据此把推理Token数量当作精确认知工作量。

## 多次对照结果

下表“正确/次数”同时要求结构/黄金事实与专业内容评估通过；不是Schema成功率。时间为真实请求中位秒数，原始范围、Token、首正文、四维评分和理由均在对应JSON。没有发生额外重试的独立实验不虚构“恢复后成功率”。

| 冻结25任务 | low正确/次数 | high正确/次数 | low/high中位秒 | 主要发现 |
| --- | ---: | ---: | ---: | --- |
| 运动学提取 | 2/2 | 2/2 | 11.9 / 54.4 | low明显更快；high解释较完整 |
| 离散稀疏抽样提取 | 0/2 | 0/2 | 16.3 / 41.6 | low缺条件；high倒归习题标题；输入断续本身限制解释 |
| 局部规划修订 | 0/2 | 0/2 | 7.2 / 22.1 | 缺全局身份合同，两档都冲突健康C3；根因修复后另建基线 |
| 完整运动学规划 | 0/2 | 0/2 | 30.5 / 54.5 | 目标/知识归属与domain/cell关联局部错误，两档都需合同保护 |
| 必要scope负例核查 | 2/2 | 1/2 | 4.5 / 6.7 | high一次误把不存在的e归给习题4；不据此整体改成low审核 |
| Lesson作者 | 0/2 | 0/2 | 25.9 / 46.2 | 长ID/引文与错误路程推广；不能用技术完成掩盖 |
| 普通Tutor | 2/2 | 2/2 | 6.9 / 15.1 | 两档主结论均正确，low更快 |
| 嵌套CP Tutor | 3/3 | 1/3 | 27.6 / 46.7 | high的证明成立但添加错误反例或强弱关系断言 |
| 独立解题 | 0/2 | 2/2 | 11.8 / 16.4 | low把−27带符号位移直接说成27路程；high保持正确 |
| 错rubric核查 | 2/2 | 2/2 | 11.6 / 33.9 | 两档都拒绝实际错误项 |
| 部分正确评分 | 3/3 | 2/3 | 7.3 / 16.5 | criterion六项均对；high一次独立反馈与criterion矛盾 |
| 全正确评分 | 2/2 | 2/2 | 10.5 / 15.7 | 正确等价表达均接受 |
| Formal作者 | 1/2 | 1/2 | 42.8 / 61.3 | 未限制转向分支、隐藏解释要求；不能直接发布全部候选 |

| 补充基线任务 | low正确/次数 | high正确/次数 | low/high中位秒 | 作用 |
| --- | ---: | ---: | ---: | --- |
| 冻结26修复后的局部规划合同 | 2/2 | 2/2 | 9.1 / 35.0 | 合同修复消除身份冲突，健康对象保持 |
| 冻结26连续45块CP/习题提取 | 2/2 | 2/2 | 48.7 / 90.4 | 各自保留P/T限制、CP、a–d与存疑4b；不混稀疏样本 |
| 冻结26短别名Lesson | 0/1 | 0/1 | 16.1 / 64.4 | 结构各1/1，但两档仍有错误推广；高推理不能代替必要核查 |
| 冻结26隐藏评分要求 | 1/2 | 2/2 | 7.2 / 18.6 | low一次惩罚未公开解释要求；保留high评分 |
| 冻结26有效替代证明评分 | 2/2 | 2/2 | 4.4 / 7.8 | 接受不同合法逆否证明 |
| 冻结26错误假设边界评分 | 2/2 | 2/2 | 6.1 / 17.0 | 正确保留部分分，拒绝错误解除原前提 |
| 冻结26scope正例 | 1/1 | 1/1 | 1.0 / 8.3 | 诚实不确定状态不误拒 |
| 冻结26rubric正例 | 1/1 | 1/1 | 10.1 / 31.5 | 核对全部有效替代答案 |
| 冻结26方向歧义解题 | 0/1 | 1/1 | 7.6 / 19.6 | low完整候选因无意义空cell结构失败；该旧失败保留 |
| 原Lesson必要核查的错误推广负例 | 0/1 | 0/1 | 4.3 / 8.6 | 两档均漏过；据此先修Goal A根因 |
| 冻结27修复核查的同类负例 | 0/1 | 1/1 | 3.3 / 20.8 | 高档识别负方向反例，低档仍误接受 |
| 冻结27正确Lesson正例 | 1/1 | 1/1 | 2.0 / 3.5 | 修复没有靠误拒正常内容获得安全 |
| 冻结27无效蕴涵Tutor | 2/2 | 2/2 | 5.3 / 15.3 | 有效反例，区分后承与恒真式 |
| 冻结27 CP反例Tutor | 2/2 | 2/2 | 9.4 / 27.8 | 完整真值反例；high一次建议措辞过强，主证明仍对 |

四个Tutor输入的受控组共每档9次，low9/9、high7/9；不同freeze分组指标如上，这个总计只描述已审查样本，不是总体置信区间。普通Tutor的低档平均Output507、高档655；嵌套CP分别1298/2156；独立解题分别900/1311。对应Input同组固定，原始reasoning分项另存，没有把生成长篇文字等同于质量。

## 已实施的任务策略

| 任务 | 自动档位 | 决策依据和限制 |
| --- | --- | --- |
| 教材提取、完整规划、局部修订 | low | 沿用已真实冷启动的有效配置；补充合同与连续来源对照支持更低耗时。完整规划两档首次输出都可能失败，必须保留现有局部校验/恢复。 |
| Tutor普通解释与证明 | low | 多输入重复验证及生产期限复验支持较低延迟；没有增加Tutor审核。自然答疑仍可能出现附带错误。 |
| Practice/Retest/Formal题目作者 | low | 两档作者可接受率均1/2，high没有已证实优势；发布仍经过独立解题与必要rubric/公开题面检查。 |
| Lesson作者 | high | 保守保留已有设置；两档都出现实质错误，证据不足以证明high作者更优。短身份与高档必要核查保护最终课文。 |
| 独立可信解题、主观判分 | high | 实际低档的路程符号和隐藏评分冲突失败不能被速度优势抵消。 |
| 必要Lesson/scope/rubric核查 | high | 修复后低档仍漏过错误推广；scope/rubric的小样本不足以全面降低审核档位。 |
| Repair与其他未充分对照职责 | high | 保留保守默认；已有真实Repair/Retest通过，不伪称做过每个函数的匹配重复实验。 |

自动策略仅用于MoMA glm-5.3，其他模型auto不发送reasoning_effort，尊重用户选择的模型身份。现有设置中的“请求资源与等待时间”增加思考强度：auto / provider-default / low / high / max；环境变量为MODEL_REASONING_EFFORT，显式选择优先。已知HTTP400/422明确提示不支持reasoning_effort字段时，至多一次去掉字段的兼容回退，同一个模型；未知结果不自动重发。兼容回退行为通过离线测试，实际平台拒绝正文已单独保留。

没有创建动态复杂度判别Agent、额外模型路由、统一多轮核查或形式化的三套预设。数据支持这个简单任务分配；证据不足的作者/Repair任务明确保守保留。策略及逐任务依据为 `reasoning-strategy-decision.json`。

## 策略实现后的真实验证

生产默认条件7次真实请求，在 `strategy-validation-results.json` 与 `strategy-validation-audit.json` 保存：普通Tutor low14.4秒；复杂CP low33.7秒；部分判分 high8.9秒且11/18；隐藏要求 high7.6秒并标记uncertain/rubric_question_conflict；合法替代证明 high8.8秒全对；歧义解题 high8.6秒；必要错误推广核查 high11.9秒正确拒绝。这些使用生产实际输出预算及期限，与固定24000/240秒对照分开。

首次技术成功6/7。歧义解题已正确给出 `t=6±√31`、`v=±2√31` 和solvable=false，但附带 `coverage.cellId=""` 导致结构失败。expectedCells为空时，这项是服务端不适用标注，归一为[]后复用同一完整候选：17ms、0新请求，最终7项均完成正确控制。**不可解题的正确拒绝是检查成功，不是发布了该题。** 原失败记录与物理priorInterpretation保留，未降低真实Formal覆盖、答案或歧义标准。

最终冻结30普通UI从只读课堂提出新问题，实际开启独立revisit，用low6.5秒完成“改成可兼或后R→Q是否成立”的合法证明；原课文、旧对话和完成记录未变。该回复另有一句“排斥或只保证M假则Q真”说窄了：排斥或还排除两者同真。`freeze30-ui-tutor-audit.json`把集成/所求证明通过与fullResponseCorrectness=false分开记录，质量6/8；没有编辑回复、再发请求或计成全文完美。它说明自由Tutor不能获得无错误保证，不能用已通过的教学/Evidence机制替它兜底。

冻结27的必要课文核查另用真实正负例验证后，只更换坏seg2并执行原有核查；四个健康段及coverage保持，纠正为“路程等于位移的绝对值”，负方向例子也正确。证据为 `freeze27-necessary-verification-acceptance.json`、`freeze27-lesson-local-repair-acceptance.json`。没有为正常Lesson新增审查步骤。

## 用量、失败消耗与数据核对

研究账本自2026-10-13T05:25:08.803Z统计，最终580次真实发送，574次有完整平台Input/Output报告；2,639,550 Input + 777,748 Output = **3,417,298已报告Token**。平台Reasoning分项293,496，未重复加入合计。没有用量的失败/未知请求不能算0消耗，因此合计是可报告部分，不是完整账单。

其中103次受控实验：291,364 Input、123,379 Output，合计414,743；其余477次包括历史续修、真实产品验收、策略和恢复复验，不是同基线重复试验。所有请求诊断耗时合计14,976,760ms（约249.6分钟）；中位17.9秒，151ms至240010ms。请求计时合计包含失败/等待，不等于用户端到端学习时间。

物理/内容状态账本：521次技术完成、37次已知内容拒绝、20次已知传输/格式等失败、2次上游结果未知。另有1次本地预算护栏在发送前拒绝，不算真实请求。这些分类不代表521份内容全都正确；实验中的完整错误答案仍在内容评估中失败。两次上游未知未盲目重发。每个请求的用量、流结束、首次正文、失败类型、候选出处和局部重验证见 `final-call-ledger.json`，汇总与各freeze比较见 `final-metrics.json`。

冷启动本身27请求、159850 Input/30668 Output（190518合计）、562226ms约9分22秒。它在一个普通入口Operation中完成，内部出现一次提取局部更正和一次局部规划修订，属于产品自身有界恢复；不是27次全部首次内容完美，也没有工程手插合格课程。

数据保护最终检查：3158保护文件、原数据库全部逻辑行、原连接/Key、源码快照和Git HEAD均未改变；没有commit或push。hash统计始终用原baseline，未重建基线。一次重用持久化文件前缀的记录问题已在 `persistence-artifact-correction.json`保留解释，脚本现在拒绝覆盖旧测量；freeze30及最终freeze31分别使用新前缀，两个Workspace均15表hash不变且0模型请求。

## 工程验证与结论边界

最终冻结31：**354测试通过（shared20/server288/web46）**，生产构建/类型与lint通过；离线golden流程和仅localhost的HTTP回归通过。日志为freeze31-tests.log、freeze31-build.log、freeze31-lint.log、freeze31-offline.log、freeze31-http.log。测试覆盖局部身份/健康成果、缓存物理出处、取消未知结果、持久化、评分与不适用标注，以及配置覆盖/兼容回退和旧隐式默认身份迁移。

冻结29构建日志实际含TypeScript错误，之前状态摘要误报为成功。冻结30显式区分Schema的未知输入与已验证输出类型，修正推断成unknown的类型边界；重新完整构建与回归通过。旧freeze29-build.log保留，不宣称它曾通过；这一修复不改运行时、Prompt、内容或质量门槛。

最终缓存审查又发现auto表示迁移会改变原默认身份，尽管实际请求参数相同。冻结31规范该身份，并通过只读真实历史stage缓存复用验收；未重置候选或重买成果。期间离线/HTTP回归与npm test的共享包重建错误并行，出现临时dist缺失，另有审计脚本AbortController全局引用lint错误；原日志保留，修正脚本并等待构建完成后重跑均通过，没有增加模型请求。

剩余风险：只有一份原始教材的完整正常冷启动样本，不能估计总体成功率；扫描PDF原图未获得，习题4b仍不确定；评价者为同一助手、学习者为模拟作答；自由Tutor可能出现事实或措辞错误，最终UI样本已保留一个例子；完整规划和Lesson作者首次输出仍有缺陷，正确发布依赖现有必要核查与局部恢复；高档也会生成错误，不能等同于质量保证；长请求仍可能在期限内结果未知；Reasoning元数据不完全可信；赠送额度适用由用户确认，实际货币账单不可查询。

没有发现最终已接受的课程/可信答案/正式评分/Evidence中尚未解决的重大正确性或持久化阻断。建议使用auto运行本次实测的MoMA glm-5.3，保持必要检查与有界局部修复，按原产品节奏学习、可跳过Practice、自愿Formal。源码及文档可供用户统一审阅后再决定Git提交。
