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

  async remove(ref: ConnectionRef): Promise<void> {
    const { error } = await this.admin
      .from("connection_secrets")
      .delete()
      .eq("connection_id", ref.connectionId)
      .eq("workspace_id", ref.workspaceId);
    if (error) throw error;
  }
}
