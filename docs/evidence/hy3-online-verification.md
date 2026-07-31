# Hy3 Study Clinic — Real Hy3 Online Verification

> Sanitized public record of the real-provider evaluation (`eval:hy3`) executed online
> against the Hy3 API at the source commit below. Derived from the gitignored raw report
> by `eval/export-evidence.mjs`; the raw report itself is never committed.

## Run identity

| Field | Value |
| --- | --- |
| Overall result | **passed** (6/6 operations) |
| Provider | `hy3` (real online API) |
| Fake fallback | `false` — eval/run-hy3.mjs 在缺少 HY3_BASE_URL/HY3_API_KEY/HY3_MODEL 时直接拒绝运行并以非零码退出;脚本内不存在 Fake Provider 代码路径,不可能静默退回 Fake。 |
| Model | `hy3` |
| Endpoint host | `tokenhub.tencentmaas.com` |
| Source commit | `46d34f288d6c619d396ee5f39e12cb33249161da` |
| Branch / worktree | `main` / clean |
| Executed at (UTC) | 2026-07-31T04:28:21.661Z |
| Evidence generated at (UTC) | 2026-07-31T04:32:32.265Z |
| Runtime | Node.js v24.14.1 on win32 |
| Requests | 9 total, 1 bounded repair call(s), provider latency 43.6s |

## Operations

| Operation | Result | Requests | Bounded repairs | Latency | Key metrics |
| --- | --- | ---: | ---: | ---: | --- |
| `concept_analysis` | ✅ passed | 1 | 0 | 4.8s | proposed=4, groundingAccepted=4, groundingAcceptanceRate=1, firstPassSchema=true |
| `concept_analysis_doc_b` | ✅ passed | 1 | 0 | 4.0s | proposed=3, groundingAccepted=3 |
| `alignment_agreement` | ✅ passed | 1 | 0 | 1.8s | comparablePairs=1, agreement=1, agreementRate=1 |
| `grading_agreement` | ✅ passed | 3 | 0 | 6.9s | samples=3, correctnessAgreement=1, keyPointExactMatch=1 |
| `cross_document_assessment` | ✅ passed | 2 | 1 | 23.8s | items=2, itemsWithVerifiedPrimaryEvidence=2, itemsTrulyCrossDocument=2 |
| `tutor_first_step` | ✅ passed | 1 | 0 | 2.2s | action=call_tool, tool=inspect_learning_state |

## What this proves

- The exact source version above completed every model-backed evaluation operation against the real Hy3 endpoint, with structured output accepted by runtime schema validation (at most one bounded repair per call).
- Proposed evidence quotes were verified by the local exact-quote grounding validator against the real source blocks.
- Alignment and short-answer grading agreed with the small hand-authored labels at the rates recorded above, and the cross-document operation produced at least one question whose verified evidence really spans multiple documents.
- The Tutor first step stayed inside the controlled action vocabulary.

## What this does not prove

- 样本量很小(小型自建夹具与人工标注,数量见上方各操作指标),结果仅供粗略参考,不构成基准测试;数值依赖所配置的模型与 API。
- 对齐一致率只统计本次运行中模型提取概念名与标注对得上的概念对(comparablePairs),未对上的标注对不计入。
- 本报告证明引用的文本在声称的源位置真实存在并通过了本地结构校验;精确引文验证不能独立证明生成解释的完整语义蕴含。
- 原始报告(eval/reports/)保持 gitignore,本文件由导出器从原始报告派生并做脱敏;端点仅保留主机名,凭证与本地路径一律不发布。

## Reproduce

```bash
npm run build
npm run eval:hy3   # 需要你自己的真实 HY3_* 凭证;缺失即拒绝运行
npm run eval:evidence
```

完整数值见同目录的 `hy3-online-verification.json`(与本文件由同一净化对象生成)。
