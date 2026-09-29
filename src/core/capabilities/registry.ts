import type { CapabilityDefinition, CapabilityKey, OperationDefinition } from "./types";

/**
 * Capability registry. Operation defaults follow docs/architecture/08 §15.
 * Capabilities without operations are planned for later MVP slices.
 */
const CAPABILITIES: Record<CapabilityKey, CapabilityDefinition> = {
  tasks: {
    key: "tasks",
    status: "available",
    operations: {
      list: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listLists: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      create: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      update: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      complete: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      reopen: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      delete: { kind: "destructive", risk: "medium", defaultApproval: "ask_when_uncertain" },
    },
  },
  email: { key: "email", status: "planned", operations: {} },
  calendar: {
    key: "calendar",
    status: "available",
    operations: {
      listCalendars: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listEvents: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      findAvailability: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      // Simple personal events proceed; tools escalate to external_communication when an
      // event involves other people (docs/architecture/15 §18, 08 §16).
      createEvent: { kind: "write", risk: "medium", defaultApproval: "ask_when_uncertain" },
      updateEvent: { kind: "write", risk: "medium", defaultApproval: "ask_when_uncertain" },
      deleteEvent: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
    },
  },
  knowledge: { key: "knowledge", status: "planned", operations: {} },
  habits: { key: "habits", status: "planned", operations: {} },
  lists: { key: "lists", status: "planned", operations: {} },
  goals: { key: "goals", status: "planned", operations: {} },
  notes: { key: "notes", status: "planned", operations: {} },
  finance: { key: "finance", status: "planned", operations: {} },
  web_search: { key: "web_search", status: "planned", operations: {} },
  voice: { key: "voice", status: "planned", operations: {} },
};

export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as CapabilityKey[];

export function getCapability(key: CapabilityKey): CapabilityDefinition {
  return CAPABILITIES[key];
}

export function getOperation(
  capability: CapabilityKey,
  operation: string,
): OperationDefinition | undefined {
  return CAPABILITIES[capability].operations[operation];
}
