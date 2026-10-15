# 第三方与素材声明

本项目原创源码以[Apache License 2.0](LICENSE)发布。第三方组件保留各自许可，本页提供维护入口，不替代其完整许可证。准确依赖版本以package-lock.json为准。

| 范围                                                                          | 许可与来源                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React、React DOM、Fastify、Zod、better-sqlite3、ts-fsrs、unpdf、yauzl、xmldom | 各包MIT；安装包保留上游许可                                                                                                                                         |
| @mozilla/readability、sharp                                                   | Apache-2.0                                                                                                                                                          |
| dotenv、mammoth                                                               | BSD-2-Clause                                                                                                                                                        |
| jsdom                                                                         | MIT                                                                                                                                                                 |
| sharp的libvips与平台原生组件                                                  | 包含LGPL-3.0-or-later组件；sharp本身的Apache许可不覆盖全部二进制依赖                                                                                                |
| jszip（传递依赖）                                                             | MIT OR GPL-3.0-or-later，按MIT选项使用                                                                                                                              |
| Noto Sans SC、Noto Serif SC                                                   | SIL Open Font License 1.1；[来源说明](apps/web/public/fonts/README.md)、[Sans许可](apps/web/public/fonts/OFL.txt)、[Serif许可](apps/web/public/fonts/OFL-serif.txt) |
| Tabler Icons                                                                  | MIT；[来源](apps/web/public/icons/tabler/README.md)、[许可](apps/web/public/icons/tabler/LICENSE.txt)                                                               |

仅分发源码和依赖清单时不打包node_modules。若未来分发自带sharp/libvips的可执行包或镜像，应随包保留第三方许可证，并按实际二进制分发方式履行LGPL相关义务。当前没有制作这类产品二进制发行包。

## 产品媒体与用户资料

现有品牌／背景包含AI生成的栅格素材，用于装饰；其来源说明保留在[历史媒体记录](docs/DEMO.md#资源与许可)。新V2公开截图来自同一已验收产品的真实页面，记录采集与哈希在[media/v2/manifest.json](docs/media/v2/manifest.json)。

截图中的教材片段仅作为必要产品说明，底层教材权利仍属于相应权利人；未附教材全文、原扫描文件或可导入课程数据库。用户自导资料不自动取得本仓库Apache许可。本次发布范围为已审阅的必要产品展示片段。

公开方案保留官方移动云杯模型应用赛模板与标识，说明赛事作品设计。官方模板和标识权利归相应权利人，不自动适用本项目Apache许可。模板原件、个人联系信息及私人参赛包不进入Git或Release。

正式Demo《The Fourth》使用原创72 BPM编曲、合成纸页声及GeneralUser GS 2.0.3乐器采样，无人声旁白。[完整音源许可](docs/media/v2/licenses/GeneralUser-GS-LICENSE.txt)允许私人及商业音乐创作，未分发音源库。中文字体为Noto Sans SC、Noto Serif SC，完整OFL见上表；品牌书页为已有AI栅格装饰。成片通过Release附件分发，素材哈希与展示边界见[DEMO](docs/DEMO.md)；原始录像、视频工程及缓存留在仓库外。此前C线制作记录仍保留。

## 服务与模型

MoMA / GLM-5.3、Hy3及其他兼容Provider服务受各自平台条款约束。开源代码不分发API Key、赠送额度或模型权重。用户自行配置连接并承担模型服务用量；本地研究报告没有可核实的货币账单。
