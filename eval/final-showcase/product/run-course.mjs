import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openRuntime, read, CAMPAIGN, sha } from "./runtime.mjs";
import { studyView, learnerTask } from "./learner.mjs";

// Sources are registered before generation. An isolated Hy3 learner answers the
// visible tasks; this is synthetic delivery evidence, not human learning effects.
export async function runCourse(
  source,
  {
    runRoot,
    providerName = "hy3",
    resume = false,
    maxTeaching = 3,
    maxFormal = 1,
    failPractice = false,
    tutor = true,
    stopAfterPreparation = false,
  } = {},
) {
  const caseId = source.id || source.sourceId;
  const h = await openRuntime({
    runRoot,
    caseId,
    providerName,
    fresh: !resume,
  });
  const { services: s, repos } = h;
  let state = resume
    ? read(path.join(h.caseRoot, "state.json"))
    : {
        sourceId: caseId,
        sourceSha256: sha(source),
        events: [],
        teaching: [],
        formal: [],
        tutor: [],
      };
  const completedStudy = [];
  const respond = async (task, current) => {
    const packet = {source:source.content || source.text, visibleStudy:[...completedStudy,...(current?studyView(current):[])],
      task:learnerTask(task)};
    const result=await h.answerLearner(packet);
    h.append('learner-responses.jsonl',{packet, result});
    return result.answer;
  };
  let seq = state.commandSequence || 0;
  const command = (tag) => {
    const id = caseId + "-" + tag + "-" + ++seq;
    state.commandSequence = seq;
    return {
      commandId: id,
      idempotencyKey: id,
      workspaceId: state.workspaceId,
      actor: "learner",
    };
  };
  const persist = () => h.write("state.json", state);
  const event = (stage, data) => {
    state.events.push({ at: new Date().toISOString(), stage, ...data });
    persist();
  };
  const fail = (stage, e) => {
    event(stage, { status: "failed", error: h.safeError(e) });
    return false;
  };
  try {
    if (!resume) {
      h.write("source.json", source);
      const ws = s.workspaces.create({ name: source.title });
      state.workspaceId = ws.id;
      persist();
      const doc = await s.workspaces.addDocument(ws.id, {
        kind: "text",
        title: source.title,
        content: source.content || source.text,
        filename: caseId + ".txt",
      });
      state.materialId = doc.material.id;
      const current = repos.materialRoles.getCurrent(doc.material.id);
      const proposal = s.materialRoles.propose({
        command: command("role-propose"),
        materialId: doc.material.id,
        role: "course_material",
        expectedCurrentAssignmentId: current?.id ?? null,
      });
      const role = s.materialRoles.confirm({
        command: command("role-confirm"),
        assignmentId: proposal.id,
        expectedVersion: proposal.version,
      });
      const intent =
        source.target ||
        source.learnerIntent ||
        source.intent ||
        source.goals?.join("；");
      if (!intent)
        throw Error("Registered source requires target/learnerIntent/intent");
      const fields = {
        intent,
        targetOutcome: {
          description: intent,
          targetScore: null,
          credential: null,
        },
        desiredDepth: source.depth || source.intendedDepth || "working_fluency",
        focusRequest: null,
        courseScope: {
          subjectBoundaries: [source.title],
          materials: [
            {
              materialId: doc.material.id,
              materialRoleAssignmentId: role.id,
              materialRoleAssignmentVersion: role.version,
              role: "course_material",
              disposition: "included",
            },
          ],
          includedTopics: [],
          excludedTopics: [],
        },
        learnerSelfReport: {
          priorStudy: null,
          confidence: null,
          strengths: [],
          knownGaps: [],
        },
        examContext: null,
        riskTolerance: {
          description: null,
          allowExplicitDeferral: true,
          maximumUnresolvedPriority: null,
        },
      };
      let contract = s.learningContracts.createDraft({
        command: command("contract-create"),
        fields,
        predecessorContractId: null,
        expectedActiveContractId: null,
      }).contract;
      for (const transition of ["propose", "confirm"])
        contract = s.learningContracts.transition({
          command: command("contract-" + transition),
          contractId: contract.id,
          expectedVersion: contract.version,
          transition,
        }).contract;
      state.contractId = contract.id;
      persist();
    }
    for (let i = 0; i < 8; i++) {
      const p = s.coursePreparation.get(state.workspaceId);
      h.write("preparation-" + i + ".json", p);
      const overview = s.courseOverview.get(state.workspaceId);
      if (overview.capabilities?.canAcceptCurriculum) {
        const curriculum = repos.curricula
          .list(state.workspaceId)
          .find((c) => c.status === "proposed" && c.validation.valid);
        if (curriculum) {
          s.curriculum.accept({
            command: command("accept-curriculum"),
            curriculumId: curriculum.id,
            expectedVersion: curriculum.version,
            expectedContractId: curriculum.contractVersionId,
            expectedExecutionSourceManifestFingerprint:
              curriculum.executionSourceManifest.fingerprint,
            acceptanceBasis: "learner_review",
          });
          event("curriculum-accepted", { curriculumId: curriculum.id });
          continue;
        }
      }
      // Accepted status is explicitly requested through the ordinary learner API.
      const proposed = overview.proposedCurriculum;
      if (
        proposed &&
        proposed.status === "proposed" &&
        proposed.validation?.valid
      ) {
        s.curriculum.accept({
          command: command("accept-curriculum"),
          curriculumId: proposed.id,
          expectedVersion: proposed.version,
          expectedContractId: proposed.contractVersionId,
          expectedExecutionSourceManifestFingerprint:
            proposed.executionSourceManifest.fingerprint,
          acceptanceBasis: "learner_review",
        });
        event("curriculum-accepted", { curriculumId: proposed.id });
        continue;
      }
      if (!p.canResume || !p.machineAction || !p.operationKey) {
        event("preparation-stop", { state: p.state, blocker: p.blocker });
        break;
      }
      await s.coursePreparation.run({
        command: {
          ...command("prepare"),
          commandId: p.operationKey,
          idempotencyKey: p.operationKey,
        },
        expectedRevision: p.revision,
      });
      event("preparation-step", {
        state: p.state,
        machineAction: p.machineAction,
      });
    }
    h.snapshot(state.workspaceId, "prepared");
    if (stopAfterPreparation) {
      state.status = "prepared";
      persist();
      return state;
    }
    for (let routeStep = 0; routeStep < 20; routeStep++) {
      const overview = s.courseOverview.get(state.workspaceId);
      h.write("overview-" + routeStep + ".json", overview);
      const next = overview.nextAction;
      if (!next) {
        event("route-stop", { reason: "no current executable next action" });
        break;
      }
      const item = next.item;
      const agenda = repos.sessionAgendas.get(next.agendaId);
      if (item.kind === "learning_unit_teaching") {
        if (state.teaching.length >= maxTeaching) {
          event("route-stop", {
            reason: "prespecified teaching ceiling",
            agendaItemId: item.id,
          });
          break;
        }
        const record = {
          agendaItemId: item.id,
          learningUnitId: item.learningUnitId,
          status: "started",
        };
        state.teaching.push(record);
        persist();
        try {
          const execution = repos.courseExecution.get(state.workspaceId);
          const session = s.studySessions.start(state.workspaceId, {
            contractVersionId: agenda.contractVersionId,
            curriculumVersionId: agenda.curriculumVersionId,
            studyPlanVersionId: agenda.studyPlanVersionId,
            sessionAgendaId: agenda.id,
            expectedCourseExecutionVersion: execution.version,
          }).session;
          record.sessionId = session.id;
          let current = await s.lessonExecution.ensure(
            state.workspaceId,
            session.id,
            {
              command: command("lesson-prepare"),
              expectedSessionVersion: session.version,
              expectedAgendaVersion: agenda.version,
              expectedAgendaItemId: item.id,
            },
          );
          const saveSurface = (label) =>
            h.write(
              "lesson-" + state.teaching.length + "-" + label + ".json",
              current,
            );
          saveSurface("prepared");
          record.preparationAttempts = [{ attempt: 1, status: current.status }];
          if (
            ["retry_available", "practice_retry_available"].includes(current.status) &&
            current.allowedActions.includes("retry_preparation")
          ) {
            event("lesson-user-retry", {
              agendaItemId: item.id,
              initialStatus: current.status,
              policy: "one-explicit-retry-when-offered",
            });
            current = await s.lessonExecution.ensure(
              state.workspaceId,
              session.id,
              {
                command: command("lesson-explicit-retry"),
                expectedSessionVersion: current.session.version,
                expectedAgendaVersion: current.agenda.version,
                expectedAgendaItemId: item.id,
              },
            );
            record.preparationAttempts.push({
              attempt: 2,
              status: current.status,
            });
            saveSurface("after-explicit-retry");
          }
          const act = async (action) => {
            h.append("learner-actions.jsonl", {
              sessionId: session.id,
              agendaItemId: item.id,
              preAnswerSurface: current,
              action,
              answerPolicy: "independent-visible-study-response-v1",
            });
            current = await s.lessonExecution.command(
              state.workspaceId,
              session.id,
              {
                command: command(action.kind),
                expectedSessionVersion: current.session.version,
                expectedAgendaVersion: current.agenda.version,
                expectedAgendaItemId: item.id,
                expectedLessonStateVersion: current.progress.stateVersion,
                action,
              },
            );
          };
          if (current.status !== "ready")
            throw Error(
              "Lesson unavailable: " + current.status + " " + current.message,
            );
          if (current.allowedActions.includes("start_lesson"))
            await act({ kind: "start_lesson" });
          if (tutor && state.tutor.length === 0) {
            try {
              const turn = await s.studySessions.submitTurn(
                state.workspaceId,
                session.id,
                {
                  commandId: command("tutor").commandId,
                  expectedSessionVersion: current.session.version,
                  content:
                    source.tutorQuestion ||
                    "请针对当前内容，用一个与资料不同但容易理解的例子解释关键关系，并说明例子的适用边界。",
                },
              );
              state.tutor.push({
                status: "completed",
                sessionId: session.id,
                turnId: turn.turn.id,
              });
              h.write("tutor.json", turn);
              current = s.lessonExecution.get(state.workspaceId, session.id);
            } catch (e) {
              state.tutor.push({ status: "failed", error: h.safeError(e) });
              event("tutor", { status: "failed", error: h.safeError(e) });
              current = s.lessonExecution.get(state.workspaceId, session.id);
            }
          }
          for (let step = 0; step < 100; step++) {
            if (
              current.practice?.status === "completed" ||
              (current.progress?.presentationCompletedAt && !current.practice)
            )
              break;
            const allowed = current.allowedActions;
            const index = current.progress.currentSegmentIndex;
            if (allowed.includes("respond_to_worked_interaction")) {
              const shown =
                current.lesson.segments[index].workedProcess.interaction;
              const phase =
                shown.stage === "scaffold"
                  ? "scaffold"
                  : shown.stage === "transfer"
                    ? "transfer"
                    : "guided";
              await act({
                kind: "respond_to_worked_interaction",
                segmentIndex: index,
                phase,
                response: await respond(phase === 'guided' ? shown.activity : shown[phase],current),
              });
            } else if (allowed.includes("respond_to_informal_check")) {
              const shown = current.currentInformalCheck || current.lesson.segments[index].informalCheck;
              await act({
                kind: "respond_to_informal_check",
                segmentIndex: index,
                response: await respond(shown,current),
              });
            } else if (allowed.includes("complete_presentation")) {
              await act({ kind: "complete_presentation" });
              saveSurface("presentation-complete");
            } else if (allowed.includes("prepare_practice_repair")) {
              await act({
                kind: "prepare_practice_repair",
                learnerNote:
                  source.repairNote ||
                  "请根据我刚才选择的答案，解释关键错误，并给我新的检验机会。",
              });
              record.repairGenerated = true;
              saveSurface("repair");
            } else if (allowed.includes("start_practice_retest"))
              await act({ kind: "start_practice_retest" });
            else if (allowed.includes("submit_practice_retest")) {
              const recovery = current.practice.recovery;
              const key = await respond(recovery.retest,current);
              await act({
                kind: "submit_practice_retest",
                index: recovery.retest.index,
                optionId: key,
              });
              record.retestAnswers = (record.retestAnswers || 0) + 1;
            } else if (allowed.includes("submit_practice_response")) {
              const q = current.practice.item;
              if(failPractice) throw Error('Deliberate mainline failure injection is disabled');
              const optionId = await respond(q,current);
              await act({
                kind: "submit_practice_response",
                itemIndex: q.index,
                optionId,
              });
            } else if (allowed.includes("move_to_next_segment"))
              await act({ kind: "move_to_segment", segmentIndex: index + 1 });
            else
              throw Error("No supported learning action: " + allowed.join(","));
          }
          saveSurface("complete");
          completedStudy.push(...studyView(current));
          record.status =
            current.practice?.status === "completed" ||
            (current.progress.presentationCompletedAt && !current.practice)
              ? "completed"
              : "bounded_incomplete";
          record.practiceItems = current.practice?.itemCount || 0;
          h.snapshot(
            state.workspaceId,
            "after-teaching-" + state.teaching.length,
          );
          persist();
          if (record.status !== "completed") break;
        } catch (e) {
          record.status = "failed";
          record.error = h.safeError(e);
          fail("teaching", e);
          break;
        }
      } else if (
        [
          "formal_checkpoint",
          "synthesis",
          "due_review",
          "targeted_repair",
        ].includes(item.kind)
      ) {
        if (state.formal.length >= maxFormal) {
          event("route-stop", {
            reason: "prespecified Formal ceiling",
            agendaItemId: item.id,
          });
          break;
        }
        const record = {
          agendaItemId: item.id,
          objectiveIds: item.objectiveIds || [],
          status: "started",
        };
        state.formal.push(record);
        persist();
        try {
          const launched = await s.courseActionLaunch.launch({
            command: command("formal-launch"),
            agendaId: agenda.id,
            expectedAgendaVersion: agenda.version,
            agendaItemId: item.id,
            expectedContractId: agenda.contractVersionId,
            expectedStudyPlanId: agenda.studyPlanVersionId,
            expectedExecutionSourceManifestFingerprint:
              agenda.executionSourceManifestFingerprint,
          });
          h.write("formal-" + state.formal.length + "-launch.json", launched);
          if (
            launched.kind !== "assessment" ||
            !launched.formalAssessmentVersionId
          ) {
            record.status = "blocked";
            record.reason = launched.reason || launched.kind;
            persist();
            break;
          }
          const learner = s.learnerAssessments.start(
            launched.formalAssessmentVersionId,
            state.workspaceId,
          );
          const version = repos.formalAssessments.getVersion(
            learner.assessmentVersionId,
          );
          h.write("formal-" + state.formal.length + "-version.json", version);
          h.write("formal-" + state.formal.length + "-before.json", learner);
          // Prespecified controls fork the same genuine pre-answer database.
          record.controls=[];
          for(const control of source.additionalAnswerControls || []) {
            const controlId=caseId+'-'+control.name+'-'+state.formal.length;
            const controlPath=path.join(h.runRoot,'data',controlId+'.sqlite');
            if(fs.existsSync(controlPath))throw Error('Control branch already exists');
            await h.db.backup(controlPath);
            const branch=await openRuntime({runRoot:h.runRoot,caseId:controlId,providerName,fresh:false,databasePath:controlPath});
            try {
              const answers=Object.fromEntries(learner.items.map(q=>[q.itemId,control.answer]));
              const submitted=await branch.services.learnerAssessments.submit(learner.attempt.id,answers);
              branch.write('answer.json',{answerPolicy:'preregistered-'+control.name,answers,result:submitted});
              branch.snapshot(state.workspaceId,'after-control');
              record.controls.push({name:control.name,caseId:controlId,result:submitted});
            } catch(e) {record.controls.push({name:control.name,caseId:controlId,error:branch.safeError(e)});branch.snapshot(state.workspaceId,'after-control');}
            finally {await branch.close();}
          }
          const answers = {};
          for (const q of learner.items) answers[q.itemId]=await respond({prompt:q.prompt});
          const policy = 'independent-visible-study-response-v1; no-author-key-rubric-or-review';
          const result = await s.learnerAssessments.submit(
            learner.attempt.id,
            answers,
          );
          h.write("formal-" + state.formal.length + "-answer.json", {
            answerPolicy: policy,
            answers,
            result,
          });
          record.result = result;
          record.status = "completed";
          const before = h.snapshot(
            state.workspaceId,
            "before-replay-" + state.formal.length,
          );
          const countBefore = h.counts();
          const replay = await s.learnerAssessments.submit(
            learner.attempt.id,
            answers,
          );
          const after = h.snapshot(
            state.workspaceId,
            "after-replay-" + state.formal.length,
          );
          const changedTables = Object.keys(before.rows).filter(
            (t) => sha(before.rows[t]) !== sha(after.rows[t]),
          );
          record.replay = {
            identicalResult: sha(result) === sha(replay),
            changedTables,
            newPhysicalCalls: h.counts().physical - countBefore.physical,
          };
          h.write(
            "formal-" + state.formal.length + "-replay.json",
            record.replay,
          );
          persist();
          event('journey-ended',{reason:'prespecified first Formal submission completed'});
          break;
        } catch (e) {
          record.status = "failed";
          record.error = h.safeError(e);
          fail("formal", e);
          break;
        }
      } else {
        event("route-stop", {
          reason: "unsupported natural route item",
          kind: item.kind,
          agendaItemId: item.id,
        });
        break;
      }
    }
    state.status = "completed_with_observed_boundaries";
  } catch (e) {
    state.status = "failed";
    fail("course", e);
  } finally {
    state.counts = h.counts();
    persist();
    try {
      h.snapshot(state.workspaceId, "final");
    } catch (e) {
      h.write("snapshot-error.json", h.safeError(e));
    }
    await h.close();
  }
  return state;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
  const sourceFile = value("--source");
  if (!sourceFile) throw Error("--source JSON is required");
  const source = read(sourceFile);
  const runRoot = value("--run-root", path.join(CAMPAIGN, "runs", "sentinel"));
  const result = await runCourse(source, {
    runRoot,
    providerName: args.includes("--fake") ? "fake" : "hy3",
    resume: args.includes("--resume"),
    maxTeaching: Number(value("--max-teaching", 3)),
    maxFormal: Number(value("--max-formal", 1)),
    failPractice: args.includes("--fail-practice"),
    tutor: !args.includes("--no-tutor"),
    stopAfterPreparation: args.includes("--prepare-only"),
  });
  console.log(
    JSON.stringify({
      sourceId: result.sourceId,
      status: result.status,
      teaching: result.teaching.map((r) => r.status),
      formal: result.formal.map((r) => r.status),
      counts: result.counts,
    }),
  );
}
