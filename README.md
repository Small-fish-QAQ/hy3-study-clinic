# Hy3 Study Clinic

把自己的资料变成课程：读讲解、做练习，遇到不懂的地方继续追问，答错后换个问题再试。

[![CI](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml/badge.svg)](https://github.com/Small-fish-QAQ/hy3-study-clinic/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

[观看演示](docs/DEMO.md) · [正式作答样例](docs/DEMO.md#核对一次正式作答) · [设计与评估报告](docs/REPORT.md) · [快速核验](docs/VERIFICATION.md#快速核验)

## 三个设计选择

这是一个面向学生与自学开发者的本地学习应用。你提供课件、讲义或技术文档，选择学习深度，确认课程目录；Hy3 根据资料准备讲解和练习，应用保存课程和作答，下次打开可以接着学。

- **课程按已确认的安排继续。** 系统保存目录、先后依赖和学习位置，暂停、恢复和重试沿着已有安排进行。资料改变时建立新版本，保留旧记录的出处。[设计理由](docs/REPORT.md#课程确认后按既定安排继续)
- **纠错围绕这次作答展开。** 根据实际错误解释缺失的理解，再用新问题检验；不懂的片段可以向 Tutor 助教追问。[视频中的错误与复测](docs/DEMO.md#视频中的学习过程)
- **正式通过可以回看依据。** 学习活动与正式测评分开记录；通过记录保留题目、实际回答、评分标准和版本。[查看一个已保存的例子](docs/DEMO.md#核对一次正式作答)

例如，演示中的访谈练习要求根据三位同学的经历判断需求。选错后，系统解释为什么少数人的经历不能推出所有学生的需求，再换一个情境继续练习。

[![系统针对访谈练习中的错误，解释个人经历为何不能直接推出全体学生的需求](docs/media/screenshots/11-repair-explanation.webp)](docs/DEMO.md#截图导览)

## 按这个顺序快速了解

1. **看学习过程。** 下方 1 分 50 秒视频展示讲解、追问、错误分析和换题复测。
2. **核对一次正式作答。** [四分位数案例](docs/DEMO.md#核对一次正式作答)展示题目、回答、评分和已保存的通过记录，来自另一批真实 Hy3 运行。
3. **看完整分母。** [20 课结果](docs/REPORT.md#产品运行与实际失败)同时列出完成情况与失败。需要进一步检查时，按[快速核验](docs/VERIFICATION.md#快速核验)操作。

## 观看演示

这段 1 分 50 秒的视频展示“用户访谈”课程中的讲解、追问、错误分析和复测。

https://github.com/user-attachments/assets/ba1004fd-fec8-44cb-9fbf-0961fa6962f2

[完整图集与操作说明](docs/DEMO.md) · [下载 MP4](docs/media/demo/Hy3-Study-Clinic-demo-2560x1440.mp4) · [查看实际题目和作答](docs/DEMO.md#保存的学习案例)

## 当前验证到什么程度

在 20 份完整原创讲义上，用 Hy3 模拟学习者，15 课完成了从导入到首个正式作答的流程。检查实际内容时，仍发现了题目泄露答案、评分标准多提要求等问题；完整结果和失败都保留在[主报告](docs/REPORT.md#产品运行与实际失败)中。这是产品运行实验，尚未测量真实学生的学习效果。

为检查生成的讲解、题目和反馈，项目还提供 StudyEval 评估工具。验证时，为 24 个任务各准备好、中、差三个版本，共 72 份材料；评估器在 22 组中按预期区分了三档。这里的预期等级由样本构造者事先指定，人类评分的支持范围见[样本与验证](docs/REPORT.md#受控样本怎样构造)。

## 快速运行

推荐 **Node.js 24 + npm**。从新检出的仓库开始：

```bash
git clone https://github.com/Small-fish-QAQ/hy3-study-clinic.git
cd hy3-study-clinic
npm ci
npm run build
npm run dev
```

打开 [http://localhost:5173](http://localhost:5173)。默认使用无需密钥的演示模式（Fake），通过预设内容体验操作流程。安装完成后，使用本地资料可离线重复运行；具体内容与排序可能变化。要查看真实生成效果，按[运行指南](docs/SETUP.md)配置 Hy3，并在设置页核对生效模型。

可导入带文本层的 PDF、DOCX、PPTX、Markdown、HTML、网页快照和源码文本。当前教学与界面使用简体中文；扫描 PDF 暂不支持 OCR，复杂图表与公式的提取有限。应用按本地使用设计，公共部署尚需补充用户认证与数据隔离。

## 继续了解

| 想了解什么                     | 阅读入口                           |
| ------------------------------ | ---------------------------------- |
| 为什么这样设计，实验发现了什么 | [设计与评估报告](docs/REPORT.md)   |
| 界面如何使用，实际生成了什么   | [演示与案例](docs/DEMO.md)         |
| 如何安装、配置和排查问题       | [运行指南](docs/SETUP.md)          |
| 模块如何协作，学习状态如何更新 | [系统架构](docs/ARCHITECTURE.md)   |
| 如何检查实现、重算保存结果     | [验证与复现](docs/VERIFICATION.md) |

[文档导航](docs/README.md)说明各文件的用途；评测协议、测试材料和历史记录按需查阅。

## 许可

[Apache-2.0](LICENSE)。内置讲义与评测样本为项目原创内容；字体、图标和媒体说明见[资源与许可](docs/DEMO.md#资源与许可)。

本项目为参与「腾讯犀牛鸟开源人才培养计划 · 混元大语言模型项目」实战任务 1 开发的个人作品，不代表腾讯或 Hy3 官方发布。
