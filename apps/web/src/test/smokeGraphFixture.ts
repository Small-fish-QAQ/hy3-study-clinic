/**
 * Persisted smoke-graph topology (the 认知科学冒烟测试 workspace created by
 * npm run demo:graph with the fake provider): 7 concepts, 11 validated
 * edges. Used as the crossing-minimization regression fixture — the
 * deterministic layout + route-plan pipeline over this graph must stay
 * free of node-edge intersections and last-mile shared-node crossings.
 */

export interface SmokeGraphConcept {
  id: string;
  name: string;
}

export interface SmokeGraphEdge {
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
  relation: string;
}

export const smokeGraphConcepts: SmokeGraphConcept[] = [
  { id: 'con_afe43f07-2486-476c-ad32-c522ffaeee80', name: '长时记忆' },
  { id: 'con_bbb3c9b7-190b-438b-9a0d-74204648be84', name: '工作记忆' },
  { id: 'con_c1b0a0b6-2e0e-4873-b2d2-a928be7ed775', name: '检索练习' },
  { id: 'con_40aa645e-3c9d-42cc-9cc1-e828b0fbcdc6', name: 'Spacedrepetition' },
  { id: 'con_7ed8f1eb-86b6-4c23-b535-4dd971938c79', name: 'Workingmemoryhas' },
  { id: 'con_44595db4-13e6-4162-b415-1574d56ca35b', name: '间隔重复' },
  { id: 'con_9657a8de-d1a5-4038-ab79-63d107bfe70b', name: '记忆的科学' },
];

export const smokeGraphEdges: SmokeGraphEdge[] = [
  {
    id: 'ge_0c45a649-dc54-4878-b1c0-3879af7f84ab',
    sourceConceptId: 'con_44595db4-13e6-4162-b415-1574d56ca35b',
    targetConceptId: 'con_afe43f07-2486-476c-ad32-c522ffaeee80',
    relation: 'part_of',
  },
  {
    id: 'ge_4d30e72e-4bf0-437a-a631-bf7b43347d7c',
    sourceConceptId: 'con_40aa645e-3c9d-42cc-9cc1-e828b0fbcdc6',
    targetConceptId: 'con_7ed8f1eb-86b6-4c23-b535-4dd971938c79',
    relation: 'prerequisite',
  },
  {
    id: 'ge_5123dd37-cfa7-4614-ac0b-649b2d5b6076',
    sourceConceptId: 'con_7ed8f1eb-86b6-4c23-b535-4dd971938c79',
    targetConceptId: 'con_44595db4-13e6-4162-b415-1574d56ca35b',
    relation: 'prerequisite',
  },
  {
    id: 'ge_750d6473-15c1-4ad4-843b-47bc075dd7c0',
    sourceConceptId: 'con_c1b0a0b6-2e0e-4873-b2d2-a928be7ed775',
    targetConceptId: 'con_40aa645e-3c9d-42cc-9cc1-e828b0fbcdc6',
    relation: 'prerequisite',
  },
  {
    id: 'ge_a289a584-0fa9-4897-9907-950e2df41516',
    sourceConceptId: 'con_bbb3c9b7-190b-438b-9a0d-74204648be84',
    targetConceptId: 'con_c1b0a0b6-2e0e-4873-b2d2-a928be7ed775',
    relation: 'prerequisite',
  },
  {
    id: 'ge_b9bb723b-4803-458a-8a19-80f0117b7319',
    sourceConceptId: 'con_9657a8de-d1a5-4038-ab79-63d107bfe70b',
    targetConceptId: 'con_bbb3c9b7-190b-438b-9a0d-74204648be84',
    relation: 'example_of',
  },
  {
    id: 'ge_bbed35ff-9183-4871-a756-aac75006b427',
    sourceConceptId: 'con_afe43f07-2486-476c-ad32-c522ffaeee80',
    targetConceptId: 'con_40aa645e-3c9d-42cc-9cc1-e828b0fbcdc6',
    relation: 'causes',
  },
  {
    id: 'ge_c79125fb-84a3-4a66-8580-971478951896',
    sourceConceptId: 'con_afe43f07-2486-476c-ad32-c522ffaeee80',
    targetConceptId: 'con_bbb3c9b7-190b-438b-9a0d-74204648be84',
    relation: 'prerequisite',
  },
  {
    id: 'ge_cca57865-f52d-49d3-bf06-0f1fe2f83db7',
    sourceConceptId: 'con_44595db4-13e6-4162-b415-1574d56ca35b',
    targetConceptId: 'con_9657a8de-d1a5-4038-ab79-63d107bfe70b',
    relation: 'prerequisite',
  },
  {
    id: 'ge_cca8d4d2-a9d2-411e-a185-aa0f2f8beb31',
    sourceConceptId: 'con_c1b0a0b6-2e0e-4873-b2d2-a928be7ed775',
    targetConceptId: 'con_afe43f07-2486-476c-ad32-c522ffaeee80',
    relation: 'part_of',
  },
  {
    id: 'ge_e0951d90-7682-479b-be62-e05647a27963',
    sourceConceptId: 'con_bbb3c9b7-190b-438b-9a0d-74204648be84',
    targetConceptId: 'con_c1b0a0b6-2e0e-4873-b2d2-a928be7ed775',
    relation: 'contrasts_with',
  },
];
