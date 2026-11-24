# Our patches

The patches Syndicate runs on the deployed Paperclip build, kept here so that this
fork carries them and they can be read, rebased and sent upstream.

The patch set is the one for tag `v2026.1117.0` — the version the live instance runs.

## Applied on this branch (source level)

| commit | patch | what it does |
| --- | --- | --- |
| `fix(server): name the exact secret key in the access-denied answer` | source twin of `server/2026.1117.0/SOURCE-secrets.patch` | the 403 body points at `GET /api/agents/me/secrets` |

The two UI patches are in `ui/2026.1117.0/` and are applied as code on branch
`syn/upstream-master` — see the note below.

## Ready-to-push series on upstream master

`branch-on-upstream-master/` holds the same patch set rebased onto current
upstream master (`base-commit.txt` names the commit): the two UI patches as
source commits, the secrets hint and this patch set. Apply it with
`git am series-4-commits.patch` once the fork holds upstream master.

It is a file here and not a branch because the token this fork was pushed with
had no `workflow` scope, and GitHub refuses any push into this repository that
would create or update a file under `.github/workflows/`. The token now carries
that scope: the fork's `master` is synced with upstream master and the same patch
set is applied as source commits on branch `syn/upstream-master`. This branch
keeps the fork's older base and the patch set as files.

## Patch files for the published build

`server/2026.1117.0/` and `adapter/2026.1117.0/` hold the patches the host applies to
the **published npm output** of `@paperclipai/server` and `@paperclipai/adapter`
(`dist/routes/**`, `dist/services/**`, `runtime-config.js`), not to this source tree.
Every directory has its own `PATCH-MANIFEST.txt` with the semantics, the base version
and the porting notes.

| patch | what it does |
| --- | --- |
| `server/2026.1117.0/SOURCE-issue-scoped-run-lookup.patch` | a live run is resolved by issue identity, not by the assignee's newest run |
| `server/2026.1117.0/SOURCE-routine-dispatch-conflict.patch` | a routine dispatch that loses the open-execution race is coalesced into the live execution issue |
| `server/2026.1117.0/SOURCE-secrets.patch` | the secrets 403 hint (the source twin of the commit above) |
| `server/2026.1117.0/in-review-handoff-stop/` | a task parked in `in_review` does not stop its own run |
| `server/2026.1117.0/mcp-tools-call-timeout/` | an MCP `tools/call` forwards the caller's timeout instead of a hard 10 s cut |
| `server/2026.1117.0/question-answer-resume/` | a human answer to `ask_user_questions` hands the task back to the agent |
| `server/2026.1117.0/task-session-keep-on-reassignment/` | an OpenCode task session is kept on an `issue_assigned` wake |
| `adapter/2026.1117.0/SOURCE-small-model-session.patch` | the OpenCode `small_model` defaults to the session model |

## Not applied here

`not-applied-here/` holds our source-level patches that were written against a
different upstream state and do not apply to the fork's own base as they are:

- `5c0e6a2f-...-issue-scoped-run-lookup.patch` — the source-level twin of the server
  run-lookup patch, written against upstream master of 2026-11-12;
  `server/src/services/issue-run-presence.ts` does not exist in the 2026.1117.0 tag.
- `stuck-inprogress-recovery.patch` — the sweeper for issues stuck in `in_progress`
  after an agent run dies.
- `SOURCE-fallback.patch` — the adapter's fallback model retry, written against
  2026.1106.0 (`packages/adapters/opencode-local/src/server/**`).
