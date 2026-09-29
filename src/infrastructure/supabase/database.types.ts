/**
 * Database types matching supabase/migrations. Hand-written until a Supabase project exists;
 * then replace with `npx supabase gen types typescript --linked > this file`.
 */

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Row + insert/update shapes. `Req` lists columns without a database default. */
type Table<Row, Req extends keyof Row> = {
  Row: Row;
  Insert: Pick<Row, Req> & Partial<Omit<Row, Req>>;
  Update: Partial<Row>;
  Relationships: [];
};

type Ts = string;

export type UserProfileRow = {
  id: string;
  display_name: string | null;
  preferred_language: "es" | "en";
  timezone: string;
  avatar_url: string | null;
  onboarding_status: "pending" | "completed" | "skipped";
  created_at: Ts;
  updated_at: Ts;
};

export type WorkspaceRow = {
  id: string;
  name: string;
  type: "personal" | "team" | "business";
  owner_user_id: string;
  default_language: "es" | "en";
  timezone: string;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type WorkspaceMemberRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "invited" | "removed";
  joined_at: Ts;
  created_at: Ts;
  updated_at: Ts;
};

export type UserPreferenceRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  key: string;
  value_json: Json;
  source: "user" | "onboarding" | "system";
  created_at: Ts;
  updated_at: Ts;
};

export type ProviderConnectionRow = {
  id: string;
  workspace_id: string;
  provider_key: string;
  created_by_user_id: string | null;
  external_account_id: string;
  display_name: string;
  account_label: string | null;
  context_label: string | null;
  status:
    "connecting" | "connected" | "needs_reauthorization" | "error" | "disabled" | "disconnected";
  auth_metadata: Json;
  last_health_check_at: Ts | null;
  last_connected_at: Ts | null;
  last_error_code: string | null;
  last_error_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
  disconnected_at: Ts | null;
};

export type ConnectionCapabilityRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  capability_key: string;
  enabled: boolean;
  permission_level: "understand" | "read" | "write";
  authorized_scopes: string[];
  created_at: Ts;
  updated_at: Ts;
};

export type CapabilityBindingRow = {
  id: string;
  workspace_id: string;
  capability_key: string;
  connection_id: string;
  context_type: "personal" | "work" | "entity" | "knowledge_space" | "custom" | null;
  context_id: string | null;
  priority: number;
  is_default: boolean;
  enabled: boolean;
  configuration: Json;
  created_at: Ts;
  updated_at: Ts;
};

export type ConversationRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  title: string | null;
  status: "active" | "archived";
  last_message_at: Ts;
  active_context: Json;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  workspace_id: string;
  role: "user" | "assistant" | "system_internal" | "tool_summary";
  content: string;
  content_format: "markdown" | "text";
  run_id: string | null;
  metadata: Json;
  created_at: Ts;
};

export type AiRunRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  conversation_id: string | null;
  ai_provider: string;
  model_key: string;
  skill_key: string;
  status: "running" | "completed" | "failed" | "cancelled";
  request_id: string | null;
  started_at: Ts;
  completed_at: Ts | null;
  latency_ms: number | null;
  token_usage: Json;
  tool_call_count: number;
  error_code: string | null;
  created_at: Ts;
};

export type TaskRow = {
  id: string;
  workspace_id: string;
  task_list_id: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "low" | "medium" | "high" | null;
  category: string | null;
  due_date: string | null;
  completed_at: Ts | null;
  created_by_user_id: string | null;
  source: "user_ui" | "ai" | "schedule" | "import" | "system";
  metadata: Json;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type ActionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  ai_run_id: string | null;
  tool_name: string;
  capability_key: string;
  operation: string;
  provider_key: string | null;
  connection_id: string | null;
  target_type: string | null;
  target_id: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  origin: "ai" | "user_ui" | "schedule" | "system";
  status:
    | "proposed"
    | "waiting_for_clarification"
    | "waiting_for_approval"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled"
    | "expired"
    | "unknown_outcome";
  input_snapshot: Json;
  input_hash: string;
  idempotency_key: string | null;
  result_reference: Json | null;
  error_code: string | null;
  created_at: Ts;
  executed_at: Ts | null;
  updated_at: Ts;
};

export type ToolExecutionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  action_id: string | null;
  ai_run_id: string | null;
  tool_name: string;
  provider_key: string | null;
  connection_id: string | null;
  status: "succeeded" | "failed" | "approval_required" | "clarification_required" | "rejected";
  latency_ms: number | null;
  error_code: string | null;
  result_metadata: Json;
  started_at: Ts;
  completed_at: Ts;
  created_at: Ts;
};

export type ApprovalRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  action_id: string;
  capability_key: string;
  operation: string;
  provider_key: string | null;
  connection_id: string | null;
  risk_level: "low" | "medium" | "high" | "critical";
  payload_snapshot: Json;
  payload_hash: string;
  summary: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired" | "cancelled" | "superseded";
  expires_at: Ts | null;
  created_at: Ts;
  resolved_at: Ts | null;
  resolved_by_user_id: string | null;
};

export type NotificationRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  notification_type: string;
  title: string;
  content: string | null;
  priority: "low" | "normal" | "high";
  source_type: string | null;
  source_id: string | null;
  action_url: string | null;
  read_at: Ts | null;
  created_at: Ts;
  expires_at: Ts | null;
  metadata: Json;
};

export type AuditEventRow = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  event_type: string;
  resource_type: string | null;
  resource_id: string | null;
  action_id: string | null;
  provider_key: string | null;
  connection_id: string | null;
  approval_id: string | null;
  origin: "ai" | "user_ui" | "schedule" | "system";
  result: "success" | "failure" | "pending";
  metadata: Json;
  created_at: Ts;
};

export type OAuthStateRow = {
  id: string;
  state_hash: string;
  workspace_id: string;
  user_id: string;
  provider_key: string;
  capabilities: string[];
  connection_id: string | null;
  code_verifier_ciphertext: string;
  return_path: string;
  created_at: Ts;
  expires_at: Ts;
};

export type ConnectionSecretRow = {
  connection_id: string;
  workspace_id: string;
  provider_key: string;
  ciphertext: string;
  access_token_expires_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
};

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "waiting"
  | "waiting_for_approval"
  | "completed"
  | "completed_with_warning"
  | "failed"
  | "cancelled";

export type BackgroundJobRow = {
  id: string;
  workspace_id: string;
  user_id: string | null;
  job_type: "schedule.run";
  status: BackgroundJobStatus;
  progress_current: number | null;
  progress_total: number | null;
  progress_message: string | null;
  runtime_provider: string;
  runtime_job_id: string | null;
  attempts: number;
  result_reference: Json | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Ts | null;
  completed_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
};

export type ScheduleRow = {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  name: string;
  schedule_type: "one_time" | "recurring";
  status: "active" | "paused" | "needs_attention" | "completed" | "archived";
  timezone: string;
  schedule_definition: Json;
  action_type: "morning_brief";
  configuration: Json;
  capabilities: string[];
  instructions: string | null;
  delivery_config: Json;
  approval_behavior: "policy";
  next_run_at: Ts | null;
  last_run_at: Ts | null;
  runtime_reference: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type ScheduleRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "completed_with_warning"
  | "failed"
  | "cancelled"
  | "missed"
  | "skipped";

export type ScheduleRunRow = {
  id: string;
  workspace_id: string;
  schedule_id: string;
  background_job_id: string | null;
  trigger: "scheduled" | "manual";
  status: ScheduleRunStatus;
  scheduled_for: Ts;
  started_at: Ts | null;
  completed_at: Ts | null;
  approval_id: string | null;
  result_id: string | null;
  warnings: Json;
  error_code: string | null;
  error_message: string | null;
  runtime_metadata: Json;
  created_at: Ts;
};

export type ScheduledResultRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  schedule_id: string;
  schedule_run_id: string;
  result_type: "morning_brief";
  title: string;
  content: Json;
  artifact_reference: string | null;
  read_at: Ts | null;
  metadata: Json;
  created_at: Ts;
};

export type Database = {
  public: {
    Tables: {
      user_profiles: Table<UserProfileRow, "id">;
      workspaces: Table<WorkspaceRow, "name" | "owner_user_id">;
      workspace_members: Table<WorkspaceMemberRow, "workspace_id" | "user_id">;
      user_preferences: Table<UserPreferenceRow, "workspace_id" | "user_id" | "key" | "value_json">;
      provider_connections: Table<
        ProviderConnectionRow,
        "workspace_id" | "provider_key" | "external_account_id" | "display_name"
      >;
      connection_capabilities: Table<
        ConnectionCapabilityRow,
        "workspace_id" | "connection_id" | "capability_key"
      >;
      capability_bindings: Table<
        CapabilityBindingRow,
        "workspace_id" | "capability_key" | "connection_id"
      >;
      conversations: Table<ConversationRow, "workspace_id" | "user_id">;
      messages: Table<MessageRow, "conversation_id" | "workspace_id" | "role" | "content">;
      ai_runs: Table<AiRunRow, "workspace_id" | "user_id" | "ai_provider" | "model_key">;
      tasks: Table<TaskRow, "workspace_id" | "title">;
      actions: Table<
        ActionRow,
        | "workspace_id"
        | "user_id"
        | "tool_name"
        | "capability_key"
        | "operation"
        | "risk_level"
        | "origin"
        | "input_snapshot"
        | "input_hash"
      >;
      tool_executions: Table<
        ToolExecutionRow,
        "workspace_id" | "user_id" | "tool_name" | "status" | "started_at"
      >;
      approvals: Table<
        ApprovalRow,
        | "workspace_id"
        | "user_id"
        | "action_id"
        | "capability_key"
        | "operation"
        | "risk_level"
        | "payload_snapshot"
        | "payload_hash"
        | "summary"
        | "reason"
      >;
      notifications: Table<
        NotificationRow,
        "workspace_id" | "user_id" | "notification_type" | "title"
      >;
      oauth_states: Table<
        OAuthStateRow,
        | "state_hash"
        | "workspace_id"
        | "user_id"
        | "provider_key"
        | "capabilities"
        | "code_verifier_ciphertext"
      >;
      connection_secrets: Table<
        ConnectionSecretRow,
        "connection_id" | "workspace_id" | "provider_key" | "ciphertext"
      >;
      audit_events: Table<AuditEventRow, "workspace_id" | "event_type" | "origin" | "result">;
      background_jobs: Table<BackgroundJobRow, "workspace_id" | "job_type">;
      schedules: Table<
        ScheduleRow,
        | "workspace_id"
        | "created_by_user_id"
        | "name"
        | "schedule_type"
        | "timezone"
        | "schedule_definition"
        | "action_type"
      >;
      schedule_runs: Table<
        ScheduleRunRow,
        "workspace_id" | "schedule_id" | "trigger" | "scheduled_for"
      >;
      scheduled_results: Table<
        ScheduledResultRow,
        | "workspace_id"
        | "user_id"
        | "schedule_id"
        | "schedule_run_id"
        | "result_type"
        | "title"
        | "content"
      >;
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export type { Json };
