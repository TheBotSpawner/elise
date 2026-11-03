# ADR-129: Smart Life for every user is blocked by Tuya — what is verified, and the next move

**Status:** Accepted (2026-11-02). Corrects ADR-119 §1–2. ADR-119's code stays: it is built and
tested, and can't be turned on. ADR-128's owner-only test link stays as it is.

## Context: what was checked (2026-11-02)

**ELISE's Tuya project, as the owner saw it in the console**
- Data center: Western America (US).
- Cloud Authorization: one key.
- App Authorization: none.
- Six API services: IoT Core, Authorization Token Management, Smart Home Basic Service, IR
  Control Hub Open Service and two more.
- Link App Account: one SmartLife account linked by "Platform Authorization" and "Automatic
  Link".
- The OAuth screen says **"OAuth authorization only supports OEM Apps."** No Authorization Key,
  and no "Apps for Login Authorization".

**Tuya's documentation (read 2026-11-02; each page's "last updated" date is in parentheses)**
- [Link Devices](https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl) (2025-06-23):
  - SmartLife accounts can be linked to a project.
  - "Each app account can be linked with two projects at most."
  - "Link my app" means an "OEM App" or an app "developed based on Tuya app SDKs".
- [Request Cloud API Key](https://developer.tuya.com/en/docs/developer/apply-cloud-api-key?id=Kff30z8sv62ah) (2026-03-24):
  - The QR is shown by the developer console: "Open the Tuya or SmartLife app and scan the QR
    code".
  - Linking needs the IoT Core plan and the Smart Home development method.
- [OAuth 2.0 Authorization Flow](https://developer.tuya.com/en/docs/iot/authorization-code-page-usage?id=Kdkyz44dz6a7r) (2026-01-05):
  - The key "must be the one specific to app authorization".
  - The page names no public app.
- [Manage Authorization](https://developer.tuya.com/en/docs/iot/manage-application?id=Kag37wnxynxnw) (2024-06-21):
  - App Authorization keys are for the developer's own iOS/Android app (Bundle ID, SHA1).
- [Device Data Sharing](https://developer.tuya.com/en/docs/iot/device_data_sharing_usage?id=Kex4vski8ylak) (2025-11-27):
  - The only documented route that names the SmartLife app: "enabled authorization by
    default".
  - EU only, enterprise verification required, paid.
- [Pricing](https://developer.tuya.com/en/docs/iot/membership-service?id=K9m8k45jwvg9j) (2026-07-28):
  - "The Trial Edition only applies to individual developers or works for debugging purposes.
    Commercial use is prohibited."
  - Trial limits: 50 devices / 10 controllable, about 26 k API calls a month, then suspended
    until the next month.
- [Tuya's Home Assistant guide](https://developer.tuya.com/en/docs/iot/Home-assistant-tuya-intergration?id=Kb0eqjig0utdd) (2025-03-03):
  - The person enters the User Code from the SmartLife app and scans a QR. No developer project
    is needed.
  - HA core's Tuya integration uses a built-in client ID (`TUYA_CLIENT_ID` in const.py) and the
    MIT-licensed `tuya-device-sharing-sdk`.
  - HA's docs: every platform is supported "except the lock and remote platform". `wnykq` (IR
    hub) is only an enum entry; no IR-remote entities are created.
- Support note K8sdy1gdbu7f0 could not be read (redirect loop).

**Verified against the real API**
- The linked account's hub, its TV and AC remotes, their keys and the AC ranges were read with
  the project token (ADR-128). No command has been sent.

## Decision

1. **Consumer linking is BLOCKED.** No documented, available mechanism lets a person with a
   public SmartLife / Tuya Smart account authorize ELISE themselves from Argentina:
   - **OAuth 2.0** is for OEM apps: users of ELISE's own branded app, not SmartLife users.
   - **The console QR** needs the developer's console for every person, at most two projects
     per account, and a paid plan for commercial use.
   - **Device Data Sharing** is EU only.
   - **The Home Assistant route** reaches SmartLife accounts but not IR remotes, which is the
     use case, and its client ID belongs to Home Assistant's integration.
2. **No OAuth turns on.** ADR-119's start/callback/refresh/revoke code stays dormant: no
   `TUYA_OAUTH_URL_*` is set and none will be until Tuya confirms a mechanism in writing.
   Nothing creates an OEM app or buys a plan by default.
3. **The owner's test link stays restricted on the server** (`TUYA_DEV_WORKSPACE_ID` + uid
   check on every token request). It is development only: the project is on a Trial-era setup
   until a plan is chosen.
4. **Before any consumer flow is enabled:**
   - **Pin the account id outside member-writable data.** `provider_connections` is
     member-updatable under RLS, so `auth_metadata.uid` is not trustworthy by itself. Today the
     test link is guarded by config, and a test now fixes that (a member who edits their row into
     a "test" one gets nothing). For OAuth, keep the uid inside the encrypted secret and check
     each refresh's uid against it.
   - **Confirm commercial terms:** plan, quotas, regions for Argentina.
5. **Next move:** ask Tuya, with the questions in this ADR's ticket, and decide based on the
   answer. Possible outcomes:
   - **A consumer mechanism exists** (partner program, or SmartLife allowed in OAuth): wire it
     into ADR-119's contract.
   - **OEM only:** a product decision (an ELISE OEM app, paid) that this ADR doesn't take.
   - **Nothing for IR:** keep the test link for the owner, and evaluate the Home Assistant route
     for non-IR Tuya devices in Desktop only, after confirming its client ID may be used that way.

## Modalities

| Modality | Public SmartLife accounts | Self-service | IR remotes | Scale / terms | Status |
| --- | --- | --- | --- | --- | --- |
| Console QR (Link Tuya app account) | Yes | No: the developer's console shows the QR | Yes (verified) | 2 projects per account; Trial forbids commercial use | Works for the owner only |
| OAuth 2.0 (Configure OAuth) | No: "only supports OEM Apps" | Yes, for OEM app users | Presumably | Needs an OEM app (paid, unknown price) | Not applicable |
| Device Data Sharing | Yes | Yes | Unknown | EU only, enterprise, paid | Not available (Argentina) |
| Home Assistant user code + QR | Yes | Yes (Desktop engine) | **No** | HA's built-in client ID; terms for third parties unknown | Not suitable for IR; unconfirmed |
| Tuya partner / other | Unknown | Unknown | Unknown | Unknown | Ask Tuya |

## Consequences

- No consumer sees a working "Conectar Smart Life" until Tuya answers. The owner keeps testing
  real hardware through the test link.
- ADR-119's code and tests stay. It is the contract any confirmed mechanism plugs into.
