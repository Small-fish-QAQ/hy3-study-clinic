# Study Clinic 版本说明

适用版本：V2（2.0.0）。

V2已完成真实MoMA / GLM-5.3代表性产品验收，当前以以下文档为维护入口：

- [运行指南](SETUP.md)：安装、数据初始化、Provider／推理强度策略、备份与恢复。
- [现行架构](ARCHITECTURE.md)：确定性服务端、模型合同、持久操作、局部修订及可信Evidence。
- [产品与研究报告](REPORT.md)：可靠性验收、推理强度对照、真实冷启动、最终真人体验、成本和已知限制。
- [验证与复现](VERIFICATION.md)：现行工程命令、公开证据及CI状态。
- [真实界面](DEMO.md)：来自同一已验收业务版本的截图及采集边界。
- [CHANGELOG](../CHANGELOG.md)：当前版本变化和历史里程碑。

产品基线9ec6bde693455eac3df00e33984d9e0e0d9d8c93，schema7。旧Hy3库只读拒绝，V2库按已有增量迁移保留历史。发布整理只调整文档、媒体、元数据和验证入口，教学业务、Prompt、Schema及UI保持已验收版本。

[整体精简实施记录](ARCHITECTURE_SIMPLIFICATION_IMPLEMENTATION.md)记录2026-10-12阶段的工程结果；其中“A16尚未执行”和schema4属于当时状态。[真实集成](REAL_MOMA_INTEGRATION.md)、[可靠性研究](RELIABILITY_AND_REASONING_STUDY.md)、[最终真人验收](FINAL_HUMAN_ACCEPTANCE_20261014.md)记录后续完成过程。阶段原报告不反向改写。

第三个正式里程碑拟为v2.0-mobile-cloud-cup-2026；开源整理已推送main，Annotated Tag与Release仍待用户批准。后续继续在原仓库main演进。
