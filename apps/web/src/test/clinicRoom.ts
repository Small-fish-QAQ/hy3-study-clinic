import type { Classroom } from '../clinicApi.js';

export function clinicRoom(): Classroom {
  const session: Classroom['session'] = {
    id: 'session',
    workspaceId: 'w',
    curriculumId: 'p',
    lessonVersionId: 'lv',
    purpose: 'learning',
    originSessionId: null,
    status: 'active',
    createdAt: '2026-10-12T00:00:00.000Z',
    completedAt: null,
  };
  const span = { revisionId: 'r', blockId: 'b', start: 0, end: 7 };
  return {
    session,
    sessions: [session],
    turns: [],
    sourceQuotes: [{ span, title: '物理讲义', quote: '速度包含方向。' }],
    content: {
      id: 'lv',
      title: '第一课正文',
      lessonId: 'l',
      workspaceId: 'w',
      curriculumId: 'p',
      semanticKey: 'key',
      version: 1,
      sourceScopeHash: 'hash',
      policyVersion: 'study-clinic-v2.1',
      segments: [
        {
          id: 'segment',
          kind: 'explanation',
          origin: 'textbook',
          text: '速度包含方向。',
          sourceRefs: [span],
          uncertaintyCodes: [],
        },
      ],
      teachingCoverage: [
        {
          knowledgeId: 'k',
          objectiveIds: ['o'],
          segmentId: 'segment',
          teachingQuote: '速度包含方向。',
        },
      ],
      deliveryCheck: {
        policyVersion: 'study-clinic-v2.1',
        requiredKnowledgeHash: 'k-hash',
        localChecksHash: 'local-hash',
        targetedReceipts: [],
        anchors: [
          {
            knowledgeId: 'k',
            objectiveIds: ['o'],
            segmentId: 'segment',
            start: 0,
            end: 7,
            segmentHash: 'segment-hash',
          },
        ],
      },
    },
  };
}
