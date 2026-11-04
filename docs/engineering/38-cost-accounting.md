# Costos por cuenta y límites de consumo (Fase 1)

Decisión: [ADR-138](../decisions/ADR-138-cost-accounting-and-budgets.md). Datos al 2026-11-04.
Lo implementado queda en modo `observe`: registra y no bloquea. Nada de esto está aplicado en producción.

## 1. Lo que dicen los datos

Una sola cuenta, la del dueño, del 2 de octubre al 4 de noviembre (33 días, 23.647 eventos). Es uso de
desarrollo y pruebas, **no un usuario típico**: sirve para ver la forma del costo, no para fijar precios.

| Concepto | Uso | A precio oficial | Estimado anterior |
| --- | --- | ---: | ---: |
| ElevenLabs (voz de Elise) | 320.150 caracteres | **US$12,81** | US$4,80 |
| Búsqueda web (OpenAI) | 314 búsquedas | US$4,43 | US$1,29 |
| GPT-6 Luna | 64,4 M tokens de entrada, 57 % en caché | US$3,24 | US$1,66 (parcial) |
| Maps | 110 llamadas | US$1,37 | US$1,29 |
| Transcripción | 252 min | US$1,13 | US$1,51 |
| GPT-5 mini | 5,5 M tokens de entrada | US$0,59 | US$0,59 |
| GPT-6 Sol | 0,3 M tokens de entrada | US$0,28 | sin precio |
| Embeddings, OCR | | US$0,01 | US$0,01 |
| OpenAI TTS | 95.352 caracteres | **desconocido** | US$1,43 |
| **Total con precio** | | **US$23,85** (≈ US$21,70 cada 30 días) | US$12,58 |

Tres conclusiones:

- **La voz de ElevenLabs es el 54 % del costo.** Es la primera palanca de cualquier decisión de precio.
- El costo real era casi el doble del que mostraba `/admin/usage`.
- A este ritmo, los US$3 de la beta se gastarían en unos 4 días. Un consumidor debería usar mucho menos,
  pero hoy no hay datos para afirmarlo.

Estas cifras son recálculos de esta auditoría sobre totales ya guardados. Los eventos históricos no se
modifican. No incluyen las escrituras de caché ni los streams cortados, que antes no se registraban.

## 2. Cobertura

| Ruta | Evidencia | Estado |
| --- | --- | --- |
| OpenAI chat, voz y herramientas | `infrastructure/ai/openai/provider.ts` | Instrumentada; tokens, caché, escrituras e id del proveedor |
| Stream cortado o colgado | mismo archivo, `finally` | Instrumentada como estimación (antes no quedaba rastro) |
| Reintentos internos del SDK (`maxRetries: 2`) | mismo archivo | **No observable**: suceden dentro del SDK |
| Embeddings | `openai/embeddings.ts` | Instrumentada |
| Transcripción | `openai/speech.ts` | Instrumentada, segundos del proveedor |
| ElevenLabs HTTP y WebSocket | `elevenlabs/speech.ts` | Instrumentada; ahora con el modelo que realmente habló |
| OpenAI TTS | `openai/speech.ts` | Unidades sí; **costo desconocido**: se factura por token de audio y la API no lo informa |
| Failover ElevenLabs → OpenAI | `failover-speech.ts` | Cubierta; cada proveedor registra lo suyo |
| Audio en caché (frases fijas) | `voice-service.ts` | Sin costo, no se registra |
| Búsqueda web OpenAI y Tavily | `web/search-providers.ts` | Instrumentada, con la tarifa por llamada |
| Maps | `location/google-maps.ts` | Instrumentada |
| OCR | `ocr/google-document-ai.ts` | Instrumentada |
| GPT-Live | `live-voice-service.ts` | Apagado. Solo se controla el inicio; **no observable** en el servidor |
| Jobs de Trigger con costo | `src/trigger/*` | Cubiertos; se sumaron backfill de Recall y sync de Finanzas, que no dejaban registro |
| Borrador de Métodos, mapeos de Finanzas y Notion | `application/*` | Cubiertos; tampoco dejaban registro |
| Fase previa del turno de chat | `chat-service.ts` | **A verificar en shadow** (ver checklist) |
| Búsquedas iniciadas desde pantallas sin chat, Estudio fuera del chat | `workspace-service.ts`, acciones | **A verificar en shadow** |
| Desktop | `desktop/src/main/protocol.ts` | Sin proveedores propios: todo pasa por el servidor. Vosk es local y gratis |
| Compute de Trigger.dev | panel de Trigger | Costo compartido; no se atribuye por cuenta |
| Vercel, Supabase, Sentry, plan de Trigger | facturas | Costo fijo compartido |

## 3. Tarifario

Fuente en `src/config/pricing.ts`, versión `2026-11-04`. Revisado ese día en las páginas oficiales.

| Servicio | Precio | Fuente |
| --- | --- | --- |
| GPT-6 Luna | US$0,10 entrada / 0,01 caché / 0,125 escritura / 0,50 salida por 1 M; más de 272 K: 0,20 / 0,02 / 0,75 | [OpenAI](https://developers.openai.com/api/docs/pricing) |
| GPT-6 Sol | US$2 / 0,20 / 2,50 / 10 por 1 M; más de 272 K: 4 / 0,40 / 15 | OpenAI |
| GPT-5 mini, GPT-5 nano, GPT-4.1 mini | según la tabla del código | OpenAI |
| gpt-transcribe | US$0,0045 por minuto | OpenAI |
| Búsqueda web | US$10 por 1.000 llamadas, más tokens | OpenAI |
| ElevenLabs Flash, v4 Turbo | US$0,04 por 1.000 caracteres | [ElevenLabs](https://elevenlabs.io/pricing/api) |
| Maps | Text Search US$40, Details 25, Photos 7, Geocoding 5, Routes y Matrix 10 por 1.000 | [Google](https://developers.google.com/maps/billing-and-pricing/pricing) |
| Tavily | US$0,008 por crédito | [Tavily](https://docs.tavily.com/documentation/api-credits) |
| Document AI OCR | US$1,50 por 1.000 páginas | [Google Cloud](https://cloud.google.com/document-ai/pricing), visto en resultados de búsqueda, no en la página completa |
| gpt-4o-mini-tts | **unknown**: US$0,60 y US$12 por 1 M de tokens, sin dato de tokens de audio | OpenAI |
| GPT-Live | **pending_reconciliation**: se registraría a US$0,05 por minuto (ADR-026), sin verificar | |

Todos son precios brutos de lista. **Para reconciliar:**

- Los US$0,04 de ElevenLabs son el precio por API. Si el plan contratado incluye créditos, el costo
  marginal real puede ser otro: cargar la factura en `provider_invoices`.
- Maps tiene cupos mensuales gratis que no se descuentan, y sus precios bajan por volumen.
- Los SKU de Routes y Details se tomaron por el nivel más caro plausible; la factura lo dirá.
- `eleven_v4_turbo` no aparece como id en la página: se asumió que es el "v4 Turbo" publicado.
- Developers reportan cobros de búsqueda web mayores al listado, sin confirmación de OpenAI.
- El log local no distingue cuánta entrada del `gpt-4.1-mini` de búsqueda es el bloque fijo de 8.000 tokens.

## 4. Límites propuestos

Son hipótesis en `budget_plans`, editables sin deploy, con todos los planes comerciales inactivos.
Ninguna equivalencia a minutos o mensajes es una promesa.

| Plan | Total | Mes | Día | Voz por día | Chat por día | Fondo por día |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Beta 90 días | US$3,00 | US$1,50 | US$0,20 | US$0,15 | US$0,15 | US$0,03 |
| Personal | | US$3,00 | US$0,40 | US$0,30 | US$0,30 | US$0,06 |
| Plus | | US$6,00 | US$0,80 | US$0,60 | US$0,60 | US$0,12 |

Beta: fondo global de US$90 y 30 lugares. Personal y Plus usan el tope alto de cada objetivo, para medir.
Los límites técnicos que ya existían siguen: 20 mensajes por minuto, 300 búsquedas web por día, tope de
pasos de herramientas por turno y límites de voz por usuario.

**Riesgos y supuestos**

- Con el costo actual, US$0,15 de voz por día son unos 3 minutos hablados por el usuario (US$0,055 por
  minuto, sin el modelo). Es muy poco para un producto de voz. Hay que elegir entre subir el presupuesto,
  bajar el costo de voz o limitar la voz premium.
- La muestra es de una persona que desarrolla el producto. **No hay p50 ni p95 reales.**
- El mes y el día se cuentan en UTC. Una cuenta en Argentina cambia de día a las 21.

**Después de 2 a 4 semanas de telemetría:** revisar la distribución por cuenta, el costo por minuto de
voz, cuántas veces se habría bloqueado en shadow, y comparar el estimado contra las facturas.

## 5. Modelo de costo mensual

No se publican estimaciones para 10, 30, 100 o 1.000 usuarios: una cuenta de desarrollo no respalda
ningún p50 o p95. Este es el modelo a completar con `/admin/usage`:

```
variable = N × (m_voz × c_voz + t_chat × c_turno + b_web × c_web + j × c_job)
total    = variable + fijos(Vercel, Supabase, Trigger, Sentry)
```

`m_voz` son los minutos de voz por mes, `t_chat` los turnos, `b_web` las búsquedas y `j` los jobs. Dato
medido, solo como referencia: voz sin modelo US$0,055 por minuto hablado, búsqueda web US$0,014.

## 6. Privacidad

Un evento guarda solo metadatos. Una prueba fija la lista exacta de columnas. Ejemplo:

```json
{
  "workspace_id": "<uuid>", "user_id": "<uuid>", "feature": "chat", "modality": "chat",
  "source": "desktop", "operation": "llm", "provider": "openai", "model": "gpt-6-luna",
  "input_tokens": 1000, "cached_tokens": 400, "cache_write_tokens": 100, "output_tokens": 10,
  "estimated_cost_usd": 0.000135, "budget_micro": 135, "cost_status": "actual",
  "price_version": "2026-11-04", "idempotency_key": "openai:resp_...", "status": "succeeded"
}
```

Sin prompts, respuestas, transcripciones ni claves. Las pruebas verifican que un stream cortado no deja
texto en el evento y que el informe de admin no contiene IDs reales ni emails: muestra hashes cortos.

## 7. Seguridad

Revisado:

- **`Members update connections` (ADR-129):** sigue abierta y fuera de este alcance. Ningún dato de plan o
  cuota vive en `provider_connections`, `user_preferences` ni otra tabla editable por el usuario.
- **Spoofing de usuario o workspace:** la identidad sale de la sesión, y la base además exige membresía.
- **Doble gasto y carreras:** reserva atómica con filas bloqueadas en orden.
- **Bypass por `x-request-id` (encontrado y corregido en esta fase):** la clave del turno era controlable
  por el cliente. Ahora la genera el servidor, y una clave cerrada no aprueba nunca más.
- **Rutas no instrumentadas:** la red de seguridad de los adaptadores las rechaza al aplicar límites.
- **Usuario sin plan, admin, job sin usuario:** sin plan se rechaza; ser admin no da saldo; el job
  responde por el dueño del workspace.
- **Webhooks:** ninguno registra consumo. La tabla descarta duplicados por id del proveedor.
- **Cliente:** ninguna tabla de presupuesto se puede leer ni escribir, ni llamar a sus funciones.
- **Límites por instancia:** `rateLimit` y la concesión de voz viven en memoria por instancia.
- **Trigger.dev:** no se imprimió ni guardó ninguna variable de entorno en esta auditoría.

## 8. Activación segura

1. Revisar y aplicar la migración 070 en un entorno de prueba, y luego en producción. El código funciona
   sin ella, sin las columnas nuevas.
2. Verificar en `/admin/usage` que los eventos nuevos traen `cost_status`, sin `unknown` inesperados.
3. Cargar presupuestos y alertas en cada proveedor (OpenAI, ElevenLabs, Google): son el último freno.
4. Crear la fila `internal` en `account_plans` para el dueño. **Sin ella, enforced lo bloquea.**
5. `ELISE_BUDGET_MODE=shadow` durante 1 a 2 semanas. Buscar en logs `budget.ungated`: **tiene que llegar a
   cero** antes de seguir, porque esas rutas fallarían al aplicar límites. Revisar `budget.would_deny`.
6. Programar `expire_budget_reservations` y borrar reservas viejas (no hay limpieza automática todavía).
7. Probar la concurrencia contra Postgres real (ver pendientes).
8. `ELISE_BUDGET_MODE=enforced:ws=<id>` en una cuenta de prueba. Después, general.
9. Para abrir la beta: `active = true` en `beta_90d`, crear invitaciones con hash y sumar la pantalla.

**Rollback:** `ELISE_BUDGET_MODE=observe` y redeploy; el gate deja de consultarse. La migración es aditiva
y no necesita revertirse.

## 9. Pendientes

**Sin probar:**

- Concurrencia con conexiones reales: PGlite tiene una sola, así que la prueba valida la lógica y no los
  bloqueos de Postgres.
- Rendimiento del trigger en volumen, en especial la fila del fondo global.
- Nada de esto corrió contra proveedores reales ni contra la base de producción, salvo una lectura agregada.

**Decisiones del dueño:** límites finales, cobro en ARS e impuestos, alcance de los 90 días gratis, cuentas
compartidas, precios de Personal y Plus, y qué hacer con el costo de la voz.
