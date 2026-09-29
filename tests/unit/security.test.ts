import { describe, expect, it } from "vitest";

import { toPublicError, AppError } from "@/core/errors";
import { redactSensitive } from "@/infrastructure/observability/redaction";
import { safeNextPath } from "@/lib/safe-redirect";

describe("redactSensitive", () => {
  it("removes secret-looking keys and values at any depth", () => {
    const out = redactSensitive({
      event: "x",
      nested: { access_token: "abc", note: "key sk-abcdefghijklmnopqrstuv and Bearer eyJabc.def" },
      headers: { Authorization: "Bearer zzz", cookie: "sb=1" },
      list: ["sb_secret_12345678901234"],
    });
    expect(JSON.stringify(out)).not.toMatch(
      /abcdefghijklmnop|zzz|sb=1|sb_secret_1234|access_token":"abc/,
    );
    expect(out).toMatchObject({ event: "x", nested: { access_token: "[REDACTED]" } });
  });
});

describe("toPublicError", () => {
  it("never leaks internal error messages", () => {
    expect(toPublicError(new Error("db password is hunter2"))).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Unexpected error",
    });
    expect(toPublicError(new AppError("NOT_FOUND", "Task not found")).message).toBe(
      "Task not found",
    );
  });
});

describe("safeNextPath", () => {
  it("only allows same-app relative paths", () => {
    expect(safeNextPath("/my-elise/tasks")).toBe("/my-elise/tasks");
    expect(safeNextPath("https://evil.com")).toBe("/");
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath(String.raw`/\evil.com`)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
  });
});
