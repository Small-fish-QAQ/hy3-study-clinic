# Hy3 智学诊所 · Hy3 Study Clinic

> 证据可溯源(evidence-grounded)的出题、判分与错题康复练习 Web 应用,由 Hy3 提供大模型能力,并内置**离线确定性 Fake Provider**,无需联网、无需 API Key 即可完整体验两条学习闭环。
>
> An evidence-grounded quiz / grading / mistake-remediation web app powered by Hy3, with a built-in **offline deterministic fake provider** — the full workflows run without network access or an API key.

- **License / 许可证:** Apache-2.0
- **状态 / Status:** 初始实现进行中(Initial implementation in progress)

## 导航 / Navigation

- [快速开始(Fake 模式) / Quick start (fake mode)](#快速开始--quick-start)
- [两条核心闭环 / Two core flows](#两条核心闭环--two-core-flows)
- [架构 / Architecture](#架构--architecture)
- [真实 Hy3 配置 / Real Hy3 configuration](#真实-hy3-配置--real-hy3-configuration)

## 快速开始 / Quick start

```bash
npm ci
npm run build
npm test
npm run dev
```

> 详细文档将在里程碑 7 中补全。The full documentation is completed in Milestone 7.

## 两条核心闭环 / Two core flows

- **Flow A:** 源材料 → 源切分 → 概念分析 → 证据可溯源出题 → 交互答题
- **Flow B:** 提交作答 → 判分 → 错题本 → 针对性康复出题 → 掌握度更新

## 架构 / Architecture

npm workspaces monorepo:

- `apps/web` — React + Vite 前端(中文优先,不接触任何凭证)
- `apps/server` — Fastify + SQLite 后端(唯一持有 Provider 配置)
- `packages/shared` — 共享 Zod 模型与工具

## 真实 Hy3 配置 / Real Hy3 configuration

复制 `.env.example` 为 `.env`,设置 `LLM_PROVIDER=hy3` 及相关变量。**切勿提交真实 `.env`。**
