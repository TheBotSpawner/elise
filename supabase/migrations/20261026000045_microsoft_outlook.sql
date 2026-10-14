-- Microsoft (ADR-058): a provider family; today it implements only the canonical Email
-- capability through Outlook Mail (Microsoft Graph, delegated permissions). Credentials use the
-- existing encrypted vault (connection_secrets); nothing of the mailbox is stored here.

insert into public.provider_definitions (key, display_name, auth_type, supports_multiple_accounts, status) values
  ('microsoft', 'Microsoft', 'oauth2', true, 'available')
on conflict (key) do nothing;

insert into public.provider_capabilities (provider_key, capability_key) values
  ('microsoft', 'email')
on conflict do nothing;
