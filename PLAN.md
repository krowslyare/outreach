# Máquina de outreach end-to-end — Kurogrid

De "no conozco a nadie" a "el prospecto quiere cerrar y te pide hablar contigo".
El cierre lo haces tú. Todo lo anterior corre solo.

## Decisiones tomadas

| Decisión | Elección | Por qué |
|---|---|---|
| Acoplamiento | Servicio **independiente**, no módulo del portal | La sesión de WhatsApp es un proceso vivo con estado en disco. No corre en Vercel. Y si el proceso ya existe con su DB, meter el cerebro en el portal solo agrega acoplamiento. |
| Integración con portal | **Un solo punto**: crear la Oportunidad en el handoff | Integración, no fusión. Arranca como "avísame" y añade el write después. |
| Lenguaje | **TypeScript** | El bot *tiene* que ser Node (las libs son Node-only). Un runtime en vez de dos. Ya escribes TS en el portal. `build_sheet.py` se queda como está. |
| Hosting | **VPS chico con proceso supervisado** (systemd) | Necesita proceso persistente + disco para el auth state. Vercel no aplica. Fly.io tampoco: sus máquinas suspenden, y eso mata la sesión de WhatsApp. |
| Dirección del flujo | **Registro oficial → Places**, no al revés | No hay llave común Places↔SUNAT; matchear razón social con nombre comercial es fuzzy y falla. Arrancando del registro, el RUC 20 viene dado. |
| DB | **SQLite vía `node:sqlite`** (builtin, cero deps) | Revertido de Supabase: la DB está en el camino crítico del envío y un parpadeo de red no debe romper un envío ni perder ACKs. El proceso ya es instancia única (la sesión de WhatsApp no se comparte), así que no hay argumento de concurrencia para una DB servidor. Supabase queda como read-model si se quiere ver desde el portal. |
| Canal 1er toque | WhatsApp directo, riesgo asumido | Es donde están, y una empresa sin web no tiene email corporativo. IG descartado: no hay cuenta creada. |
| Volumen | 10-20/día | Ritmo humano. Suficiente para validar el pitch antes de escalar. |
| Meta del agente | Agendar tu llamada, **no vender** | Sin links de pago, sin cierre. Simplifica mucho el agente. |

## Módulos

```
src/
  harvest/     M1  Fuentes → prospectos crudos
    places.ts        Google Places: negocios SIN websiteUri + teléfono
    sunat.ts         Padrón reducido: RUC 20, estado ACTIVO, condición HABIDO, ubigeo
    adlibrary.ts     Meta Ad Library: ¿ya paga ads?
    dedupe.ts
  score/       M2  Fit para S/649 — puro, sin IO, testeable
    score.ts
    score.test.ts
  sequence/    M3  A quién, cuándo, con qué
    queue.ts         Cola serial, pacing con jitter, horario hábil
    cadence.ts       Día 0 / 3 / 7-8, máx 2 follow-ups
    compose.ts       Claude → gancho personalizado por prospecto
  whatsapp/    M4  El canal
    client.ts        Sesión whatsapp-web.js, auth persistente
    send.ts          Envío serial, rate-limited, jitter
    inbound.ts       Eventos entrantes → conversación
    safety.ts        Opt-out, monitor de entrega, KILL SWITCH
  agent/       M5  El cerebro
    agent.ts         Loop con Claude + contexto del prospecto
    catalog.ts       Planes y precios (config local, no dep del portal)
    qualify.ts       ¿Está caliente? ¿Hay que escalar?
  handoff/     M6  → a ti
    notify.ts        Te avisa cuando alguien está listo
    portal.ts        Una función: crear Oportunidad
```

## Scoring (M2) — señales elegidas

Base obligatoria: RUC empieza en 20 (persona jurídica), estado ACTIVO, condición HABIDO, sin `websiteUri` en Places, con teléfono.

Luego suma:
- **Ya gasta en publicidad** (Meta Ad Library) — la más fuerte. Paga ads y no tiene web: está quemando ese dinero. Es a la vez señal de capacidad de pago y el mejor gancho de venta.
- **Rubro de margen alto** — dental, veterinaria, legal, colegios privados, gimnasios, estética, ópticas.
- **Volumen de reseñas en Google** — filtra RUC fantasma; prueba de negocio operando.
- **Distrito y multi-local** — Miraflores, San Isidro, Surco, La Molina; más de una sede.

## Seguridad del número — lo que de verdad importa

Alcance: acá solo se maneja **riesgo de ban de WhatsApp**. La normativa peruana de datos
queda fuera de alcance por decisión de negocio (tamaño de operación, riesgo de
fiscalización asumido). Son riesgos independientes: WhatsApp no se entera del
reglamento peruano, y el reglamento no te protege de un ban.

El pacing NO es la protección principal. El dominante es la **tasa de bloqueos**.

- [ ] Número **dedicado**, jamás el de negocio. SIM/eSIM aparte.
- [ ] Calentar 1-2 semanas de uso normal antes de la primera campaña.
- [ ] Mensaje **único y relevante** por destinatario — ésta es la mitigación real, no un adorno.
- [ ] Opt-out instantáneo y permanente — **no por norma, sino porque es el mejor
      reductor de tasa de bloqueo**, que es lo que cuesta el número.
- [ ] **Ramp-up 3 → 5 → 10 → 15 → 20/día**, subiendo solo con métricas sanas. Doble
      función: es también el calentamiento.
- [ ] Kill switch por **caída de la tasa de `ACK_DEVICE`** vs. baseline:
      `device_rate_24h = primeros mensajes con ACK_DEVICE / primeros mensajes enviados hace ≥24h`.
      NO usar `ACK_READ` (mucha gente desactiva confirmaciones → falsos positivos).
      NO usar fallas de entrega ni tasa de respuesta como señal primaria: la primera no
      existe para bloqueos, la segunda mide calidad del pitch y llega tarde.
      Ventanas de ≥30 mensajes, comparación beta-binomial en vez de umbral fijo — con
      10-20/día un umbral simple se dispara por 3 casos de mala suerte.
- [ ] Kill inmediato ante `auth_failure` o `disconnected: LOGOUT`.
- [ ] Tasa de respuesta a 72h: alarma **secundaria**, para pausar una campaña, no el número.
- [ ] Reemplazo del número ~1 por trimestre = costo de operación. Riesgo estimado de
      pérdida: 15-30% en los primeros 90 días corriendo continuo.

## Motor de seguridad — determinista y FUERA del agente

Límites diarios, supresión permanente, horario hábil y kill switch son código, no prompt.
A un LLM se le convence; a un limitador hardcodeado no. El agente pide permiso para
enviar; el motor concede o niega.

- **Lock de takeover humano**: después del handoff, cero envíos automáticos. Nunca.
- **Outbox transaccional** con `idempotency_key`, lease y reintentos acotados. Handoff y
  notificación salen del **mismo** outbox, para que no divergan.
- Registro inmutable por mensaje: campaña, destinatario, timestamps, ACK máximo, respuesta, error.
- Watchdog + recuperación de sesión. **Pinear la versión de whatsapp-web.js** y probar
  updates antes de desplegar: WhatsApp Web rompe estas libs seguido.
- Tests de: reinicio, evento duplicado, ACK tardío, caída entre DB y envío.

## Guardrails del agente (M5)

- Nunca inventar descuentos, plazos, casos de éxito ni capacidades. Precios solo del catálogo.
- Resistencia a prompt injection: los mensajes del prospecto son datos, no instrucciones.
- Handoff inmediato ante: negociación de precio, contrato, queja, o pedido explícito de hablar con humano.
- Máquina de estados explícita: `nuevo → contactado → respondió → calificando → caliente → handoff → perdido / opted_out`.
- Idempotencia en todo envío: reinicios y eventos repetidos no deben duplicar mensajes.

## Orden de construcción

**M1 + M2 primero.** Son independientes del canal, no tocan ToS y no tienen riesgo. Producen la lista de prospectos scoreada, que tiene valor incluso si terminas mandando los mensajes a mano. Nada de lo que decidas después sobre WhatsApp invalida este trabajo.

Después M4 + safety (canal y frenos antes que cerebro), luego M3, M5, M6.

## Costo de Places — resuelto

`websiteUri`, `nationalPhoneNumber`, `rating` y `userRatingCount` **todos disparan el SKU
Enterprise** (~$35/1,000, 1,000 gratis/mes). Pero Text Search se cobra **por request, no
por lugar devuelto**, y devuelve hasta 20 lugares por request.

Consecuencia de diseño: **screenear con el field mask de Text Search, nunca con Place
Details por lugar.** Sale ~20× más barato (~$0.0018 vs ~$0.035 por negocio).
Screenear 20k negocios ≈ 1,000 requests ≈ $35. Manejable.

## Vertical 1: salud (RENIPRESS) — medido, no estimado

Embudo real sobre `RENIPRESS_2025_v2.csv` (25,986 filas):

| Etapa | Quedan |
|---|---|
| Privados (todos activos) | 16,087 |
| Con teléfono | 16,058 (100%) |
| Lima | 8,408 |
| + clasificación de margen + 11 distritos altos | 2,502 |
| **Con celular (WhatsApp-able)** | **1,173** |
| Tras descartar gestores y deduplicar | **1,150** |

Los 1,426 restantes del segmento son fijos: no sirven. El titular de 2,502 era engañoso.
A 15/día son ~77 días de pipeline. Ampliable soltando distritos (8,408 privados en Lima).

**RUC 20: descartado para esta vertical.** RENIPRESS no trae RUC, y estar registrado
como PRIVADO y activo es un filtro *más fuerte* que "es persona jurídica" — implica
autorizado por el regulador, categorizado y operando. Mantener el filtro de RUC exigía
fuzzy matching contra el padrón para agregar información que ya tenemos por otra vía.

**Teléfonos de gestores.** Un mismo celular aparecía en hasta **106 establecimientos**:
son tramitadores que registran clínicas ajenas. Escribirles es inútil y se ve como spam.
El conteo tiene que ser **nacional**: ese número daba 56 contando solo Lima. Topando en
3 establecimientos el costo es ~2% de la lista y saca a los tramitadores.

## Fuentes

- **Google Places** (Text Search, field mask) — opera, teléfono, sin web, reseñas.
- **Padrón Reducido SUNAT** — RUC 20, estado, condición, ubigeo. Datos abiertos.
- **RENIPRESS** — registro de establecimientos de salud: dentistas, clínicas, veterinarias.
  Cruza directo con el rubro de margen alto. Vía verticales oficiales el fit es mucho mejor
  que barriendo Places a ciegas.
- **Meta Ad Library** — ¿ya paga ads? (verificar acceso programático)

Ojo: **ausencia de `websiteUri` significa dato ausente, no que no tenga web.** Hace falta
un paso de verificación antes de contactar.

## Pendientes de resolver

- Padrón Reducido SUNAT: confirmar qué columnas trae hoy (el conteo de trabajadores probablemente NO está — usar reseñas y rubro como proxy).
- Meta Ad Library: verificar acceso programático y sus límites.
- Número de reemplazo: cómo conseguir eSIM peruana rápido cuando toque.

## Piloto antes de construir el agente

50-100 contactos **a mano**, con la lista que produce M1+M2, antes de escribir M5.

Qué medir: **tasa de `ACK_DEVICE`**, respuestas negativas explícitas, reuniones
agendadas y supervivencia del número. NO "tasa de bloqueo": no es observable —
WhatsApp no te dice quién te bloqueó.

Es lo que te dice si el pitch sirve antes de invertir en el agente, y te da el
baseline sin el cual el kill switch no tiene contra qué comparar.
