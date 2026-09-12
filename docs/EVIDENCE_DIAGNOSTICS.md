# 冻结证据的诊断分解

[返回最终结果](EVALUATION_RESULTS.md) · [原始输入与复核入口](../eval/final-evaluation/README.md)

本页是对 **2026-09-12 已冻结记录的事后诊断分解**，不是预注册主指标或新的“准确率”。没有运行模型、改变分数、裁决人类分歧或删改分母。原始结果仍为：严格三档 **5/24**、重复完全一致 **29/44**、首次判断 **48 U / 7 INVALID**、20 门课程中 **4 门准入 Formal / 2 门产生受支持证据**。

## 24 个受控三元组：未严格排序的 19 组是什么

按[原始构造参照](../eval/final-evaluation/dataset/constructor-reference.json)的 strong / middle / poor 顺序，只取[原始 schedule](../eval/final-evaluation/dataset/final-schedule.json)中各案例的首次观察，不按实际得分重排。构造等级是预先假设，不是人类真值。

| 首次结果（强、中、差） | 组数 | 原始三元组 ID                          |
| ---------------------- | ---: | -------------------------------------- |
| 2、1、0                |    5 | T04、T10、T11、T18、T21                |
| 2、2、0                |    8 | T05、T06、T07、T08、T09、T13、T15、T23 |
| 2、0、0                |    1 | T02                                    |
| U、0、0                |    1 | T01                                    |
| U、U、0                |    2 | T03、T19                               |
| 2、U、0                |    4 | T12、T14、T17、T22                     |
| U、2、0                |    2 | T16、T24                               |
| U、1、0                |    1 | T20                                    |

**19 组非严格排序 = 10 组含 U + 9 组全数值但有并列。** 先把含 U 的组归入不可用类别；T01 同时还有中/差并列，因此这不是互不重叠的底层原因分类。10 组共含 12 个 U（强、中各 6），该受控首次集合没有 INVALID 或 MISSING。9 组全数值并列中，8 组未区分强/中，1 组未区分中/差；所有可比数值对都没有方向倒置。

| 配对（按构造预期） | 全部预定对 | 双方数值 | 预期方向严格大于 | 并列 | 反向小于 | 含 U |
| ------------------ | ---------: | -------: | ---------------: | ---: | -------: | ---: |
| 强–中              |         24 |       14 |                6 |    8 |        0 |   10 |
| 中–差              |         24 |       18 |               16 |    2 |        0 |    6 |
| 强–差              |         24 |       18 |               18 |    0 |        0 |    6 |
| 合计               |         72 |       50 |               40 |   10 |        0 |   22 |

这解释了 **40/50 数值配对排序正确，全部预定对仍为 40/72**。24 个构造差例都得到 0；强–差的 24 个机会中，18 个可比且均为 2 对 0，另 6 个因强例为 U 而不可比。若把 5/24 读成整体质量方向判别能力，会明显低估这组记录中的粗粒度区分；它实际同时要求可用性和完整三档分辨率。强/中细分仍弱，U 不能当作正确判断，同来源及同组三个配对也不是独立样本。

原始理由进一步限制了解释：[逐行结果](../eval/final-evaluation/results/complete-rows.json)中的 12 个 U，有 7 个记录反例检查未建立，1 个要求证据复核，2 个为 `REQUIRED_CRITERION_UNCERTAIN`，2 个指出整体 `supportFields` 同时包含被依赖和被质疑的判分，无法证明证据独立。四个 Q2 中档得到 2 的理由是必要目标已覆盖，薄弱处属于次要目标；其他中档的 2 涉及局部讲解目标、无已见解答记录的原文检索题、或可用的补救步骤。两个中档 Q1 的 0 则分别指出人次分布颠倒和原价引用错误。并列包含构造分级与 rubric 范围/严重度解释的差异；这些保存理由不证明评估器必然正确，也不改变构造标签。

## 重复实验：29/44 之外的 15 组

35 个输入对应 44 个维度组，各观察三次；**29/44 组完全一致**。以下按“先含 U，再含 INVALID，再数值变化”作互斥计数：

| 非完全一致类别       | 组数 | 原始序列或范围                                             |
| -------------------- | ---: | ---------------------------------------------------------- |
| 含 U                 |   11 | 包含 E712/Q4 的 U、2、0；不是所有 U 波动都只有一个数值等级 |
| 含 INVALID（不含 U） |    1 | E618/Q4：0、INVALID、0                                     |
| 仅相邻数值变化       |    2 | N-F08-tutor/Q1：2、1、1；N-F09-tutor/Q1：2、2、1           |
| 仅数值且跨越 0 和 2  |    1 | N-F04-curriculum/Q2：0、2、0                               |

原来的转变表比较的是**第 2、3 次分别相对第 1 次**，不是连续时间相邻两次。88 个参照比较中，68 个相同（0→0=30、2→2=35、U→U=3）；20 个不同为：15 个 U/数值转变（U→2=10、2→U=4、U→0=1）、3 个相邻数值转变（2→1）、1 个 0→INVALID、**1 个 0→2**。这些是同组相关比较，不替代 29/44。

再看每组三次的全部数值范围，**两组曾同时出现 0 和 2**：N-F04-curriculum/Q2，以及含 U 的 E712/Q4。后者以 U 为首次参照，原表记录 U→2 和 U→0，所以没有进入 0→2 单元格。原表的一次 0→2 计数正确，但不能理解成整个重复实验只有一组跨越极性。盲评包的 34 条 PRIMARY 判断中 StudyEval、Max、Fable 两两无 0↔2，是另一个分母与比较场景。

## Formal：保留 20 门课程的完整漏斗

20 是全部新建课程：16 个来源根的原深度课程，加 4 个共享来源的基础深度对照。冻结遍历上限为每门两个教学 portion、至多尝试一次 Formal；不足作答分支不增加课程数。20 不是“已经确认具备正式资格的 20 次出题机会”。

根据[完整冻结产品审计](../eval/final-evaluation/results/final-product-audit.json)逐课程计数，各阶段都保留完整的 20 门分母：

| 到达阶段                         | 课程数 / 全部课程 | 与前一阶段的差额及记录                                                                 |
| -------------------------------- | ----------------: | -------------------------------------------------------------------------------------- |
| 启动建课                         |             20/20 | 包含所有失败和基础深度对照                                                             |
| 接受课程结构并完成课程准备       |             18/20 | E03、F06 在课程生成/校验阶段失败                                                       |
| 至少一次 Lesson 准备就绪         |             15/20 | B-F05、F04、F10 首次 Lesson 在一次显式重试后仍未就绪                                   |
| 完成至少一次讲解及练习流程       |             13/20 | F08、F11 的 Lesson 已就绪，但 Practice 补救/复测链生成失败，记录截断输出               |
| 实际尝试路由的 Formal 启动       |             11/20 | F02 在第二次 Lesson 准备失败后停止；F12 完成教学后没有可执行下一项                     |
| 通过调用前支持门控并生成候选     |              5/20 | B-F01、E01、E02、F01、F03、F05 共 6 门被运行期语义支持门控拒绝，未进入 Formal 候选生成 |
| 候选通过校验、准入并完成作答评分 |              4/20 | B-E01、B-F09、F07、F09；E04 候选引用超长被 schema 拒绝，随后修复调用传输失败           |
| 主作答产生 supported evidence    |              2/20 | B-E01、F07；B-F09 为 partial，F09 为 unavailable                                       |

原审计字段 `withDeliveredLesson=13` 实际按 `teaching[].status == "completed"` 计数，本次计入的 13 门均完成了关联 Practice 流程；因此本报告将原“交付讲解”行明确为“完成讲解及练习流程”。单独的 Lesson 就绪是 15 门，不能用 13 代指所有成功生成的 Lesson。

11 次启动在课程概览中可路由，但仍须通过运行期 `formal_provider` 语义支持检查；实际有 5 门通过此门控进入 `proposeAssessment`。这只证明到达该阶段的 5 次生成资格，不证明其他尚未到达的计划目标一定不合格。计划中的 Formal 项或概览的可启动状态都不是已经验证的资格分母。5 门候选课程由 4 门完成的 Formal 与 E04 的 `propose_formal_assessment` 拒绝记录组成；E04 的两处 quote 超过 500 字符，随后出现 `PROVIDER_ERROR`，不能把这一路损失统称为语义门控拒绝。

**4/20 仍是这次冻结遍历中公平的端到端 Formal 可用性摘要，2/20 是受支持证据的课程覆盖。** 11 次实际启动中 6 次在生成前被支持门控拒绝，5 次进入候选生成后 4 次准入；这些阶段计数帮助定位损失，不替换完整分母或代表总体成功率。四个不足作答分支也全部保留，均为 unavailable、未展示达成。

fail-closed 权威边界有意拒绝未建立支持的内容，同时存在真实的生成/执行和交付可用性损失。改进方向是提高满足支持条件的证据生成与交付可用率，同时保留权威边界；本次记录不能证明六次门控判定都正确，也不是学习效果实验。

## 离线机械复算

先运行现有的 `node eval/final-evaluation/scripts/verify-publication.mjs` 验证完整文件身份。然后把下列 Python 标准库代码保存到仓库外，从仓库根目录运行；它只读原始 schedule、输入和观察以及冻结产品审计，不导入或执行 StudyEval、不访问网络。输出包含全部 24 组三元组及案例 ID、12 个 U 的原始理由、全部 15 组不一致序列、原口径转变和逐课程漏斗，便于检查分类与遗漏。

```python
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

root = Path("eval/final-evaluation")


def read(name):
    return json.loads((root / name).read_text(encoding="utf-8"))


schedule = read("dataset/final-schedule.json")
canonical = json.dumps(schedule, ensure_ascii=False, separators=(",", ":")).encode()
assert hashlib.sha256(canonical).hexdigest() == read(
    "results/frozen-receipts.json"
)["identities"]["scheduleHash"]
assert len(schedule) == len({t["runId"] for t in schedule}) == 279
groups = defaultdict(list)
reasons = {}
for task in schedule:
    case = task["caseId"]
    folder = "natural-cases" if task["population"] == "natural" else "controlled-cases"
    packet = read(f"dataset/{folder}/{case}.json")
    observation = read(f"results/observations/{task['runId']}.json")
    assert observation["task"] == task
    result = observation["evaluation"]["result"]
    assert result["status"] in ("VALID", "JUDGE_INVALID")
    dimensions = {d["dimension"]: d for d in result.get("dimensions", [])}
    if result["status"] == "VALID":
        assert set(dimensions) == set(packet["dimensions"])
    for dim in packet["dimensions"]:
        value = dimensions[dim]["level"] if result["status"] == "VALID" else "INVALID"
        groups[case, dim].append((task["replicate"], value))
        if task["replicate"] == 1:
            reasons[case, dim] = dimensions.get(dim, result).get("reason")
series = {key: [v for _, v in sorted(items)] for key, items in groups.items()}
for items in groups.values():
    assert sorted(r for r, _ in items) in ([1], [1, 2, 3])
assert sum(map(len, series.values())) == 327
print("primary", dict(Counter(v[0] for v in series.values())))

reference = read("dataset/constructor-reference.json")
labels = {r["caseId"]: r["quality"] for r in reference["references"]}
patterns = defaultdict(list)
pairs = {name: Counter() for name in ("strong-middle", "middle-poor", "strong-poor")}
triplets = []
u_reasons = []
for t in reference["triplets"]:
    ids, dim = t["caseIds"], t["dimension"]
    assert [labels[c] for c in ids] == ["strong", "middle", "poor"]
    values = [series[c, dim][0] for c in ids]
    triplets.append({**t, "levels": values})
    patterns[tuple(values)].append(t["tripletId"])
    for c, v in zip(ids, values):
        if v == "U":
            u_reasons.append([c, dim, reasons[c, dim]])
    for name, i, j in (("strong-middle", 0, 1), ("middle-poor", 1, 2), ("strong-poor", 0, 2)):
        a, b = values[i], values[j]
        numeric = type(a) is int and type(b) is int
        outcome = "unavailable" if not numeric else "ordered" if a > b else "tie" if a == b else "inverted"
        pairs[name][outcome] += 1
        pairs[name]["planned"] += 1
        pairs[name]["numeric"] += int(numeric)
print("triplets", json.dumps(triplets, ensure_ascii=False))
print("patterns", [(list(k), v) for k, v in patterns.items()])
print("U reasons", json.dumps(u_reasons, ensure_ascii=False))
print("pairs", {k: dict(v) for k, v in pairs.items()})

repeat = {k: v for k, v in series.items() if len(v) == 3}
categories, transitions = Counter(), Counter()
nonexact, polarity_span = [], []
for (case, dim), values in repeat.items():
    if len(set(values)) == 1:
        category = "exact"
    elif "U" in values:
        category = "contains_U"
    elif "INVALID" in values:
        category = "contains_INVALID"
    else:
        category = "numeric_polarity" if {0, 2} <= set(values) else "numeric_adjacent"
    categories[category] += 1
    if category != "exact":
        nonexact.append([case, dim, values])
    if {0, 2} <= set(values):
        polarity_span.append([case, dim, values])
    for value in values[1:]:
        transitions[f"{values[0]}->{value}"] += 1
print("repeated inputs / dimension groups", len({c for c, _ in repeat}), len(repeat))
print("repeat categories", dict(categories))
print("nonexact", nonexact)
print("first-reference transitions", dict(transitions))
print("groups spanning 0 and 2", polarity_span)

audit = read("results/final-product-audit.json")
funnel = defaultdict(list)
gate_rejected, outcomes, insufficient = [], {}, {}
for course in audit["details"]:
    cid = course["sourceId"]
    events, teaching, formal = (course[k] for k in ("events", "teaching", "formal"))
    prepared = any(e["stage"] == "curriculum-accepted" for e in events) and any(
        e["stage"] == "preparation-stop" and e.get("state") == "complete" for e in events
    )
    ready = any(a["status"] == "ready" for t in teaching for a in t["preparationAttempts"])
    completed = any(t["status"] == "completed" for t in teaching)
    admitted = any(f["status"] == "completed" for f in formal)
    candidate = admitted or any(r["operation"] == "propose_formal_assessment" for r in course["rejectedCandidates"])
    stages = [True, prepared, ready, completed, bool(formal), candidate, admitted, course["supportedAssessmentEvidence"] > 0]
    assert all(not later or earlier for earlier, later in zip(stages, stages[1:]))
    assert len(formal) <= 1
    for name, reached in zip(("courses", "prepared", "lesson_ready", "teaching_practice_completed", "formal_attempted", "candidate", "admitted", "supported"), stages):
        if reached:
            funnel[name].append(cid)
    for f in formal:
        detail = f.get("error", {}).get("details", {})
        if detail.get("kind") == "objective_authority_semantic_support_invalid" and detail.get("boundary") == "formal_provider":
            gate_rejected.append(cid)
        if f["status"] == "completed":
            outcomes[cid] = f["result"]["result"]["evidenceStatus"]
            negative = f["negative"]["result"]["result"]
            insufficient[cid] = [negative["evidenceStatus"], negative["demonstrated"]]
print("funnel", {k: {"n": len(v), "of_all_courses": len(audit["details"]), "ids": v} for k, v in funnel.items()})
print("rejected before candidate generation", gate_rejected)
print("main evidence outcomes", outcomes)
print("insufficient branches", insufficient)
```
