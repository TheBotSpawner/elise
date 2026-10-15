import "server-only";

import { decrypt, encrypt } from "@/infrastructure/crypto/encryption";
import type { createAdminClient } from "@/infrastructure/supabase/admin";

import type { ConnectionRef, CredentialVault, StoredCredential } from "./credentials";

type AdminClient = ReturnType<typeof createAdminClient>;

/** The ciphertext is bound to its workspace and connection (AEAD context). */
function aad(ref: ConnectionRef): string {
  return `connection_secret:${ref.workspaceId}:${ref.connectionId}`;
}

/**
 * Encrypted credential storage in `connection_secrets` (no RLS policies; API roles have no
 * privileges). Always filtered by workspace_id AND connection_id.
 */
export class SupabaseCredentialVault implements CredentialVault {
  constructor(
    private readonly admin: AdminClient,
    private readonly providerKey: string,
  ) {}

  async read(ref: ConnectionRef): Promise<StoredCredential | null> {
    const { data, error } = await this.admin
      .from("connection_secrets")
      .select("ciphertext")
      .eq("connection_id", ref.connectionId)
      .eq("workspace_id", ref.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return JSON.parse(decrypt(data.ciphertext, aad(ref))) as StoredCredential;
  }

  async write(ref: ConnectionRef, credential: StoredCredential): Promise<void> {
    const { error } = await this.admin.from("connection_secrets").upsert(
      {
        connection_id: ref.connectionId,
        workspace_id: ref.workspaceId,
        provider_key: this.providerKey,
        ciphertext: encrypt(JSON.stringify(credential), aad(ref)),
        access_token_expires_at: credential.accessTokenExpiresAt,
      },
      { onConflict: "connection_id" },
    );
    if (error) throw error;
  }

  /**
   * One refresher at a time per connection, across instances (single-use refresh tokens): a
   * short lease taken only if free or expired. Returns whether this caller holds it.
   */
  async acquireRefreshLease(ref: ConnectionRef, ms = 30_000): Promise<boolean> {
    const now = new Date();
    const { data, error } = await this.admin
      .from("connection_secrets")
      .update({ refresh_lease_until: new Date(now.getTime() + ms).toISOString() })
      .eq("connection_id", ref.connectionId)
      .eq("workspace_id", ref.workspaceId)
      .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${now.toISOString()}`)
      .select("connection_id");
    if (error) throw error;
    return (data ?? []).length === 1;
  }

  async releaseRefreshLease(ref: ConnectionRef): Promise<void> {
    await this.admin
      .from("connection_secrets")
      .update({ refresh_lease_until: null })
      .eq("connection_id", ref.connectionId)
      .eq("workspace_id", ref.workspaceId);
  }

  async remove(ref: ConnectionRef): Promise<void> {
    const { error } = await this.admin
      .from("connection_secrets")
      .delete()
      .eq("connection_id", ref.connectionId)
      .eq("workspace_id", ref.workspaceId);
    if (error) throw error;
  }
}
