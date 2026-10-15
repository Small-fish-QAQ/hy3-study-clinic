# Study Clinic 更新记录

## 2.0.0 — 2026-10-15，移动云杯里程碑

产品业务基线9ec6bde693455eac3df00e33984d9e0e0d9d8c93。正式Tag为[v2.0-mobile-cloud-cup-2026](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/v2.0-mobile-cloud-cup-2026)，保存当前源码、技术文档与公开展示资料。项目继续沿原仓库main演进。

### 产品与可靠性

- 显式完整知识清单和Course Map，审阅深度与目标后确认，Lesson按需生成。
- Lesson、Tutor、Practice、主动Repair/Retest、自愿Formal分别保存，学习路线与正式证据分开。
- 统一题目准入、独立可信解题、公开题面／rubric核查、服务端客观与总分计算、逐题持久化。
- 同一MoMA / GLM-5.3的任务级auto推理强度，保留用户显式配置优先级。
- 不可变候选与物理出处、定位到知识／目标／段落／题目的有界局部恢复，保护健康成果。
- 课程管理、学习中心、按模块选课和窄屏布局完成真人验收。
- 使用独立V2数据库，schema7，拒绝自动转换旧Hy3库。

### 公开版本整理

- 产品名称统一为Study Clinic，V2（2.0.0）独立标明为版本；当前资料、官方PPT及展示封面同步。
- 当前README、运行、架构、研究、验证和历史导航；少量脱敏指标及真实截图。
- 版本元数据统一2.0.0，Node声明按锁定依赖校准，扩充本地数据／密钥忽略边界。
- 保留历史Hy3、StudyEval证据及两个正式发布Tag。未重新运行真实课程生成。
- 正式Demo选用《The Fourth》（3分20秒），公开22页PPT/PDF、素材来源及许可作为Release附件。
- 补齐OpenAI兼容端点配置、模型列表获取及本版实测边界；明确行业试点与四层商业路径属于规划。
- 发布Commit的CI与附件哈希记录在Release，私有参赛包和联系方式不公开。

### 已知限制

扫描PDF暂无OCR，复杂公式与历史LaTeX显示有限。教材语义覆盖、自由Tutor和模型候选仍可能错误。实验小样本、同助手评价和模拟学习者不支持真实学生提分结论。当前为本地单用户应用。

## 历史里程碑

- 2026-09-14：[task1-final-2026-09-14-r2](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/task1-final-2026-09-14-r2)，固定df7bbd04ee03fcbadaf3e790351a2f23c55fdc52，Hy3产品展示与StudyEval历史研究。
- 2026-07-31：[issue-4-final](https://github.com/Small-fish-QAQ/hy3-study-clinic/releases/tag/issue-4-final)，固定c67ac6d5a42295a21197794e5055ef7785df3b0b，早期犀牛鸟实战交付。

历史完整记录见[HISTORY](docs/HISTORY.md)。本页没有追溯编造早期逐版本变更。
