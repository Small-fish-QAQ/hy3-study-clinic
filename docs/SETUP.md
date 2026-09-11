# 运行 Hy3 Study Clinic

[返回首页](../README.md) · [验证命令](VERIFICATION.md)

## 环境与安装

推荐 Node.js 24 和随附的 npm，支持 Windows、macOS 与 Linux。仓库 `.nvmrc` 选择 Node 20 系列；使用该系列时需 **20.19 或更新版本**，以满足锁定的 Vite 依赖。根包中 `>=20.9` 的声明不足以描述全部依赖的最低要求。

在仓库根目录执行：

```bash
npm ci
npm run build
npm run dev
```

`npm ci` 需要下载依赖。默认 Fake 模式的教学流程在安装后可离线运行；导入网页快照仍需要访问所选网页。Fake 内容用于体验与回归验证，不代表真实 Hy3 输出。

前端默认在 [http://localhost:5173](http://localhost:5173)，API 在 [http://127.0.0.1:8787](http://127.0.0.1:8787)。以终端打印的前端地址为准；5173 被占用时 Vite 可能选择下一个端口。终端按 Ctrl+C 停止服务。

创建课程后，在“课程资料”添加资料，选择全局深度与可选重点，审阅并确认课程结构，然后从课程主页开始学习。当前学习界面和生成契约使用 `zh-CN`。

## 接入真实 Hy3

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

密钥保存在服务端环境或被 Git 忽略的本地设置文件中，不需要前端 `VITE_*` 密钥。缺少真实配置时，真实评估命令会失败，不会自动改用 Fake。

## 配置优先级与数据位置

服务端总是加载仓库根目录的 `.env`，已有进程环境变量优先于其中的值。随后，**有效的已保存 Provider 设置优先于环境中的 Provider 设置**。因此修改 `.env` 后若模型没有变化，应在设置页检查保存的配置；只写 `LLM_PROVIDER=fake` 不能覆盖已保存的 Hy3 设置。

| 变量                                         | 默认值                        | 作用                                                                                             |
| -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `LLM_PROVIDER`                               | `fake`                        | 语言 Provider，取 `fake` 或 `hy3`。                                                              |
| `HY3_BASE_URL` / `HY3_API_KEY` / `HY3_MODEL` | 未设置                        | 真实 Hy3 的接口、密钥和模型。                                                                    |
| `HY3_TIMEOUT_MS`                             | `30000`                       | 单次请求超时，允许 1000–300000 ms；整段课程准备可能包含多次请求。                                |
| `VISUAL_PROVIDER`                            | `disabled`                    | 可选视觉描述路径。参赛与评估保持关闭。                                                           |
| `PORT` / `HOST`                              | `8787` / `127.0.0.1`          | API 监听地址。                                                                                   |
| `DATABASE_PATH`                              | `./data/clinic.sqlite`        | SQLite 数据文件，首次启动自动建库和迁移；`:memory:` 为临时内存库。                               |
| `PROVIDER_CONFIG_PATH`                       | `./data/provider-config.json` | 设置页保存的服务端配置。                                                                         |
| `AUTOMATION_EXPECT_PROVIDER`                 | 未设置                        | 设为 `fake` 时，实际生效的语言 Provider 必须是 Fake，且不能启用外部视觉 Provider，否则启动拒绝。 |

数据库与设置文件的相对路径以**服务端进程工作目录**解析。通过根目录 `npm run dev` 或 `npm run dev:server` 启动时，服务端 npm workspace 工作目录为 `apps/server`，默认数据在 `apps/server/data/`。如需固定位置，请使用绝对路径。

`.env`、`data/`、SQLite 文件和 `provider-config.json` 均被 Git 忽略。课程资料、学习记录与保存的配置应按本地数据管理；备份时先停止服务并保存相应数据目录。删除课程不是可撤销操作。

前端开发代理固定转发 `/api` 到 `127.0.0.1:8787`，详见 [vite.config.ts](../apps/web/vite.config.ts)。只改 API 的 `PORT` 不会同步更改代理；初次运行建议保持默认端口。

## 确保体验过程使用 Fake

新检出、没有 `.env` 或保存设置时默认使用 Fake。在已有配置的机器上，可用独立设置文件和数据库启动一次临时体验。

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
| 课程准备中断或失败                    | 按页面错误检查来源、可执行目标和 Provider 状态，再显式重试。不要通过删除历史或降低目标来伪造成功。                   |
| 资料导入后内容不完整                  | PDF 需文本层；复杂图表、公式、扫描件与动态网页见[限制说明](LIMITATIONS.md)。                                         |
| `eval:fake` / `eval:hy3` 拒绝视觉配置 | 显式设置 `VISUAL_PROVIDER=disabled`；评估不包含可选视觉路径。                                                        |

这是本地开发运行方式。`npm run build` 生成工作区构建产物；API 的生产启动命令是 `npm run start -w @hy3-clinic/server`，它不负责托管前端静态站点。公共部署所需的认证、TLS、访问控制与前端代理不在当前运行方案内。
