# Kurogrid Outreach

Pipeline local de prospección y conversación controlada por WhatsApp para
Kurogrid. El proyecto conecta descubrimiento, revisión humana, composición de
mensajes, cadencia, recepción de respuestas y handoff a una persona.

[![CI](https://github.com/krowslyare/outreach/actions/workflows/ci.yml/badge.svg)](https://github.com/krowslyare/outreach/actions/workflows/ci.yml)

> Estado: prototipo operativo en fine-tuning. No es un servicio público ni un
> sistema de envío masivo.

## Qué demuestra

- TypeScript sobre Node.js 22 y SQLite local con `node:sqlite`.
- Adaptadores intercambiables para Anthropic, Gemini, Codex y Claude CLI.
- Descubrimiento por vertical con Google Places y fuentes registrales.
- Separación explícita entre encontrar un prospecto y autorizar el contacto.
- Motor determinista de seguridad: opt-out, takeover humano, kill switch,
  pacing, horario, idempotencia y dry-run fail-closed.
- Clasificación de entrantes, agrupación de ráfagas y escalamiento a una
  persona.
- Suite de pruebas offline para el flujo de conversación y los límites del
  canal.

## Flujo

```text
fuentes → shortlist → revisión web + perfil de WhatsApp
        → aprobación humana → dry-run → envío controlado
        → entrantes → agente → handoff humano
        → cliente → requisitos → publicación
```

La aprobación nunca se infiere desde Places o desde una importación. El perfil
actual de WhatsApp se consulta como preflight; la aprobación exige revisar esa
identidad y confirmar la ausencia de web. Las reglas duras viven en código, no
en el prompt del modelo.

## Inicio rápido

Requisitos: Node.js `>=22.5.0` y npm.

```bash
npm ci
cp .env.example .env
npm run typecheck
npm test
```

Las pruebas no necesitan API keys ni una sesión de WhatsApp. Los comandos que
usan Places, un proveedor LLM o el canal real sí requieren su configuración
correspondiente en `.env`.

## Comandos principales

```bash
# Ver verticales, búsquedas y ángulos comerciales
npm run prospectos -- --verticales

# Calcular el embudo local de RENIPRESS sin llamar a Places
# Requiere el dataset local ignorado data_renipress_2025.csv.
npm run harvest -- --limit 10

# Descubrir una shortlist en Places; --import solo deja filas pendientes
npm run descubrir -- --vertical dental --distrito Miraflores --max 20 --import

# Revisar prospectos pendientes y consultar perfiles actuales de WhatsApp
npm run prospectos -- --preflight --limite 10
npm run prospectos -- --aprobados

# Simular una campaña: no abre WhatsApp y no envía nada
npm run campana -- --dry-run --max 3

# Ver qué conversaciones esperan una respuesta (tuya o del bot)
npm run bandeja

# El resumen de la mañana: cuenta, bandeja, clientes y embudo
npm run panel

# Onboarding de un cliente cerrado: ficha, checklist y kickoff
npm run cliente -- --nuevo +51987654321 --nombre "Clínica Sonrisa" --plan empresa+
npm run cliente -- --kickoff +51987654321   # imprime el mensaje para pegar
npm run cliente                              # tablero de clientes

# Evaluar conversaciones offline
npm run eval:conversaciones
```

Para probar el camino completo contra un teléfono propio, se siembra primero
un destinatario de prueba y se apunta la campaña de forma explícita:

```bash
npm run sembrar -- --e164 +51987654321 --nombre "Teléfono de prueba"
npm run campana -- --solo +51987654321 --max 1 --escuchar
```

Una campaña real requiere revisión del dry-run, un número dedicado, sesión
vinculada, `NUMERO_HUMANO` y aprobación explícita de los prospectos. No se debe
usar el número comercial ni aumentar volumen antes de validar el circuito.

## Canales

El sistema habla con WhatsApp a través de un solo contrato (`WaClient`), con dos
implementaciones intercambiables:

- **`baileys`** (default): sesión de WhatsApp Web vinculada por QR. Permite
  enviar texto libre —es el canal del outreach en frío— al precio de mantener
  una sesión viva.
- **`cloud`**: la API oficial de Meta (`CANAL=cloud`). Recibe respuestas por
  webhook firmado y contesta dentro de la ventana de servicio de 24h, que es
  gratis. Lo business-initiated sale por **plantillas utility aprobadas en
  Meta** (`WHATSAPP_PLANTILLA_FOLLOWUP` para follow-ups de tanda,
  `WHATSAPP_PLANTILLA_NOTIFICACION` para el aviso de handoff; cada una con un
  hueco `{{1}}`). Sin plantilla de follow-up configurada, `campana` rechaza
  correr tandas en ese modo. Requiere un número dado de alta en la consola de
  Meta, token, app secret y un webhook público con HTTPS.

| Tramo | baileys | cloud |
|---|---|---|
| Primer toque en frío | sí | no (requiere plantilla de marketing) |
| Follow-up fuera de ventana | sí | sí, vía plantilla utility |
| Contestar dentro de la ventana de 24h | sí | sí |
| Riesgo de bloqueo del número | alto | bajo |
| Notificación al `NUMERO_HUMANO` | sí | sí, vía plantilla (o texto si hay ventana abierta) |

El primer toque en frío sigue siendo territorio de Baileys: exige una plantilla
de marketing aprobada y pagada por entrega, y su calidad es lo que decide la
composición personalizada.

## Estructura

```text
src/
├── agent/          conversación, catálogo y guardrails
├── bandeja/        cola de atención humana leída de la base local
├── evals/          matriz reproducible de conversaciones
├── handoff/        escalamiento al dueño: lock, aviso y acuse
├── harvest/        RENIPRESS y enriquecimiento con Places
├── llm/            puerto y adaptadores de proveedores
├── onboarding/     clientes cerrados: requisitos, progreso y kickoff
├── orquestador/    inbound, ráfagas y cola
├── panel/          resumen diario compuesto sobre los read-models
├── prospects/      verticales, discovery y preflight
├── score/          fit para el servicio administrado; puro y testeable
├── sequence/       auditoría, composición, cadencia y visuales opt-in
└── wa/             canal: Baileys, API oficial, SQLite y seguridad
```

Documentación operativa:

- [`PROSPECTING.md`](PROSPECTING.md): fuentes, verticales y criterios de
  revisión.
- [`PLAN.md`](PLAN.md): decisiones de arquitectura y riesgos del canal.
- [`VISUAL_OUTREACH.md`](VISUAL_OUTREACH.md): manifiestos y QA de imágenes
  opt-in.

## Datos y seguridad

`.env`, la sesión de Baileys, SQLite, cachés, prospectos importados y visuales
de campaña están excluidos del repositorio. No deben subirse teléfonos,
manifiestos de cohortes ni material criptográfico. Las barreras técnicas no
reemplazan las obligaciones legales, la revisión humana ni las políticas de
WhatsApp.

## Verificación

```bash
npm run typecheck
npm test
```

CI ejecuta exactamente esos dos checks en cada push y pull request.
