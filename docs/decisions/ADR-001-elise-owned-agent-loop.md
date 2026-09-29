# ADR-001 — ELISE Core owns the agent loop; OpenAI via the `openai` SDK

**Status:** Accepted (2026-09-29)

## Context

`12-agent-runtime.md` allows using the OpenAI Agents SDK inside `src/infrastructure/ai/openai/`,
but also requires that validation, provider resolution, permissions, approvals, idempotency,
tracing and audit are deterministic ELISE code, and that the AI provider stays replaceable.
The Agents SDK runs its own tool loop and invokes tool functions itself, which would place the
loop — and the hooks where policy must run — inside a vendor SDK.

## Decision

- ELISE Core (`src/core/agents/runtime.ts`) owns the loop: model turn → tool calls →
  `executeToolCall` (registry → schema → resolver → permission → policy/approval → provider →
  trace + audit) → results → next turn, with explicit limits.
- The `AIProvider` port performs exactly one streamed model turn and returns text deltas and
  tool-call requests. It never executes tools.
- The first implementation (`OpenAIProvider`) uses the official `openai` SDK (Responses API,
  `store: false`). `@openai/agents` was removed as an unused dependency.
- Model names are configuration (`OPENAI_MODEL`, `OPENAI_MODEL_FAST`), selected by tier.

## Consequences

- Adding another model provider means implementing one small interface.
- Chat, UI actions and (future) Schedules share one execution path, so a background run can
  never bypass policy.
- We do not get Agents SDK conveniences (handoffs, built-in tracing). Handoffs are not wanted
  (one ELISE, no per-provider agents) and tracing is ours (`ai_runs`, `tool_executions`).
