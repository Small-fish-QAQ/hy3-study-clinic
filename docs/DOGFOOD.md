# Hy3 Study Clinic — Human Dogfood Protocol (30–45 minutes)

This protocol evaluates the pre-dogfood upgrade (activity executability, section-aware extraction with 资料映射, and lesson-card teaching) against real study needs. Run it AFTER `npm run dev` with either provider; the real Hy3 provider is strongly recommended for teaching-quality judgments. Nothing in this document reports results — it is the script for a human session, and no human outcome has been recorded yet.

## Preparation (before opening the app)

1. Pick a REAL course document you personally study: 10–25 pages, with headings, ideally containing at least one formula/procedure-heavy section. PDF, DOCX, Markdown, or pasted text.
2. On paper (outside the app), write the 10–15 concepts you believe this document must yield. This list is your personal must-find label set — write it BEFORE import so the comparison stays honest.
3. Have a strong general-purpose AI assistant open in another window for side-by-side teaching comparisons.

## Session script

1. **Import & extraction** — create a course space, add the document, run 提取概念. Note total time and whether the progress/summary wording is understandable.
2. **Mapping** — open 资料映射 under the document. Compare the mapped sections and extracted concepts against your pre-written list. For 1–2 sections marked 未映射 (or thin ones), press 继续提取 and check what appears. Record every concept from your list that is still missing afterwards.
3. **Lesson cards** — open 讲解 for 4–5 concepts, including the formula/procedure-heavy one. Read fully. Check: does the explanation teach (not merely restate)? Are 课程资料/本地已验证 labels only on text the source really supports (spot-check the expanded quotes)? Try one directive (更多例子 or 更深入). If the course defines something unusually, is a conflict shown with a verified quote?
4. **Compare with a general assistant** — ask the assistant to explain the same 2–3 concepts. Judge: where is the clinic's card better (course-specific definitions/notation/scope), where is it worse (depth, fluency, follow-ups)?
5. **Diagnostic & queue** — generate the graph, run 诊断评估 from 今日学习, answer honestly and get some questions wrong. Then follow 3–4 queue items of different kinds (错题巩固 / 复习 / 前置修复 / 继续学习), launching each with its 开始 button.
6. **Tutor** — on a weak concept, run the Tutor and press 开始推荐活动. Complete the launched activity.
7. **Remediation & history** — finish a remediation round until at least one mistake resolves; reopen the attempt from 测验历史.

## Record (severity in brackets)

- [critical] any 开始/推荐活动 button that fails to launch, and the exact message;
- [critical] any lesson segment labeled 课程资料/本地已验证 whose expanded quote does not actually support the sentence;
- [major] materially wrong AI teaching (even when correctly labeled AI 辅助讲解);
- [major] concepts from your pre-written list still missing after deepening;
- [minor] latency pain points (extraction, lesson generation), graph clutter at the new concept counts, confusing wording;
- where the clinic beat the general assistant, and where it lost;
- every moment you WANTED to ask a free-form follow-up question the card could not answer;
- every moment you wanted the app to decide the next step for you (sequencing), rather than picking from the queue.

## Decision gates for the reserved adaptive layer (Phase 3)

- **Build Phase 3** if activities were reliable AND lessons were useful, but the recorded follow-up/sequencing moments show the static loop is the binding constraint.
- **Defer or redesign Phase 3** if teaching quality (not orchestration) remains the main gap, or if lessons + queue already sustained a full session comfortably.
- **Add the semantic coverage-unit layer** only if 资料映射 repeatedly called sections "mapped" that you experienced as uncovered.
