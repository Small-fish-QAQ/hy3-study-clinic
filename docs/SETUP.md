# Study Clinic V2 运行指南

[首页](../README.md) · [架构](ARCHITECTURE.md) · [验证](VERIFICATION.md)

## 安装与启动

推荐Node.js 24 LTS和随附npm。声明兼容Node 20.19+、22.13+、24系列；发布检查优先使用Node 24。better-sqlite3与sharp包含原生依赖，安装失败时核对系统架构和受支持Node版本。

在新检出的仓库根目录执行：

```bash
npm ci
npm run build
npm run dev
```

前端通常为 http://localhost:5173，API默认 http://127.0.0.1:8787。Vite占用端口时可能使用5174，以终端输出为准。Ctrl+C停止。前端代理固定到8787；改变API端口时需同步代理，普通安装保留默认即可。

npm run dev先构建shared，再启动服务端与前端。npm run build顺序构建shared、server、web。独立服务端可使用npm run dev:server；生产服务端入口为npm run start -w @hy3-clinic/server。vite preview仅预览前端静态构建，不等于完整应用部署。

## 数据初始化与路径

新安装无需导入数据库。应用自动初始化V2 schema（当前版本7），默认相对路径为./data/clinic-v2.sqlite。通过根目录npm workspace开发命令启动时，服务端工作目录为apps/server，因此默认文件实际位于apps/server/data/clinic-v2.sqlite；Provider配置同样位于apps/server/data/provider-config.json。

**旧Hy3数据库不转换、不重建。** 应用先只读检查application_id，误指旧库或其他SQLite库时拒绝。已有.env仍指向旧库的用户应选择新的V2路径；原V2用户继续指向自己的现有V2库，不应为了升级改成空库。V2内部schema增量迁移保留历史行、引用和不可变记录。

需要固定路径时，使用绝对路径启动。以下为新目录示例，不指定项目原验收库：

```powershell
$env:DATABASE_PATH = 'C:/StudyClinicData/clinic-v2.sqlite'
$env:PROVIDER_CONFIG_PATH = 'C:/StudyClinicData/provider-config.json'
npm run dev
```

DATABASE_PATH=:memory:只适合临时体验，停止服务后课程消失。评测脚本在仓库根目录运行，其相对路径与npm workspace服务不同；跨命令复用同一库或设置时，应明确使用绝对路径。

## 连接 MoMA / GLM-5.3

新安装默认选择未配置MoMA。进入“设置 → 模型服务”，填写API Base URL、自己的API Key和Model ID。当前实测端点为https://zhenze-huhehaote.cmecloud.cn/v1，实测模型为glm-5.3；平台同时有其他入口，按自己的模型、资源池与套餐选择。依据：[MoMA接口总览](https://ecloud.10086.cn/op-help-center/doc/article/98330)。

“获取模型”使用/models；无权限或不支持时可以手填Model ID。“测试连接”才发送真实Chat Completions请求，可能消耗用量。保存设置不购买课程。编辑期间是连接草稿；保存后新任务使用新连接，运行中的操作保留开始时的Provider快照。

支持moma、compatible、历史hy3和显式fake。当前只有一个启用连接；同一模型的auto策略不构成多模型路由。

### 推理强度与等待时间

思考强度可选auto、provider-default、low、high、max。auto在MoMA / glm-5.3使用已实测任务策略：提取、课程规划、局部规划修订、题目作者、Tutor使用low；Lesson、独立解题、主观评分、Repair和必要核查保守使用high。其他模型的auto不发送reasoning_effort。显式选择优先，兼容平台是否支持由该平台决定。

已知HTTP400/422明确拒绝reasoning_effort时，至多一次去掉字段的同模型兼容回退；结果未知不自动重发。[实验依据与失败边界](REPORT.md#推理强度实验与-auto)。

代码普通请求默认30,000ms，长任务默认240,000ms。MoMA / GLM-5.3的真实验收使用过普通120,000ms、长任务240,000ms；较复杂Tutor可能超出30秒，可在设置中调整。它们是可配置资源参数，不是完成时限保证。

MODEL_MAX_OUTPUT_TOKENS默认64,000，是未知模型的回退上限；应服从实际模型能力。预算依据输入、可见输出、软推理估计和已知模型上限计算。推理内容不能充当完整答案，空正文或截断候选不能发布；本地预算不保证上游实际返回长度。

![真实MoMA连接与auto设置，未显示Key](media/v2/moma-auto.webp)

## 配置优先级与环境变量

服务端入口读取仓库根目录.env，已有进程环境变量优先于其中值。随后，已保存UI配置优先于Provider环境设置，包括主动清除Key后的禁用连接。不存在保存配置时使用环境；缺少连接明确失败，不会静默切换Fake。

.env.example只包含公开示例；已有.env时不要覆盖。历史HY3_*变量名继续供真实兼容连接作为启动回退使用，不改变实际provider/model身份。

| 变量                                            | 默认值                      | 用途                                 |
| ----------------------------------------------- | --------------------------- | ------------------------------------ |
| LLM_PROVIDER                                    | moma                        | moma / compatible / hy3 / fake       |
| HY3_BASE_URL / HY3_API_KEY / HY3_MODEL          | 空                          | 未有保存设置时的真实连接             |
| MODEL_REASONING_EFFORT                          | auto（隐式）                | 任务策略或显式档位                   |
| HY3_TIMEOUT_MS / LONG_TASK_TIMEOUT_MS           | 30000 / 240000              | 普通／长任务deadline，毫秒           |
| MODEL_MAX_OUTPUT_TOKENS                         | 64000                       | 输出回退上限                         |
| MODEL_CONTEXT_TOKENS / MODEL_REASONING_ESTIMATE | 未设置                      | 已知上下文／软推理估计               |
| IMPORT_FILE_BYTES / IMPORT_TEXT_BYTES           | 10485760 / 10485760         | 文件／文本导入资源保护               |
| PROVIDER_CONCURRENCY                            | 2                           | 模型请求并发                         |
| OPERATION_LEASE_MS / OPERATION_HEARTBEAT_MS     | 90000 / 20000               | 操作租约／心跳；心跳小于租约         |
| DATABASE_PATH                                   | ./data/clinic-v2.sqlite     | V2 SQLite                            |
| PROVIDER_CONFIG_PATH                            | ./data/provider-config.json | 服务端设置与配套.key                 |
| HOST / PORT                                     | 127.0.0.1 / 8787            | API监听                              |
| VISUAL_PROVIDER                                 | disabled                    | 当前V2教学不调用视觉模型             |
| AUTOMATION_EXPECT_PROVIDER                      | 未设置                      | 离线验收指定fake，生效模式不符则拒绝 |

## 无密钥离线体验

使用独立配置和数据库，避免读取已有真实连接。在新的PowerShell中执行：

```powershell
$env:LLM_PROVIDER = 'fake'
$env:VISUAL_PROVIDER = 'disabled'
$env:AUTOMATION_EXPECT_PROVIDER = 'fake'
$env:PROVIDER_CONFIG_PATH = './data/offline-preview-provider.json'
$env:DATABASE_PATH = ':memory:'
npm run dev
```

Linux / macOS：

```bash
LLM_PROVIDER=fake VISUAL_PROVIDER=disabled AUTOMATION_EXPECT_PROVIDER=fake PROVIDER_CONFIG_PATH=./data/offline-preview-provider.json DATABASE_PATH=:memory: npm run dev
```

若这个独立设置文件之前已保存为真实连接，保护条件会拒绝；使用新的文件名。PowerShell变量在该终端继续生效，切回真实模式使用新终端或显式更新。界面可以载入原创“认知科学入门：记忆与学习”示例。Fake只验证产品流程，不能证明真实教学质量。

无需端口的离线回归：npm run build后运行npm run eval:fake，使用内存库并阻断外网，输出到本地output，参见[验证指南](VERIFICATION.md)。

## 暂停、失败与恢复

知识提取与规划返回持久Operation；离开页面不等于取消。重载查询真实进度。服务重启把未完成操作标为interrupted，用户明确重试后只续未完成范围。健康提取包、课文、已准入题和已评分项可复用。

完整坏候选保留内容和失败原因，不能作为成功缓存重放。有界局部修订仍失败时明确停止并展示下一步；不要反复点击已标不可重试的操作。上游已发送但结果未知记outcome_unknown，不能认定零消耗或exactly-once计费。

历史课堂与对话可读，新问题进入独立revisit。Practice / Retest更新日常观察；Formal保留每次独立成绩。Formal草稿缺必考范围时不能开考，可在学习记录中明确补齐缺失题目，保留好题、蓝图与旧失败。

## 备份与公开边界

停止写入服务后备份数据库及配置目录；服务运行中使用SQLite online backup，不能仅复制主.sqlite而遗漏WAL。Key使用AES-256-GCM加密；Windows配套密钥由DPAPI CurrentUser保护，其他平台使用本机0600密钥。跨机器或用户恢复后可能需要重新输入Key。

默认绑定loopback。当前版本没有账号认证和多用户隔离，Origin检查不等于登录认证；不要把本机API直接当作公共服务部署。浏览器仅显示已配置状态，不持久化Key。前端不读取真实.env，也不应设置VITE_*凭据。

用户数据库、配置、密钥、教材全文、敏感日志和原始实验留在本地。自定义路径也应位于被忽略的私有目录。删除课程会删除其归属的资料、作答、成绩和Evidence，操作前使用产品确认及备份。

## 常见问题

| 现象                   | 处理                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| 配置后仍用旧模型       | 检查UI保存配置及启动时的绝对PROVIDER_CONFIG_PATH；环境不覆盖保存连接 |
| 提示旧库／其他数据库   | 选择独立V2库；不要删除或转换原库                                     |
| 同一数据库已被进程占用 | 使用原运行服务或停止它后再开；验收使用独立副本                       |
| 页面打开，API不通      | 核对8787和前端代理；5173/5174是当前开发Origin白名单                  |
| 长时间思考或空正文     | 核对模型、超时与输出配置；检查Operation详情，未知结果不要盲重发      |
| 扫描PDF没有正文        | 当前无OCR，提供有文本层文件或补充可授权文字                          |
| 数学公式直接显示源码   | StudyText只支持部分Markdown，历史LaTeX并非完整数学渲染               |
