# ELISE — Connections, Authentication & Permissions

**Document:** `08-connections-auth-permissions.md`  
**Status:** Draft v1  
**Purpose:** Definir cómo ELISE autentica usuarios, conecta cuentas externas, solicita permisos, administra credenciales y controla acciones sensibles de forma segura y comprensible.

---

# 1. Core Principle

ELISE debe diferenciar claramente entre:

1. la identidad del usuario dentro de ELISE;
2. las cuentas externas que el usuario conecta;
3. los permisos concedidos a cada conexión;
4. los permisos operativos que ELISE tiene para actuar.

Estas capas no deben confundirse.

Ejemplo:

```text
ELISE Account
leo@example.com

Connected Accounts
├── Gmail Personal
├── Gmail Firbot
├── Google Calendar Personal
├── Google Drive Firbot
├── Notion Personal
└── Notion Firbot
```

El usuario puede iniciar sesión en ELISE con una identidad y conectar posteriormente múltiples cuentas completamente independientes.

---

# 2. ELISE Authentication

El MVP utilizará Supabase Auth.

Métodos iniciales:

```text
Email + Password
Magic Link
Google Sign-In
```

La arquitectura debe permitir agregar posteriormente:

```text
Microsoft
Apple
Enterprise SSO
Other OAuth providers
```

---

# 3. Authentication vs Connected Providers

La cuenta utilizada para iniciar sesión en ELISE no determina qué servicios externos puede conectar el usuario.

Ejemplo:

```text
Login:
leo@gmail.com

Connections:
├── Google Workspace Firbot
├── Gmail Personal
├── Notion Firbot
└── Notion Personal
```

No debe existir dependencia conceptual entre:

```text
Supabase Auth identity
```

y:

```text
Provider connections
```

---

# 4. User and Workspace Context

Toda sesión autenticada debe resolver:

```text
user_id
workspace_id
```

Durante el MVP:

```text
User
→ Personal Workspace
```

La arquitectura debe permitir posteriormente:

```text
User
├── Personal Workspace
├── Firbot Workspace
└── Team Workspace
```

Las operaciones sensibles siempre deben validar el workspace activo.

---

# 5. Session Model

Flujo conceptual:

```text
User
 ↓
Supabase Auth
 ↓
Session
 ↓
Next.js Server
 ↓
Resolve User + Workspace
 ↓
Application Services
```

Nunca confiar únicamente en IDs enviados desde el frontend.

Cada operación debe verificar ownership o membership en backend.

---

# 6. Provider Connections

Una Connection representa una autorización concreta entre ELISE y una cuenta externa.

Ejemplo:

```text
Provider:
Google

Account:
leo@firbot.com

Capabilities:
Gmail
Calendar
Drive
Tasks
Sheets
```

Una misma cuenta OAuth puede habilitar varias capabilities si el provider lo permite.

---

# 7. Connection Lifecycle

Estados conceptuales:

```text
Connecting
Connected
Partially Authorized
Healthy
Needs Reauthorization
Expired
Error
Disabled
Disconnected
```

ELISE debe mostrar estos estados en lenguaje simple.

Ejemplo:

```text
Google Firbot
Needs attention

Calendar access expired.

[ Reconnect ]
```

---

# 8. Progressive Permissions

ELISE utilizará permisos progresivos.

No se solicitará acceso amplio a servicios que el usuario todavía no decidió utilizar.

Ejemplo:

Si el usuario selecciona solamente:

```text
Calendar
```

ELISE no debería pedir acceso a:

```text
Gmail
Drive
Tasks
Sheets
```

sin necesidad.

---

# 9. Grouped Authorization

Cuando el usuario configure varias capabilities relacionadas al mismo provider durante el mismo flujo, ELISE puede agrupar permisos cuando sea técnicamente posible.

Ejemplo:

```text
User selects:
✓ Email
✓ Calendar
✓ Drive
```

ELISE puede iniciar una autorización Google que contemple esas tres capabilities.

El objetivo es reducir fricción sin pedir permisos irrelevantes.

---

# 10. Principle of Least Privilege

Cada conexión debe solicitar solamente los scopes necesarios para las funcionalidades habilitadas.

Regla:

> **Ask for the minimum access required to deliver the feature the user chose.**

Si posteriormente el usuario habilita una capability adicional, ELISE solicita los nuevos permisos en ese momento.

---

# 11. Permission UX

La UI debe evitar exponer scopes OAuth técnicos como experiencia principal.

En su lugar:

```text
ELISE can:

✓ Understand this source
✓ Read current data
○ Make changes
```

En configuraciones avanzadas puede mostrarse más detalle.

---

# 12. Permission Layers

ELISE debe distinguir varios niveles.

## Layer 1 — Provider Authorization

Lo que Google, Notion u otro servicio autorizó técnicamente.

## Layer 2 — Capability Permission

Qué capabilities están habilitadas dentro de ELISE.

## Layer 3 — Operational Policy

Qué acciones puede ejecutar automáticamente.

## Layer 4 — Context Rules

Excepciones o reglas específicas del usuario.

---

# 13. Example Permission Stack

Ejemplo Gmail:

```text
Provider OAuth:
Read + Draft + Send allowed

ELISE Capability:
Email enabled

Operational Policy:
Read → automatic
Draft → automatic
Send → ask first

Context Rule:
Emails to internal Firbot team → auto-send allowed
```

La autorización técnica no significa automáticamente que ELISE deba usar toda esa capacidad sin control.

---

# 14. Approval Modes

Las acciones configurables podrán utilizar tres modos principales:

```text
Always Ask
Ask When Uncertain
Allow Automatically
```

En español:

```text
Preguntar siempre
Preguntar si hay dudas
Permitir automáticamente
```

Los defaults deben priorizar seguridad.

---

# 15. Default Approval Policy

Ejemplo inicial:

| Operation | Default |
|---|---|
| Read email | Allow automatically |
| Search email | Allow automatically |
| Summarize email | Allow automatically |
| Create draft | Allow automatically |
| Send email | Always ask |
| Read calendar | Allow automatically |
| Create event | Ask when uncertain |
| Edit event | Ask when uncertain |
| Delete event | Always ask |
| Read tasks | Allow automatically |
| Create task | Allow automatically |
| Complete task | Allow automatically |
| Delete task | Ask when uncertain |
| Read Knowledge | Allow automatically |
| Add Note | Allow automatically |
| Delete Knowledge | Always ask |
| Read Finance | Allow automatically |
| Create transaction | Ask when uncertain |
| Delete transaction | Always ask |

Estos defaults pueden evolucionar.

---

# 16. Risk-Based Approval

La aprobación no debe depender únicamente del tipo de capability.

Debe considerar:

```text
operation
risk
context
confidence
user rules
destination
reversibility
scope
```

Ejemplo:

```text
Create calendar event
```

puede ser automático cuando:

```text
personal calendar
known time
no attendees
high confidence
```

pero requerir aprobación si:

```text
external attendees
ambiguous calendar
conflicting event
```

---

# 17. Confidence-Aware Behavior

Cuando ELISE tenga baja confianza en datos necesarios para una acción, debe preguntar.

Ejemplo:

> “Agendame reunión con Martín mañana a las 3.”

Si existen dos contactos llamados Martín:

```text
Which Martín?

○ Martín López
○ Martín García
```

Nunca convertir incertidumbre en una acción silenciosa.

---

# 18. Remember This Decision

Después de una aprobación, ELISE puede ofrecer:

```text
Remember this choice
```

Ejemplo:

```text
Always use Firbot Gmail for Client X
```

o:

```text
Allow ELISE to create personal tasks automatically
```

Estas decisiones deben persistirse como reglas explícitas.

---

# 19. User Rules Cannot Override Hard Security Boundaries

Aunque el usuario configure autonomía amplia, ciertas acciones pueden seguir requiriendo protecciones adicionales.

Ejemplos potenciales:

- destructive bulk actions;
- account disconnection;
- credential changes;
- sensitive financial operations;
- actions crossing workspace boundaries.

Las restricciones exactas se definirán en el documento de seguridad.

---

# 20. Approval Objects

Las aprobaciones deben persistirse como entidades.

Modelo conceptual:

```text
Approval

id
workspace_id
user_id
action_type
capability
provider
connection_id
payload
risk_level
reason
status
created_at
expires_at
resolved_at
```

Estados:

```text
Pending
Approved
Rejected
Expired
Cancelled
```

---

# 21. Approval Flow

```text
User request
   ↓
ELISE interprets intent
   ↓
Resolve provider/account
   ↓
Permission check
   ↓
Policy check
   ↓

Safe?
├── Yes → Execute
└── No  → Create Approval
              ↓
         Realtime UI
              ↓
       User decision
              ↓
      Execute or cancel
```

---

# 22. Approvals in Background Jobs

Scheduled Tasks también deben respetar políticas.

Ejemplo:

```text
Scheduled email follow-up
```

Si la política indica:

```text
Send email → Always Ask
```

la ejecución debe detenerse en:

```text
Waiting for approval
```

El job no debe enviar automáticamente solo porque fue iniciado en background.

---

# 23. Connection-Specific Policies

Cada cuenta puede tener reglas diferentes.

Ejemplo:

```text
Personal Gmail
Send → Ask when uncertain

Firbot Gmail
Send → Always Ask
```

o:

```text
ELISE Tasks
Create → Automatic

Google Tasks
Create → Ask when uncertain
```

---

# 24. Context-Specific Policies

También pueden existir reglas por contexto.

Ejemplo:

```text
Work / Firbot
Create calendar events → Automatic

Personal
Create calendar events → Ask when uncertain
```

El motor de políticas debe resolver:

```text
global defaults
→ capability rules
→ connection rules
→ context rules
→ operation rules
```

---

# 25. Credentials

Tokens y secretos deben manejarse exclusivamente del lado servidor.

Nunca almacenar credenciales sensibles en:

```text
localStorage
client-side state
frontend bundles
AI prompts
conversation history
normal logs
```

---

# 26. OAuth Tokens

Las conexiones OAuth pueden requerir:

```text
access token
refresh token
expiry
provider account identifier
authorized scopes
```

Estos datos deben tratarse como secretos.

Solo componentes de infraestructura autorizados deben poder acceder a ellos.

---

# 27. AI Credential Isolation

Los modelos de IA nunca deben recibir credenciales.

Correcto:

```text
AI:
email.search({ query: "proposal" })

Backend:
resolve provider
retrieve credential
call Gmail
normalize result
return safe result
```

Incorrecto:

```text
AI receives Gmail OAuth token
```

---

# 28. Connection Ownership

Cada conexión debe estar asociada explícitamente a:

```text
workspace_id
user_id / owner
```

Toda llamada debe verificar acceso antes de utilizarla.

Nunca confiar en:

```text
connection_id
```

enviado desde cliente sin ownership validation.

---

# 29. Multi-Account Security

Una capability puede consultar varias cuentas.

Sin embargo, cada resultado debe preservar:

```text
provider
connection
workspace
source
```

Esto evita escribir accidentalmente en la cuenta equivocada.

---

# 30. Revoking Access

El usuario debe poder desconectar una cuenta fácilmente.

Al desconectar:

```text
Stop provider access
Invalidate/revoke credentials where possible
Disable bindings
Stop future scheduled operations requiring it
Preserve audit history as appropriate
```

ELISE debe explicar qué funcionalidades dejarán de funcionar.

---

# 31. Dependency Warning Before Disconnect

Ejemplo:

```text
Disconnect Gmail Firbot?

This connection is currently used by:

• Morning Brief
• 2 Schedules
• Work Email
```

Acciones:

```text
[ Cancel ]
[ Disconnect ]
```

No ocultar impactos.

---

# 32. Expired Credentials

Si un token expira o deja de ser válido:

```text
Connection
→ Needs Reauthorization
```

Las tareas relacionadas deben:

- fallar de manera controlada;
- no repetir agresivamente;
- registrar el error;
- avisar al usuario cuando corresponda;
- ofrecer `Reconnect`.

---

# 33. Scope Upgrades

Ejemplo:

El usuario inicialmente habilitó:

```text
Gmail Read
```

Luego pide:

> “Mandá este email.”

Si falta permiso:

```text
ELISE needs permission to send email.

[ Allow sending ]
```

Se inicia una autorización incremental.

---

# 34. Scope Downgrades

El usuario debe poder reducir acceso cuando el provider lo permita.

Ejemplo:

```text
Gmail

✓ Read
✓ Draft
○ Send
```

Si técnicamente no puede reducir scopes sin reconectar, la UI debe explicarlo claramente.

---

# 35. Connection Setup UX

Flujo:

```text
Choose capability
    ↓
Choose provider
    ↓
Explain requested access
    ↓
OAuth
    ↓
Account connected
    ↓
Choose context / alias
    ↓
Optional default
```

Debe ser corto y visual.

---

# 36. Connection Aliases

ELISE puede sugerir nombres como:

```text
Personal
Firbot
University
RSFA
```

El usuario puede cambiarlos.

Estos aliases ayudan al resolver y a la UI.

---

# 37. Auth Error UX

Los errores deben traducirse.

Malo:

```text
invalid_grant
```

Mejor:

```text
Google disconnected this session.

Reconnect your account to continue.

[ Reconnect ]
```

Detalles técnicos pueden estar disponibles de forma secundaria.

---

# 38. Authentication Security UX

Acciones sensibles de cuenta pueden requerir reautenticación futura.

Ejemplos:

- deleting account;
- exporting all data;
- changing security settings;
- transferring workspace ownership.

No todas estas funciones son requisito MVP, pero la arquitectura debe contemplarlas.

---

# 39. Account Deletion

Futuro flujo esperado:

```text
Delete ELISE account
→ Explain impact
→ Reauthenticate
→ Confirm
→ Revoke connections
→ Delete/anonymize data according to policy
```

La política detallada se documentará por separado.

---

# 40. Auditability

Las acciones importantes deben registrar:

```text
who
when
workspace
capability
provider
connection
operation
approval
result
```

Sin registrar secretos.

Ejemplo:

```text
User approved email.send
Connection: Gmail Firbot
Time: 14:32
Result: Success
```

---

# 41. Permission Change Audit

Cambios de autonomía también deben ser auditables.

Ejemplo:

```text
Send Email
Always Ask
→
Allow Automatically
```

Esto debe quedar registrado.

---

# 42. Provider Consent vs ELISE Consent

Hay dos momentos diferentes:

## Provider Consent

Ejemplo Google:

> Allow ELISE to access Calendar.

## ELISE Operational Consent

Ejemplo:

> ELISE may create calendar events automatically.

Ambos conceptos deben permanecer separados.

---

# 43. Browser Notifications

Las notificaciones del navegador requieren autorización independiente.

ELISE debe pedir este permiso cuando exista contexto útil.

No inmediatamente al abrir la app por primera vez.

Mejor:

```text
Your Morning Brief is configured.

Would you like ELISE to notify you when it's ready?
```

---

# 44. Location Permission — Future

El mismo principio aplica a ubicación.

No solicitar ubicación globalmente al iniciar la app.

Solicitar cuando exista un caso concreto:

```text
"¿Dónde puedo estacionar cerca?"
```

ELISE puede explicar:

```text
Allow location access to search near you.
```

---

# 45. Microphone Permission

Para Voice:

- pedir acceso al micrófono al iniciar una interacción de voz;
- no durante onboarding sin necesidad;
- explicar claramente el propósito.

---

# 46. Permissions Are Revocable

Toda autorización configurable dentro de ELISE debe poder revisarse posteriormente.

Ruta conceptual:

```text
Settings
→ Privacy & Permissions
```

o:

```text
Connection
→ Permissions
```

El usuario debe mantener control.

---

# 47. MVP Authentication Scope

Incluido en MVP:

```text
Supabase Auth
Email + Password
Magic Link
Google Sign-In
Session handling
Protected routes
Personal workspace
Multi-account external connections
Progressive OAuth permissions
Connection status
Reconnect
Disconnect
Capability permissions
Approval policies
Pending approvals
Basic audit history
```

---

# 48. Post-MVP Authentication Scope

Posibles extensiones:

```text
Microsoft Sign-In
Apple Sign-In
Passkeys
MFA
Enterprise SSO
Team invitations
Workspace roles
Admin policies
SCIM
Advanced secret management
```

---

# 49. Security Principles

1. Least privilege.
2. Progressive permissions.
3. Credentials remain server-side.
4. AI never receives secrets.
5. Auth identity and provider identity are independent.
6. Every resource has ownership.
7. Every write resolves exact destination.
8. High-risk actions require stronger confirmation.
9. Permissions are revocable.
10. Authorization is deterministic, not decided solely by AI.
11. Scheduled actions obey the same permissions as interactive actions.
12. Ambiguity produces clarification, not guessing.

---

# 50. North Star

> **ELISE should feel powerful because it has access, not dangerous because it has access.**
>
> Connections are easy to add.
>
> Permissions are easy to understand.
>
> Autonomy is configurable.
>
> Sensitive actions remain controlled.
