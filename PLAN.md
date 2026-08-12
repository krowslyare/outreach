# Máquina de outreach end-to-end — Kurogrid

De "no conozco a nadie" a "el prospecto quiere cerrar y te pide hablar contigo".
El cierre lo haces tú. Todo lo anterior corre solo.

> Estado operativo actual: la prospección ya no autoriza envíos automáticamente.
> El flujo vigente, los verticales y los comandos están en `PROSPECTING.md`.

## Decisiones tomadas

| Decisión | Elección | Por qué |
|---|---|---|
| Acoplamiento | Servicio **independiente**, no módulo del portal | La sesión de WhatsApp es un proceso vivo con estado en disco. No corre en Vercel. Y si el proceso ya existe con su DB, meter el cerebro en el portal solo agrega acoplamiento. |
| Integración con portal | **Un solo punto**: crear la Oportunidad en el handoff | Integración, no fusión. Arranca como "avísame" y añade el write después. |
| Lenguaje | **TypeScript** | El bot *tiene* que ser Node (las libs son Node-only). Un runtime en vez de dos. Ya escribes TS en el portal. `build_sheet.py` se queda como está. |
| Hosting | **VPS chico con proceso supervisado** (systemd) | Necesita proceso persistente + disco para el auth state. Vercel no aplica. Fly.io tampoco: sus máquinas suspenden, y eso mata la sesión de WhatsApp. |
| Dirección del flujo | **Dos entradas: registro → Places y categoría → Places** | Los registros validan formalidad donde existen; Text Search permite descubrir verticales sin padrón nacional, siempre con revisión posterior. |
| DB | **SQLite vía `node:sqlite`** (builtin, cero deps) | Revertido de Supabase: la DB está en el camino crítico del envío y un parpadeo de red no debe romper un envío ni perder ACKs. El proceso ya es instancia única (la sesión de WhatsApp no se comparte), así que no hay argumento de concurrencia para una DB servidor. Supabase queda como read-model si se quiere ver desde el portal. |
| Canal 1er toque | WhatsApp directo, riesgo asumido | Es donde están, y una empresa sin web no tiene email corporativo. IG descartado: no hay cuenta creada. |
| Volumen | 10-20/día | Ritmo humano. Suficiente para validar el pitch antes de escalar. |
| Meta del agente | Agendar tu llamada, **no vender** | Sin links de pago, sin cierre. Simplifica mucho el agente. |
| Autorespondedores | **Clasificar el entrante**, no partir el primer mensaje | Casi todo establecimiento tiene saludo automático de WhatsApp Business y llega a los segundos del primer contacto. La alternativa evaluada era mandar un "Buenas" para quemar el saludo y el pitch 15s después; se descartó porque choca contra cinco cosas (separación mínima de 180s, llave de idempotencia del paso, conteo de follow-ups, la consulta de candidatos y el propio `canContact`), duplica los salientes —de 15 contactos/día a 7— y deja un estado nuevo donde una caída del proceso deja al prospecto con un "Buenas" pelado. Detalle abajo. |

## Módulos

```
src/
  harvest/     M1  Registro RENIPRESS → validación con Places
  prospects/   M1b Fuentes y verticales modulares
    verticals.ts             prioridad, búsquedas y hooks por rubro
    places-discovery.ts      descubrimiento por categoría y distrito
  cli/
    prospectos.ts            entrada manual/Meta + gate de aprobación
    descubrir.ts             shortlist de Places; nunca autoaprueba
  score/       M2  Fit para el servicio administrado — puro, sin IO, testeable
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
- **Ya gasta en publicidad** (Meta Ad Library) — la señal más fuerte, pero entra
  manualmente con su URL. No se implementó un scraper dependiente de la UI.
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

## Entrantes automáticos — por qué la cadencia se moría sola

El **mensaje de bienvenida** de WhatsApp Business se dispara una sola vez por
contacto y se rehabilita recién tras 14 días de inactividad. O sea: llega una vez,
en el primer contacto, y los follow-ups de día 3 y día 7 no lo vuelven a
disparar. El **mensaje de ausencia** es otra cosa —se dispara fuera del horario
que el negocio configuró— y no está confirmado con qué frecuencia se repite. Para
el sistema los dos son lo mismo: `automatico`.

El daño nunca estuvo en el chat: el prospecto recibe el pitch completo y lo lee
igual. Estaba en nuestra contabilidad. Un saludo automático seteaba
`lastInboundAt`, y con eso:

1. `canContact` negaba para siempre → **ningún follow-up de la lista se enviaba**,
   y cada prospecto figuraba en el log como "ya respondió", que es justo lo que
   uno espera ver.
2. La consulta de candidatos lo excluía por SQL, así que arreglar solo
   `canContact` no alcanzaba.
3. Se gastaba una llamada al LLM con esfuerzo alto contestándole a un robot.
4. "En breve un asesor lo atenderá" leído por el agente puede parecer interés y
   escalar un lead que no existe.

El criterio vive en `src/wa/clasificar.ts` y está **sesgado a "humano"**. Marca
`automatico` solo si se cumple todo: llegó dentro de 60s de nuestro saliente, es
texto plano, no cita nuestro mensaje, no trae media, y hace match con una frase de
plantilla. Cualquier duda cae en humano.

La asimetría es la razón del sesgo: tratar a una persona como robot significa
seguir mandándole follow-ups a alguien que ya contestó —grosero, y quema el
prospecto—. Tratar a un robot como persona cuesta dos follow-ups. Solo latencia no
alcanza: una recepcionista mirando el chat contesta "¿de qué se trata?" en menos
de diez segundos.

Se arreglaron dos bugs que estaban tapados por el anterior: `followUpCount`
contaba las respuestas libres del agente como follow-ups, y los entrantes no
tenían idempotencia, así que una reconexión de WhatsApp Web podía hacer que el
agente contestara dos veces el mismo mensaje.

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

## Calibración contra Places — medido, 2026-07-26

Primera corrida real contra la API sobre 30 prospectos del segmento.

| | de 30 | |
|---|---|---|
| Match confiable (≥0.6) | 17 | 57% |
| **De esos, sin web** | **9** | **30%** |
| Ya tienen web | 14 | 47% |
| Sin match utilizable | 13 | 43% |

**El embudo real es ~30%, no 100%.** De los 1,143 con celular quedan **~343**
prospectos verificables y sin web: unos 23 días a 15/día. Suficiente para el
piloto; bastante menos que la lista cruda.

Distribución de confianza: 0.00→5, 0.20→7, 0.50→1, 0.70→12, 0.95→5.

**Los umbrales quedan como están.** Los rechazos de 0.20 son correctos: dos
médicos distintos matchearon el mismo placeId, que es justo el falso positivo
que el umbral ataja. RENIPRESS registra a muchos profesionales bajo su nombre
personal y Google los tiene bajo nombre comercial — el nombre no puede tender
ese puente.

**El cuello de botella son las coordenadas, no la heurística.** Los 7 rechazos
de 0.20 tienen todos `coords: NO`; sin coordenadas el matching cae al camino de
solo-nombre, que topa en 0.70. El 45% del segmento está así. Si se quiere subir
la tasa, el lever es geocodificar, no aflojar umbrales.

**Pendiente de decidir:** si un match de 0.95 (coordenadas a <100m + solape de
nombre) alcanza para dar `verificadoSinWeb` por bueno. Hoy no se hace: que
Places no traiga el campo sigue sin probar que no exista un sitio. Pero el
riesgo en ese tramo es bastante menor que en un match de 0.70.

## Fuentes

- **Google Places** (Text Search, field mask) — opera, teléfono, sin web, reseñas.
- **Padrón Reducido SUNAT** — RUC 20, estado, condición, ubigeo. Datos abiertos.
- **RENIPRESS** — registro de establecimientos de salud: dentistas y clínicas.
- **Identicole** — fuente oficial para educación privada.
- **MINCETUR** — directorios de hospedajes, agencias y restaurantes calificados.
- **Meta Ad Library** — ¿ya paga ads? (verificar acceso programático)

Ojo: **ausencia de `websiteUri` significa dato ausente, no que no tenga web.** Hace falta
un paso de verificación antes de contactar.

## Pendientes de resolver

- Padrón Reducido SUNAT: confirmar qué columnas trae hoy (el conteo de trabajadores probablemente NO está — usar reseñas y rubro como proxy).
- Automatización de Meta: mantener entrada manual/browser-assisted hasta contar
  con acceso programático oficial estable para anuncios comerciales peruanos.
- Número de reemplazo: cómo conseguir eSIM peruana rápido cuando toque.

## Piloto antes de construir el agente

50-100 contactos **a mano**, con la lista que produce M1+M2, antes de escribir M5.

Qué medir: **tasa de `ACK_DEVICE`**, respuestas negativas explícitas, reuniones
agendadas y supervivencia del número. NO "tasa de bloqueo": no es observable —
WhatsApp no te dice quién te bloqueó.

Es lo que te dice si el pitch sirve antes de invertir en el agente, y te da el
baseline sin el cual el kill switch no tiene contra qué comparar.

## La oferta, verificada contra el código de Kurogrid — 2026-07-27

Corrección de un supuesto que arrastramos desde el planteo inicial: **S/649 no es
la oferta, es el plan más caro de tres.** El de entrada es S/199.

| Plan | Mensualidad | Para quién |
|---|---|---|
| Presencia | S/199 | No tiene web y necesita existir en Google con algo serio |
| Empresa | S/449 | Quiere que la web capte pacientes, no solo estar presente |
| Empresa + | S/649 | Varios servicios o sedes, cambios seguido, Libro de Reclamaciones |

Consecuencia directa: calificar por "puede pagar S/649 sin rechistar" encogía el
mercado sin razón. Un consultorio chico entra por S/199.

**No hay costo de desarrollo inicial.** Verificado en tres fuentes independientes
del código de Kurogrid: `waas-plans.ts` (`setup: "S/ 0 costo de creación
inicial"`), la migración de pricing del portal, y el documento de operaciones del
plan Empresa+. La landing lo llama "Desarrollo inicial cero".

Eso habilita el gancho más concreto del primer contacto, y por eso se agregó la
apertura `modelo`. Dos reglas al usarlo, que están en el prompt: en minúsculas y
con palabras —nunca "S/ 0" ni mayúsculas, que leen como aviso de préstamo— y
siempre pegado a la mensualidad, nunca como "gratis" a secas, que atrae a quien
no va a pagar.

**Qué vende Kurogrid, en sus propias palabras:** "servicio digital administrado",
"nos encargamos de la web y las herramientas digitales que tu empresa necesita,
con un solo proveedor y una mensualidad clara". No es una web como entregable ni
es marketing de captación: es que el cliente no se tenga que ocupar.

El compositor no sabía nada de esto —importaba el catálogo y no lo usaba— y el
prompt le pedía explícitamente que NO explicara el servicio. De ahí salían
mensajes que no decían nada, del tipo "busco a la persona que ve cómo los
encuentran los pacientes".
