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
      /** ELISE labels (ADR-050): create/rename/delete a label, never a task. */
      labels: { kind: "write", risk: "low", defaultApproval: "allow_automatically" },
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
      triage: { kind: "read", risk: "low", defaultApproval: "allow_automatically" },
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
  // Team Messaging (ADR-062): read live from the provider, nothing synced. Drafts stay in ELISE;
  // anything other people will read — a message, a reply — waits for the user's approval of the
  // exact text and destination. Reactions are reversible one-emoji writes: they run, audited.
  team_messaging: {
    key: "team_messaging",
    status: "available",
    operations: {
      search: READ,
      listChannels: READ,
      getRecent: READ,
      getThread: READ,
      getMessage: READ,
      findUser: READ,
      // What the user hasn't read yet (ADR-099): read state, never marked as read by ELISE.
      unread: READ,
      draftMessage: WRITE,
      sendMessage: { kind: "external_communication", risk: "high", defaultApproval: "always_ask" },
      reply: { kind: "external_communication", risk: "high", defaultApproval: "always_ask" },
      addReaction: WRITE,
      removeReaction: WRITE,
      // Only when the user asks: a snapshot with its Slack provenance (never automatic indexing).
      saveToKnowledge: WRITE,
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
      // Administration (ADR-035): reads and safe changes run; archiving/removing always asks.
      listSpaces: READ,
      getSpace: READ,
      createSpace: WRITE,
      updateSpace: WRITE,
      moveDocument: WRITE,
      retry: WRITE,
      syncSource: WRITE,
      saveAttachment: WRITE,
      archiveSpace: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
      remove: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
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
      getStats: READ,
      create: WRITE,
      update: WRITE,
      checkIn: WRITE,
      pause: WRITE,
      archive: ARCHIVE,
      restore: WRITE,
      delete: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
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
      update: WRITE,
      moveItem: WRITE,
      // Checked items are soft-removed (recoverable), so no approval prompt.
      clearChecked: WRITE,
      duplicate: WRITE,
      archive: ARCHIVE,
    },
  },
  goals: {
    key: "goals",
    status: "available",
    operations: {
      list: READ,
      getProgress: READ,
      getVision: READ,
      create: WRITE,
      update: WRITE,
      updateProgress: WRITE,
      linkResource: WRITE,
      unlinkResource: WRITE,
      complete: WRITE,
      pause: WRITE,
      archive: ARCHIVE,
      restore: WRITE,
      delete: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
      createVision: WRITE,
      updateVision: WRITE,
      deleteVision: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
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
      setKnowledgeSpaces: WRITE,
      archive: ARCHIVE,
      // ADR-088: tags are the user's own labels; deleting one keeps every note.
      listTags: READ,
      tag: WRITE,
      saveTag: WRITE,
      deleteTag: WRITE,
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
      updateCategory: WRITE,
      deleteCategory: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
      // ADR-083: reversible (the sources are kept; undo brings them back). Asked for explicitly,
      // it just runs; the model only combines when the user asks for it.
      combineTransactions: WRITE,
      importFile: WRITE,
      createCategory: WRITE,
      archiveTransaction: ARCHIVE,
      undoImport: { kind: "destructive", risk: "high", defaultApproval: "always_ask" },
      // ADR-052. Reports and budgets read; Books, budgets and rates are bookkeeping settings.
      listBooks: READ,
      getBudgets: READ,
      createReport: READ,
      saveBook: WRITE,
      setBudget: WRITE,
      setRate: WRITE,
      restoreTransaction: WRITE,
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
      analyze: READ,
      getRecord: READ,
      createRecord: WRITE,
      updateRecord: WRITE,
      archiveRecord: ARCHIVE,
      bulkUpdate: { kind: "write", risk: "high", defaultApproval: "always_ask" },
    },
  },
  // The current external world (ADR-015): server-provided, no user connection. Reading the
  // public web is a read; saving a page to Knowledge is an explicit, recorded write.
  web_search: {
    key: "web_search",
    status: "available",
    internal: true,
    operations: {
      search: READ,
      searchNews: READ,
      open: READ,
      research: READ,
      discover: READ,
      saveToKnowledge: WRITE,
    },
  },
  // Places, addresses and travel (ADR-023): server-provided, no user connection, read-only.
  // Opening a place on a map, calling or booking stay with the user.
  location: {
    key: "location",
    status: "available",
    internal: true,
    operations: {
      searchPlaces: READ,
      getPlace: READ,
      geocode: READ,
      reverseGeocode: READ,
      getRoute: READ,
      compareTravelTimes: READ,
    },
  },
  // Current conditions and forecasts (ADR-038): server-provided, no user connection, read-only.
  weather: {
    key: "weather",
    status: "available",
    internal: true,
    operations: { current: READ, forecast: READ },
  },
  // ELISE Home (ADR-079): the person's own devices through their paired hub. Reading is free;
  // an explicit command on a low-risk device (lights, plugs, climate within its range…) runs
  // at once; deleting a mode asks. Locks, alarms and the like aren't controllable at all.
  home: {
    key: "home",
    status: "available",
    internal: true,
    operations: {
      status: READ,
      control: WRITE,
      runScene: WRITE,
      saveScene: WRITE,
      deleteScene: { kind: "destructive", risk: "medium", defaultApproval: "always_ask" },
    },
  },
  // Public market data (ADR-074): server-provided (FMP), no user connection. Reads need no
  // approval; following an asset is the person's own low-risk preference. No trading, ever.
  markets: {
    key: "markets",
    status: "available",
    internal: true,
    operations: {
      search: READ,
      getQuote: READ,
      getHistory: READ,
      getProfile: READ,
      listWatchlist: READ,
      watch: WRITE,
      unwatch: WRITE,
    },
  },
  // Public economic data (ADR-094): server-provided (DolarApi, ArgentinaDatos), no user
  // connection, read-only. Nothing here touches the user's money.
  economy: {
    key: "economy",
    status: "available",
    internal: true,
    operations: {
      exchangeRates: READ,
      exchangeHistory: READ,
      inflation: READ,
      depositRates: READ,
      indicators: READ,
      holidays: READ,
    },
  },
  // Context Profiles (ADR-016): an organizational layer over the user's data. Proposing,
  // activating and briefing only read (each source under its own permissions); creating or
  // changing a profile is an audited write; archiving asks when ELISE proposes it.
  contexts: {
    key: "contexts",
    status: "available",
    internal: true,
    operations: {
      list: READ,
      get: READ,
      propose: READ,
      activate: READ,
      clear: READ,
      findPeople: READ,
      brief: READ,
      create: WRITE,
      update: WRITE,
      archive: ARCHIVE,
    },
  },
  // ELISE Shortcuts (ADR-017): typed triggers for existing workflows. Proposing and running
  // only read (the steps run as their own tools, under their own policy); saving is an audited
  // write; deleting asks when ELISE proposes it.
  shortcuts: {
    key: "shortcuts",
    status: "available",
    internal: true,
    operations: {
      list: READ,
      propose: READ,
      run: READ,
      create: WRITE,
      update: WRITE,
      enable: WRITE,
      disable: WRITE,
      delete: ARCHIVE,
    },
  },
  // Study Mode (ADR-016): sessions and progress are the user's own learning records.
  study: {
    key: "study",
    status: "available",
    internal: true,
    operations: {
      progress: READ,
      start: WRITE,
      answer: WRITE,
      hint: WRITE,
      next: WRITE,
      reveal: WRITE,
      configure: WRITE,
      end: WRITE,
    },
  },
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
  // Methods (ADR-040): how the user wants work done. Reading and loading are reads; changes
  // are audited writes, every one a version that can be restored (so archiving is reversible
  // too). A Method is instructions only: it never grants a capability or skips an approval.
  methods: {
    key: "methods",
    status: "available",
    internal: true,
    operations: {
      list: READ,
      search: READ,
      get: READ,
      history: READ,
      create: WRITE,
      update: WRITE,
      archive: WRITE,
      restore: WRITE,
      rollback: WRITE,
      attachReference: WRITE,
      removeReference: WRITE,
    },
  },
  // Music (ADR-042): searching and reading playback are reads; playing, pausing, skipping,
  // volume and moving playback are low-risk, reversible writes that never ask. They act on the
  // user's own player only (nothing is shared, sent or bought).
  music: {
    key: "music",
    status: "available",
    operations: {
      search: READ,
      getPlayback: READ,
      listDevices: READ,
      play: WRITE,
      pause: WRITE,
      resume: WRITE,
      next: WRITE,
      previous: WRITE,
      seek: WRITE,
      setVolume: WRITE,
      transfer: WRITE,
    },
  },
  // Native Time (ADR-045): the user's own timers, Pomodoros and stopwatches. Starting, pausing,
  // extending or cancelling one is a low-risk, reversible write: automatic, recorded, audited.
  time: {
    key: "time",
    status: "available",
    internal: true,
    operations: {
      start: WRITE,
      list: READ,
      control: WRITE,
      addTime: WRITE,
      now: READ,
      // Alarms (ADR-100): one alarm at a time; low-risk, audited writes like timers.
      setAlarm: WRITE,
      listAlarms: READ,
      changeAlarm: WRITE,
      deleteAlarm: WRITE,
      alarmAction: WRITE,
      alarmSounds: WRITE,
      alarmDestinations: WRITE,
    },
  },
  // Universal Recall: the user's past interactions, read-only (ADR-012).
  history: {
    key: "history",
    status: "available",
    internal: true,
    operations: {
      search: READ,
      getContext: READ,
      getInteraction: READ,
      getRecent: READ,
      // History organized by Knowledge (ADR-020): organizing the user's own threads.
      listKnowledgeLinks: READ,
      addKnowledgeLink: WRITE,
      removeKnowledgeLink: WRITE,
    },
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
      // The wake phrase and voice behavior (ADR-017 §9): allowlisted values only.
      updateVoice: WRITE,
      // The curated voice (ADR-030): a stable catalog key, never a provider id; reversible.
      getVoice: READ,
      listVoices: READ,
      setVoice: WRITE,
      // ELISE's personality (ADR-076): tone only, never permissions; reversible.
      setPersonality: WRITE,
      listConnections: READ,
      // Mi ELISE (ADR-064): the person's own choice of modules; reversible, audited.
      listModules: READ,
      setModules: WRITE,
      // Memory (ADR-068): the person's own facts; visible and editable in Settings.
      listMemory: READ,
      remember: WRITE,
      forget: WRITE,
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
      // Charts planned from sourced evidence (ADR-027).
      visualize: READ,
      timeline: READ,
      // Answer-first (ADR-071): presentation of what the model already synthesized.
      answer: READ,
      show: READ,
      update: READ,
      focus: READ,
      dismiss: READ,
      clear: READ,
      // The Live Canvas (ADR-021): keep a Surface, or show results in time order.
      pin: READ,
      arrange: READ,
      prepareMeeting: READ,
      // Orchestrations that only gather and present (ADR-017 §14-15).
      planToday: READ,
      // A day's plan, proposed and checked (ADR-098): it never writes; saving is the calendar's.
      proposeDay: READ,
      briefToday: READ,
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
