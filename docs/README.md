# Study Clinic 文档导航

适用版本：V2（2.0.0）。

初次了解读[首页](../README.md)和[产品与研究报告](REPORT.md)，运行按[SETUP](SETUP.md)。

| 当前维护入口                            | 回答的问题                                                   |
| --------------------------------------- | ------------------------------------------------------------ |
| [REPORT](REPORT.md)                     | 为什么做、已实现什么、真实实验与限制、成本与前景             |
| [SETUP](SETUP.md)                       | 安装、初始化、模型配置、auto、数据路径、备份与恢复           |
| [ARCHITECTURE](ARCHITECTURE.md)         | 模型与服务端职责、来源／版本／覆盖／评分／Evidence、局部恢复 |
| [VERIFICATION](VERIFICATION.md)         | 当前构建、测试、离线和HTTP检查，保存结果复现及CI身份         |
| [DEMO](DEMO.md)                         | 真实产品界面、素材来源与展示边界                             |
| [HISTORY](HISTORY.md)                   | 两次犀牛鸟发布、旧Hy3／StudyEval及阶段记录                   |
| [CHANGELOG](../CHANGELOG.md)            | V2变化、版本里程碑                                           |
| [第三方声明](../THIRD_PARTY_NOTICES.md) | 依赖、字体、图标、媒体与用户资料边界                         |

## 冻结研究与阶段记录

[RELIABILITY_AND_REASONING_STUDY](RELIABILITY_AND_REASONING_STUDY.md)记录产品可靠性验收与推理强度对照实验，[REASONING_EXPERIMENT_PROTOCOL](REASONING_EXPERIMENT_PROTOCOL.md)保留实验协议，[FINAL_HUMAN_ACCEPTANCE_20261014](FINAL_HUMAN_ACCEPTANCE_20261014.md)保留冻结真人复测。摘要在REPORT维护，阶段原件的次数、失败和当时状态保留。

PHASE4_*、ARCHITECTURE_SIMPLIFICATION_IMPLEMENTATION、UI_RESTORATION、COURSE_PREPARATION_RESTORATION、FIRST_REAL_USE_FIX、REAL_MOMA_INTEGRATION、PRODUCT_EXPERIENCE_VALIDATION、UNIT_FORMAL_*属于不同日期的实施／调试／验收记录；不能以其中旧schema、预算或“尚未执行”覆盖当前源码。来源和顺序见HISTORY。

本地未跟踪的architecture-audit、architecture-redesign、architecture-simplification-plan（除测试必须的no-network）、real-course-evaluation以及研究脚本继续原样保留，不作为当前公开运行依赖，不批量搬迁或删除。

eval/studyeval、studyeval-validation、final-showcase保留历史冻结输入、输出、分析和verifier；StudyEval v2.0是评估器版本，不是Study Clinic的V2版本验收。EVALUATION、EVALUATION_RESULTS、HUMAN_VALIDATION旧路径保留作历史入口。

## 维护约定

每个主题维护一个完整入口。首页概览，REPORT解释产品与研究，ARCHITECTURE讲实现，SETUP讲运行，VERIFICATION讲检查。公开原始证据不批量格式化；新实验使用新目录与分母，保留失败和未知结果。

当前公开摘要在evidence/v2，当前截图在media/v2。媒体只整合已检查成品，不纳入视频工程与缓存；私人材料、原始数据库、密钥、完整候选和敏感日志保持本地。
