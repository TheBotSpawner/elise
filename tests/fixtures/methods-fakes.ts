import { AppError } from "@/core/errors";
import type {
  Method,
  MethodReference,
  MethodStore,
  MethodVersion,
  SpaceRef,
} from "@/core/skills/model";

/**
 * In-memory MethodStore that behaves like the database: content changes bump the version and
 * append a snapshot; status changes don't.
 */
export class InMemoryMethodStore implements MethodStore {
  constructor(private readonly spaceList: SpaceRef[] = []) {}

  methods = new Map<string, Method>();
  history = new Map<string, MethodVersion[]>();
  refs = new Map<string, MethodReference[]>();
  attachments = new Map<string, { name: string; text: string }>();

  private snapshot(m: Method, source: MethodVersion["changeSource"]) {
    this.history.set(m.id, [
      ...(this.history.get(m.id) ?? []),
      {
        version: m.version,
        name: m.name,
        description: m.description,
        instructions: m.instructions,
        hints: m.hints,
        spaceId: m.spaceId,
        changeSummary: m.changeSummary,
        changeSource: source,
        createdAt: new Date().toISOString(),
      },
    ]);
  }
  async index() {
    return [...this.methods.values()].filter((m) => m.status === "active");
  }
  async list() {
    return [...this.methods.values()];
  }
  async get(id: string) {
    const m = this.methods.get(id);
    if (!m) throw new AppError("NOT_FOUND", "Method not found");
    return { ...m };
  }
  async create(
    input: Parameters<MethodStore["create"]>[0],
    p: Parameters<MethodStore["create"]>[1],
  ) {
    const m: Method = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      hints: input.hints ?? [],
      spaceId: input.spaceId ?? null,
      platforms: input.platforms ?? ["web"],
      version: 1,
      status: "active",
      changeSummary: p.summary,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.methods.set(m.id, m);
    this.snapshot(m, p.source);
    return { ...m };
  }
  async update(
    id: string,
    patch: Parameters<MethodStore["update"]>[1],
    p: Parameters<MethodStore["update"]>[2],
  ) {
    const old = await this.get(id);
    const next: Method = { ...old, ...patch, spaceId: patch.spaceId ?? old.spaceId } as Method;
    const changed =
      (["name", "description", "instructions", "spaceId"] as const).some(
        (k) => next[k] !== old[k],
      ) || JSON.stringify(next.hints) !== JSON.stringify(old.hints);
    if (changed) {
      next.version = old.version + 1;
      next.changeSummary = p.summary;
      this.methods.set(id, next);
      this.snapshot(next, p.source);
    }
    return { ...this.methods.get(id)! };
  }
  async setStatus(id: string, status: Method["status"]) {
    const m = await this.get(id);
    this.methods.set(id, { ...m, status });
    return { ...m, status };
  }
  async versions(id: string) {
    return [...(this.history.get(id) ?? [])].reverse();
  }
  async references(id: string) {
    return this.refs.get(id) ?? [];
  }
  async addReference(id: string, ref: Parameters<MethodStore["addReference"]>[1]) {
    const file = ref.source === "attachment" ? this.attachments.get(ref.attachmentId) : null;
    if (ref.source === "attachment" && !file)
      throw new AppError("NOT_FOUND", "Attachment not found");
    const r: MethodReference = {
      id: crypto.randomUUID(),
      kind: ref.kind,
      title: ref.source === "text" ? ref.title : (file?.name ?? "Document"),
      sourceType:
        ref.source === "attachment"
          ? "chat_attachment"
          : ref.source === "knowledge_item"
            ? "knowledge_item"
            : "text",
      mimeType: null,
      attachmentId: ref.source === "attachment" ? ref.attachmentId : null,
      knowledgeItemId: ref.source === "knowledge_item" ? ref.itemId : null,
      content: ref.source === "text" ? ref.content : (file?.text ?? null),
      createdAt: new Date().toISOString(),
    };
    this.refs.set(id, [...(this.refs.get(id) ?? []), r]);
    return r;
  }
  async removeReference(id: string, referenceId: string) {
    this.refs.set(
      id,
      (this.refs.get(id) ?? []).filter((r) => r.id !== referenceId),
    );
  }
  async spaces() {
    return this.spaceList;
  }
}
