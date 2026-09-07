# Tutor inside Study

Tutor opens beside the Lesson on desktop and in a bottom drawer on smaller
screens. Select a passage to draft a question about it, or use **问 Tutor** from
the current Lesson, Practice, or Repair. Opening a quotation does not send it.
Closing Tutor returns to the reading surface; a completed reply stays in the
session conversation. Enter sends a question, Shift+Enter adds a line, and IME
composition does not submit.

The server checks a selected passage against the current learner projection and
its exact Lesson execution version. Context includes presented teaching, visible
worked steps, the active question, prior submitted errors, and revealed Repair
teaching. Private answer keys and future Retest questions are excluded. Context
also carries accepted depth and focus, a bounded conversation window, and exact
source excerpts. The serialized input has a 96,000-byte UTF-8 ceiling; distant
teaching and older history are reduced before the selected passage or question.

Hy3 returns teaching prose and selected source keys. Local code resolves source
names and saves the exact cited excerpts with the turn, so a later Lesson cannot
rebind an old reply's citations. Supplementary examples and explanations are
identified separately in prose. Source membership proves the excerpt exists;
it does not prove every claim in an answer. Historical replies without saved
excerpts do not acquire citations from the current Lesson.

Conversation, request identity, cancellation and failure use the existing
StudySession stores and operation fences. A reply is rejected if its Lesson or
session changes during generation. Reload synchronizes an unfinished turn before
allowing a new question. Failed questions remain available to edit. Unsent drafts
and selected passages use optional, session-scoped browser storage; the server
conversation remains the durable record. Lesson commands use the current session
version after Tutor bookkeeping without changing Lesson progression rules.

Completed Tutor prose is also a conservative record of potentially seen teaching.
Repair generation receives recent relevant replies and checks new Retest prompts
against the full relevant transcript. Formal item exposure recognizes exact
prompts already contained in earlier Tutor replies. These checks do not prove
semantic novelty or detect every paraphrase. Saving a reply before a disconnect
can conservatively count it as potentially seen even if the learner did not read
it. No new mastery, Evidence, credit, Review, curriculum, or Repair state machine
is created, and Tutor never answers on the learner's behalf.
