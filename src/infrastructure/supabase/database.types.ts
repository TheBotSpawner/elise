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
  theme: "system" | "dark" | "light";
  accent: "cyan" | "blue" | "violet" | "green" | "amber";
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

export type TaskListRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  is_default: boolean;
  created_at: Ts;
  updated_at: Ts;
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
  job_type: "schedule.run" | "structured.bulk";
  input: Json | null;
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

type NativeSource = "user_ui" | "ai" | "schedule" | "import" | "system";

export type HabitRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  frequency_type: "daily" | "weekly" | "specific_days";
  target_value: number;
  unit: string | null;
  preferred_days: number[];
  active: boolean;
  start_date: string;
  metadata: Json;
  source: NativeSource;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type HabitEntryRow = {
  id: string;
  workspace_id: string;
  habit_id: string;
  entry_date: string;
  value: number;
  status: "done" | "skipped";
  notes: string | null;
  source: NativeSource;
  created_at: Ts;
  updated_at: Ts;
};

export type GoalRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: "active" | "completed" | "paused" | "cancelled";
  target_date: string | null;
  progress_type: "binary" | "numeric" | "percentage";
  progress_mode: "manual" | "linked" | "hybrid";
  start_value: number | null;
  current_value: number | null;
  target_value: number | null;
  direction: "increase" | "decrease";
  metric: string | null;
  parent_goal_id: string | null;
  completed_at: Ts | null;
  source: NativeSource;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type GoalLinkRow = {
  id: string;
  workspace_id: string;
  goal_id: string;
  resource_type: "habit" | "task" | "goal" | "note" | "entity";
  resource_id: string;
  relationship_type: "supports" | "milestone" | "related";
  created_at: Ts;
};

export type ListRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: "active" | "archived";
  source: NativeSource;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type ListItemRow = {
  id: string;
  workspace_id: string;
  list_id: string;
  content: string;
  checked: boolean;
  position: number;
  notes: string | null;
  source: NativeSource;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type NoteRow = {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  space_id: string | null;
  status: "active" | "archived";
  source: NativeSource;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type KnowledgeSpaceRow = {
  id: string;
  workspace_id: string;
  parent_space_id: string | null;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  status: "active" | "archived";
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type KnowledgeSourceRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  provider_key: string;
  connection_id: string | null;
  source_type: "upload" | "google_drive" | "notion" | "note";
  display_name: string;
  source_url: string | null;
  configuration: Json;
  status: "idle" | "syncing" | "ready" | "needs_attention" | "disconnected" | "archived";
  last_synced_at: Ts | null;
  next_sync_at: Ts | null;
  last_error_code: string | null;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type KnowledgeItemRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  source_id: string;
  item_type:
    | "file"
    | "drive_file"
    | "google_doc"
    | "google_sheet"
    | "google_slides"
    | "notion_page"
    | "notion_database_page"
    | "note";
  external_id: string;
  title: string;
  source_url: string | null;
  mime_type: string | null;
  status: "queued" | "processing" | "ready" | "needs_attention" | "failed" | "removed" | "archived";
  status_detail: string | null;
  error_code: string | null;
  current_version_id: string | null;
  external_modified_at: Ts | null;
  last_synced_at: Ts | null;
  metadata: Json;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type KnowledgeVersionRow = {
  id: string;
  workspace_id: string;
  knowledge_item_id: string;
  version_number: number;
  source_revision: string | null;
  content_hash: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  extracted_text: string | null;
  status: "pending" | "processing" | "ready" | "failed" | "unchanged" | "superseded";
  parser_version: string | null;
  chunking_version: string | null;
  embedding_model: string | null;
  chunk_count: number;
  is_current: boolean;
  runtime_job_id: string | null;
  error_code: string | null;
  metadata: Json;
  created_at: Ts;
  processed_at: Ts | null;
};

export type KnowledgeChunkRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  source_id: string;
  knowledge_item_id: string;
  version_id: string;
  chunk_index: number;
  content: string;
  heading_path: string[];
  page_number: number | null;
  token_count: number;
  /** pgvector literal "[0.1,0.2,…]". */
  embedding: string | null;
  embedding_model: string | null;
  metadata: Json;
  created_at: Ts;
};

export type KnowledgeSyncRunRow = {
  id: string;
  workspace_id: string;
  source_id: string;
  trigger: "scheduled" | "manual" | "initial";
  status: "queued" | "running" | "completed" | "completed_with_warning" | "failed" | "cancelled";
  runtime_job_id: string | null;
  started_at: Ts | null;
  completed_at: Ts | null;
  items_discovered: number;
  items_created: number;
  items_updated: number;
  items_removed: number;
  items_failed: number;
  error_code: string | null;
  created_at: Ts;
};

type Source = "user_ui" | "ai" | "schedule" | "import" | "system";

export type FinanceSettingsRow = {
  workspace_id: string;
  default_currency: string | null;
  reporting_currency: string | null;
  created_at: Ts;
  updated_at: Ts;
};

export type FinanceAccountRow = {
  id: string;
  workspace_id: string;
  name: string;
  account_type:
    "cash" | "bank" | "credit_card" | "debit_card" | "digital_wallet" | "business" | "other";
  currency: string | null;
  status: "active" | "archived";
  metadata: Json;
  source: Source;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type FinanceCategoryRow = {
  id: string;
  workspace_id: string;
  parent_category_id: string | null;
  name: string;
  category_type: "income" | "expense" | "both";
  status: "active" | "archived";
  source: Source;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

/** `amount` is numeric: always read as text (`amount::text`) and written as a decimal string. */
export type FinanceTransactionRow = {
  id: string;
  workspace_id: string;
  transaction_type: "income" | "expense";
  amount: string;
  currency: string;
  transaction_date: string;
  description: string | null;
  counterparty: string | null;
  account_id: string | null;
  category_id: string | null;
  subcategory: string | null;
  payment_method: string | null;
  project: string | null;
  entity_id: string | null;
  status: "completed" | "pending" | "cancelled";
  notes: string | null;
  source: Source;
  import_id: string | null;
  import_row_number: number | null;
  external_reference: string | null;
  fingerprint: string;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type ImportRow = {
  id: string;
  workspace_id: string;
  import_type: "finance_transactions";
  source_type: "csv" | "xlsx" | "google_sheets";
  source_reference: string;
  source_label: string | null;
  connection_id: string | null;
  file_path: string | null;
  file_hash: string | null;
  status:
    "uploading" | "uploaded" | "importing" | "completed" | "failed" | "rolled_back" | "cancelled";
  mapping_config: Json;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  duplicate_rows: number;
  imported_rows: number;
  error_code: string | null;
  runtime_job_id: string | null;
  created_by_user_id: string | null;
  started_at: Ts | null;
  completed_at: Ts | null;
  rolled_back_at: Ts | null;
  created_at: Ts;
  updated_at: Ts;
};

export type ImportRowRow = {
  id: string;
  workspace_id: string;
  import_id: string;
  source_row_number: number;
  raw_data: Json;
  normalized_data: Json | null;
  status: "imported" | "invalid" | "duplicate";
  error_details: Json | null;
  created_resource_type: string | null;
  created_resource_id: string | null;
  created_at: Ts;
};

export type FinanceSourceRow = {
  id: string;
  workspace_id: string;
  source_type: "google_sheets";
  connection_id: string | null;
  display_name: string;
  spreadsheet_id: string;
  sheet_id: number;
  sheet_title: string;
  mapping_config: Json;
  include_in_totals: boolean;
  status: "idle" | "syncing" | "ready" | "needs_attention" | "disconnected" | "archived";
  row_count: number;
  invalid_rows: number;
  last_synced_at: Ts | null;
  last_error_code: string | null;
  next_sync_at: Ts | null;
  sync_started_at: Ts | null;
  runtime_job_id: string | null;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type FinanceSourceRowRow = {
  id: string;
  workspace_id: string;
  source_id: string;
  row_key: string;
  row_number: number;
  transaction_type: "income" | "expense";
  amount: string;
  currency: string;
  transaction_date: string;
  description: string | null;
  counterparty: string | null;
  account_name: string | null;
  category_name: string | null;
  subcategory: string | null;
  payment_method: string | null;
  project: string | null;
  status: "completed" | "pending" | "cancelled";
  notes: string | null;
  fingerprint: string;
  created_at: Ts;
  updated_at: Ts;
};

export type StructuredSourceRow = {
  id: string;
  workspace_id: string;
  connection_id: string | null;
  provider_key: "notion";
  database_id: string;
  data_source_id: string;
  name: string;
  context: string | null;
  semantic_type: "generic" | "habits";
  schema_fingerprint: string;
  schema_snapshot: Json;
  field_mappings: Json;
  allow_read: boolean;
  allow_create: boolean;
  allow_update: boolean;
  allow_archive: boolean;
  status: "active" | "needs_attention" | "paused" | "archived";
  schema_issues: Json;
  schema_checked_at: Ts | null;
  url: string | null;
  created_by_user_id: string | null;
  created_at: Ts;
  updated_at: Ts;
  archived_at: Ts | null;
};

export type InteractionSessionRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  modality: "text" | "voice" | "proactive" | "live";
  conversation_id: string | null;
  title: string | null;
  summary: string | null;
  topics: string[];
  status: "active" | "archived";
  started_at: Ts;
  last_activity_at: Ts;
  indexed_through: Ts | null;
  summarized_turns: number;
  index_version: number;
  metadata: Json;
  created_at: Ts;
  updated_at: Ts;
};

export type InteractionTurnRow = {
  id: string;
  workspace_id: string;
  session_id: string;
  role: "user" | "assistant" | "tool" | "surface";
  modality: "text" | "voice";
  content: string;
  occurred_at: Ts;
  metadata: Json;
  created_at: Ts;
};

export type RecallChunkRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  session_id: string;
  chunk_index: number;
  source_ids: string[];
  started_at: Ts;
  ended_at: Ts;
  modality: string;
  content: string;
  content_hash: string;
  topics: string[];
  embedding: string | null;
  embedding_model: string | null;
  created_at: Ts;
};

export type LiveWorkspaceRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  conversation_id: string;
  intent: Json | null;
  surfaces: Json;
  focus_id: string | null;
  turn: number;
  next_handle: number;
  version: number;
  updated_at: Ts;
  expires_at: Ts;
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
      live_workspaces: Table<LiveWorkspaceRow, "workspace_id" | "user_id" | "conversation_id">;
      messages: Table<MessageRow, "conversation_id" | "workspace_id" | "role" | "content">;
      ai_runs: Table<AiRunRow, "workspace_id" | "user_id" | "ai_provider" | "model_key">;
      task_lists: Table<TaskListRow, "workspace_id" | "name">;
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
      habits: Table<HabitRow, "workspace_id" | "name" | "frequency_type">;
      habit_entries: Table<HabitEntryRow, "workspace_id" | "habit_id" | "entry_date">;
      goals: Table<GoalRow, "workspace_id" | "title">;
      goal_links: Table<GoalLinkRow, "workspace_id" | "goal_id" | "resource_type" | "resource_id">;
      lists: Table<ListRow, "workspace_id" | "name">;
      list_items: Table<ListItemRow, "workspace_id" | "list_id" | "content" | "position">;
      notes: Table<NoteRow, "workspace_id" | "title">;
      knowledge_spaces: Table<KnowledgeSpaceRow, "workspace_id" | "name">;
      knowledge_sources: Table<
        KnowledgeSourceRow,
        "workspace_id" | "space_id" | "provider_key" | "source_type" | "display_name"
      >;
      knowledge_items: Table<
        KnowledgeItemRow,
        "workspace_id" | "space_id" | "source_id" | "item_type" | "external_id" | "title"
      >;
      knowledge_versions: Table<
        KnowledgeVersionRow,
        "workspace_id" | "knowledge_item_id" | "version_number"
      >;
      knowledge_chunks: Table<
        KnowledgeChunkRow,
        | "workspace_id"
        | "space_id"
        | "source_id"
        | "knowledge_item_id"
        | "version_id"
        | "chunk_index"
        | "content"
      >;
      knowledge_sync_runs: Table<KnowledgeSyncRunRow, "workspace_id" | "source_id" | "trigger">;
      finance_settings: Table<FinanceSettingsRow, "workspace_id">;
      interaction_sessions: Table<InteractionSessionRow, "workspace_id" | "user_id">;
      interaction_turns: Table<
        InteractionTurnRow,
        "workspace_id" | "session_id" | "role" | "content"
      >;
      recall_chunks: Table<
        RecallChunkRow,
        | "workspace_id"
        | "user_id"
        | "session_id"
        | "chunk_index"
        | "started_at"
        | "ended_at"
        | "content"
        | "content_hash"
      >;
      structured_sources: Table<
        StructuredSourceRow,
        "workspace_id" | "database_id" | "data_source_id" | "name" | "schema_fingerprint"
      >;
      finance_accounts: Table<FinanceAccountRow, "workspace_id" | "name">;
      finance_categories: Table<FinanceCategoryRow, "workspace_id" | "name">;
      finance_transactions: Table<
        FinanceTransactionRow,
        | "workspace_id"
        | "transaction_type"
        | "amount"
        | "currency"
        | "transaction_date"
        | "fingerprint"
      >;
      imports: Table<
        ImportRow,
        "workspace_id" | "import_type" | "source_type" | "source_reference"
      >;
      import_rows: Table<
        ImportRowRow,
        "workspace_id" | "import_id" | "source_row_number" | "status"
      >;
      finance_sources: Table<
        FinanceSourceRow,
        "workspace_id" | "display_name" | "spreadsheet_id" | "sheet_id" | "sheet_title"
      >;
      finance_source_rows: Table<
        FinanceSourceRowRow,
        | "workspace_id"
        | "source_id"
        | "row_key"
        | "row_number"
        | "transaction_type"
        | "amount"
        | "currency"
        | "transaction_date"
        | "fingerprint"
      >;
    };
    Views: Record<never, never>;
    Functions: {
      search_recall_chunks: {
        Args: {
          p_workspace_id: string;
          p_user_id: string;
          p_keywords: string;
          p_embedding: string | null;
          p_embedding_model: string;
          p_from?: string | null;
          p_to?: string | null;
          p_exclude_session?: string | null;
          p_limit?: number;
        };
        Returns: {
          chunk_id: string;
          session_id: string;
          chunk_index: number;
          content: string;
          started_at: string;
          ended_at: string;
          source_ids: string[];
          similarity: number | null;
          keyword_rank: number | null;
          score: number;
        }[];
      };
      search_knowledge_chunks: {
        Args: {
          p_workspace_id: string;
          p_keywords: string;
          p_embedding: string | null;
          p_embedding_model: string;
          p_space_ids?: string[] | null;
          p_item_ids?: string[] | null;
          p_limit?: number;
        };
        Returns: {
          chunk_id: string;
          knowledge_item_id: string;
          version_id: string;
          space_id: string;
          chunk_index: number;
          content: string;
          heading_path: string[];
          page_number: number | null;
          similarity: number | null;
          semantic_rank: number | null;
          keyword_rank: number | null;
          score: number;
        }[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export type { Json };
