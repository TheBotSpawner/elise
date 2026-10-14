import { AppError } from "@/core/errors";
import { logger } from "@/infrastructure/observability/logger";

import { refreshAccessToken, type FetchLike, type GoogleOAuthConfig, type TokenSet } from "./oauth";

/** Decrypted OAuth credentials. Lives only in server memory for the duration of a request. */
export interface StoredCredential {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string | null;
  scopes: string[];
}

/** Server-only secret storage port (encrypted at rest; see connection-vault.ts). */
export interface CredentialVault {
  read(ref: ConnectionRef): Promise<StoredCredential | null>;
  write(ref: ConnectionRef, credential: StoredCredential): Promise<void>;
  remove(ref: ConnectionRef): Promise<void>;
}

export interface ConnectionRef {
  connectionId: string;
  workspaceId: string;
}

export function credentialFromTokens(
  tokens: TokenSet,
  previous: StoredCredential | null,
): StoredCredential {
  return {
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.expiresAt.toISOString(),
    // Google only returns a refresh token on consent (Microsoft rotates it): keep the one we have
    // when none comes back.
    refreshToken: tokens.refreshToken ?? previous?.refreshToken ?? null,
    scopes: tokens.scopes.length ? tokens.scopes : (previous?.scopes ?? []),
  };
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * Supplies a valid access token for one connection, refreshing it when it is about to expire.
 * A revoked grant marks the connection as needing reauthorization and fails closed.
 * Tokens never leave this object except as an Authorization header.
 */
export class GoogleTokenProvider {
  private cached: StoredCredential | null = null;

  constructor(
    private readonly ref: ConnectionRef,
    private readonly deps: {
      vault: CredentialVault;
      onReauthorizationRequired: (ref: ConnectionRef, code: string) => Promise<void>;
      fetchImpl?: FetchLike;
      now?: () => number;
      /** Shown in errors and logs ("Google", "Microsoft"). */
      providerName?: string;
    } & (
      | { config: GoogleOAuthConfig }
      // Another OAuth provider (Microsoft) brings its own refresh; the lifecycle is the same.
      | { refresh: (refreshToken: string) => Promise<TokenSet> }
    ),
  ) {}

  private get name() {
    return this.deps.providerName ?? "Google";
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const now = this.deps.now?.() ?? Date.now();
    const current = this.cached ?? (await this.deps.vault.read(this.ref));
    if (!current) {
      await this.deps.onReauthorizationRequired(this.ref, "missing_credentials");
      throw new AppError("AUTH_EXPIRED", `This ${this.name} account needs to be reconnected`, {
        recovery: "reconnect",
      });
    }
    this.cached = current;
    if (
      !forceRefresh &&
      new Date(current.accessTokenExpiresAt).getTime() - REFRESH_MARGIN_MS > now
    ) {
      return current.accessToken;
    }
    if (!current.refreshToken) {
      await this.deps.onReauthorizationRequired(this.ref, "no_refresh_token");
      throw new AppError("AUTH_EXPIRED", `This ${this.name} account needs to be reconnected`, {
        recovery: "reconnect",
      });
    }
    try {
      // ponytail: concurrent requests may both refresh; Google and Microsoft keep earlier tokens
      // valid after a refresh (Microsoft's rotation doesn't revoke the previous refresh token), so
      // the last write wins harmlessly. Add a per-connection lock if that changes.
      const tokens =
        "refresh" in this.deps
          ? await this.deps.refresh(current.refreshToken)
          : await refreshAccessToken(this.deps.config, current.refreshToken, this.deps.fetchImpl);
      const next = credentialFromTokens(tokens, current);
      await this.deps.vault.write(this.ref, next);
      this.cached = next;
      return next.accessToken;
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_EXPIRED") {
        logger.warn("oauth.token_revoked", {
          provider: this.name.toLowerCase(),
          connection_id: this.ref.connectionId,
          workspace_id: this.ref.workspaceId,
        });
        // The provider's precise reason (revoked, consent withdrawn, conditional access…) when known.
        const reason = error.details?.reason;
        await this.deps.onReauthorizationRequired(
          this.ref,
          typeof reason === "string" ? reason : "invalid_grant",
        );
      }
      throw error;
    }
  }
}
