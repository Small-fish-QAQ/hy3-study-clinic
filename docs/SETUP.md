# 运行 Hy3 Study Clinic

当前新版运行以 [CLINIC_V2.md](CLINIC_V2.md) 为准。默认独立 `data/clinic-v2.sqlite`；已有 `.env` 的旧路径需由用户改为新路径。旧库不升级、不清空。下文保留历史安装/模型配置参考，不应据旧 API 或强制学习链验收新版。

[返回首页](../README.md) · [统一验证与复现入口](VERIFICATION.md)

## 环境与安装

推荐 Node.js 24 和随附的 npm，支持 Windows、macOS 与 Linux。仓库 `.nvmrc` 选择 Node 20 系列；使用该系列时需 **20.19 或更新版本**，以满足锁定的 Vite 依赖。根包中 `>=20.9` 的声明不足以描述全部依赖的最低要求。

在仓库根目录执行：

```bash
npm ci
npm run build
npm run dev
```

`npm ci` 需要下载依赖。新安装默认选择 MoMA，连接未完整配置前不会生成课程，也不会退回 Fake。开发、测试与离线体验可显式选择 `LLM_PROVIDER=fake`；Fake 内容不代表真实模型输出。导入网页快照仍需要访问所选网页。

前端默认在 [http://localhost:5173](http://localhost:5173)，API 在 [http://127.0.0.1:8787](http://127.0.0.1:8787)。以终端打印的前端地址为准；5173 被占用时 Vite 可能选择下一个端口。终端按 Ctrl+C 停止服务。

创建课程后，在“课程资料”添加资料，选择全局深度与可选重点，审阅并确认课程结构，然后从课程主页开始学习。当前学习界面和生成契约使用 `zh-CN`。

第一次体验可跟随[固定样例操作](VERIFICATION.md#固定样例操作)，其中给出了现成资料、点击顺序和每一步应看到的结果。

## 配置模型服务（MoMA 或其他兼容平台）

在应用“设置 → 模型服务”选择“移动云 MoMA”或“其他兼容平台”。MoMA 默认填入 `https://zhenze-huhehaote.cmecloud.cn/v1`；这是 [2026-10-10 核对的官方接口总览](https://ecloud.10086.cn/op-help-center/doc/article/98330) 中覆盖多数文本模型的推荐入口。官方同时列有 `https://moma.cmecloud.cn/v1` 和 `/v2` 等入口，请按自己的模型、资源池或套餐修改 URL。

在密码输入框填写自己的 API Key，点击“获取模型”后选择 Model ID，或直接手动输入。模型列表不支持、无权限或为空时仍可手动指定。点击“测试连接”才会发送最小 Chat Completions 请求；这可能产生费用。模型列表请求只使用 `/models`，保存不会触发模型生成。

点击“保存并启用”后，新任务使用当前连接；编辑平台、URL、Key 或模型时只是草稿，正在执行的任务保留开始时的连接。重新打开或重启后无需重复输入 Key。已有 Key 仅显示“已配置”，可替换或清除；清除后该真实连接被禁用，教学请求明确报错，保持原有课程与 checkpoint。

当前支持 OpenAI-compatible Chat Completions。第一版只保留一个已启用连接。历史 Hy3 连接保持原有身份；换到第三方服务请选“其他兼容平台”，不要将第三方调用记成 MoMA 证据。

### GLM-5.3 的深度思考与资源预算

GLM-5.3 始终启用思考。应用保留用户选择的模型和默认思考模式，不自动关闭思考或切换模型。智谱官方文档支持 `reasoning_effort=low/high/max`（默认 max），但 MoMA 当前 GLM 接口文档未声明这些控制；MoMA 通用文档中的 `thinking_budget` 也未明确承诺适用于此 GLM 接口，因此本版本不猜测并发送这些参数。

GLM-5.3 连接探测只发一次请求，总输出上限为 4,128 Token、最长 30 秒，并继续受用户配置上限约束。课程 Map 的本地正文目标为 8,000 Token，另加一次性 12,000 Token 推理余量；其他结构化阶段采用同样的固定余量，总上限为 32,000 Token。它们是**本地总预算规划，不是上游独立的推理/正文配额**。重试不翻倍总预算；截断或空正文明确报告资源边界并停止自动重试。只有非空、完整且通过原有 Schema、来源和教学审查的正文才能使用；思考内容不能充当答案。缺少细分 Usage 时保持未知。

Detail 根据精确 UTF-8 请求字节和输出估算分批，最多两批，保留 120,000 字节请求及 62,000 字节输出估算门限，不按固定证据项数拒绝小型片段。通过 Map 质量检查的候选先保留为生成依赖，本地规划失败不会要求模型重生成。完整的旧容量拒绝候选可在课程、来源和哈希等归属一致时重新做本地质量与容量校验；历史失败不改写，新操作记录复用出处。

官方依据、此次候选的纯本地验证和最小真实测试步骤见 [GLM-5.3 修复记录](PHASE4_GLM53_FIX.md)。

## 历史 Hy3 环境变量配置

先复制示例配置。已有 `.env` 时直接编辑它，避免覆盖现有配置。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS / Linux：

```bash
cp .env.example .env
```

编辑 `.env` 中以下项目，填写自己的 Hy3 接入信息：

```dotenv
LLM_PROVIDER=hy3
HY3_BASE_URL=https://your-hy3-endpoint.example.com/v1
HY3_API_KEY=your-api-key
HY3_MODEL=your-hy3-model-id
VISUAL_PROVIDER=disabled
```

服务端使用兼容的 `chat/completions` 接口。示例域名和模型名是占位符；应使用供应商实际分配的值。重启服务后，在设置页核对实际生效的 Provider 和模型。外部连接测试与真实教学生成都会发起请求，可能产生费用。

密钥只保留在服务端，不需要前端 `VITE_*` 密钥。UI 保存的 Key 使用 AES-256-GCM 加密，Windows 的本地加密密钥再由 DPAPI CurrentUser 保护；macOS/Linux 使用权限为 `0600` 的独立本机密钥文件。历史 v1 设置在读取时加密升级。配置或密钥损坏时明确拒绝读取，避免意外改用另一服务或 Fake。

配置接口（包括读取、模型发现与连接测试）仅接受本机 loopback 请求、本机 Host 和可信 Origin，并拒绝跨站 Fetch。开发 Origin 白名单精确限定为 HTTP/HTTPS 的 `localhost`、`127.0.0.1`、`[::1]` 在 5173/5174 的来源，同时接受服务端自身的同源页面；其他本机端口（如 9001）不在开发白名单内。远程部署与额外代理端口需要另行配置可信访问层，此版本不提供远程管理设置。能运行任意本机代码或控制同一用户账号的进程仍能访问凭据；这不是多用户密钥管理系统。不要通过公开、无鉴权的反向代理暴露本机配置路由。

## 配置优先级与数据位置

服务端总是加载仓库根目录的 `.env`，已有进程环境变量优先于其中的值。随后，**已保存 UI 配置优先于环境中的 Provider 设置**，包括用户主动清除 Key 的禁用连接。因此修改 `.env` 后若模型没有变化，应在设置页检查保存的配置；旧 Hy3 环境变量不会覆盖 UI 保存的 MoMA/兼容平台。无保存配置时使用环境变量；无环境指定时保持未配置 MoMA。缺少真实配置明确报错，不会静默启用 Fake。

| 变量                                         | 默认值                        | 作用                                                                                             |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`                               | `moma`                        | 语言 Provider，取 `moma`、`compatible`、历史 `hy3` 或显式离线 `fake`。                           |
| `HY3_BASE_URL` / `HY3_API_KEY` / `HY3_MODEL` | 未设置                        | 真实 Hy3 的接口、密钥和模型。                                                                    |
| `HY3_TIMEOUT_MS`                             | `30000`                       | 单次请求超时，允许 1000–300000 ms；整段课程准备可能包含多次请求。                                |
| `MODEL_MAX_OUTPUT_TOKENS`                     | `64000`                       | 内部输出上限；原有请求预算和有界截断恢复仍生效，可按已知模型上限调低。                           |
| `VISUAL_PROVIDER`                            | `disabled`                    | 可选视觉描述路径。参赛与评估保持关闭。                                                           |
| `PORT` / `HOST`                              | `8787` / `127.0.0.1`          | API 监听地址。                                                                                   |
| `DATABASE_PATH`                              | `./data/clinic.sqlite`        | SQLite 数据文件，首次启动自动建库和迁移；`:memory:` 为临时内存库。                               |
| `PROVIDER_CONFIG_PATH`                       | `./data/provider-config.json` | 设置页保存的服务端配置。                                                                         |
| `AUTOMATION_EXPECT_PROVIDER`                 | 未设置                        | 设为 `fake` 时，实际生效的语言 Provider 必须是 Fake，且不能启用外部视觉 Provider，否则启动拒绝。 |

数据库与设置文件的相对路径以**服务端进程工作目录**解析。通过根目录 `npm run dev` 或 `npm run dev:server` 启动时，服务端 npm workspace 工作目录为 `apps/server`，默认数据在 `apps/server/data/`。如需固定位置，请使用绝对路径。

`.env`、`data/`、SQLite 文件、`provider-config.json` 和 `provider-config.json.key` 均被 Git 忽略。自定义配置文件名时需要自行将配置与配套 `.key` 文件加入忽略规则。备份时停止服务并保存整个配置目录；Windows DPAPI 密钥与当前用户绑定，换机器或用户后需要重新填写 Key。删除课程不是可撤销操作。

前端开发代理固定转发 `/api` 到 `127.0.0.1:8787`，详见 [vite.config.ts](../apps/web/vite.config.ts)。只改 API 的 `PORT` 不会同步更改代理；初次运行建议保持默认端口。

## 确保体验过程使用 Fake

新检出需显式选择 Fake。在已有配置的机器上，可用独立设置文件和数据库启动一次临时体验。

Windows PowerShell：

```powershell
$env:LLM_PROVIDER = 'fake'
$env:VISUAL_PROVIDER = 'disabled'
$env:AUTOMATION_EXPECT_PROVIDER = 'fake'
$env:PROVIDER_CONFIG_PATH = './data/offline-preview-provider.json'
$env:DATABASE_PATH = ':memory:'
npm run dev
```

macOS / Linux：

```bash
LLM_PROVIDER=fake VISUAL_PROVIDER=disabled AUTOMATION_EXPECT_PROVIDER=fake \
PROVIDER_CONFIG_PATH=./data/offline-preview-provider.json DATABASE_PATH=:memory: npm run dev
```

内存课程会在服务停止时消失。若独立设置文件以前被保存为 Hy3，保护条件会拒绝启动；可换一个未使用的设置文件名。PowerShell 的变量对当前终端后续命令仍然生效，切回真实 Hy3 时请使用新终端或显式修改这些变量。

## 常见问题

| 现象                                  | 检查方法                                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 原生依赖安装失败                      | 确认使用受支持的 Node.js、系统架构和完整依赖安装；SQLite 与图像库使用原生模块。先用推荐的 Node.js 24 重试 `npm ci`。 |
| 页面打开但 API 请求失败               | 确认服务端成功启动，8787 未被其他程序占用，开发代理地址与 API 一致。                                                 |
| 配置了 Hy3 仍显示 Fake，或反过来      | 在设置页查看生效配置，检查 `PROVIDER_CONFIG_PATH` 指向的保存设置与进程环境。                                         |
| 课程准备中断或失败                    | 按页面错误检查资料、可执行目标与 Provider 状态，再显式重试；资料或目标改变后需重新确认课程结构。                     |
| 资料导入后内容不完整                  | PDF 需文本层；复杂图表、公式、扫描件与动态网页见[限制说明](REPORT.md#当前能力边界)。                                 |
| `eval:fake` / `eval:hy3` 拒绝视觉配置 | 显式设置 `VISUAL_PROVIDER=disabled`；评估不包含可选视觉路径。                                                        |

这是本地开发运行方式。`npm run build` 生成工作区构建产物；API 的生产启动命令是 `npm run start -w @hy3-clinic/server`，它不负责托管前端静态站点。公共部署所需的认证、TLS、访问控制与前端代理不在当前运行方案内。

## 查看评估结果

想了解结果含义，阅读[设计与评估报告](REPORT.md)；想查看实际题目和作答，阅读[学习案例](DEMO.md#保存的学习案例)。已有结果可按[验证与复现](VERIFICATION.md)无密钥核对，无需配置真实模型。
