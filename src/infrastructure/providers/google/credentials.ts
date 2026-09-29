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
    // Google only returns a refresh token on consent; keep the one we have otherwise.
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
      config: GoogleOAuthConfig;
      onReauthorizationRequired: (ref: ConnectionRef, code: string) => Promise<void>;
      fetchImpl?: FetchLike;
      now?: () => number;
    },
  ) {}

  async accessToken(forceRefresh = false): Promise<string> {
    const now = this.deps.now?.() ?? Date.now();
    const current = this.cached ?? (await this.deps.vault.read(this.ref));
    if (!current) {
      await this.deps.onReauthorizationRequired(this.ref, "missing_credentials");
      throw new AppError("AUTH_EXPIRED", "This Google account needs to be reconnected", {
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
      throw new AppError("AUTH_EXPIRED", "This Google account needs to be reconnected", {
        recovery: "reconnect",
      });
    }
    try {
      // ponytail: concurrent requests may both refresh; Google allows several live access
      // tokens, so the last write wins harmlessly. Add a per-connection lock if that changes.
      const tokens = await refreshAccessToken(
        this.deps.config,
        current.refreshToken,
        this.deps.fetchImpl,
      );
      const next = credentialFromTokens(tokens, current);
      await this.deps.vault.write(this.ref, next);
      this.cached = next;
      return next.accessToken;
    } catch (error) {
      if (error instanceof AppError && error.code === "AUTH_EXPIRED") {
        logger.warn("google.token_revoked", {
          connection_id: this.ref.connectionId,
          workspace_id: this.ref.workspaceId,
        });
        await this.deps.onReauthorizationRequired(this.ref, "invalid_grant");
      }
      throw error;
    }
  }
}
