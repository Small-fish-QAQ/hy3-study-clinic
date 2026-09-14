# Representative Saved Journeys

These examples were selected after content review to illustrate the product. They come from the single frozen run; all20 cases remain in the published metric. The source, teaching, first Formal task, learner response and evidence state are linked below. They are not a second benchmark or human learning evidence.

## J04 / 四分位数与四分位距

[Source](dataset/courses/J04.json) | [Teaching](runs/scored-01/cases/J04/lesson-1-prepared.json) | [Formal task](runs/scored-01/cases/J04/formal-1-before.json) | [Actual answer and grade](runs/scored-01/cases/J04/formal-1-answer.json) | [Terminal state](runs/scored-01/cases/J04/final.snapshot.json)

Task:

> 某次测验中，7名学生的得分已按从小到大排序如下（单位：分）：62, 68, 75, 80, 85, 90, 95。请严格按本课明确约定（先求整体中位数，奇数个去掉正中后分低高半组，再取各组中位数）计算Q1与Q3，写出中间过程与结果。

Actual learner answer:

> 排序数据：62, 68, 75, 80, 85, 90, 95（单位：分）。共7个，为奇数个，整体中位数为正中的第4个数80分。去掉80后，低半组为左侧62, 68, 75，高半组为右侧85, 90, 95。低半组有3个（奇数），其中位数为中间值68分，故Q1=68分；高半组有3个（奇数），其中位数为中间值90分，故Q3=90分。最终结果：Q1=68分，Q3=90分。

Review: Under the explicit convention remove median 80; low half 62/68/75 and high half 85/90/95 give Q1=68, Q3=90. Process and units correct; all required steps explicitly requested.

## J15 / 赊销收入、应收账款与现金

[Source](dataset/courses/J15.json) | [Teaching](runs/scored-01/cases/J15/lesson-1-prepared.json) | [Formal task](runs/scored-01/cases/J15/formal-1-before.json) | [Actual answer and grade](runs/scored-01/cases/J15/formal-1-answer.json) | [Terminal state](runs/scored-01/cases/J15/final.snapshot.json)

Task:

> 某服务企业采用本课简化的权责发生制模型：模型中没有税费、坏账、退款、利息或预收款；所有收入都来自已经完成的服务。期初应收账款为0。根据模型，收入按服务完成确认，收款不新增收入。应收账款滚动关系：期末应收=期初应收+本期新增赊销收入-本期收回的应收款。三月1日，企业完成500元服务并当场收款。三月10日，完成800元服务，约定四月付款。三月20日，收到上述800元欠款中的200元。请计算三月服务收入、现金流入与月末应收账款，并说明三月20日收款为何不新增服务收入。

Actual learner answer:

> 三月服务收入 = 500（3月1日当场完成收现）+ 800（3月10日完成赊销）= 1300元。现金流入 = 500（3月1日收现）+ 200（3月20日收回旧欠款）= 700元。月末应收账款 = 期初0 + 本期新增赊销收入800 - 本期收回应收款200 = 600元（3月1日当场收现不产生应收，3月10日赊销使应收增至800，3月20日收款减至600）。三月20日收款不新增服务收入的原因：对应的800元服务已在3月10日服务完成且客户产生付款义务时确认了收入，当时已记入应收账款；3月20日收到200元只是将原有债权的一部分变现为现金，属于收回前期形成的应收款，并未提供新的服务。若再次计入收入会重复计算同一笔服务收入。记录收款应指向原有债权而非仅看现金流入。

Review: March revenue 1300, cash received 700, closing receivable 600. The 200 collection converts an existing debt to cash without new service revenue. Correct event classification and no duplicate revenue.

## J17 / Joining related tables without losing unmatched rows

[Source](dataset/courses/J17.json) | [Teaching](runs/scored-01/cases/J17/lesson-1-prepared.json) | [Formal task](runs/scored-01/cases/J17/formal-1-before.json) | [Actual answer and grade](runs/scored-01/cases/J17/formal-1-answer.json) | [Terminal state](runs/scored-01/cases/J17/final.snapshot.json)

Task:

> 现有左表 Authors(author_id, name) 包含行 (1, 'Lee'), (2, 'Mo')；右表 Books(book_id, author_id, title) 包含行 (101,1,'A'), (102,1,'B'), (103,2,'C')。关系连接根据显式条件（如 author_id 相等）组合两表行，左表每一行独立检查右表所有行，键相等则产生配对行，且此机制不自动汇总。请解释关系连接基于显式条件组合行的机制，并基于上述数据说明为什么作者 'Lee' 在连接结果中会出现多次（即一个左表行可以匹配多个右表行）。

Actual learner answer:

> 关系连接机制：根据显式条件（如 Authors.author_id = Books.author_id），对左表每一行独立扫描右表所有行；只要右表某行的连接键与左表行相等，就产生一个由两行组合而成的结果行。该过程按配对逐一发射，不自动汇总或合并多个匹配。
>
> 基于给定数据：Authors 有 (1,'Lee') 和 (2,'Mo')；Books 有 (101,1,'A')、(102,1,'B')、(103,2,'C')。以 author_id 相等为条件，处理左行 Lee (author_id=1) 时，检查 Books 全部行：book_id=101 的 author_id=1，相等，生成组合行 (Lee,101,'A')；book_id=102 的 author_id=1，相等，生成组合行 (Lee,102,'B')；book_id=103 的 author_id=2，不相等，无配对。因此 Lee 这一个左表行因为右表中存在两行满足键相等，被配对两次，在连接结果中出现两次（例如内连接结果包含 (Lee,101,'A'), (Lee,102,'B'), (Mo,103,'C')）。这正说明一个左表行可以匹配多个右表行，且连接机制不会把这两行合并为单行。

Review: Lee author_id=1 matches books 101 and 102, producing two combined rows; Mo matches 103. Correct multiplicity explanation on explicit data. Mechanism is scaffolded but identifying actual matching pairs is still required; unmatched-row behavior is not assessed at this first checkpoint.

## Current UI on Saved Evidence

[![Current Candidate 23 UI displaying the saved J04 answer and required criteria](../../docs/media/showcase/formal-desktop.webp)](../../docs/media/showcase/formal-desktop.webp)

Current UI, displaying a copy of the actual J04 Hy3 database with Fake provider enabled only for display. No new generation or grading and no changes to the scored database. Route3/5, teaching2/2 and objectives with Formal evidence1/3 remain distinct. [Mobile capture](../../docs/media/showcase/formal-mobile.webp) and [media provenance](../../docs/media/showcase/manifest.json).
