# Phase 4 GLM-5.3 首次运行修复

本轮只处理首次真实运行确认的容量、推理预算与重复生成问题。没有调用付费 API，没有改写用户课程数据库历史，没有 commit/push。真实教学输出仍待用户授权验证。

## 官方参数核对（2026-10-10）

- [智谱 GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)：始终思考，不能禁用；`reasoning_effort` 支持 low/high/max，默认 max。
- [MoMA GLM API](https://ecloud.10086.cn/op-help-center/doc/article/94470)：列出 GLM-5.3 及当前 `/v1/chat/completions` 入口、`max_tokens`，未列出该入口的 `reasoning_effort` 或独立思考预算。
- [MoMA 通用 Chat API](https://ecloud.10086.cn/op-help-center/doc/article/99330)：列出混合思考模型的 `enable_thinking`、`thinking_budget` 扩展；没有确立它们适用于本次 GLM-5.3 自营入口。

因此保留所选 GLM-5.3 和默认深度思考，不发未经模型/入口文档确认的控制参数，也不静默改模型。当前无法承诺上游独立限制推理 Token；固定总预算之外的独立控制仍是未知项。

## 最小实现

Detail 删除固定 120 项证据的拒绝条件，以实际请求字节、输出估算及原有目标数、区域数门限判断容量。优先模块边界，再枚举稳定区域边界；不改变课程层级、区域身份或证据内容。最多两批、每批 120,000 字节请求及 62,000 字节输出估算保持不变。

Map 的质量检查与 Detail 本地规划分离。质量通过的 Map 先进入现有生成依赖缓存，后续容量不足时不进入模型修复。旧拒绝候选须满足完整 JSON、内容哈希、工作区、来源、课程操作指纹、容量类拒绝记录等条件，再通过当前 Map 完整性、语义和 Detail 规划校验。新操作追加 `course_map_locally_revalidated` 事件，保留原模型/调用出处；历史失败及付费用量不改写，不伪造成功推理或已通过独立 Review。

GLM-5.3 探测由 32 改为固定 4,128 个**总**输出 Token、最长 30 秒，只发一次。结构化阶段使用本地正文目标加 12,000 个推理余量，上限 32,000，继续受配置的最大输出限制。Map 总预算为 20,000；Detail 为 28,000。余量只是本地成本规划，不保证上游在某个推理 Token 数自动转入正文。截断、空正文不翻倍预算重生成；普通内容错误仍可在同一预算内做有限修复。Map 最多两次物理生成，传输重试仍遵守既有有限预算。Usage 的总输出与推理分开；可见文本 Token 只采用上游明确提供的 `text_tokens`，缺少时为 null，并记录实际正文的字节数。

相邻排查仅删除了 Recovery 预检中同样以证据项数代替容量的误判；真实字节、输出、目标数、区域数、两批调用上限、有限修复、取消、租约、来源、覆盖 Review 和 Formal 约束均保留。

## 此次拒绝候选的本地回归

通用只读重放命令：

```text
npm run build -w @hy3-clinic/server
node scripts/verify-course-map-recovery.mjs <SQLite路径> <workspace ID>
```

只读 SQLite、`query_only=ON`，网络被禁止。只输出容量和状态计数，不输出 Key、资料或候选正文。此次实际结果：

| 项目 | 结果 |
| --- | --- |
| 当前归属、哈希、Map 质量与 Detail 校验 | 可复用 |
| 保留概念 | 20 |
| 保留精确证据 | 240，分为 137/103 |
| 每批区域 | 4/4 |
| 请求字节 | 109,316 / 85,651 |
| 输出估算字节 | 6,800 / 6,800 |
| 历史逻辑调用 | 仍为 failed |
| 数据库写入 / 模型请求 | 0 / 0 |

自动验证全部通过，均使用 Fake、注入 Mock 或 loopback 上游：

- 受影响回归：13 个文件，384/384 PASS，覆盖 Provider、Map/Detail、课程准备、独立 Review、Formal、遥测、配置安全及取消。
- 最后增加取消、outcome_unknown 和旧租约拒绝后，重跑恢复与课程准备：2 个文件，61/61 PASS（15 + 46）；其中包含上一轮重叠用例，不累加为 445 项。
- `npm run build` PASS；最后归属查询收紧后再次执行 server build PASS。
- `npm run lint` PASS，0 errors；保留既有 GraphWorkspaceView Hook warning。Vite 保留既有 bundle 大小提示。
- `git diff --check` PASS。此次实际候选在最终代码下再次只读重放 PASS。

日志：[受影响回归](../output/phase4-glm53-regression.log)、[最终恢复回归](../output/phase4-glm53-final-recovery-tests.log)、[构建](../output/phase4-glm53-build.log)、[最终服务端构建](../output/phase4-glm53-final-server-build.log)、[Lint](../output/phase4-glm53-lint.log)、[实际候选只读重放](../output/phase4-glm53-local-replay.log)。

变更文件：`apps/server/src/llm/hy3Provider.ts`、`glm53Budget.test.ts`；`apps/server/src/repositories/telemetry.ts`；`apps/server/src/services/courseMap.ts`、`courseMapProvider.test.ts`、`courseMapRecovery.ts`、`courseMapRecovery.test.ts`、`coursePreparation.test.ts`、`curriculum.ts`、`curriculumMaterialization.ts`、`curriculumMaterialization.test.ts`；`scripts/verify-course-map-recovery.mjs`；`docs/SETUP.md` 和本记录。没有改动数据库迁移、前端模型选择或用户保存配置。

## 用户授权后的最小真实验证

1. 重启应用加载新代码，核对生效 Provider、URL 和 Model ID 仍是用户选择的 MoMA / GLM-5.3。不要修改资料或课程目标，以保持复用归属。
2. 自行点击一次“测试连接”：这是一次可能计费的探测，不做循环重试；完整可见正文通过才算成功。
3. 在原课程点击重试。预计 20 个概念与这份 Map 经本地复核后复用；新 operation 应出现 `course_map_locally_revalidated`，不新增 Map 模型调用。
4. Detail 两批、每批独立覆盖 Review、目标权威评估及必要有界修复仍会调用模型。保持所有 Review 与 Formal 门槛；任何失败停止，不自动扩增成本预算。
5. 先检查生成的课程结构。接受结构后，学习计划及后续教学、练习、Formal 等属于新的调用阶段，分别验证。发生预算失败时记录安全错误类型与 Usage，不连续盲点重试。

尚未验证：真实 4,128 Token 探测是否足够、固定阶段余量是否满足当前模型的实际推理长度、真实 Review 和教学输出质量。探测成功不代表课程验收成功。Phase 4 未 CLOSED。
