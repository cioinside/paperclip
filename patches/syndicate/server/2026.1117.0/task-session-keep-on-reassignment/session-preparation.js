import { and, desc, eq } from "drizzle-orm";
import { agentConfigRevisions } from "@paperclipai/db";
import { getServerAdapter } from "../../adapters/index.js";
import { aiConnectionSessionCompatibilityInputs, managedAiSessionIdentityCompatible } from "../ai-connection-session.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { describeSessionResetReason, shouldResetTaskSessionForWake, isCanonicalSessionIdForAdapter, normalizeResumeParamsForAdapter, normalizeSessionParams, requiresCanonicalSessionIds, truncateDisplayId, } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata, readConfigFingerprintFromSessionParams, readConfiguredModelFromAdapterConfig, resolveTaskSessionConfigFreshness, stripPaperclipSessionMetadataFromSessionParams, } from "./workspaces.js";
function readNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
/** Selects a resumable session before workspace preparation; acquires no runtime resources. */
export async function prepareHeartbeatSession(db, input) {
    const { run, agent, getLatestAgentConfigRevision } = input;
    const { context, issueRef, issueContext, taskProjectContext, workspaceProjectContext, wakeCommentId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision } = input.task;
    const { taskSession, taskSessionDecodedParams, explicitResumeSessionParams, explicitResumeSessionDisplayId, sessionCodec } = input.session;
    const { runtimeConfig, agentIdentity, issueAssigneeOverrides, originalAiIssueOverrides, managedAiRuntime, aiBinding, requestedAiBinding, secretManifest, runtimeSkillEntries, routineEnvContext } = input.config;
    const { requestedExecutionWorkspaceMode, effectiveExecutionWorkspaceMode, projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings, executionPolicy, requestedReusableExecutionWorkspaceConfig, reusableExistingExecutionWorkspace } = input.workspace;
    const { environmentResolution, selectedEnvironmentId, selectedEnvironmentForConfig } = input.environment;
    const latestAgentConfigRevision = await getLatestAgentConfigRevision(agent.companyId, agent.id);
    const sessionConfigMetadataInput = {
        agentIdentityKeyId: agentIdentity?.keyId,
        adapterType: agent.adapterType,
        effectiveAdapterConfig: runtimeConfig,
        managedInstructions: await agentInstructionsService(db).getManagedEntryFingerprint({ ...agent, adapterConfig: runtimeConfig }),
        managedAiHome: managedAiRuntime?.home,
        agentRuntimeConfig: agent.runtimeConfig,
        issueOverrides: issueAssigneeOverrides,
        workspaceConfig: {
            requestedMode: requestedExecutionWorkspaceMode,
            effectiveMode: effectiveExecutionWorkspaceMode,
            issueConfigRevisionAt: issueContext?.updatedAt instanceof Date
                ? issueContext.updatedAt.toISOString()
                : (issueContext?.updatedAt ?? null),
            projectConfigRevisionAt: workspaceProjectContext?.updatedAt instanceof Date
                ? workspaceProjectContext.updatedAt.toISOString()
                : (workspaceProjectContext?.updatedAt ?? null),
            projectPolicy: projectExecutionWorkspacePolicy,
            issueSettings: issueExecutionWorkspaceSettings,
            reusableExecutionWorkspaceConfig: requestedReusableExecutionWorkspaceConfig,
            existingExecutionWorkspace: reusableExistingExecutionWorkspace
                ? {
                    id: reusableExistingExecutionWorkspace.id,
                    mode: reusableExistingExecutionWorkspace.mode,
                    strategyType: reusableExistingExecutionWorkspace.strategyType,
                    projectWorkspaceId: reusableExistingExecutionWorkspace.projectWorkspaceId,
                    repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                    baseRef: reusableExistingExecutionWorkspace.baseRef,
                    branchName: reusableExistingExecutionWorkspace.branchName,
                    config: reusableExistingExecutionWorkspace.config,
                }
                : null,
        },
        environment: {
            selectionSource: environmentResolution.source,
            selectedEnvironmentId,
            selectedEnvironment: selectedEnvironmentForConfig
                ? {
                    id: selectedEnvironmentForConfig.id,
                    driver: selectedEnvironmentForConfig.driver,
                    config: selectedEnvironmentForConfig.config,
                    configRevisionAt: selectedEnvironmentForConfig.updatedAt instanceof Date
                        ? selectedEnvironmentForConfig.updatedAt.toISOString()
                        : (selectedEnvironmentForConfig.updatedAt ?? null),
                }
                : null,
            executionPolicy,
        },
        environmentEnv: selectedEnvironmentForConfig?.envVars ?? null,
        projectEnv: taskProjectContext?.env ?? null,
        routineEnv: routineEnvContext.env,
        secretManifest,
        runtimeSkills: runtimeSkillEntries,
        agentConfigRevision: latestAgentConfigRevision
            ? {
                id: latestAgentConfigRevision.id,
                changedKeys: latestAgentConfigRevision.changedKeys,
                configRevisionAt: latestAgentConfigRevision.createdAt.toISOString(),
            }
            : null,
    };
    const sessionConfigMetadata = await buildEffectiveRunSessionConfigMetadata(sessionConfigMetadataInput);
    const compatibleConfigMetadata = [];
    const importedManagedInstructions = Boolean(taskSession && sessionConfigMetadataInput.managedInstructions?.contentHash
        && readConfigFingerprintFromSessionParams(taskSession.sessionParamsJson)?.fingerprint !== sessionConfigMetadata.fingerprint);
    if (importedManagedInstructions) {
        compatibleConfigMetadata.push(await buildEffectiveRunSessionConfigMetadata({
            ...sessionConfigMetadataInput, retainManagedInstructionPaths: true,
        }));
    }
    if (managedAiRuntime && aiBinding && taskSession &&
        readConfigFingerprintFromSessionParams(taskSession.sessionParamsJson)?.fingerprint !== sessionConfigMetadata.fingerprint) {
        const revisions = requestedAiBinding?.mode === "router"
            ? await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.companyId, agent.companyId), eq(agentConfigRevisions.agentId, agent.id))).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id)).limit(21)
            : [];
        const candidates = aiConnectionSessionCompatibilityInputs({
            effectiveAdapterConfig: runtimeConfig, agentRuntimeConfig: agent.runtimeConfig,
            agentConfigRevision: sessionConfigMetadataInput.agentConfigRevision,
            issueOverrides: issueAssigneeOverrides, originalIssueOverrides: originalAiIssueOverrides,
            binding: aiBinding, router: requestedAiBinding?.mode === "router",
            storedIdentity: taskSession.sessionParamsJson?.paperclipAiCredentialIdentity,
            sessionIdentity: managedAiRuntime.sessionIdentity, credentialIdentity: managedAiRuntime.identity, revisions,
        });
        compatibleConfigMetadata.push(...await Promise.all(candidates.flatMap(candidate => [
            buildEffectiveRunSessionConfigMetadata({ ...sessionConfigMetadataInput, ...candidate }),
            ...(importedManagedInstructions ? [buildEffectiveRunSessionConfigMetadata({
                    ...sessionConfigMetadataInput, ...candidate, retainManagedInstructionPaths: true,
                })] : []),
        ])));
    }
    const configuredModel = readConfiguredModelFromAdapterConfig(runtimeConfig);
    if (context.refreshTools === true && agent.adapterType !== "paperclip_runner") {
        const capability = getServerAdapter(agent.adapterType).supportsToolRefreshOnResume;
        const canRefresh = typeof capability === "function" ? capability(runtimeConfig) : capability === true;
        if (!canRefresh)
            context.forceFreshSession = true;
    }
    const wakeSessionResetReason = describeSessionResetReason(context);
    const sessionConfigFreshness = resolveTaskSessionConfigFreshness({
        hasTaskSession: taskSession != null,
        configuredModel,
        taskSessionParams: taskSession?.sessionParamsJson ?? taskSessionDecodedParams,
        configMetadata: sessionConfigMetadata,
        compatibleConfigMetadata,
        wakeResetReason: wakeSessionResetReason,
        preserveLegacySessionWithoutConfigMetadata: acceptedPlanContinuationWake && !acceptedPlanWakeRoutingDecision && !agentIdentity,
    });
    // A human reply on a task parked in review hands the task back to the agent,
    // which the server reports as `issue_assigned`. Resetting the task session
    // there restarted OpenCode — and its session-title generation — on every
    // reply. A task that already carries a session keeps it; a first assignment
    // (no session yet) still starts clean.
    const reassignedTaskWithSession = taskSession != null &&
        readNonEmptyString(context.wakeReason) === "issue_assigned" &&
        context.forceFreshSession !== true;
    const resetTaskSession = context.workspaceSelectionChanged === true ||
        (shouldResetTaskSessionForWake(context) && !reassignedTaskWithSession) ||
        sessionConfigFreshness.reset;
    const sessionResetReason = sessionConfigFreshness.reasons.join("; ") || null;
    const taskSessionForRun = resetTaskSession ? null : taskSession;
    const getFreshSessionHandoff = issueRef ? createNativeSessionHandoffLoader({
        db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, before: run.createdAt,
        throughCommentId: readNonEmptyString(context.conversationReplayThroughCommentId) ?? (context.interactionKind ? null : wakeCommentId),
    }) : undefined;
    const previousSessionParams = explicitResumeSessionParams ??
        (isCanonicalSessionIdForAdapter(agent.adapterType, explicitResumeSessionDisplayId)
            ? { sessionId: explicitResumeSessionDisplayId }
            : null) ??
        normalizeResumeParamsForAdapter(agent.adapterType, stripPaperclipSessionMetadataFromSessionParams(sessionCodec.deserialize(taskSessionForRun?.sessionParamsJson ?? null)));
    // Legacy plugins can consume the existing context field on a known-fresh
    // dispatch. Built-ins also load lazily if their resume attempt fails.
    if (agent.adapterType !== "paperclip_runner" && !previousSessionParams && getFreshSessionHandoff) {
        const handoff = await getFreshSessionHandoff();
        if (handoff)
            context.paperclipFreshSessionHandoffMarkdown = handoff;
    }
    return { sessionConfigMetadata, configuredModel, sessionConfigFreshness, resetTaskSession, sessionResetReason, taskSessionForRun, getFreshSessionHandoff, previousSessionParams };
}
/** Resolves adapter identity after workspace preparation, retaining in-place context and delta updates. */
export async function resolveHeartbeatAdapterSession(input) {
    const { agent, evaluateSessionCompaction } = input;
    const { context, taskKey, issueId, continuationSummary, executionContinuation } = input.task;
    const { runtime, taskSession, sessionCodec, explicitResumeSessionDisplayId, runtimeSessionParams, managedAiRuntime, prepared } = input.session;
    const { sessionConfigMetadata, sessionConfigFreshness, resetTaskSession, taskSessionForRun, previousSessionParams } = prepared;
    const { latestWorkspaceConfigMetadata, workspaceConfigFreshness, reusedExecutionWorkspace, resolvedWorkspaceReusePolicy, persistedExecutionWorkspace, runtimeWorkspaceWarnings, requestedShouldReuseExisting, workspaceReuseRequest } = input.workspace;
    const runtimeSessionFallback = taskKey || resetTaskSession
        ? null
        : isCanonicalSessionIdForAdapter(agent.adapterType, runtime.sessionId)
            ? runtime.sessionId
            : null;
    const runtimeSessionDisplayId = truncateDisplayId(explicitResumeSessionDisplayId ??
        taskSessionForRun?.sessionDisplayId ??
        (sessionCodec.getDisplayId
            ? sessionCodec.getDisplayId(runtimeSessionParams)
            : null) ??
        readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback);
    let previousSessionDisplayId = requiresCanonicalSessionIds(agent.adapterType)
        ? truncateDisplayId(readNonEmptyString(previousSessionParams?.sessionId) ??
            (isCanonicalSessionIdForAdapter(agent.adapterType, runtimeSessionDisplayId)
                ? runtimeSessionDisplayId
                : null) ??
            runtimeSessionFallback)
        : runtimeSessionDisplayId;
    let runtimeSessionIdForAdapter = readNonEmptyString(runtimeSessionParams?.sessionId) ??
        runtimeSessionFallback;
    let runtimeSessionParamsForAdapter = normalizeSessionParams(stripPaperclipSessionMetadataFromSessionParams(runtimeSessionParams));
    const sessionCompaction = await evaluateSessionCompaction({
        agent,
        sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
        issueId,
        continuationSummaryBody: continuationSummary?.body ?? null,
    });
    if (sessionCompaction.rotate) {
        context.paperclipSessionHandoffMarkdown =
            sessionCompaction.handoffMarkdown;
        context.paperclipSessionRotationReason = sessionCompaction.reason;
        context.paperclipPreviousSessionId =
            previousSessionDisplayId ?? runtimeSessionIdForAdapter;
        runtimeSessionIdForAdapter = null;
        runtimeSessionParamsForAdapter = null;
        previousSessionDisplayId = null;
        if (sessionCompaction.reason) {
            runtimeWorkspaceWarnings.push(`Starting a fresh session because ${sessionCompaction.reason}.`);
        }
    }
    else {
        delete context.paperclipSessionHandoffMarkdown;
        delete context.paperclipSessionRotationReason;
        delete context.paperclipPreviousSessionId;
    }
    const taskSessionCredentialCompatible = !managedAiRuntime || managedAiSessionIdentityCompatible(taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity, managedAiRuntime.sessionIdentity, managedAiRuntime.identity);
    if (managedAiRuntime) {
        sessionConfigMetadata.aiCredentialIdentity = managedAiRuntime.sessionIdentity;
        if (!taskSessionCredentialCompatible) {
            runtimeSessionIdForAdapter = null;
            runtimeSessionParamsForAdapter = null;
            previousSessionDisplayId = null;
            delete executionContinuation?.resumeDelta;
        }
    }
    const runtimeForAdapter = {
        sessionId: runtimeSessionIdForAdapter,
        sessionParams: runtimeSessionParamsForAdapter,
        sessionDisplayId: previousSessionDisplayId,
        taskKey,
    };
    // A delta is safe only when the selected provider session is exactly the
    // task session whose last dispatch supplied the baseline history.
    if (executionContinuation?.resumeDelta &&
        (!taskSessionForRun ||
            !taskSession?.sessionDisplayId ||
            runtimeForAdapter.sessionDisplayId !== taskSession.sessionDisplayId ||
            resetTaskSession ||
            context.forceFreshSession === true)) {
        delete executionContinuation.resumeDelta;
    }
    const configFreshnessResultMetadata = {
        version: sessionConfigMetadata.version,
        session: {
            fingerprintVersion: sessionConfigMetadata.version,
            categories: sessionConfigMetadata.categories,
            reset: resetTaskSession,
            resetReasons: sessionConfigFreshness.reasons,
            changedCategories: sessionConfigFreshness.changedCategories,
            taskSessionAvailable: taskSession != null,
            taskSessionReused: taskSessionForRun != null,
            storedFingerprintPresent: Boolean(sessionConfigFreshness.storedFingerprint),
            nextFingerprint: sessionConfigFreshness.nextFingerprint,
        },
        workspace: {
            fingerprintVersion: latestWorkspaceConfigMetadata.version,
            categories: latestWorkspaceConfigMetadata.categories,
            action: workspaceConfigFreshness.action,
            changedCategories: workspaceConfigFreshness.changedCategories,
            reasons: workspaceConfigFreshness.reasons,
            reuseRequested: requestedShouldReuseExisting,
            workspaceReused: Boolean(reusedExecutionWorkspace),
            configSnapshotRefreshed: resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
            storedFingerprintPresent: workspaceConfigFreshness.storedFingerprintPresent,
            storedFingerprint: workspaceConfigFreshness.storedFingerprint,
            inferredFingerprint: workspaceConfigFreshness.inferredFingerprint,
            nextFingerprint: workspaceConfigFreshness.nextFingerprint,
            previousWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
            activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
        },
    };
    return { previousSessionDisplayId, runtimeSessionParamsForAdapter, taskSessionCredentialCompatible, runtimeForAdapter, configFreshnessResultMetadata, sessionCompaction };
}
//# sourceMappingURL=session-preparation.js.map