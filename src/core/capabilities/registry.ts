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
  email: {
    key: "email",
    status: "available",
    operations: {
      search: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listRecent: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      getMessage: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      getThread: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      findFollowUps: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      // Drafts never leave the mailbox: creating and editing them is low-friction.
      createDraft: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      reply: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      updateDraft: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      discardDraft: { kind: "destructive", risk: "medium", defaultApproval: "ask_when_uncertain" },
      // Sending reaches people outside ELISE: approval by default (docs/architecture/15 §14).
      sendDraft: {
        kind: "external_communication",
        risk: "high",
        defaultApproval: "always_ask",
      },
      // Reversible mailbox changes; tools escalate bulk changes to an approval.
      archive: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      markRead: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
      markUnread: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
    },
  },
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
  // ELISE owns the Knowledge index (whatever fed it): searched in place, never via a provider.
  knowledge: {
    key: "knowledge",
    status: "available",
    internal: true,
    operations: {
      search: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      getItem: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listSources: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listRecentChanges: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      compare: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      overview: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
    },
  },
  habits: { key: "habits", status: "planned", operations: {} },
  lists: { key: "lists", status: "planned", operations: {} },
  goals: { key: "goals", status: "planned", operations: {} },
  notes: { key: "notes", status: "planned", operations: {} },
  finance: { key: "finance", status: "planned", operations: {} },
  web_search: { key: "web_search", status: "planned", operations: {} },
  voice: { key: "voice", status: "planned", operations: {} },
  // Proposing a Schedule from chat changes nothing: the user confirms on a card.
  schedules: {
    key: "schedules",
    status: "available",
    internal: true,
    operations: {
      propose: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
    },
  },
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
