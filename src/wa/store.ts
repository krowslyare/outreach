import { createRequire } from "node:module";

import type { ScoredProspect } from "../types.js";
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
  human_takeover integer not null default 0, created_at text not null);

create table if not exists messages (
  id integer primary key autoincrement, e164 text not null references recipients(e164),
  direction text not null check (direction in ('out','in')), body text not null,
  idempotency_key text unique, wa_message_id text, sent_at text,
  ack integer, ack_at text, error text, created_at text not null);

create table if not exists account_state (
  id integer primary key check (id = 1), campaign_started_at text,
  kill_switch_tripped integer not null default 0, kill_switch_reason text,
  kill_switch_at text, device_rate_baseline real);
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
export class Store {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(
    filename = "outreach.sqlite",
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.db = new DatabaseSync(filename);
    this.db.exec("pragma foreign_keys = on;");
    this.db.exec(SCHEMA);
    this.db
      .prepare(
        `insert into account_state (id)
         values (1)
         on conflict (id) do nothing`,
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  importRecipients(scored: readonly ScoredProspect[]): void {
    const insert = this.db.prepare(`
      insert into recipients (
        e164, source_id, name, district, classification, score, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict (e164) do update set
        source_id = excluded.source_id,
        name = excluded.name,
        district = excluded.district,
        classification = excluded.classification,
        score = excluded.score
    `);
    const createdAt = this.clock().toISOString();

    this.db.exec("begin immediate");
    try {
      for (const prospect of scored) {
        // Un prospecto bloqueado por M2 no debe entrar silenciosamente a la cola.
        if (!prospect.eligible) continue;
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
          );
        }
      }
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
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
    const sentCount = this.db
      .prepare(
        `select count(*) as count
         from messages
         where e164 = ? and direction = 'out' and sent_at is not null`,
      )
      .get(e164) as { count: number };

    return {
      e164: recipient.e164,
      suppressed: recipient.suppressed !== 0,
      humanTakeover: recipient.human_takeover !== 0,
      firstOutboundAt: asDate(firstOutbound.sent_at),
      lastOutboundAt: asDate(outbound.sent_at),
      lastInboundAt: asDate(inbound.sent_at),
      followUpCount: Math.max(0, sentCount.count - 1),
    };
  }

  loadAccountHealth(now: Date): AccountHealth {
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
    const mature = firstMessages.filter(
      (message) => new Date(message.sent_at).getTime() <= cutoff,
    );
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
             e164, direction, body, idempotency_key, created_at
           ) values (?, 'out', ?, ?, ?)`,
        )
        .run(e164, body, idempotencyKey, this.clock().toISOString());
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

  recordInbound(e164: string, body: string, at: Date): void {
    this.ensureInboundRecipient(e164, at);
    this.db
      .prepare(
        `insert into messages (
           e164, direction, body, sent_at, created_at
         ) values (?, 'in', ?, ?, ?)`,
      )
      .run(e164, body, at.toISOString(), at.toISOString());
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
         ) values (?, ?, ?, '', 'INBOUND DESCONOCIDO', null, ?)
         on conflict (e164) do nothing`,
      )
      .run(e164, `inbound:${e164}`, e164, at.toISOString());
  }
}
