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

  it("removes provider tokens inside free text (error causes)", () => {
    const text = String(
      redactSensitive(
        "google said ya29.a0AfH6SMBxyz123456 refresh 1//0gAbCdEfGhIjKlMnOpQrStUv " +
          "client GOCSPX-abcdefghijkl notion ntn_1234567890abcdefghijKLMN " +
          "secret_ABCDEFGHIJKLMNOPQRSTuv tavily tvly-dev-abcdefghij",
      ),
    );
    expect(text).not.toMatch(/ya29\.a0|1\/\/0gAb|GOCSPX-a|ntn_1234|secret_ABCD|tvly-dev/);
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
