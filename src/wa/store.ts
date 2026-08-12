import { createRequire } from "node:module";

import type { ScoredProspect } from "../types.js";
import type { ClaseInbound } from "./clasificar.js";
import type {
  AccountHealth,
  KillSwitchState,
  RecipientState,
} from "./types.js";

// Vitest 2 todavía intenta resolver `node:sqlite` como un paquete llamado
// `sqlite`. createRequire mantiene explícito que usamos el builtin de Node y no
// agrega una dependencia ni cambia el runtime de producción.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type SendStep = "first" | "fu1" | "fu2";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type ProspectOrigin =
  | "manual"
  | "meta"
  | "places"
  | "minem"
  | "renipress"
  | "identicole"
  | "mincetur"
  | "test";

export interface ManualProspectInput {
  e164: string;
  name: string;
  district: string;
  classification: string;
  vertical: string;
  origin: ProspectOrigin;
  sourceUrl?: string;
  notes?: string;
  score: number;
  verifiedWithoutWebsite: boolean;
  approve: boolean;
}

export interface WhatsAppBusinessProfile {
  description: string;
  category: string | null;
  address: string | null;
  websites: readonly string[];
}

export interface ProspectReviewRow {
  e164: string;
  sourceId: string;
  name: string;
  district: string;
  classification: string;
  score: number | null;
  hasWebsite: boolean | null;
  reviewCount: number | null;
  vertical: string;
  origin: string;
  sourceUrl: string | null;
  notes: string | null;
  approvalStatus: ApprovalStatus;
  reviewReason: string | null;
  reviewedAt: string | null;
  waDescription: string | null;
  waCategory: string | null;
  waAddress: string | null;
  waWebsites: string[];
  waCheckedAt: string | null;
}

export type ReviewMutationResult =
  | { ok: true; affected: number }
  | { ok: false; reason: string };

/**
 * Qué corresponde hacer con un entrante recién llegado.
 *
 * `pendiente` es el caso que evita perder un prospecto: la fila ya está guardada
 * pero el trabajo posterior nunca terminó, así que hay que rehacerlo.
 */
export type RegistroInbound = "nuevo" | "pendiente" | "ya_atendido";

type AccountStateRow = {
  campaign_started_at: string | null;
  kill_switch_tripped: number;
  kill_switch_reason: string | null;
  kill_switch_at: string | null;
  device_rate_baseline: number | null;
};

type MessageTimeRow = {
  sent_at: string | null;
};

type FirstMessageRow = {
  ack: number | null;
  sent_at: string;
};

const SCHEMA = `
create table if not exists recipients (
  e164 text primary key, source_id text not null, name text not null,
  district text not null, classification text not null, score integer,
  suppressed integer not null default 0, suppressed_reason text,
  human_takeover integer not null default 0, created_at text not null,
  -- Contexto que el agente usa para personalizar. Se guarda acá y no se
  -- recalcula: el prospecto puede responder semanas después del harvest.
  has_website integer, review_count integer);

create table if not exists messages (
  id integer primary key autoincrement, e164 text not null references recipients(e164),
  direction text not null check (direction in ('out','in')), body text not null,
  idempotency_key text unique, wa_message_id text, sent_at text,
  ack integer, ack_at text, error text, created_at text not null,
  -- Solo en entrantes: 'humano' o 'automatico'. Ver clasificar.ts.
  inbound_class text,
  -- Solo en salientes de campaña. null en las respuestas libres del agente, que
  -- por eso no cuentan como follow-ups.
  step text,
  -- Solo en entrantes: cuándo se terminó de atender. Recibir no es atender: si
  -- el LLM o el envío fallan después de guardar la fila, esto sigue nulo y el
  -- evento puede reprocesarse.
  handled_at text);

-- Idempotencia de entrantes. Una reconexión de WhatsApp Web puede reemitir
-- eventos ya procesados; sin esto el mismo mensaje se guarda dos veces y el
-- agente lo contesta dos veces. Los salientes ya se protegen con
-- idempotency_key, pero su wa_message_id también es único, así que el índice
-- cubre ambas direcciones. SQLite permite varios null, que es lo que necesitan
-- los salientes todavía no enviados.
create unique index if not exists idx_messages_wa_message_id
  on messages(wa_message_id);

create table if not exists account_state (
  id integer primary key check (id = 1), campaign_started_at text,
  kill_switch_tripped integer not null default 0, kill_switch_reason text,
  kill_switch_at text, device_rate_baseline real);

-- La identidad comercial y la aprobación viven separadas del registro base.
-- RENIPRESS/Places dicen "qué encontramos"; esta tabla dice "¿lo revisamos y
-- autorizamos para campaña?". La campaña falla cerrada: sin approved no sale.
create table if not exists prospect_metadata (
  e164 text primary key references recipients(e164) on delete cascade,
  vertical text not null,
  origin text not null,
  source_url text,
  notes text,
  approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'rejected')),
  review_reason text,
  reviewed_at text,
  wa_description text,
  wa_category text,
  wa_address text,
  wa_websites text,
  wa_checked_at text);
`;

function asDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: string) => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new Error(`falta ${type} al formatear la fecha`);
    return part;
  };
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localDayNumber(date: Date, timeZone: string): number {
  const [year, month, day] = dateKey(date, timeZone).split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("fecha local inválida");
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * Persistencia síncrona y pequeña del canal.
 *
 * SQLite vive en el mismo proceso que la sesión de WhatsApp: reclamar un envío
 * antes de tocar la red es lo que hace que un reinicio sea conservador. Ante la
 * duda se pierde un mensaje; nunca se duplica frente al prospecto.
 */
/**
 * Tamaño por defecto de la ventana de deviceRate, en primeros mensajes ya
 * maduros. A 15-20/día son unos 3-4 días: suficiente para que la muestra sea
 * estable y corto para que una degradación reciente mueva la aguja en vez de
 * diluirse en el histórico.
 */
export const VENTANA_DEVICE_RATE = 60;

/**
 * Clasificación que marca un destinatario creado por un inbound de alguien
 * ajeno a la campaña. Se exporta para que el orquestador pueda reconocerlo sin
 * repetir el string: es la señal de "no sé quién es esta persona".
 */
export const CLASIFICACION_STUB_INBOUND = "INBOUND DESCONOCIDO";

/**
 * `has_website` con TRES estados, no dos.
 *
 * Antes era `websiteUri === null ? 0 : 1`, o sea "no sé" se guardaba como "no
 * tiene". Eso importa porque lo que sale de acá termina en el prompt del
 * compositor: con `false` se siente autorizado a decirle a alguien "vi que no
 * tienen web", y si en realidad la tiene, se quema el prospecto y el pitch de
 * una sola vez.
 *
 * Con `null`, compose.ts le dice explícitamente "NO SE PUDO VERIFICAR — no
 * afirmes que no tiene, pregunta". Ése es el camino que permite contactar al
 * tramo de confianza media sin mentirle a nadie.
 *
 *   1     tiene web (Places la reporta)
 *   0     verificado que NO tiene (match inequívoco)
 *   null  no se pudo verificar
 */
function estadoWeb(web: ScoredProspect["web"]): number | null {
  if (web.websiteUri !== null) return 1;
  return web.verificadoSinWeb === true ? 0 : null;
}

const HOSTS_SOCIALES = new Set([
  // Un acortador no demuestra que el negocio tenga dominio propio. La URL
  // acortada puede ser una agenda, un formulario o una red social; Places y la
  // revisión manual siguen siendo quienes confirman la presencia web real.
  "bit.ly",
  // Link-in-bio pages are social profile hubs, not a managed business domain.
  "beacons.ai",
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "tiktok.com",
  "wa.me",
  "whatsapp.com",
  "youtube.com",
]);

export function esSitioPropio(value: string): boolean {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return ![...HOSTS_SOCIALES].some(
      (social) => host === social || host.endsWith(`.${social}`),
    );
  } catch {
    return false;
  }
}

export class Store {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(
    filename = "outreach.sqlite",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(filename);
    this.db.exec("pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
    this.migrar();
    this.db
      .prepare(
        `insert into account_state (id)
         values (1)
         on conflict (id) do nothing`,
      )
      .run();
  }

  /**
   * Agrega columnas nuevas a una base que ya existe.
   *
   * `create table if not exists` no toca una tabla ya creada, así que sin esto
   * una base de una versión anterior sigue corriendo sin las columnas y las
   * consultas fallan en runtime. Se lee el esquema real en vez de intentar el
   * `alter` y tragarse el error: así una falla distinta sigue siendo visible.
   */
  private migrar(): void {
    const columnas = new Set(
      (this.db.prepare("pragma table_info(messages)").all() as Array<{
        name: string;
      }>).map((fila) => fila.name),
    );
    if (!columnas.has("inbound_class")) {
      this.db.exec("alter table messages add column inbound_class text");
    }
    if (!columnas.has("step")) {
      this.db.exec("alter table messages add column step text");
    }
    if (!columnas.has("handled_at")) {
      this.db.exec("alter table messages add column handled_at text");
    }

    // El relleno corre SIEMPRE, no dentro del `if` que agrega la columna. Un
    // corte entre el `alter` —que commitea solo— y el relleno dejaría la
    // siguiente arrancada viendo la columna ya presente y saltándose el relleno
    // para siempre: los salientes de campaña quedarían con step nulo,
    // followUpCount volvería a 0 y un fu1 ya enviado se elegiría una y otra vez
    // para morir contra su propia llave de idempotencia, sin llegar nunca a fu2.
    // Sobre una base al día no toca ninguna fila.
    //
    // Los salientes anteriores a esta columna sí tienen el paso, embebido en la
    // llave de idempotencia (`e164:step`). Rellenarlo deja una sola fuente de
    // verdad para el conteo de follow-ups en vez de dos predicados que hay que
    // mantener de acuerdo. El E.164 no contiene ':', así que el primer
    // separador es el correcto.
    this.db.exec(
      `update messages
       set step = substr(idempotency_key, instr(idempotency_key, ':') + 1)
       where step is null and idempotency_key is not null`,
    );

    // Bases anteriores no tienen metadata. Se rellenan en pending para que
    // instalar este gate no autorice por accidente los prospectos históricos.
    // Solo los teléfonos propios sembrados para pruebas nacen aprobados.
    this.db.exec(
      `insert into prospect_metadata (
         e164, vertical, origin, approval_status, reviewed_at
       )
       select
         e164,
         case
           when upper(classification) like '%ODONTO%' then 'dental'
           when upper(classification) like '%VETERIN%' then 'veterinary'
           when upper(classification) like '%ESTET%' or upper(classification) like '%DERMAT%'
             then 'aesthetics'
           when upper(classification) like '%COLEG%' or upper(classification) like '%EDUC%'
             then 'education'
           else 'health'
         end,
         case
           when source_id like 'prueba:%' then 'test'
           when source_id like 'meta:%' then 'meta'
           when source_id like 'manual:%' then 'manual'
           else 'renipress'
         end,
         case when source_id like 'prueba:%' then 'approved' else 'pending' end,
         case when source_id like 'prueba:%' then created_at else null end
       from recipients
       where true
       on conflict(e164) do nothing`,
    );

    // RENIPRESS clasifica varios consultorios dentales como una categoría
    // médica genérica. El nombre comercial sí trae "dental"/"odonto"; usar
    // ambos evita que ODONTOP o DENTAL VIEIRA terminen en el módulo health.
    this.db.exec(
      `update prospect_metadata
       set vertical = case
         when upper(r.classification) like '%ODONTO%'
           or upper(r.name) like '%ODONTO%'
           or upper(r.name) like '%DENTAL%'
           then 'dental'
         when upper(r.classification) like '%ESTET%'
           or upper(r.classification) like '%DERMAT%'
           or upper(r.name) like '%ESTET%'
           or upper(r.name) like '%DERMAT%'
           then 'aesthetics'
         else prospect_metadata.vertical
       end
       from recipients r
       where r.e164 = prospect_metadata.e164
         and prospect_metadata.origin = 'renipress'`,
    );
  }

  close(): void {
    this.db.close();
  }

  importRecipients(scored: readonly ScoredProspect[]): void {
    const insert = this.db.prepare(`
      insert into recipients (
        e164, source_id, name, district, classification, score, created_at,
        has_website, review_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict (e164) do update set
        source_id = excluded.source_id,
        name = excluded.name,
        district = excluded.district,
        classification = excluded.classification,
        -- Un harvest posterior NO pisa lo que se resolvió a mano. Places sigue
        -- devolviendo "no sé" para estos prospectos, así que sin esto una
        -- reimportación los devolvía a la cola de revisión y borraba el ajuste
        -- de score: el trabajo manual se perdía sin que nada lo indicara.
        --
        -- Un dato NUEVO sí gana: si Places pasa a reportar web, esa información
        -- es más reciente que la revisión y debe imponerse.
        score = case
          when recipients.has_website is not null and excluded.has_website is null
            then recipients.score
          else excluded.score
        end,
        has_website = coalesce(excluded.has_website, recipients.has_website),
        review_count = excluded.review_count
    `);
    const createdAt = this.clock().toISOString();

    this.db.exec("begin immediate");
    try {
      for (const prospect of scored) {
        // Un prospecto bloqueado por M2 no debe entrar silenciosamente a la cola.
        //
        // Pero saltarlo del todo escondía un caso que sí importa: si Places
        // ahora reporta una web que antes no reportaba, el prospecto pasa a
        // NO elegible y con `continue` la fila vieja se quedaba tal cual, en la
        // cola, con su estado anterior. O sea: la información nueva llegaba y se
        // descartaba, y el bot le seguía escribiendo a un negocio del que ya
        // sabemos que tiene web.
        //
        // No se crean filas nuevas para bloqueados; solo se corrigen las que ya
        // existen.
        if (!prospect.eligible) {
          if (prospect.web.websiteUri !== null) {
            for (const phone of prospect.phones) {
              if (phone.kind !== "mobile" || phone.e164 === null) continue;
              const existe = this.db
                .prepare("select 1 as hay from recipients where e164 = ?")
                .get(phone.e164) as { hay: number } | undefined;
              if (existe === undefined) continue;
              this.db
                .prepare("update recipients set has_website = 1 where e164 = ?")
                .run(phone.e164);
              // Misma conexión, así que esto se une a la transacción abierta.
              this.suppress(phone.e164, "harvest posterior: ahora tiene web");
            }
          }
          continue;
        }
        for (const phone of prospect.phones) {
          if (phone.kind !== "mobile" || phone.e164 === null) continue;
          insert.run(
            phone.e164,
            prospect.sourceId,
            prospect.name,
            prospect.district,
            prospect.classification,
            prospect.score,
            createdAt,
            estadoWeb(prospect.web),
            prospect.web.userRatingCount,
          );
          this.db
            .prepare(
              `insert into prospect_metadata (
                 e164, vertical, origin, approval_status, reviewed_at
               ) values (?, ?, ?, ?, ?)
               on conflict(e164) do nothing`,
            )
            .run(
              phone.e164,
              this.inferirVertical(prospect.classification, prospect.name),
              prospect.sourceId.startsWith("prueba:") ? "test" : "renipress",
              prospect.sourceId.startsWith("prueba:") ? "approved" : "pending",
              prospect.sourceId.startsWith("prueba:") ? createdAt : null,
            );
        }
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private inferirVertical(classification: string, name: string): string {
    const value = `${classification} ${name}`
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleUpperCase("es-PE");
    if (value.includes("ODONTO")) return "dental";
    if (value.includes("VETERIN")) return "veterinary";
    if (value.includes("ESTET") || value.includes("DERMAT")) return "aesthetics";
    if (value.includes("COLEG") || value.includes("EDUC")) return "education";
    return "health";
  }

  upsertManualProspect(input: ManualProspectInput): void {
    if (!/^\+51\d{9}$/.test(input.e164)) {
      throw new Error(`E.164 peruano inválido: ${input.e164}`);
    }
    if (!Number.isSafeInteger(input.score) || input.score < 0 || input.score > 100) {
      throw new RangeError("score debe ser un entero entre 0 y 100");
    }
    if (input.approve && !input.verifiedWithoutWebsite) {
      throw new Error(
        "no se puede aprobar sin confirmar que el prospecto no tiene web",
      );
    }

    const now = this.clock().toISOString();
    const sourceId = `${input.origin}:${input.e164}`;
    const hasWebsite = input.verifiedWithoutWebsite ? 0 : null;

    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          `insert into recipients (
             e164, source_id, name, district, classification, score, created_at,
             has_website, review_count
           ) values (?, ?, ?, ?, ?, ?, ?, ?, null)
           on conflict(e164) do update set
             name = excluded.name,
             district = excluded.district,
             classification = excluded.classification,
             score = max(coalesce(recipients.score, 0), excluded.score),
             has_website = coalesce(excluded.has_website, recipients.has_website)`,
        )
        .run(
          input.e164,
          sourceId,
          input.name,
          input.district,
          input.classification,
          input.score,
          now,
          hasWebsite,
        );

      this.db
        .prepare(
          `insert into prospect_metadata (
             e164, vertical, origin, source_url, notes, approval_status,
             reviewed_at, review_reason
           ) values (?, ?, ?, ?, ?, 'pending', null, null)
           on conflict(e164) do update set
             vertical = excluded.vertical,
             origin = excluded.origin,
             source_url = coalesce(excluded.source_url, prospect_metadata.source_url),
             notes = coalesce(excluded.notes, prospect_metadata.notes)`,
        )
        .run(
          input.e164,
          input.vertical,
          input.origin,
          input.sourceUrl?.trim() || null,
          input.notes?.trim() || null,
        );
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }

    if (input.approve) {
      const result = this.aprobarProspecto(input.e164);
      if (!result.ok) {
        throw new Error(`no se pudo aprobar ${input.e164}: ${result.reason}`);
      }
    }
  }

  aprobarProspecto(e164: string): ReviewMutationResult {
    const row = this.db
      .prepare(
        `select r.source_id, r.has_website, r.suppressed, r.human_takeover,
                pm.origin, pm.wa_checked_at, pm.wa_websites
         from recipients r
         join prospect_metadata pm on pm.e164 = r.e164
         where r.e164 = ?`,
      )
      .get(e164) as
      | {
          source_id: string;
          has_website: number | null;
          suppressed: number;
          human_takeover: number;
          origin: string;
          wa_checked_at: string | null;
          wa_websites: string | null;
        }
      | undefined;

    if (row === undefined) return { ok: false, reason: "prospecto inexistente" };
    if (row.suppressed !== 0) return { ok: false, reason: "prospecto suprimido" };
    if (row.human_takeover !== 0) {
      return { ok: false, reason: "conversación tomada por humano" };
    }
    if (row.origin !== "test" && row.wa_checked_at === null) {
      return {
        ok: false,
        reason: "falta consultar el perfil actual de WhatsApp",
      };
    }
    if (this.parseWebsites(row.wa_websites).some(esSitioPropio)) {
      return {
        ok: false,
        reason: "el perfil de WhatsApp muestra un sitio web propio",
      };
    }
    if (row.has_website !== 0) {
      return {
        ok: false,
        reason:
          row.has_website === 1
            ? "el prospecto ya tiene web"
            : "todavía no se confirmó que no tenga web",
      };
    }

    const now = this.clock().toISOString();
    this.db.exec("begin immediate");
    try {
      // Un negocio puede traer dos móviles. Se aprueba UNO y los hermanos se
      // rechazan para impedir dos primeros contactos al mismo establecimiento.
      const siblings = this.db
        .prepare("select e164 from recipients where source_id = ?")
        .all(row.source_id) as Array<{ e164: string }>;
      for (const sibling of siblings) {
        const approved = sibling.e164 === e164;
        this.db
          .prepare(
            `update prospect_metadata
             set approval_status = ?,
                 review_reason = ?,
                 reviewed_at = ?
             where e164 = ?`,
          )
          .run(
            approved ? "approved" : "rejected",
            approved
              ? null
              : `otro número del mismo establecimiento; se aprobó ${e164}`,
            now,
            sibling.e164,
          );
      }
      this.db.exec("commit");
      return { ok: true, affected: siblings.length };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  rechazarProspecto(e164: string, reason: string): ReviewMutationResult {
    const row = this.db
      .prepare("select source_id from recipients where e164 = ?")
      .get(e164) as { source_id: string } | undefined;
    if (row === undefined) return { ok: false, reason: "prospecto inexistente" };

    const result = this.db
      .prepare(
        `update prospect_metadata
         set approval_status = 'rejected', review_reason = ?, reviewed_at = ?
         where e164 in (select e164 from recipients where source_id = ?)`,
      )
      .run(reason.trim() || "rechazado en revisión", this.clock().toISOString(), row.source_id);
    return { ok: true, affected: Number(result.changes) };
  }

  guardarPerfilWhatsApp(
    e164: string,
    profile: WhatsAppBusinessProfile,
  ): ReviewMutationResult {
    const result = this.db
      .prepare(
        `update prospect_metadata
         set wa_description = ?, wa_category = ?, wa_address = ?,
             wa_websites = ?, wa_checked_at = ?
         where e164 = ?`,
      )
      .run(
        profile.description.trim() || null,
        profile.category,
        profile.address,
        JSON.stringify(profile.websites),
        this.clock().toISOString(),
        e164,
      );
    return Number(result.changes) === 0
      ? { ok: false, reason: "prospecto inexistente" }
      : { ok: true, affected: 1 };
  }

  listarProspectos(
    status: ApprovalStatus = "pending",
    limit = 100,
    filters: { vertical?: string; origin?: string } = {},
  ): ProspectReviewRow[] {
    const rows = this.db
      .prepare(
        `select
           r.e164, r.source_id, r.name, r.district, r.classification, r.score,
           r.has_website, r.review_count,
           pm.vertical, pm.origin, pm.source_url, pm.notes,
           pm.approval_status, pm.review_reason, pm.reviewed_at,
           pm.wa_description, pm.wa_category, pm.wa_address,
           pm.wa_websites, pm.wa_checked_at
         from recipients r
         join prospect_metadata pm on pm.e164 = r.e164
         where pm.approval_status = ?
           and r.source_id not like 'inbound:%'
           and (? is null or pm.vertical = ?)
           and (? is null or pm.origin = ?)
         order by r.score desc nulls last, r.name asc
         limit ?`,
      )
      .all(
        status,
        filters.vertical ?? null,
        filters.vertical ?? null,
        filters.origin ?? null,
        filters.origin ?? null,
        limit,
      ) as Array<{
      e164: string;
      source_id: string;
      name: string;
      district: string;
      classification: string;
      score: number | null;
      has_website: number | null;
      review_count: number | null;
      vertical: string;
      origin: string;
      source_url: string | null;
      notes: string | null;
      approval_status: ApprovalStatus;
      review_reason: string | null;
      reviewed_at: string | null;
      wa_description: string | null;
      wa_category: string | null;
      wa_address: string | null;
      wa_websites: string | null;
      wa_checked_at: string | null;
    }>;

    return rows.map((row) => ({
      e164: row.e164,
      sourceId: row.source_id,
      name: row.name,
      district: row.district,
      classification: row.classification,
      score: row.score,
      hasWebsite:
        row.has_website === null ? null : row.has_website !== 0,
      reviewCount: row.review_count,
      vertical: row.vertical,
      origin: row.origin,
      sourceUrl: row.source_url,
      notes: row.notes,
      approvalStatus: row.approval_status,
      reviewReason: row.review_reason,
      reviewedAt: row.reviewed_at,
      waDescription: row.wa_description,
      waCategory: row.wa_category,
      waAddress: row.wa_address,
      waWebsites: this.parseWebsites(row.wa_websites),
      waCheckedAt: row.wa_checked_at,
    }));
  }

  private parseWebsites(value: string | null): string[] {
    if (value === null) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  loadRecipientState(e164: string): RecipientState {
    const recipient = this.db
      .prepare(
        `select e164, suppressed, human_takeover
         from recipients
         where e164 = ?`,
      )
      .get(e164) as
      | { e164: string; suppressed: number; human_takeover: number }
      | undefined;

    if (recipient === undefined) {
      throw new Error(`destinatario desconocido: ${e164}`);
    }

    const outbound = this.db
      .prepare(
        `select max(sent_at) as sent_at
         from messages
         where e164 = ? and direction = 'out' and sent_at is not null`,
      )
      .get(e164) as MessageTimeRow;
    // El primer contacto se guarda aparte porque la cadencia se mide desde ahí:
    // medirla desde el último saliente corre la fecha con cada mensaje enviado.
    const firstOutbound = this.db
      .prepare(
        `select min(sent_at) as sent_at
         from messages
         where e164 = ? and direction = 'out' and sent_at is not null`,
      )
      .get(e164) as MessageTimeRow;
    const inbound = this.db
      .prepare(
        `select max(coalesce(sent_at, created_at)) as sent_at
         from messages
         where e164 = ? and direction = 'in'`,
      )
      .get(e164) as MessageTimeRow;
    // Separado del anterior a propósito: `lastInboundAt` queda como rastro de
    // auditoría de TODO lo que entró, y solo éste decide sobre la cadencia. Un
    // saludo automático de WhatsApp Business no es el prospecto respondiendo.
    const humanInbound = this.db
      .prepare(
        `select max(coalesce(sent_at, created_at)) as sent_at
         from messages
         where e164 = ? and direction = 'in'
           and coalesce(inbound_class, 'humano') = 'humano'`,
      )
      .get(e164) as MessageTimeRow;
    // Solo los pasos de campaña. Las respuestas del agente son salientes
    // enviados igual, pero contarlas hacía que dos o tres respuestas a un
    // prospecto lo empujaran por encima de maxFollowUps y lo sacaran de la
    // secuencia sin que nadie hubiera mandado un solo follow-up.
    const sentCount = this.db
      .prepare(
        `select count(*) as count
         from messages
         where e164 = ? and direction = 'out' and sent_at is not null
           and step is not null`,
      )
      .get(e164) as { count: number };

    return {
      e164: recipient.e164,
      suppressed: recipient.suppressed !== 0,
      humanTakeover: recipient.human_takeover !== 0,
      firstOutboundAt: asDate(firstOutbound.sent_at),
      lastOutboundAt: asDate(outbound.sent_at),
      lastInboundAt: asDate(inbound.sent_at),
      lastHumanInboundAt: asDate(humanInbound.sent_at),
      followUpCount: Math.max(0, sentCount.count - 1),
    };
  }

  /**
   * @param ventanaDeviceRate Cuántos primeros mensajes maduros entran al
   * cálculo de deviceRate, empezando por los más recientes. Acotarlo es lo que
   * hace que la señal sea de ventana y no acumulada de por vida.
   */
  loadAccountHealth(
    now: Date,
    ventanaDeviceRate: number = VENTANA_DEVICE_RATE,
  ): AccountHealth {
    const state = this.db
      .prepare(
        `select campaign_started_at, kill_switch_tripped,
                kill_switch_reason, kill_switch_at, device_rate_baseline
         from account_state
         where id = 1`,
      )
      .get() as AccountStateRow;

    const sentRows = this.db
      .prepare(
        `select sent_at
         from messages
         where direction = 'out' and sent_at is not null`,
      )
      .all() as MessageTimeRow[];
    const today = dateKey(now, "America/Lima");
    const sentToday = sentRows.reduce((count, row) => {
      return row.sent_at !== null &&
        dateKey(new Date(row.sent_at), "America/Lima") === today
        ? count + 1
        : count;
    }, 0);

    const lastSent = this.db
      .prepare(
        `select max(sent_at) as sent_at
         from messages
         where direction = 'out' and sent_at is not null`,
      )
      .get() as MessageTimeRow;

    const firstMessages = this.db
      .prepare(
        `with ranked as (
           select ack, sent_at,
                  row_number() over (
                    partition by e164 order by sent_at asc, id asc
                  ) as position
           from messages
           where direction = 'out' and sent_at is not null
         )
         select ack, sent_at
         from ranked
         where position = 1`,
      )
      .all() as FirstMessageRow[];
    const cutoff = now.getTime() - 86_400_000;
    // La cohorte se acota a los más RECIENTES que ya maduraron. Sin tope
    // superior, deviceRate se vuelve una tasa acumulada de por vida: un número
    // que empieza a degradarse aporta demasiados pocos fallos como para mover
    // un histórico grande y sano por debajo del umbral, y el kill switch nunca
    // salta mientras el número se quema. La señal tiene que ser de ventana,
    // como dice el contrato, no de siempre.
    const mature = firstMessages
      .filter((message) => new Date(message.sent_at).getTime() <= cutoff)
      .sort(
        (left, right) =>
          new Date(right.sent_at).getTime() - new Date(left.sent_at).getTime(),
      )
      .slice(0, ventanaDeviceRate);
    const delivered = mature.filter(
      (message) => message.ack !== null && message.ack >= 2,
    ).length;

    let dayIndex = 1;
    if (state.campaign_started_at !== null) {
      // El ramp-up avanza por días calendario limeños, igual que el tope diario.
      const started = new Date(state.campaign_started_at);
      dayIndex = Math.max(
        1,
        localDayNumber(now, "America/Lima") -
          localDayNumber(started, "America/Lima") +
          1,
      );
    }

    return {
      dayIndex,
      sentToday,
      lastSentAt: asDate(lastSent.sent_at),
      deviceRate: mature.length === 0 ? null : delivered / mature.length,
      deviceRateSample: mature.length,
      deviceRateBaseline: state.device_rate_baseline,
      killSwitch: {
        tripped: state.kill_switch_tripped !== 0,
        reason: state.kill_switch_reason,
        trippedAt: asDate(state.kill_switch_at),
      },
    };
  }

  claimSend(e164: string, step: SendStep, body: string): number | null {
    const idempotencyKey = `${e164}:${step}`;
    try {
      const result = this.db
        .prepare(
          `insert into messages (
             e164, direction, body, idempotency_key, step, created_at
           ) values (?, 'out', ?, ?, ?, ?)`,
        )
        .run(e164, body, idempotencyKey, step, this.clock().toISOString());
      return Number(result.lastInsertRowid);
    } catch (error) {
      // Solo el choque de ESTA llave significa "ya intentado". Una FK u otra
      // restricción es corrupción/uso incorrecto y debe seguir siendo visible.
      const existing = this.db
        .prepare("select id from messages where idempotency_key = ?")
        .get(idempotencyKey);
      if (existing !== undefined) return null;
      throw error;
    }
  }

  markSent(id: number, waMessageId: string): void {
    const sentAt = this.clock().toISOString();
    this.db
      .prepare(
        `update messages
         set wa_message_id = ?, sent_at = ?, error = null
         where id = ?`,
      )
      .run(waMessageId, sentAt, id);

    // La campaña empieza al primer envío confirmado por la librería, no al
    // claim: un intento fallido no debe consumir días del ramp-up.
    this.db
      .prepare(
        `update account_state
         set campaign_started_at = coalesce(campaign_started_at, ?)
         where id = 1`,
      )
      .run(sentAt);
  }

  markError(id: number, error: string): void {
    this.db
      .prepare("update messages set error = ? where id = ?")
      .run(error, id);
  }

  recordAck(waMessageId: string, ack: number, at: Date): void {
    // Los ACK pueden llegar repetidos o fuera de orden. Guardar el máximo evita
    // que un ACK_SERVER tardío borre evidencia de que llegó al dispositivo.
    this.db
      .prepare(
        `update messages
         set ack = ?, ack_at = ?
         where wa_message_id = ?
           and (ack is null or ? > ack)`,
      )
      .run(ack, at.toISOString(), waMessageId, ack);
  }

  /**
   * Si este número se sembró a mano para probar, y no salió del harvest.
   *
   * Es la condición que habilita saltarse el horario hábil: hacerlo hacia un
   * prospecto real a las 3am delata al bot y quema el número, pero hacia un
   * teléfono propio no protege de nada. La distinción vive en el store y no en
   * un flag suelto para que la excusa no se pueda invocar sobre cualquiera.
   */
  esDestinatarioDePrueba(e164: string): boolean {
    const fila = this.db
      .prepare("select source_id from recipients where e164 = ?")
      .get(e164) as { source_id: string } | undefined;
    return fila !== undefined && fila.source_id.startsWith("prueba:");
  }

  /**
   * Libera los pasos reclamados que nunca confirmaron un envío, para un número
   * de prueba. Devuelve cuántos liberó.
   *
   * `claimSend` reclama la llave ANTES de tocar la red, a propósito: si el
   * proceso muere después de enviar, preferimos perder el mensaje a duplicarlo.
   * El costo es que un fallo de envío deja el paso quemado y el reintento choca
   * con "envío ya reclamado" para siempre.
   *
   * Solo toca números de prueba y solo filas con `sent_at` nulo. Aun así hay
   * ambigüedad —"no se confirmó" no es lo mismo que "no salió"—, y por eso está
   * limitado a un teléfono propio: ahí el operador puede mirar el chat y
   * decidir. Sobre un prospecto real esta operación no existe.
   */
  liberarEnviosNoConfirmados(e164: string): number {
    if (!this.esDestinatarioDePrueba(e164)) return 0;
    const resultado = this.db
      .prepare(
        `delete from messages
         where e164 = ? and direction = 'out' and sent_at is null`,
      )
      .run(e164);
    return Number(resultado.changes);
  }

  /**
   * Borra un destinatario sembrado a mano y todo su historial.
   *
   * Solo toca filas con `source_id` de prueba. Ésa es la garantía que hace que
   * este método pueda existir: un prospecto real nunca se borra, porque perder
   * su historial de mensajes destruye la evidencia de qué se le mandó y cuándo,
   * que es lo que sostiene la supresión y el conteo de follow-ups.
   *
   * Devuelve false si el número no existe o no es de prueba.
   */
  eliminarDestinatarioDePrueba(e164: string): boolean {
    const fila = this.db
      .prepare("select source_id from recipients where e164 = ?")
      .get(e164) as { source_id: string } | undefined;
    if (fila === undefined || !fila.source_id.startsWith("prueba:")) return false;

    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from messages where e164 = ?").run(e164);
      this.db.prepare("delete from recipients where e164 = ?").run(e164);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
    return true;
  }

  /**
   * Último saliente enviado a este número, o null.
   *
   * A diferencia de `loadRecipientState`, no exige que el destinatario exista:
   * hay que poder correlacionar un entrante antes de crear su stub, y para un
   * número ajeno a la campaña la respuesta correcta es null, no una excepción.
   */
  ultimoOutboundAt(e164: string): Date | null {
    const fila = this.db
      .prepare(
        `select max(sent_at) as sent_at
         from messages
         where e164 = ? and direction = 'out' and sent_at is not null`,
      )
      .get(e164) as MessageTimeRow;
    return asDate(fila.sent_at);
  }

  /**
   * Registra un entrante y dice qué corresponde hacer con él.
   *
   * "Recibido" y "atendido" son estados distintos a propósito. Si se tratara
   * cualquier fila ya existente como procesada, un fallo del LLM, del handoff o
   * del envío —que ocurren DESPUÉS de este insert— dejaría el mensaje guardado y
   * sin responder para siempre: una reconexión reemitiría el evento y este
   * método lo descartaría por duplicado. Un prospecto diciendo "sí, me
   * interesa" quedaría sin respuesta, que es peor que contestarle dos veces.
   *
   * `clase` por defecto 'humano' a propósito: ausente debe significar el lado
   * conservador, que es cortar la cadencia. Un llamador que no clasifica no
   * debería, por omisión, dejar a un prospecto recibiendo follow-ups después de
   * haber contestado.
   */
  recordInbound(
    e164: string,
    body: string,
    at: Date,
    meta: { waMessageId?: string | null; clase?: ClaseInbound } = {},
  ): RegistroInbound {
    this.ensureInboundRecipient(e164, at);
    const waMessageId = meta.waMessageId ?? null;
    // La idempotencia se consulta antes de insertar en vez de depender del
    // choque del índice: el insert corre dentro de la misma llamada que crea el
    // stub del destinatario, y distinguir "duplicado" de un error real por el
    // mensaje de la excepción es frágil.
    if (waMessageId !== null) {
      const existing = this.db
        .prepare("select handled_at from messages where wa_message_id = ?")
        .get(waMessageId) as { handled_at: string | null } | undefined;
      if (existing !== undefined) {
        // No se vuelve a insertar: la fila ya está y el historial la incluye.
        // Solo cambia si hay que rehacer el trabajo que quedó a medias.
        return existing.handled_at === null ? "pendiente" : "ya_atendido";
      }
    }

    this.db
      .prepare(
        `insert into messages (
           e164, direction, body, wa_message_id, inbound_class, sent_at, created_at
         ) values (?, 'in', ?, ?, ?, ?, ?)`,
      )
      .run(
        e164,
        body,
        waMessageId,
        meta.clase ?? "humano",
        at.toISOString(),
        at.toISOString(),
      );
    return "nuevo";
  }

  /**
   * Marca un entrante como atendido de punta a punta.
   *
   * Se llama recién cuando la decisión llegó a un final: se respondió, se
   * escaló, se suprimió o se descartó con motivo. Mientras esto no corra, el
   * evento sigue siendo elegible para reprocesarse.
   */
  /**
   * Entrantes humanos que quedaron sin atender, del más viejo al más nuevo.
   *
   * El caso que esto rescata: alguien escribe 21:40, la ventana horaria está
   * cerrada, `manejarInbound` devuelve `diferido` y —a propósito— NO lo marca
   * atendido para que se pueda reintentar. Pero nada reintentaba: la deuda
   * quedaba anotada y nadie la cobraba. Al abrir la ventana, esto los devuelve.
   *
   * Sirve además al arrancar el proceso: lo que llegó con el bot apagado, o lo
   * que quedó a medias porque el LLM o el envío fallaron, entra por acá.
   *
   * Solo humanos: un autorespondedor se registra sin `handled_at` y no hay nada
   * que contestarle.
   */
  inboundsPendientes(
    limite: number,
    e164?: string,
  ): Array<{
    e164: string;
    waMessageId: string;
    at: Date;
  }> {
    // El filtro por número va en el SQL y no después, en memoria. Filtrando
    // fuera, con 50 pendientes viejos de OTROS chats el límite global dejaba
    // afuera el mensaje recién llegado: atenderNumero no encontraba nada,
    // devolvía "duplicado" y el prospecto en vivo se quedaba sin respuesta
    // hasta el siguiente barrido.
    const filas = this.db
      .prepare(
        `select m.e164, m.wa_message_id, m.created_at
         from messages m
         join recipients r on r.e164 = m.e164
         where m.direction = 'in'
           and m.handled_at is null
           and coalesce(m.inbound_class, 'humano') = 'humano'
           and m.wa_message_id is not null
           and r.suppressed = 0
           and r.human_takeover = 0
           and r.source_id not like 'inbound:%'
           and (? is null or m.e164 = ?)
         order by m.created_at asc
         limit ?`,
      )
      .all(e164 ?? null, e164 ?? null, limite) as Array<{
      e164: string;
      wa_message_id: string;
      created_at: string;
    }>;

    return filas.map((fila) => ({
      e164: fila.e164,
      waMessageId: fila.wa_message_id,
      at: new Date(fila.created_at),
    }));
  }

  /**
   * Prospectos cuyo estado de web quedó en "no se sabe", del mejor score al peor.
   *
   * Son los que Places identificó razonablemente pero sin la confianza que hace
   * falta para afirmar que no tienen web. No son contactables hasta resolver
   * esa duda y aprobarlos: el gate nuevo falla cerrado para evitar afirmar o
   * inferir algo comercial desde datos incompletos.
   */
  paraRevisar(limite: number): Array<{
    e164: string;
    sourceId: string;
    nombre: string;
    distrito: string;
    score: number | null;
    resenas: number | null;
  }> {
    const filas = this.db
      .prepare(
        `select e164, source_id, name, district, score, review_count
         from recipients
         where has_website is null
           and suppressed = 0
           and human_takeover = 0
           and source_id not like 'inbound:%'
         order by score desc, name asc
         limit ?`,
      )
      .all(limite) as Array<{
      e164: string;
      source_id: string;
      name: string;
      district: string;
      score: number | null;
      review_count: number | null;
    }>;

    return filas.map((fila) => ({
      e164: fila.e164,
      sourceId: fila.source_id,
      nombre: fila.name,
      distrito: fila.district,
      score: fila.score,
      resenas: fila.review_count,
    }));
  }

  /**
   * Asienta el resultado de una revisión manual.
   *
   * Con web: se suprime. No es un prospecto — el producto es justamente la web.
   * Sin web: pasa a verificado y sube el score con la misma diferencia que
   * aplica el harvest, para que la cola quede ordenada de forma coherente
   * mezclando revisados y no revisados.
   *
   * Devuelve false si el número no estaba pendiente de revisión, para que la CLI
   * pueda decirlo en vez de fingir que hizo algo.
   */
  resolverWeb(e164: string, tieneWeb: boolean, delta: number): boolean {
    const fila = this.db
      .prepare(
        `select r.source_id, r.has_website, pm.approval_status
         from recipients r
         join prospect_metadata pm on pm.e164 = r.e164
         where r.e164 = ? and r.source_id not like 'inbound:%'`,
      )
      .get(e164) as
      | {
          source_id: string;
          has_website: number | null;
          approval_status: ApprovalStatus;
        }
      | undefined;
    if (fila === undefined) return false;
    // A manual web check can arrive after approval (or even after the first
    // contact). Allow only the corrective `--con-web` transition for a row
    // already verified as no-web; never add the score twice for `--sin-web`.
    if (!tieneWeb && fila.has_website !== null) return false;
    if (tieneWeb && fila.has_website === 1) return false;
    if (
      tieneWeb &&
      fila.has_website === 0 &&
      fila.approval_status !== "approved"
    ) {
      return false;
    }

    // La revisión es sobre el ESTABLECIMIENTO, no sobre un teléfono. Un mismo
    // source_id puede tener varios móviles y por lo tanto varias filas; aplicar
    // el resultado a una sola dejaba las demás contactables, así que el bot
    // podía escribirle al mismo negocio por otro número después de que alguien
    // ya hubiera verificado que tiene web.
    const hermanos = this.db
      .prepare(
        `select e164 from recipients
         where source_id = ? and (has_website is null or e164 = ?)`,
      )
      .all(fila.source_id, e164) as Array<{ e164: string }>;

    for (const { e164: numero } of hermanos) {
      if (tieneWeb) {
        this.db
          .prepare("update recipients set has_website = 1 where e164 = ?")
          .run(numero);
        this.suppress(numero, "revisión manual: ya tiene web");
      } else {
        this.db
          .prepare(
            `update recipients
             set has_website = 0, score = coalesce(score, 0) + ?
             where e164 = ?`,
          )
          .run(delta, numero);
      }
    }
    return true;
  }

  /**
   * ¿Este número existe como destinatario?
   *
   * Existe porque `loadRecipientState` LANZA para un desconocido, y hay un
   * llamador —la detección de envíos manuales— donde eso no es un error sino lo
   * normal: el dueño le escribe a cualquiera desde su teléfono vinculado. Ahí la
   * excepción viajaba por un `void` sin await y terminaba como unhandled
   * rejection, o sea el proceso caído y el listener con él.
   */
  existeDestinatario(e164: string): boolean {
    const fila = this.db
      .prepare("select 1 as hay from recipients where e164 = ?")
      .get(e164) as { hay: number } | undefined;
    return fila !== undefined;
  }

  /**
   * ¿Este id lo envió el bot?
   *
   * Segunda barrera de la detección de envíos manuales. La primera vive en el
   * cliente y es un Set en memoria; ésta cubre lo que ese Set no puede: los
   * mensajes que mandó una ejecución ANTERIOR del proceso. Sin ella, reiniciar
   * el bot haría que sus propios envíos recientes parecieran escritos a mano.
   */
  esMensajeNuestro(waMessageId: string): boolean {
    const fila = this.db
      .prepare(
        "select 1 as hay from messages where wa_message_id = ? and direction = 'out'",
      )
      .get(waMessageId) as { hay: number } | undefined;
    return fila !== undefined;
  }

  marcarInboundAtendido(waMessageId: string, at: Date): void {
    this.db
      .prepare(
        `update messages
         set handled_at = ?
         where wa_message_id = ? and direction = 'in' and handled_at is null`,
      )
      .run(at.toISOString(), waMessageId);
  }

  /**
   * La conversación en orden cronológico, para armar el historial del agente.
   * Solo mensajes efectivamente enviados o recibidos: un saliente reclamado
   * pero nunca enviado no forma parte de lo que el prospecto vio.
   *
   * Los entrantes automáticos quedan fuera: se registran para auditoría, pero
   * ponerlos en el historial le da al agente un turno del "prospecto" que el
   * prospecto nunca escribió. "En breve un asesor lo atenderá" leído como
   * intención es exactamente el falso positivo que hay que evitar.
   */
  loadConversacion(e164: string): Array<{ direction: "in" | "out"; body: string }> {
    return this.db
      .prepare(
        `select direction, body
         from messages
         where e164 = ?
           and (
             (direction = 'in' and coalesce(inbound_class, 'humano') = 'humano')
             or (direction = 'out' and sent_at is not null)
           )
         order by coalesce(sent_at, created_at) asc, id asc`,
      )
      .all(e164) as Array<{ direction: "in" | "out"; body: string }>;
  }

  /** Ficha del prospecto para personalizar. null si el número no es de campaña. */
  loadFichaProspecto(e164: string): {
    nombre: string;
    distrito: string;
    clasificacion: string;
    /** null solo para registros legacy sin metadata de prospección. */
    vertical: string | null;
    tieneWeb: boolean | null;
    resenas: number | null;
  } | null {
    // Se excluyen los stubs que crea recordInbound para no perder un mensaje
    // por la clave foránea. Un stub NO es un prospecto de campaña: si contara
    // como ficha válida, cualquiera que le escriba al número recibiría
    // respuesta del agente, sin contexto y sin haber sido nunca contactado.
    const row = this.db
      .prepare(
        `select r.name, r.district, r.classification, r.has_website,
                r.review_count, pm.vertical
         from recipients r
         left join prospect_metadata pm on pm.e164 = r.e164
         where r.e164 = ? and r.source_id not like 'inbound:%'`,
      )
      .get(e164) as
      | {
          name: string;
          district: string;
          classification: string;
          vertical: string | null;
          has_website: number | null;
          review_count: number | null;
        }
      | undefined;

    if (row === undefined) return null;

    return {
      nombre: row.name,
      distrito: row.district,
      clasificacion: row.classification,
      vertical: row.vertical,
      tieneWeb: row.has_website === null ? null : row.has_website !== 0,
      resenas: row.review_count,
    };
  }

  /**
   * Registra una respuesta conversacional ya enviada.
   *
   * Sin idempotency_key a propósito: ésa protege los pasos de campaña, que son
   * un conjunto cerrado y repetible ('first', 'fu1', 'fu2'). Una respuesta a un
   * inbound es única por definición y no se reintenta sola — reintentarla sería
   * mandar dos veces lo mismo, que es justo lo que hay que evitar.
   */
  recordOutboundLibre(
    e164: string,
    body: string,
    waMessageId: string,
    at: Date,
  ): void {
    const timestamp = at.toISOString();
    this.db
      .prepare(
        `insert into messages (e164, direction, body, wa_message_id, sent_at, created_at)
         values (?, 'out', ?, ?, ?, ?)`,
      )
      .run(e164, body, waMessageId, timestamp, timestamp);
  }

  /**
   * Candidatos a contactar, del mejor score al peor.
   *
   * Excluye suprimidos, conversaciones tomadas por un humano y a quien ya
   * respondió: si alguien contestó, la cadencia automática se terminó y lo que
   * corresponde es responderle, no seguir empujando la secuencia.
   *
   * "Respondió" significa un entrante HUMANO. Filtrar por cualquier entrante
   * dejaba fuera a todo el que tuviera saludo automático de WhatsApp Business
   * configurado —casi todos— y esos follow-ups no se enviaban jamás. Este
   * filtro tiene que decir lo mismo que canContact: si divergen, un candidato
   * pasa la consulta y muere en la puerta, o al revés.
   *
   * Excluye también los stubs de inbound: nunca fueron prospectos de campaña.
   */
  candidatosParaContactar(
    limite: number,
    desplazamiento = 0,
    vertical?: string,
  ): Array<{ e164: string; score: number | null }> {
    return this.db
      .prepare(
        `select r.e164, r.score
         from recipients r
         join prospect_metadata pm on pm.e164 = r.e164
         where r.suppressed = 0
           and r.human_takeover = 0
           and r.source_id not like 'inbound:%'
           and pm.approval_status = 'approved'
           and (? is null or pm.vertical = ?)
           -- Defensa en profundidad: el producto ES la web. Quien ya tiene una
           -- no se contacta aunque por algún camino haya quedado sin suprimir.
           and r.has_website = 0
           and not exists (
             select 1 from messages m
             where m.e164 = r.e164 and m.direction = 'in'
               and coalesce(m.inbound_class, 'humano') = 'humano'
           )
         order by r.score desc nulls last, r.e164 asc
         limit ? offset ?`,
      )
      .all(vertical ?? null, vertical ?? null, limite, desplazamiento) as Array<{
      e164: string;
      score: number | null;
    }>;
  }

  /** Los salientes ya enviados, en orden, para que el compositor no se repita. */
  mensajesEnviados(e164: string): string[] {
    const rows = this.db
      .prepare(
        `select body from messages
         where e164 = ? and direction = 'out' and sent_at is not null
         order by sent_at asc, id asc`,
      )
      .all(e164) as Array<{ body: string }>;
    return rows.map((r) => r.body);
  }

  /**
   * Aperturas de primeros contactos recientes, no de follow-ups.
   *
   * Se deriva por posición real en el historial en vez de confiar en la llave
   * de idempotencia: así también representa salientes antiguos o importados
   * que no necesariamente usaron el step `first`.
   */
  aperturasRecientes(limite: number): string[] {
    const rows = this.db
      .prepare(
        `with salientes_ordenados as (
           select id, e164, body, sent_at,
                  row_number() over (
                    partition by e164 order by sent_at asc, id asc
                  ) as posicion
           from messages
           where direction = 'out' and sent_at is not null
         )
         select substr(body, 1, 80) as body
         from salientes_ordenados
         where posicion = 1
         order by sent_at desc, id desc
         limit ?`,
      )
      .all(limite) as Array<{ body: string }>;
    return rows.map((row) => row.body);
  }

  suppress(e164: string, reason: string): void {
    this.ensureInboundRecipient(e164, this.clock());
    this.db
      .prepare(
        `update recipients
         set suppressed = 1, suppressed_reason = ?
         where e164 = ?`,
      )
      .run(reason, e164);
  }

  setHumanTakeover(e164: string): void {
    this.ensureInboundRecipient(e164, this.clock());
    this.db
      .prepare("update recipients set human_takeover = 1 where e164 = ?")
      .run(e164);
  }

  tripKillSwitch(state: KillSwitchState): void {
    if (!state.tripped) return;
    this.db
      .prepare(
        `update account_state
         set kill_switch_tripped = 1,
             kill_switch_reason = ?,
             kill_switch_at = ?
         where id = 1`,
      )
      .run(state.reason, state.trippedAt?.toISOString() ?? this.clock().toISOString());
  }

  setBaseline(rate: number): void {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      throw new RangeError("el baseline debe estar entre 0 y 1");
    }
    this.db
      .prepare(
        "update account_state set device_rate_baseline = ? where id = 1",
      )
      .run(rate);
  }

  private ensureInboundRecipient(e164: string, at: Date): void {
    // Un número que inicia conversación puede no estar en la campaña. Se crea
    // un stub auditable para no perder el inbound por la clave foránea.
    this.db
      .prepare(
        `insert into recipients (
           e164, source_id, name, district, classification, score, created_at
         ) values (?, ?, ?, '', '${CLASIFICACION_STUB_INBOUND}', null, ?)
         on conflict (e164) do nothing`,
      )
      .run(e164, `inbound:${e164}`, e164, at.toISOString());
  }
}
