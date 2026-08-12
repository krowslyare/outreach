# Sistema de prospección

Objetivo: conseguir conversaciones con negocios que ya tienen demanda y una
necesidad digital visible. El score ordena; no autoriza. Solo el gate de revisión
permite que un teléfono entre a campaña.

## Decisión comercial

La mejor señal no es “está en un padrón”. Es esta combinación:

1. paga anuncios o mantiene actividad comercial reciente;
2. tiene evidencia de operación (reseñas, servicios, sedes);
3. el anuncio termina en Instagram o WhatsApp y no en un sitio propio;
4. el WhatsApp actual sí pertenece al negocio esperado;
5. Kurogrid puede resolver algo concreto: consultas, reservas, promociones,
   Libro de Reclamaciones o gestión desde el Portal.

Un negocio pequeño puede ser buen cliente. Pocos seguidores no lo descartan.
Un número reciclado, otra ciudad, otra identidad o una web propia sí lo frenan.

### Patrón dental de la primera cohorte

La referencia es una clínica especializada y comercialmente activa: muestra
casos, doctores, agenda y tratamientos de ticket alto como ortodoncia,
alineadores, implantes o estética. Para ser prospecto de esta oferta debe
conservar esa calidad, pero depender todavía de Instagram, Facebook, TikTok,
Linktree o WhatsApp en vez de un dominio propio.

El orden para dental es:

1. anuncio activo con CTA a WhatsApp y sin dominio propio;
2. clínica con 20 o más reseñas, buena calificación y servicios de ticket alto;
3. actividad social reciente, equipo o sedes visibles;
4. identidad y dirección confirmadas en el WhatsApp actual.

Tener muchos seguidores no compensa una web propia. Tener pocas reseñas exige
otra señal fuerte, como anuncios actuales o una especialización clara.

## Fuentes, en orden

| Prioridad | Fuente | Qué demuestra | Uso |
|---|---|---|---|
| A | Anuncio activo de Meta visto en Ad Library o en el feed | Intención y presupuesto actuales | Entrada manual con URL del anuncio |
| A/B | Google Places por rubro y distrito | Operación, móvil, reseñas y web reportada | Descubrimiento automático acotado |
| B | RENIPRESS, Identicole, MINCETUR | Formalidad y rubro | Base para validar, no permiso de contacto |
| B | Instagram activo sin web, encontrado manualmente | Actividad reciente y oferta visible | Entrada manual con evidencia |
| C | Referidos de fotógrafos, community managers, contadores o consultores | Confianza transferida | Entrada manual; separar del cold outreach |

No se implementó scraping frágil de Meta. La Ad Library permite investigar
anuncios activos, pero la captación entra por una interfaz estable
(`--agregar`/`--importar`) que luego también puede alimentar un navegador
asistido. Así, un cambio de UI de Meta no rompe la base ni autoriza envíos.

La investigación asistida ya fue validada con anuncios activos en Perú. Para
cada hallazgo se guarda el negocio, teléfono visible, ID de la biblioteca,
fecha de inicio, URL y CTA. Luego pasa por la misma revisión de web e identidad
de WhatsApp que cualquier otra fuente; aparecer en Meta nunca basta para
aprobarlo.

## Verticales

Primera ola:

- `dental`: web, consultas, Libro de Reclamaciones y Portal.
- `veterinary`: reservas, campañas, catálogo y Portal.
- `aesthetics`: consultas, promociones, reservas y Portal.

Segunda ola:

- `health`: web, Libro de Reclamaciones, equipo y Portal.
- `education`: admisiones, campañas, Libro de Reclamaciones y Portal.

Después de tener datos:

- `legal`: consultas calificadas y presentación de equipo.
- `hospitality`: reservas, promociones y catálogo.

Las reglas viven en `src/prospects/verticals.ts`. Cada cohorte se mide por
separado; mezclar dentales con veterinarias hace imposible saber qué oferta y
mensaje funcionan.

## Flujo obligatorio

```text
fuente -> shortlist pendiente -> confirmar web -> perfil WA actual
       -> aprobación humana -> campaña -> respuesta -> handoff
```

No hay aprobación implícita por score, padrón, importación ni `--solo`.

### Lead visto en un anuncio

En Ad Library: país Perú, anuncios activos y una búsqueda concreta como
`centro estético`, `veterinaria` o `dentista`. Priorizar anuncios con teléfono
visible o CTA directo a WhatsApp y guardar siempre el ID del anuncio.

```bash
npm run prospectos -- \
  --agregar +51987654321 \
  --nombre "Veterinaria Patitas" \
  --distrito SURCO \
  --vertical veterinary \
  --origen meta \
  --url "URL_DEL_ANUNCIO_O_AD_LIBRARY" \
  --nota "Anuncio activo lleva a WhatsApp; 4.7 con 120 reseñas"
```

Si ya se comprobó manualmente que no tiene sitio propio, agregar `--sin-web`.
Esto todavía no lo aprueba.

### Descubrimiento replicable con Places

Una variante equivale a una request y devuelve hasta 20 resultados antes de
filtros. La CLI conserva solo negocios operativos, con móvil y sin web reportada.

```bash
# Ver sin guardar
npm run descubrir -- \
  --vertical veterinary \
  --distrito MIRAFLORES \
  --max 20

# Guardar la shortlist como pendiente
npm run descubrir -- \
  --vertical veterinary \
  --distrito MIRAFLORES \
  --max 20 \
  --import
```

`websiteUri` vacío en Places no demuestra que no exista una web. Por eso estos
leads entran pendientes aunque tengan muchas reseñas.

### Registro de salud actual

```bash
npm run harvest -- --enrich --limit 20 --import
npm run revisar
npm run revisar -- --sin-web +51987654321
```

El último comando confirma la web, pero no aprueba el teléfono.

### Preflight del WhatsApp actual

Consulta de solo lectura; no envía mensajes:

```bash
npm run prospectos -- --perfil +51987654321
```

Comparar nombre, categoría, dirección y links con el negocio esperado. Si no
coincide, rechazar. Si aparece un dominio propio, el store bloquea la aprobación.
Para consultar una cohorte en una sola sesión, sin enviar:

```bash
npm run prospectos -- \
  --preflight \
  --origen places \
  --vertical veterinary \
  --limite 10
```

```bash
npm run prospectos -- \
  --rechazar +51987654321 \
  --motivo "el WhatsApp actual pertenece a otro negocio"
```

Si coincide:

```bash
npm run prospectos -- \
  --aprobar +51987654321 \
  --identidad-confirmada
```

Si un establecimiento tiene dos móviles, aprobar uno rechaza automáticamente
el otro.

### Ver la bandeja

```bash
npm run prospectos
npm run prospectos -- --aprobados
npm run prospectos -- --rechazados
npm run prospectos -- --origen places --vertical veterinary
npm run prospectos -- --verticales
```

Solo después:

```bash
npm run campana -- --vertical dental --max 3 --escuchar
```

El filtro de vertical es obligatorio en los pilotos para no mezclar cohortes.
Para reiniciar el bot y atender conversaciones sin abrir una tanda nueva:

```bash
npm run campana -- --sin-tanda --escuchar
```

## Importación en lote

`npm run prospectos -- --importar leads.json` acepta un arreglo JSON. Ninguna
fila se aprueba al importarse.

```json
[
  {
    "e164": "+51987654321",
    "nombre": "Veterinaria Patitas",
    "distrito": "SURCO",
    "vertical": "veterinary",
    "origen": "meta",
    "url": "https://www.facebook.com/ads/library/...",
    "nota": "Anuncio activo a WhatsApp",
    "sinWeb": true,
    "score": 90
  }
]
```

## Piloto

1. Empezar con una cohorte homogénea de 10 leads A de `dental`.
2. Enviar la primera tanda dentro de horario, dejando el listener activo. La
   separación aleatoria de 2–5 minutos evita una ráfaga sin convertir diez
   contactos en una jornada completa.
3. No optimizar por “respuestas” solamente. Separar:
   `ACK_DEVICE`, respuesta humana, interés real, handoff y reunión.
4. Revisar cada conversación y ajustar el módulo de la vertical, no el prompt
   global, salvo que el problema sea común.
5. Replicar luego en `veterinary` y `aesthetics`, cada una en su propia cohorte.

El primer objetivo no es volumen. Es demostrar que una combinación
`fuente + vertical + mensaje + oferta` produce handoffs. Recién entonces se
replica por distrito y vertical.
