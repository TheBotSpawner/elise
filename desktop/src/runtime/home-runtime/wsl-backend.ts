import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, release as osRelease, totalmem } from "node:os";
import { join } from "node:path";

import type { HomeRuntimeRequirement } from "@/core/home/runtime";

import { RuntimeError, type HomeRuntimeBackend } from "./backend";
import { downloadVerified } from "./download";
import { bootstrapEngine } from "./ha-bootstrap";
import type { HomeRuntimeRelease } from "./releases";

/**
 * ELISE Home on Windows (ADR-082): Home Assistant Container inside ELISE's own WSL2 distro
 * ("ELISE-Home"), with WSL's mirrored networking so the engine sits on the home's LAN (mDNS,
 * SSDP, local IPs) instead of behind NAT. No Docker Desktop, no VirtualBox: WSL is a Windows
 * component, turned on once with admin rights (and usually one restart).
 *
 * Every command is a fixed executable with fixed arguments (no shell strings built from input);
 * the only variable values are the pinned release and a validated time zone.
 */
export const DISTRO = "ELISE-Home";
const CONTAINER = "elise-home";
const ENGINE_URL = "http://127.0.0.1:8123";
const WSL_VM_CREATOR = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}";
const MIN_BUILD = 22621; // Windows 11 22H2: first with WSL mirrored networking
const MIN_MEMORY = 4 * 1024 ** 3;
const MIN_DISK = 12 * 1024 ** 3;

const SYSTEM32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const WSL = join(SYSTEM32, "wsl.exe");
const POWERSHELL = join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");

type Run = (
  file: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ code: number; out: string }>;

const runProcess: Run = (file, args, timeoutMs = 120_000) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, WSL_UTF8: "1" },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          out: `${stdout}${stderr}`.replace(/\0/g, ""),
        }),
    );
  });

/** Inside the distro, as root: fixed script, pinned values only. */
export function provisionScript(release: HomeRuntimeRelease) {
  if (!/^[\w./:-]+@sha256:[0-9a-f]{64}$/.test(release.engineImage))
    throw new RuntimeError("HOME_RUNTIME_INSTALL_FAILED", "engine image must be pinned by digest");
  return [
    "set -eu",
    // apk verifies every package signature.
    "apk update >/dev/null",
    "apk add --no-cache podman fuse-overlayfs tzdata ca-certificates >/dev/null",
    "mkdir -p /etc/containers /var/lib/elise-home/config",
    `printf '[engine]\\ncgroup_manager = "cgroupfs"\\nevents_logger = "file"\\n' > /etc/containers/containers.conf`,
    // The engine listens on this computer only; ELISE is its only client.
    "[ -f /var/lib/elise-home/config/configuration.yaml ] || printf 'default_config:\\nhttp:\\n  server_host: 127.0.0.1\\n' > /var/lib/elise-home/config/configuration.yaml",
    // Pulled by digest: the registry and podman verify the content.
    `podman pull --quiet ${release.engineImage} >/dev/null`,
    `printf '%s\\n' '${release.engineImage}' > /var/lib/elise-home/engine-image`,
  ].join(" && ");
}

/** Mirrored networking puts WSL on the LAN. Global to WSL: the original file is kept aside. */
export function withMirroredNetworking(original: string): string | null {
  if (/^\s*networkingMode\s*=\s*mirrored\s*$/im.test(original)) return null;
  const lines = original.split(/\r?\n/);
  const without = lines.filter((l) => !/^\s*networkingMode\s*=/i.test(l));
  const at = without.findIndex((l) => /^\s*\[wsl2\]\s*$/i.test(l));
  if (at === -1)
    return `${without.join("\n").trimEnd()}\n\n[wsl2]\nnetworkingMode=mirrored\n`.trimStart();
  without.splice(at + 1, 0, "networkingMode=mirrored");
  return `${without.join("\n").trimEnd()}\n`;
}

export class WslContainerBackend implements HomeRuntimeBackend {
  readonly kind = "wsl_container" as const;
  private child: ChildProcess | null = null;
  private tail: string[] = [];

  constructor(
    private readonly dataDir: string,
    private readonly timezone: string,
    private readonly run: Run = runProcess,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void = () =>
      undefined,
  ) {}

  private get tz() {
    return /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(this.timezone) ? this.timezone : "UTC";
  }

  async checkRequirements(): Promise<HomeRuntimeRequirement[]> {
    const build = Number(osRelease().split(".")[2] ?? 0);
    const disk = await statfs(this.dataDir)
      .then((s) => s.bavail * s.bsize)
      .catch(() => 0);
    const virt = await this.run(POWERSHELL, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$c=Get-CimInstance Win32_ComputerSystem; $p=Get-CimInstance Win32_Processor | Select-Object -First 1; "$($c.HypervisorPresent)|$($p.VirtualizationFirmwareEnabled)"',
    ]);
    const [hypervisor, firmware] = virt.out.trim().split("|");
    const wsl = await this.run(WSL, ["--version"], 30_000);
    const wslVersion = /WSL[^:\n]*:\s*(\d+)\.(\d+)/i.exec(wsl.out);
    const wslOk = wsl.code === 0 && Number(wslVersion?.[1] ?? 0) >= 2;
    return [
      {
        key: "windows_version",
        ok: process.platform === "win32" && build >= MIN_BUILD,
        fix: "person",
        detail: `build ${build}, needs ${MIN_BUILD}+ (Windows 11 22H2)`,
      },
      { key: "architecture", ok: process.arch === "x64", fix: "person", detail: process.arch },
      {
        key: "memory",
        ok: totalmem() >= MIN_MEMORY,
        fix: "person",
        detail: `${Math.round(totalmem() / 1024 ** 3)} GB (8 GB recommended)`,
      },
      {
        key: "disk",
        ok: disk >= MIN_DISK,
        fix: "person",
        detail: `${Math.round(disk / 1024 ** 3)} GB free, needs 12 GB`,
      },
      {
        key: "virtualization",
        // Firmware virtualization on is enough: turning WSL on starts the hypervisor.
        ok: /true/i.test(hypervisor ?? "") || /true/i.test(firmware ?? ""),
        fix: "person",
        detail: `hypervisor=${hypervisor ?? "?"} firmware=${firmware ?? "?"}`,
      },
      {
        key: "wsl",
        ok: wslOk,
        fix: "enable",
        detail: wslOk ? wslVersion?.[0] : "WSL 2 not installed",
      },
    ];
  }

  async enableRequirements(): Promise<{ restartRequired: boolean }> {
    // One elevated step: the WSL platform + inbound discovery replies (mDNS, SSDP) for WSL only.
    const rule = (name: string, port: number) =>
      `try { if (-not (Get-NetFirewallHyperVRule -Name '${name}' -ErrorAction SilentlyContinue)) { New-NetFirewallHyperVRule -Name '${name}' -DisplayName 'ELISE Home (${name})' -Direction Inbound -VMCreatorId '${WSL_VM_CREATOR}' -Protocol UDP -LocalPorts ${port} -Action Allow | Out-Null } } catch {}`;
    const script = [
      "& wsl.exe --install --no-distribution --web-download",
      "$code = $LASTEXITCODE",
      rule("ELISE-Home-mDNS", 5353),
      rule("ELISE-Home-SSDP", 1900),
      "exit $code",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const r = await this.run(
      POWERSHELL,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Start-Process -FilePath '${POWERSHELL}' -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -Verb RunAs -Wait -WindowStyle Hidden -PassThru; exit $p.ExitCode`,
      ],
      20 * 60_000,
    );
    if (/cancel/i.test(r.out))
      throw new RuntimeError(
        "HOME_RUNTIME_ELEVATION_DECLINED",
        "administrator permission declined",
      );
    if (r.code !== 0 && r.code !== 3010)
      throw new RuntimeError("HOME_RUNTIME_REQUIREMENT_MISSING", `enabling WSL failed (${r.code})`);
    // Fresh platform features take effect after a restart (3010 = restart needed).
    const now = await this.run(WSL, ["--status"], 30_000);
    return { restartRequired: r.code === 3010 || now.code !== 0 };
  }

  download(release: HomeRuntimeRelease, onProgress: Parameters<HomeRuntimeBackend["download"]>[1]) {
    return mkdir(join(this.dataDir, "downloads"), { recursive: true }).then(() =>
      downloadVerified({
        url: release.base.url,
        sha256: release.base.sha256,
        sizeBytes: release.base.sizeBytes,
        file: join(this.dataDir, "downloads", `base-${release.base.sha256.slice(0, 12)}.tar.gz`),
        onProgress,
      }),
    );
  }

  private async registered() {
    const r = await this.run(WSL, ["--list", "--quiet"], 30_000);
    return r.code === 0 && r.out.split(/\r?\n/).some((l) => l.trim() === DISTRO);
  }

  private async ensureMirrored() {
    const file = join(homedir(), ".wslconfig");
    const original = existsSync(file) ? await readFile(file, "utf8") : "";
    const next = withMirroredNetworking(original);
    if (next === null) return;
    const backup = join(this.dataDir, "wslconfig.backup");
    if (!existsSync(backup)) await writeFile(backup, original);
    await writeFile(file, next);
    this.log("home_runtime_wsl_networking", { mode: "mirrored" });
    await this.run(WSL, ["--shutdown"], 60_000); // applies on the next start
  }

  async install(
    release: HomeRuntimeRelease,
    artifact: string,
    onProgress: Parameters<HomeRuntimeBackend["install"]>[2],
  ) {
    await this.ensureMirrored();
    if (!(await this.registered())) {
      const target = join(this.dataDir, "distro");
      await mkdir(target, { recursive: true });
      const r = await this.run(
        WSL,
        ["--import", DISTRO, target, artifact, "--version", "2"],
        10 * 60_000,
      );
      if (r.code !== 0) throw new RuntimeError("HOME_RUNTIME_INSTALL_FAILED", r.out.slice(0, 200));
    }
    onProgress({ stage: "downloading_engine" });
    const p = await this.run(
      WSL,
      ["-d", DISTRO, "-u", "root", "--", "/bin/sh", "-c", provisionScript(release)],
      60 * 60_000,
    );
    if (p.code !== 0)
      throw new RuntimeError(
        /network|resolve|timeout|fetch/i.test(p.out)
          ? "HOME_RUNTIME_NETWORK_FAILED"
          : "HOME_RUNTIME_INSTALL_FAILED",
        p.out.slice(-300),
      );
    onProgress({ stage: "configuring" });
  }

  isInstalled() {
    return this.registered();
  }

  private async engineImage() {
    const r = await this.run(
      WSL,
      ["-d", DISTRO, "-u", "root", "--", "cat", "/var/lib/elise-home/engine-image"],
      30_000,
    );
    const image = r.out.trim();
    if (r.code !== 0 || !/@sha256:[0-9a-f]{64}$/.test(image))
      throw new RuntimeError("HOME_RUNTIME_START_FAILED", "engine not provisioned");
    return image;
  }

  async start() {
    if (this.child && this.child.exitCode === null && (await this.healthy())) return;
    const image = await this.engineImage();
    // Foreground on purpose: this process keeps the distro alive and is supervised here.
    const child = spawn(
      WSL,
      [
        "-d",
        DISTRO,
        "-u",
        "root",
        "--",
        "podman",
        "run",
        "--rm",
        "--replace",
        "--name",
        CONTAINER,
        "--network=host",
        "-e",
        `TZ=${this.tz}`,
        "-v",
        "/var/lib/elise-home/config:/config",
        image,
      ],
      { windowsHide: true, env: { ...process.env, WSL_UTF8: "1" } },
    );
    this.child = child;
    const keep = (d: Buffer) => {
      this.tail = [...this.tail, ...d.toString().split(/\r?\n/).filter(Boolean)].slice(-50);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new RuntimeError(
          "HOME_RUNTIME_START_FAILED",
          this.tail.slice(-5).join(" | ").slice(0, 300),
        );
      if (await this.healthy()) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new RuntimeError("HOME_RUNTIME_START_FAILED", "engine didn't answer in 5 minutes");
  }

  async stop() {
    await this.run(
      WSL,
      ["-d", DISTRO, "-u", "root", "--", "podman", "stop", "-t", "20", CONTAINER],
      60_000,
    );
    this.child?.kill();
    this.child = null;
    await this.run(WSL, ["--terminate", DISTRO], 60_000);
  }

  async healthy() {
    try {
      const res = await fetch(`${ENGINE_URL}/api/`, { signal: AbortSignal.timeout(5000) });
      return res.status === 401 || res.ok; // up (and asking for auth)
    } catch {
      return false;
    }
  }

  bootstrap(language: string) {
    return bootstrapEngine(ENGINE_URL, language);
  }

  async backup() {
    const dir = join(this.dataDir, "backups");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `config-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(
        WSL,
        [
          "-d",
          DISTRO,
          "-u",
          "root",
          "--",
          "tar",
          "-C",
          "/var/lib/elise-home",
          "-czf",
          "-",
          "config",
        ],
        { windowsHide: true },
      );
      p.stdout.pipe(createWriteStream(file));
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`backup ${code}`))));
    });
    return file;
  }

  async restore(backup: string) {
    const winPath = backup.replace(/\\/g, "/");
    const r = await this.run(
      WSL,
      [
        "-d",
        DISTRO,
        "-u",
        "root",
        "--",
        "/bin/sh",
        "-c",
        'tar -C /var/lib/elise-home -xzf "$(wslpath -u "$1")"',
        "sh",
        winPath,
      ],
      10 * 60_000,
    );
    if (r.code !== 0) throw new RuntimeError("HOME_RUNTIME_INSTALL_FAILED", "restore failed");
  }

  async reset() {
    if (await this.registered()) await this.run(WSL, ["--unregister", DISTRO], 5 * 60_000);
    await rm(join(this.dataDir, "distro"), { recursive: true, force: true });
    await rm(join(this.dataDir, "downloads"), { recursive: true, force: true });
    // Put the person's WSL settings back exactly as they were.
    const backup = join(this.dataDir, "wslconfig.backup");
    if (existsSync(backup)) {
      await copyFile(backup, join(homedir(), ".wslconfig"));
      await rm(backup, { force: true });
    }
  }
}
