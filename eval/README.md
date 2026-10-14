# 评测与保存证据

当前Study Clinic V2的产品／技术结果见[REPORT](../docs/REPORT.md)，检查命令见[VERIFICATION](../docs/VERIFICATION.md)。当前公开摘要位于[docs/evidence/v2](../docs/evidence/v2/metrics-summary.json)。

## 当前产品检查

```bash
npm run build
npm run eval:fake
npm run verify:http
```

eval:fake执行scripts/eval-clinic-offline.mjs，使用内存Fake、阻断外网，输出本地output/architecture-implementation/offline-regression.json。verify:http只调用localhost替身。这些是软件合同检查。

eval:hy3为历史保留命令名，当前执行scripts/validate-real-course.mjs。必须显式--allow-paid、指定可授权材料／独立数据库／输出目录后才运行实际生效Provider；不作为默认CI或本轮发布整理步骤。完整说明见[真实验收](../docs/VERIFICATION.md#重新运行真实模型验收)。

eval:evidence保留历史公开摘要生成器，会写跟踪文件；核查旧结果使用下面只读verifier，不重新导出或改写冻结证据。

## 冻结历史目录

| 目录                 | 归属                                                         |
| -------------------- | ------------------------------------------------------------ |
| studyeval            | 冻结StudyEval v2.0评估器、方法和22项测试                     |
| studyeval-validation | 旧Hy3评估器验证的输入／输出、人类评分映射和207次观察         |
| final-showcase       | Candidate23历史20课Hy3运行、模拟作答、内容审查和发布verifier |
| fixtures             | 公开原创程序输入，不是本次MoMA私人教材                       |
| reports              | 被忽略的本地生成结果                                         |

```bash
node --test eval/studyeval/test/*.test.mjs
node eval/studyeval-validation/scripts/verify.mjs
node eval/final-showcase/publication/verify.mjs
```

两个verifier重算保存结果，不调用模型、不改原件，也不证明语义质量。StudyEval v2.0是评估器版本名，不能与Study Clinic V2产品混用。

## 数据保留与归档

旧输入、输出、答卷、失败和哈希清单保持冻结，不批量格式化或搬迁。历史完整运行、公开边界和Release见[HISTORY](../docs/HISTORY.md)。此前评测目录说明保留在[整理前快照](https://github.com/Small-fish-QAQ/hy3-study-clinic/blob/9ec6bde693455eac3df00e33984d9e0e0d9d8c93/eval/README.md)，其旧API评测命令应在相应历史版本运行。

新实验使用新物理目录、准确源码身份、实际provider/model、输入、预算、完整分母和失败记录，不覆盖已有成绩或用新的成功样本删除旧失败。当前研究原始库与教材留本地，公开仅派生必要脱敏摘要。
