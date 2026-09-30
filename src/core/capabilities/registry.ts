import type { CapabilityDefinition, CapabilityKey, OperationDefinition } from "./types";

/**
 * Capability registry. Operation defaults follow docs/architecture/08 §15.
 * Capabilities without operations are planned for later MVP slices.
 */
const READ: OperationDefinition = {
  kind: "read",
  risk: "low",
  defaultApproval: "allow_automatically",
};
const WRITE: OperationDefinition = {
  kind: "write",
  risk: "low",
  defaultApproval: "allow_automatically",
};
const ARCHIVE: OperationDefinition = {
  kind: "destructive",
  risk: "medium",
  defaultApproval: "ask_when_uncertain",
};

const CAPABILITIES: Record<CapabilityKey, CapabilityDefinition> = {
  tasks: {
    key: "tasks",
    status: "available",
    operations: {
      list: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      listLists: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      createList: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
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
  // Everyday native writes are automatic; archiving something significant asks when ELISE
  // proposes it (a user acting in the UI is the confirmation).
  habits: {
    key: "habits",
    status: "available",
    operations: {
      list: READ,
      getProgress: READ,
      create: WRITE,
      update: WRITE,
      checkIn: WRITE,
      pause: WRITE,
      archive: ARCHIVE,
    },
  },
  lists: {
    key: "lists",
    status: "available",
    operations: {
      list: READ,
      get: READ,
      create: WRITE,
      rename: WRITE,
      addItem: WRITE,
      updateItem: WRITE,
      checkItem: WRITE,
      uncheckItem: WRITE,
      removeItem: WRITE,
      archive: ARCHIVE,
    },
  },
  goals: {
    key: "goals",
    status: "available",
    operations: {
      list: READ,
      getProgress: READ,
      create: WRITE,
      update: WRITE,
      linkResource: WRITE,
      unlinkResource: WRITE,
      complete: WRITE,
      pause: WRITE,
      archive: ARCHIVE,
    },
  },
  notes: {
    key: "notes",
    status: "available",
    operations: {
      list: READ,
      get: READ,
      search: READ,
      create: WRITE,
      update: WRITE,
      archive: ARCHIVE,
    },
  },
  // Everyday bookkeeping is automatic; archiving asks when ELISE proposes it, and undoing a
  // whole import always asks. Connected sheets are read-only (their binding grants "read").
  finance: {
    key: "finance",
    status: "available",
    operations: {
      getSummary: READ,
      query: READ,
      listTransactions: READ,
      getTransaction: READ,
      listAccounts: READ,
      listCategories: READ,
      createTransaction: WRITE,
      updateTransaction: WRITE,
      createAccount: WRITE,
      updateAccount: WRITE,
      createCategory: WRITE,
      archiveTransaction: ARCHIVE,
      undoImport: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
    },
  },
  // Mapped external databases (Notion today). Small writes follow the usual policy; archiving
  // asks when ELISE proposes it; bulk changes always ask, with count and sample.
  structured: {
    key: "structured",
    status: "available",
    operations: {
      listSources: READ,
      getSchema: READ,
      query: READ,
      getRecord: READ,
      createRecord: WRITE,
      updateRecord: WRITE,
      archiveRecord: ARCHIVE,
      bulkUpdate: { kind: "write", risk: "high", defaultApproval: "always_ask" },
    },
  },
  web_search: { key: "web_search", status: "planned", operations: {} },
  voice: { key: "voice", status: "planned", operations: {} },
  // Proposing a Schedule from chat changes nothing: the user confirms on a card. Pausing or
  // resuming one is a reversible, audited write.
  schedules: {
    key: "schedules",
    status: "available",
    internal: true,
    operations: {
      propose: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
      list: READ,
      pause: WRITE,
      resume: WRITE,
    },
  },
  // Universal Recall: the user's past interactions, read-only (ADR-012).
  history: {
    key: "history",
    status: "available",
    internal: true,
    operations: { search: READ, getContext: READ, getInteraction: READ, getRecent: READ },
  },
  // ELISE's own product settings for this user: allowlisted values, audited (ADR-012).
  settings: {
    key: "settings",
    status: "available",
    internal: true,
    operations: {
      get: READ,
      update: WRITE,
      getAppearance: READ,
      setTheme: WRITE,
      setAccent: WRITE,
      getNotifications: READ,
      updateNotifications: WRITE,
      listConnections: READ,
    },
  },
  // Live Workspace (ADR-013): presentation only — no user data changes, so reads. Meeting
  // prep reads other capabilities through the executor, each under its own permissions.
  workspace: {
    key: "workspace",
    status: "available",
    internal: true,
    operations: {
      listSurfaces: READ,
      present: READ,
      update: READ,
      focus: READ,
      dismiss: READ,
      clear: READ,
      prepareMeeting: READ,
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
