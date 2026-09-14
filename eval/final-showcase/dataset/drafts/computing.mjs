export default [
  {
    id: 'J17', title: 'Joining related tables without losing unmatched rows', domain: 'computing', language: 'en', depth: 'working_fluency',
    goals: ['Explain matching rows using an explicit join condition', 'Derive INNER JOIN and LEFT JOIN results including multiple matches', 'Choose a join that preserves the requested population and explain null placeholders'],
    freshness: 'Relational join matching and row multiplicity, distinct from prior SQL transaction rollback and spreadsheet-reference movement.',
    text: `A relational join combines rows from two tables according to a stated condition. In this lesson, Customers has columns customer_id and name. Its rows are (1, Ada), (2, Ben), and (3, Cleo). Orders has columns order_id, customer_id, and amount. Its rows are (71, 1, 20), (72, 1, 35), and (73, 3, 10). Customer identifiers uniquely identify customers; one customer can have several orders. All identifiers used for matching are non-null.

An INNER JOIN on Customers.customer_id = Orders.customer_id returns one combined row for each matching pair. Selecting name, order_id, and amount gives (Ada, 71, 20), (Ada, 72, 35), and (Cleo, 73, 10). Ben has no matching order, so Ben does not appear. Ada appears twice because two separate order rows match Ada's customer row. A join does not automatically summarize these into a single row or add their amounts.

A LEFT JOIN preserves every row from its left table. It returns the same matching pairs where matches exist. For a left row with no match, it returns one row with null placeholders for the right-table columns. With Customers on the left, the result additionally contains (Ben, null, null). Null here means no matching order value was supplied. It does not mean Ben placed an order numbered zero with amount zero. The three matching rows are still present, so this LEFT JOIN has four result rows.

The left side matters. If the task asks for all customers, including those without orders, Customers should be the preserved side. If the task asks only for customers' actual orders, the INNER JOIN answers that request. Choosing LEFT JOIN does not imply one row per customer: multiple matches still produce multiple result rows. To obtain totals per customer would require a separate aggregation step, outside this lesson's row-by-row join task.

Consider a new order (74, 2, 8). After adding it, Ben has one match. The customer-preserving LEFT JOIN now includes (Ben, 74, 8), with no null placeholder row for Ben. Both joins have four rows for these tables. Equality of row counts in this example does not make INNER and LEFT JOIN interchangeable for every dataset; their behavior differs whenever a preserved customer has no match.

To work out a result, take each customer row, find every order with the same identifier, and emit each matching pair. For INNER JOIN, emit nothing for an unmatched customer. For LEFT JOIN, emit exactly one placeholder row for that unmatched customer. Check the matching key and the requested output columns. Result row order is not guaranteed without an explicit ordering instruction, so any ordering of the same result rows is valid here. No filter, aggregation, or duplicate-removal step is implied.`,
  },
  {
    id: 'J18', title: 'Stable sorting by primary and secondary keys', domain: 'computing', language: 'en', depth: 'working_fluency',
    goals: ['Compare records using a primary key and a tie-breaking secondary key', 'Explain stability for records with equal specified keys', 'Trace stable multi-pass sorting and choose the correct pass order'],
    freshness: 'Lexicographic record ordering and stable multi-pass sorting, not binary search, Pareto dominance or cache replacement.',
    text: `Sorting records requires an explicit comparison rule. Suppose each task has a name, a numeric priority, and a numeric duration. We want ascending priority, then ascending duration within equal priority. The primary key is priority. Compare duration only if priorities are equal. Smaller priority numbers come first in this lesson; the word priority alone does not establish a direction.

The input sequence is A(priority 2, duration 5), B(1, 9), C(2, 3), D(1, 4), E(2, 3). Comparing primary keys first puts B and D before all priority-2 tasks, even though B takes longer than C. Within priority 1, D comes before B because 4 is less than 9. Within priority 2, C and E come before A because 3 is less than 5. This is not the same as sorting all tasks by duration alone.

A stable sort preserves the original relative order of records that compare equal on all specified keys. C and E have identical priority and duration, and C originally appears before E. A stable sort by the requested pair therefore returns D, B, C, E, A. Stability does not stop a record from moving past a record with a different key. It only preserves order within a group whose comparison keys tie.

One way to obtain the same ordering is to use two stable passes. First sort by the secondary key, duration. This produces C, E, D, A, B: durations are 3, 3, 4, 5, 9, and the tied C/E order is preserved. Then stably sort that result by the primary key, priority. Priority 1 becomes D, B; priority 2 becomes C, E, A. The second pass preserves the duration order already established inside each equal-priority group.

The pass order is important: least significant key first, most significant key last, with each pass stable. If we first sort stably by priority and then stably by duration, the final result is ordered primarily by duration, because the final pass moves records across priority groups. In the example this wrong pass order yields C, E, D, A, B, which puts priority-2 tasks before priority-1 tasks. Merely using stable algorithms does not correct the wrong key precedence.

For a descending secondary key, larger duration comes first within equal priority, while primary priority can remain ascending. Each key has its own direction. If a task specifies only priority, stability preserves the input order within each priority group; it does not invent duration as an additional tie-breaker. Always state the exact keys, directions, and whether input order resolves complete ties. In this lesson keys are ordinary finite numbers and every record contains them, so no missing-value or locale rule is needed. The procedure can be checked by examining every adjacent pair in the final sequence.`,
  },
  {
    id: 'J19', title: 'FIFO queues and service order', domain: 'computing', language: 'en', depth: 'working_fluency',
    goals: ['Explain enqueue, dequeue, and peek for a FIFO queue', 'Trace queue contents and returned values across a complete operation sequence', 'Relate queue order to a single-server service timeline under explicit assumptions'],
    freshness: 'FIFO queue operations and non-preemptive service timelines, distinct from postfix LIFO evaluation, recency caches and dependency-network scheduling.',
    text: `A queue stores items in first-in, first-out order, abbreviated FIFO. Enqueue adds an item at the back. Dequeue removes and returns the item at the front. Peek returns the front item without removing it. We write queue contents from front to back in square brackets. The queue [A, B, C] will return A on the next dequeue, not C. The order of insertion determines this behavior, not alphabetical order.

Start with an empty queue. Enqueue A, enqueue B, and enqueue C produce [A, B, C]. A dequeue returns A and leaves [B, C]. Enqueue D then gives [B, C, D]. Peek returns B and leaves the same three items. A further dequeue returns B and leaves [C, D]. Distinguish an operation's returned value from the collection remaining afterward; they answer different questions.

In this lesson items have distinct identifiers and the queue has enough capacity for every stated operation. If dequeue or peek is requested on an empty queue, the operation reports empty and leaves the queue unchanged. It does not invent an item or silently reuse the most recently removed one. All worked sequences specify the initial queue and every operation, so there is no hidden earlier state.

A FIFO waiting queue can organize a single server. Assume one task is served at a time, tasks run to completion without interruption, and service begins immediately whenever the server is free and a task is waiting. Arrivals join the back of the waiting queue. A task currently being served is no longer in the waiting queue. When several arrivals share a time, use their stated input order. Durations and arrival times use the same time unit.

For example A arrives at time 0 and needs 4 units of service. B arrives at time 1 and needs 2; C arrives at time 2 and needs 1. A starts at 0 and finishes at 4. B waits from 1 to 4, starts at 4, and finishes at 6. C starts at 6 and finishes at 7. Their waiting times before service are 0, 3, and 4. C is shorter than B, but FIFO does not move it ahead of an earlier arrival. At time 3, A is in service and the waiting queue is [B, C].

For tasks in FIFO order, start time is the larger of arrival time and the previous task's finish time; finish time equals start plus service duration. This also handles idle time: a new task arriving at 10 after the server became free at 7 starts at 10, not at 7. Waiting time is start minus arrival, whereas total time in the system is finish minus arrival. State these quantities separately. The lesson's conclusion is service order under a specified policy, not a claim that FIFO minimizes every possible performance measure.`,
  },
  {
    id: 'J20', title: 'Function arguments, local names, and returned values', domain: 'computing', language: 'en', depth: 'pass_oriented',
    goals: ['Distinguish a function parameter from the argument supplied in a call', 'Trace local calculations and the value returned to the caller', 'Compose two pure function calls and explain why the caller input remains unchanged'],
    freshness: 'Pure value-returning functions and nested call evaluation, distinct from mutable object aliasing, array bounds and slicing.',
    text: `A function is a named procedure that can receive values and return a result. In this lesson all values are numbers, passed by value. Each call creates its own local parameter names. Assigning to a local name changes that call's local value; it does not change a numeric variable in the caller. The functions shown have no files, global state, or other side effects.

Consider the function adjust(x): first set x = x + 2, then return x * 3. The name x in the definition is a parameter. In adjust(4), the supplied number 4 is an argument. At the start of the call local x is 4; after the assignment it is 6; the returned value is 18. The call does not return 6 just because 6 was the last value assigned to x: the return expression multiplies it by 3.

Now let the caller have n = 4 and execute result = adjust(n). The value of n is supplied to the call, so result becomes 18. After the call n is still 4. The local reassignment of x does not update n. If the caller instead writes n = adjust(n), the returned 18 is explicitly assigned to n by the caller, so n becomes 18. These two caller statements have different effects even though the function body is identical.

Define another function half(y): return y / 2. To evaluate half(adjust(4)), first evaluate the inner call adjust(4), obtaining 18, then pass 18 to half, obtaining 9. Reversing the nesting gives adjust(half(4)): half(4) is 2, then adjust(2) returns (2 + 2) * 3 = 12. Function composition generally depends on order. The outer function receives the value returned by the inner function, not the inner function's parameter name.

A return statement ends the current function call and sends its value to the caller. For example choose(z) is defined as: if z is less than 0, return 0; otherwise return z + 1. Calling choose(-2) returns 0 and does not also add 1 afterward. Calling choose(5) returns 6. Calling choose(0) follows the otherwise branch because 0 is not less than 0, and returns 1. The conditions and operations in this definition determine each result.

These are pure functions: the same numeric argument gives the same returned value, and the call changes no external state. Two calls to adjust(4) each return 18; local x does not accumulate across calls. To explain a trace, record the incoming argument, each local update, the return expression, and any explicit assignment in the caller. Keep returned results distinct from caller variables and local names. This lesson uses exact arithmetic with the stated numbers, so implementation-specific integer overflow and floating-point rounding are outside its model.`,
  },
];
