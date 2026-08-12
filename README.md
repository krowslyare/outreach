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

## Estructura

```text
src/
├── agent/          conversación, catálogo y guardrails
├── evals/          matriz reproducible de conversaciones
├── harvest/        RENIPRESS y enriquecimiento con Places
├── llm/            puerto y adaptadores de proveedores
├── orquestador/    inbound, ráfagas y cola
├── prospects/      verticales, discovery y preflight
├── sequence/       auditoría, composición, cadencia y visuales opt-in
└── wa/             Baileys, SQLite, envío y seguridad
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
