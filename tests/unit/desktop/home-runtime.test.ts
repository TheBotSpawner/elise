import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { HomeRuntimeRequirement, HomeRuntimeStatus } from "@/core/home/runtime";
import { resumePhase } from "@/core/home/runtime";

import {
  RuntimeError,
  type HomeRuntimeBackend,
} from "../../../desktop/src/runtime/home-runtime/backend";
import { downloadVerified } from "../../../desktop/src/runtime/home-runtime/download";
import { bootstrapEngine } from "../../../desktop/src/runtime/home-runtime/ha-bootstrap";
import {
  HomeRuntimeManager,
  type PersistedRuntime,
} from "../../../desktop/src/runtime/home-runtime/manager";
import {
  CURRENT_HOME_RUNTIME,
  HOME_RUNTIME_RELEASES,
} from "../../../desktop/src/runtime/home-runtime/releases";
import {
  provisionScript,
  withMirroredNetworking,
  WslContainerBackend,
} from "../../../desktop/src/runtime/home-runtime/wsl-backend";

/**
 * The managed ELISE Home runtime (ADR-082) with a fake backend: no VM, container or Home
 * Assistant in CI. Phases, progress, verification, recovery, retry, updates and reset.
 */
const ok = (key: HomeRuntimeRequirement["key"]): HomeRuntimeRequirement => ({
  key,
  ok: true,
  fix: "none",
});

function fakeBackend(over: Partial<HomeRuntimeBackend> = {}) {
  let installed = false;
  let running = false;
  const calls: string[] = [];
  const backend: HomeRuntimeBackend = {
    kind: "wsl_container",
    checkRequirements: async () => (calls.push("check"), [ok("wsl"), ok("disk")]),
    enableRequirements: async () => (calls.push("enable"), { restartRequired: false }),
    download: async (_r, onProgress) => {
      calls.push("download");
      onProgress({ stage: "downloading_base", receivedBytes: 50, totalBytes: 100 });
      onProgress({ stage: "verifying" });
      return "artifact";
    },
    install: async () => {
      calls.push("install");
      installed = true;
    },
    isInstalled: async () => installed,
    start: async () => {
      calls.push("start");
      running = true;
    },
    stop: async () => {
      calls.push("stop");
      running = false;
    },
    healthy: async () => running,
    bootstrap: async () => (
      calls.push("bootstrap"),
      { haUrl: "http://127.0.0.1:8123", haToken: "llat", ownerPassword: "pw" }
    ),
    backup: async () => (calls.push("backup"), "backup.tar.gz"),
    restore: async () => void calls.push("restore"),
    reset: async () => {
      calls.push("reset");
      installed = false;
    },
    ...over,
  };
  return { backend, calls, setInstalled: (v: boolean) => (installed = v) };
}

function memoryStore(initial: PersistedRuntime | null = null) {
  let state = initial;
  return { load: () => state, save: (s: PersistedRuntime) => void (state = s), get: () => state };
}

function manager(backend: HomeRuntimeBackend, store = memoryStore(), creds = { has: false }) {
  const m = new HomeRuntimeManager(backend, store, {
    language: "es",
    hasCredentials: () => creds.has,
    healthIntervalMs: 60_000,
  });
  const phases: string[] = [];
  const progress: HomeRuntimeStatus["progress"][] = [];
  m.on("status", (s: HomeRuntimeStatus) => {
    if (phases.at(-1) !== s.phase) phases.push(s.phase);
    progress.push(s.progress);
  });
  m.on("credentials", () => (creds.has = true));
  return { m, phases, progress, store };
}

describe("setup", () => {
  it("not installed → requirements → real progress → verified → installed → ready, credentials once", async () => {
    const { backend, calls } = fakeBackend();
    const creds = vi.fn();
    const { m, phases, progress } = manager(backend);
    m.on("credentials", creds);
    expect(m.status().phase).toBe("not_installed");
    await m.setup();
    expect(phases).toEqual([
      "checking_requirements",
      "downloading",
      "verifying",
      "installing",
      "starting",
      "ready",
    ]);
    expect(progress).toContainEqual({
      stage: "downloading_base",
      receivedBytes: 50,
      totalBytes: 100,
    });
    expect(calls).toEqual(["check", "download", "install", "start", "bootstrap"]);
    expect(creds).toHaveBeenCalledWith({
      haUrl: "http://127.0.0.1:8123",
      haToken: "llat",
      ownerPassword: "pw",
    });
    expect(m.status()).toMatchObject({
      phase: "ready",
      enabled: true,
      version: CURRENT_HOME_RUNTIME.version,
      error: null,
    });
    m.dispose();
  });

  it("a missing Windows feature waits for the person; enabling it may need one restart", async () => {
    const { backend, calls } = fakeBackend({
      checkRequirements: async () => [ok("disk"), { key: "wsl", ok: false, fix: "enable" }],
      enableRequirements: async () => ({ restartRequired: true }),
    });
    const { m } = manager(backend);
    await m.setup();
    expect(m.status()).toMatchObject({
      phase: "requirements_missing",
      error: { code: "HOME_RUNTIME_REQUIREMENT_MISSING" },
    });
    expect(calls).not.toContain("download");
    await m.enableRequirements();
    expect(m.status().phase).toBe("restart_required");
  });

  it("a requirement only the person can fix says which (disk, unsupported host)", async () => {
    const { backend } = fakeBackend({
      checkRequirements: async () => [
        { key: "disk", ok: false, fix: "person", detail: "3 GB free" },
      ],
    });
    const { m } = manager(backend);
    await m.setup();
    expect(m.status().error).toEqual({ code: "HOME_RUNTIME_DISK_LOW", detail: "3 GB free" });
  });

  it("checksum failure → error the person can retry; retry succeeds", async () => {
    let fail = true;
    const { backend } = fakeBackend({
      download: async () => {
        if (fail) throw new RuntimeError("HOME_RUNTIME_VERIFY_FAILED", "checksum mismatch");
        return "artifact";
      },
    });
    const { m } = manager(backend);
    await m.setup();
    expect(m.status()).toMatchObject({
      phase: "error",
      error: { code: "HOME_RUNTIME_VERIFY_FAILED" },
    });
    fail = false;
    await m.setup();
    expect(m.status().phase).toBe("ready");
    m.dispose();
  });

  it("start failure is reported; a retry starts it", async () => {
    let fail = true;
    const { backend } = fakeBackend({
      start: async () => {
        if (fail) throw new Error("engine exited");
      },
    });
    const { m } = manager(backend);
    await m.setup();
    expect(m.status()).toMatchObject({
      phase: "error",
      error: { code: "HOME_RUNTIME_START_FAILED" },
    });
    fail = false;
    await m.start();
    expect(m.status().phase).toBe("ready");
    m.dispose();
  });

  it("one operation at a time: a second setup while busy doesn't run twice", async () => {
    const { backend, calls } = fakeBackend();
    const { m } = manager(backend);
    await Promise.all([m.setup(), m.setup()]);
    expect(calls.filter((c) => c === "download")).toHaveLength(1);
    m.dispose();
  });
});

describe("recovery and lifecycle", () => {
  it("restart in the middle of installing → setup resumes (never stuck on Preparando…)", async () => {
    const store = memoryStore({
      phase: "installing",
      enabled: true,
      version: null,
      error: null,
      updatedAt: "",
    });
    const { backend, calls } = fakeBackend();
    const { m } = manager(backend, store);
    await m.init();
    expect(calls).toContain("download");
    expect(m.status().phase).toBe("ready");
    m.dispose();
  });

  it("after a quit or reboot an installed, enabled engine starts again; credentials kept", async () => {
    const store = memoryStore({
      phase: "stopped",
      enabled: true,
      version: "x",
      error: null,
      updatedAt: "",
    });
    const { backend, calls, setInstalled } = fakeBackend();
    setInstalled(true);
    const { m } = manager(backend, store, { has: true });
    await m.init();
    expect(calls).toEqual(["start"]);
    expect(m.status().phase).toBe("ready");
    m.dispose();
  });

  it("not enabled → nothing runs by itself", async () => {
    const { backend, calls } = fakeBackend();
    const { m } = manager(backend);
    await m.init();
    expect(calls).toEqual([]);
  });

  it("stop / start, and resumePhase maps every interrupted phase sensibly", async () => {
    const { backend } = fakeBackend();
    const { m } = manager(backend);
    await m.setup();
    await m.stop();
    expect(m.status().phase).toBe("stopped");
    await m.start();
    expect(m.status().phase).toBe("ready");
    m.dispose();
    expect(resumePhase("downloading", false)).toBe("downloading");
    expect(resumePhase("verifying", false)).toBe("downloading");
    expect(resumePhase("restart_required", false)).toBe("checking_requirements");
    expect(resumePhase("updating", true)).toBe("starting");
    expect(resumePhase("ready", false)).toBe("not_installed");
  });

  it("update: backup → stop → install new → start; a failed update rolls back and keeps running", async () => {
    const { backend, calls } = fakeBackend();
    const { m } = manager(backend, memoryStore(), { has: true });
    await m.setup();
    const next = { ...CURRENT_HOME_RUNTIME, version: "2099.1.0-elise.1" };
    calls.length = 0;
    await m.update(next);
    expect(calls).toEqual(["backup", "stop", "download", "install", "start"]);
    expect(m.status()).toMatchObject({ phase: "ready", version: "2099.1.0-elise.1" });

    const broken = fakeBackend({
      install: async () => {
        throw new RuntimeError("HOME_RUNTIME_INSTALL_FAILED", "boom");
      },
    });
    broken.setInstalled(true);
    const b = manager(
      broken.backend,
      memoryStore({ phase: "ready", enabled: true, version: "old", error: null, updatedAt: "" }),
      { has: true },
    );
    await b.m.update(next);
    expect(broken.calls).toEqual(["backup", "stop", "download", "restore", "start"]);
    expect(b.m.status()).toMatchObject({
      phase: "ready",
      version: "old",
      error: { code: "HOME_RUNTIME_INSTALL_FAILED" },
    });
    m.dispose();
    b.m.dispose();
  });

  it("reset removes the engine and turns Home off", async () => {
    const { backend, calls } = fakeBackend();
    const { m } = manager(backend);
    await m.setup();
    await m.reset();
    expect(calls.slice(-2)).toEqual(["stop", "reset"]);
    expect(m.status()).toMatchObject({ phase: "not_installed", enabled: false, version: null });
  });
});

describe("artifacts and provisioning", () => {
  it("every allowlisted release is pinned (https base with sha256, engine by digest)", () => {
    for (const r of HOME_RUNTIME_RELEASES) {
      expect(r.base.url).toMatch(/^https:\/\//);
      expect(r.base.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(r.engineImage).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(() => provisionScript(r)).not.toThrow();
    }
    expect(() =>
      provisionScript({ ...CURRENT_HOME_RUNTIME, engineImage: "ghcr.io/x/y:latest" }),
    ).toThrow();
  });

  it("downloads resume with Range, verify SHA-256, and never keep a bad file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elise-dl-"));
    const body = Buffer.from("elise home runtime artifact");
    const sha = createHash("sha256").update(body).digest("hex");
    writeFileSync(join(dir, "a.bin.part"), body.subarray(0, 10)); // a previous partial run
    const ranges: (string | null)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("range");
      ranges.push(range);
      const from = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
      return new Response(body.subarray(from), { status: range ? 206 : 200 });
    }) as typeof fetch;
    const progress = vi.fn();
    const file = await downloadVerified({
      url: "https://example.org/a.bin",
      sha256: sha,
      sizeBytes: body.length,
      file: join(dir, "a.bin"),
      onProgress: progress,
      fetchImpl,
      retries: 0,
    });
    expect(ranges).toEqual(["bytes=10-"]);
    expect(readFileSync(file)).toEqual(body);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ totalBytes: body.length }));

    await expect(
      downloadVerified({
        url: "https://example.org/b.bin",
        sha256: "0".repeat(64),
        sizeBytes: body.length,
        file: join(dir, "b.bin"),
        onProgress: () => undefined,
        fetchImpl,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: "HOME_RUNTIME_VERIFY_FAILED" });
    await expect(
      downloadVerified({
        url: "http://example.org/c",
        sha256: sha,
        sizeBytes: 1,
        file: join(dir, "c"),
        onProgress: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "HOME_RUNTIME_DOWNLOAD_FAILED" });
  });

  it("mirrored networking is added once, keeping the person's other WSL settings", () => {
    expect(withMirroredNetworking("")).toBe("[wsl2]\nnetworkingMode=mirrored\n");
    expect(withMirroredNetworking("[wsl2]\nmemory=8GB\n")).toBe(
      "[wsl2]\nnetworkingMode=mirrored\nmemory=8GB\n",
    );
    expect(withMirroredNetworking("[wsl2]\nnetworkingMode=NAT\n")).toBe(
      "[wsl2]\nnetworkingMode=mirrored\n",
    );
    expect(withMirroredNetworking("[wsl2]\nnetworkingMode=mirrored\n")).toBeNull();
  });

  it("WSL installed but no hypervisor (Virtual Machine Platform off or pending restart) isn't ready", async () => {
    const commands: string[] = [];
    let hypervisor = "False";
    const run = async (file: string, args: string[]) => {
      const cmd = `${file.split(/[\\/]/).pop()} ${args.join(" ")}`;
      commands.push(cmd);
      if (cmd.includes("EncodedCommand")) return { code: 0, out: "" };
      if (cmd.includes("HypervisorPresent")) return { code: 0, out: `${hypervisor}|True` };
      if (cmd.includes("--version")) return { code: 0, out: "WSL version: 3.0.3.0" };
      if (cmd.includes("--list")) return { code: 0, out: "" };
      if (cmd.includes("--import"))
        return {
          code: 1,
          out: "Error code: Wsl/Service/RegisterDistro/CreateVm/HCS/HCS_E_SERVICE_NOT_AVAILABLE",
        };
      return { code: 0, out: "" }; // --status answers without a hypervisor
    };
    const dir = mkdtempSync(join(tmpdir(), "elise-wsl-"));
    const backend = new WslContainerBackend(dir, "UTC", run);
    const wsl = (await backend.checkRequirements()).find((r) => r.key === "wsl")!;
    expect(wsl).toMatchObject({ ok: false, fix: "enable" });
    expect(wsl.detail).toMatch(/Virtual Machine Platform/);
    // Enabling turns the platform on explicitly; no running hypervisor yet → one restart.
    expect((await backend.enableRequirements()).restartRequired).toBe(true);
    const elevated = commands.find((c) => c.includes("EncodedCommand"))!;
    const encoded = /EncodedCommand','([^']+)'/.exec(elevated)![1]!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(
      "/featurename:VirtualMachinePlatform",
    );
    // After the restart the hypervisor runs: ready.
    hypervisor = "True";
    expect((await backend.checkRequirements()).find((r) => r.key === "wsl")?.ok).toBe(true);
  });
});

describe("engine bootstrap", () => {
  it("ELISE becomes the owner through onboarding and mints its own long-lived token", async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (init?.method === "POST") posts.push(path);
      if (path === "/api/onboarding") return Response.json([{ step: "user", done: false }]);
      if (path === "/api/onboarding/users") return Response.json({ auth_code: "code" });
      if (path === "/auth/token")
        return Response.json({ access_token: "access", refresh_token: "r" });
      return Response.json({});
    }) as typeof fetch;
    class FakeWS {
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "auth_required" }) }));
      }
      send(raw: string) {
        const msg = JSON.parse(raw);
        const reply =
          msg.type === "auth"
            ? { type: msg.access_token === "access" ? "auth_ok" : "auth_invalid" }
            : {
                type: "result",
                success: msg.type === "auth/long_lived_access_token",
                result: "llat",
              };
        setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }));
      }
      close() {}
    }
    const creds = await bootstrapEngine(
      "http://127.0.0.1:8123",
      "es",
      fetchImpl,
      FakeWS as unknown as typeof WebSocket,
    );
    expect(creds).toMatchObject({ haUrl: "http://127.0.0.1:8123", haToken: "llat" });
    expect(creds.ownerPassword).toHaveLength(32);
    expect(posts).toEqual([
      "/api/onboarding/users",
      "/auth/token",
      "/api/onboarding/core_config",
      "/api/onboarding/analytics",
      "/api/onboarding/integration",
    ]);
  });

  it("an engine someone else already owns is never taken over", async () => {
    const fetchImpl = (async () =>
      Response.json([{ step: "user", done: true }])) as unknown as typeof fetch;
    await expect(bootstrapEngine("http://127.0.0.1:8123", "en", fetchImpl)).rejects.toMatchObject({
      code: "HOME_RUNTIME_BOOTSTRAP_FAILED",
    });
  });
});
