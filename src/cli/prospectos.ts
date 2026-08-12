// Bandeja de prospectos y gate previo a campaña.
//
// Ninguna acción de este archivo envía mensajes. El flujo deliberado es:
// agregar/importar -> verificar web -> consultar perfil WA -> aprobar -> campaña.

import "./env.js";

import { readFileSync } from "node:fs";

import {
  VERTICALES,
  VERTICAL_IDS,
  esVerticalId,
  type VerticalId,
} from "../prospects/verticals.js";
import { alertasDeIdentidad } from "../prospects/preflight.js";
import { createWaClient, type WaClient } from "../wa/client.js";
import {
  esSitioPropio,
  Store,
  type ApprovalStatus,
  type ManualProspectInput,
  type ProspectOrigin,
} from "../wa/store.js";

const ORIGENES_ENTRADA = ["manual", "meta", "places"] as const;
type OrigenEntrada = (typeof ORIGENES_ENTRADA)[number];

function valor(args: readonly string[], nombre: string): string | undefined {
  const pos = args.indexOf(`--${nombre}`);
  if (pos >= 0) {
    const next = args[pos + 1];
    return next !== undefined && !next.startsWith("--") ? next : undefined;
  }
  return args
    .find((arg) => arg.startsWith(`--${nombre}=`))
    ?.slice(`--${nombre}=`.length);
}

function entero(
  value: string | undefined,
  fallback: number,
  nombre: string,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--${nombre} requiere un entero positivo`);
  }
  return parsed;
}

function e164(value: string | undefined, flag: string): string {
  if (value === undefined || !/^\+51\d{9}$/.test(value.trim())) {
    throw new Error(
      `--${flag} requiere un móvil peruano, por ejemplo +51987654321`,
    );
  }
  return value.trim();
}

function requerido(
  value: string | undefined,
  flag: string,
): string {
  const clean = value?.trim();
  if (!clean) throw new Error(`--${flag} es obligatorio`);
  return clean;
}

function origen(value: string | undefined): OrigenEntrada {
  const clean = value?.trim().toLowerCase() ?? "manual";
  if (!(ORIGENES_ENTRADA as readonly string[]).includes(clean)) {
    throw new Error(`--origen debe ser ${ORIGENES_ENTRADA.join(", ")}`);
  }
  return clean as OrigenEntrada;
}

function vertical(value: string | undefined): VerticalId {
  const clean = requerido(value, "vertical").toLowerCase();
  if (!esVerticalId(clean)) {
    throw new Error(`--vertical debe ser ${VERTICAL_IDS.join(", ")}`);
  }
  return clean;
}

function estadoWeb(value: boolean | null): string {
  if (value === true) return "tiene web";
  if (value === false) return "sin web confirmado";
  return "web sin verificar";
}

function imprimirVerticales(): void {
  for (const id of VERTICAL_IDS) {
    const item = VERTICALES[id];
    console.info(
      `${item.id} · prioridad ${item.priority} · ${item.label}\n` +
        `  Búsquedas: ${item.placeQueries.join(" | ")}\n` +
        `  Producto: ${item.productHooks.join(" · ")}\n` +
        `  Registro: ${item.registry}\n`,
    );
  }
}

function inputDesdeObjeto(value: unknown): ManualProspectInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("cada prospecto importado debe ser un objeto");
  }
  const row = value as Record<string, unknown>;
  const verticalId = vertical(
    typeof row.vertical === "string" ? row.vertical : undefined,
  );
  const origin = origen(
    typeof row.origin === "string"
      ? row.origin
      : typeof row.origen === "string"
        ? row.origen
        : undefined,
  );
  const scoreDefault = origin === "meta" ? 90 : origin === "places" ? 70 : 80;
  const score =
    typeof row.score === "number" && Number.isSafeInteger(row.score)
      ? row.score
      : scoreDefault;
  const sourceUrl =
    typeof row.sourceUrl === "string"
      ? row.sourceUrl
      : typeof row.url === "string"
        ? row.url
        : undefined;
  if (origin === "meta" && !sourceUrl?.trim()) {
    throw new Error("un prospecto de Meta debe conservar sourceUrl/url");
  }
  return {
    e164: e164(typeof row.e164 === "string" ? row.e164 : undefined, "e164"),
    name: requerido(
      typeof row.name === "string"
        ? row.name
        : typeof row.nombre === "string"
          ? row.nombre
          : undefined,
      "nombre",
    ),
    district: requerido(
      typeof row.district === "string"
        ? row.district
        : typeof row.distrito === "string"
          ? row.distrito
          : undefined,
      "distrito",
    ).toLocaleUpperCase("es-PE"),
    classification:
      (typeof row.classification === "string"
        ? row.classification
        : typeof row.rubro === "string"
          ? row.rubro
          : VERTICALES[verticalId].label
      ).toLocaleUpperCase("es-PE"),
    vertical: verticalId,
    origin: origin as ProspectOrigin,
    sourceUrl,
    notes:
      typeof row.notes === "string"
        ? row.notes
        : typeof row.nota === "string"
          ? row.nota
          : undefined,
    score,
    verifiedWithoutWebsite:
      row.verifiedWithoutWebsite === true || row.sinWeb === true,
    // Una importación nunca autoriza envíos. La identidad actual se confirma
    // después, individualmente, con el perfil de WhatsApp.
    approve: false,
  };
}

function inputDesdeArgs(args: readonly string[]): ManualProspectInput {
  const verticalId = vertical(valor(args, "vertical"));
  const origin = origen(valor(args, "origen"));
  const scoreDefault = origin === "meta" ? 90 : origin === "places" ? 70 : 80;
  const sourceUrl = valor(args, "url")?.trim();
  if (origin === "meta" && !sourceUrl) {
    throw new Error("--origen meta requiere --url para conservar la evidencia");
  }
  return {
    e164: e164(valor(args, "agregar"), "agregar"),
    name: requerido(valor(args, "nombre"), "nombre"),
    district: requerido(valor(args, "distrito"), "distrito").toLocaleUpperCase(
      "es-PE",
    ),
    classification: (
      valor(args, "rubro") ?? VERTICALES[verticalId].label
    ).toLocaleUpperCase("es-PE"),
    vertical: verticalId,
    origin: origin as ProspectOrigin,
    sourceUrl,
    notes: valor(args, "nota")?.trim(),
    score: entero(valor(args, "score"), scoreDefault, "score"),
    verifiedWithoutWebsite: args.includes("--sin-web"),
    approve: false,
  };
}

function ocultarLogsSensiblesLibsignal(): () => void {
  const original = console.info;
  console.info = (...values: unknown[]): void => {
    if (values[0] === "Closing session:") return;
    original(...values);
  };
  return () => {
    console.info = original;
  };
}

async function consultarPerfilConCliente(
  store: Store,
  client: Pick<WaClient, "getBusinessProfile">,
  numero: string,
): Promise<void> {
  const ficha = store.loadFichaProspecto(numero);
  if (ficha === null) throw new Error(`${numero} no existe en prospectos`);

  const lookup = await client.getBusinessProfile(numero);
  if (!lookup.exists) {
    console.info(
      `${numero} no está registrado en WhatsApp. No se guardó el preflight y no se puede aprobar.`,
    );
    return;
  }

  const profile = lookup.profile ?? {
    description: "",
    category: null,
    address: null,
    websites: [],
  };
  store.guardarPerfilWhatsApp(numero, profile);
  const identityAlerts = alertasDeIdentidad(
    { name: ficha.nombre, district: ficha.distrito },
    profile,
  );

  console.info(
    `Esperado: ${ficha.nombre} · ${ficha.distrito} · ${ficha.clasificacion}\n` +
      `Perfil WA: ${profile.category ?? "sin categoría"}\n` +
      `Descripción: ${profile.description || "(vacía)"}\n` +
      `Dirección: ${profile.address ?? "(vacía)"}\n` +
      `Links: ${profile.websites.join(", ") || "(ninguno)"}`,
  );
  if (lookup.profile === null) {
    console.warn(
      "\n⚠️ WhatsApp existe, pero no devolvió perfil comercial. Revisa nombre y foto en el teléfono antes de confirmar identidad.",
    );
  }
  if (profile.websites.some(esSitioPropio)) {
    console.warn(
      "\n⛔ El perfil muestra un sitio propio. El store bloqueará su aprobación.",
    );
  }
  if (identityAlerts.length > 0) {
    console.warn(
      "\n⛔ ALERTAS DE IDENTIDAD:\n" +
        identityAlerts.map((alert) => `  - ${alert}`).join("\n") +
        `\nNo apruebes sin resolverlas. Si no coincide:\n` +
        `npm run prospectos -- --rechazar ${numero} --motivo "perfil WA no coincide"`,
    );
  } else {
    console.info(
      `\nSi la identidad coincide: npm run prospectos -- --aprobar ${numero} --identidad-confirmada`,
    );
  }
}

async function consultarPerfil(store: Store, numero: string): Promise<void> {
  const restaurarLog = ocultarLogsSensiblesLibsignal();
  const client = createWaClient();
  try {
    await client.start();
    await consultarPerfilConCliente(store, client, numero);
  } finally {
    await client.stop();
    restaurarLog();
  }
}

async function preflightPendientes(
  store: Store,
  limit: number,
  filters: { vertical?: string; origin?: string },
  refresh: boolean,
): Promise<void> {
  const rows = store
    .listarProspectos("pending", Math.max(limit, 100), filters)
    .filter((row) => refresh || row.waCheckedAt === null)
    .slice(0, limit);
  if (rows.length === 0) {
    console.info("No hay perfiles pendientes para esos filtros.");
    return;
  }

  const restaurarLog = ocultarLogsSensiblesLibsignal();
  const client = createWaClient();
  try {
    await client.start();
    for (const [index, row] of rows.entries()) {
      console.info(`\n${"═".repeat(60)}\n${index + 1}/${rows.length}`);
      try {
        await consultarPerfilConCliente(store, client, row.e164);
      } catch (error) {
        console.error(
          `${row.e164}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await client.stop();
    restaurarLog();
  }
}

function listar(
  store: Store,
  status: ApprovalStatus,
  limit: number,
  filters: { vertical?: string; origin?: string },
): void {
  const rows = store.listarProspectos(status, limit, filters);
  if (rows.length === 0) {
    console.info(`No hay prospectos en estado ${status}.`);
    return;
  }
  console.info(`${rows.length} prospecto(s) ${status}:\n`);
  for (const row of rows) {
    console.info(
      `${row.name}\n` +
        `  ${row.e164} · ${row.district} · ${row.vertical}/${row.origin} · score ${row.score ?? "—"}\n` +
        `  ${estadoWeb(row.hasWebsite)} · WA ${row.waCheckedAt ? "consultado" : "pendiente"}\n` +
        `${row.sourceUrl ? `  Fuente: ${row.sourceUrl}\n` : ""}` +
        `${row.notes ? `  Nota: ${row.notes}\n` : ""}` +
        `${row.reviewReason ? `  Revisión: ${row.reviewReason}\n` : ""}` +
        (status === "pending"
          ? `  npm run prospectos -- --perfil ${row.e164}\n` +
            `  npm run prospectos -- --aprobar ${row.e164} --identidad-confirmada\n` +
            `  npm run prospectos -- --rechazar ${row.e164} --motivo "no coincide"\n`
          : ""),
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--verticales")) {
    imprimirVerticales();
    return;
  }

  const store = new Store();
  try {
    const agregar = valor(args, "agregar");
    const importar = valor(args, "importar");
    const rechazar = valor(args, "rechazar");
    const perfil = valor(args, "perfil");
    const preflight = args.includes("--preflight");
    const aprobar =
      agregar === undefined && importar === undefined
        ? valor(args, "aprobar")
        : undefined;
    const acciones = [
      agregar,
      importar,
      rechazar,
      perfil,
      aprobar,
      preflight ? "preflight" : undefined,
    ].filter(
      (value) => value !== undefined,
    );
    if (acciones.length > 1) {
      throw new Error("usa una sola acción por ejecución");
    }

    if (agregar !== undefined) {
      const input = inputDesdeArgs(args);
      store.upsertManualProspect(input);
      console.info(
        `Guardado ${input.e164} como ${input.vertical}/${input.origin}. ` +
          "Si ya existía, conserva su estado de revisión. Nada fue enviado.",
      );
      return;
    }

    if (importar !== undefined) {
      const parsed: unknown = JSON.parse(readFileSync(importar, "utf8"));
      if (!Array.isArray(parsed)) {
        throw new Error("--importar espera un JSON que contenga un arreglo");
      }
      for (const value of parsed) store.upsertManualProspect(inputDesdeObjeto(value));
      console.info(
        `Importados ${parsed.length} prospectos como pendientes. Nada fue enviado.`,
      );
      return;
    }

    if (rechazar !== undefined) {
      const numero = e164(rechazar, "rechazar");
      const result = store.rechazarProspecto(
        numero,
        valor(args, "motivo") ?? "rechazado en revisión",
      );
      if (!result.ok) throw new Error(result.reason);
      console.info(`Rechazado ${numero} y ${result.affected - 1} número(s) hermano(s).`);
      return;
    }

    if (perfil !== undefined) {
      await consultarPerfil(store, e164(perfil, "perfil"));
      return;
    }

    if (preflight) {
      const verticalFilter = valor(args, "vertical")?.trim().toLowerCase();
      if (verticalFilter !== undefined && !esVerticalId(verticalFilter)) {
        throw new Error(`--vertical debe ser ${VERTICAL_IDS.join(", ")}`);
      }
      await preflightPendientes(
        store,
        entero(valor(args, "limite"), 10, "limite"),
        {
          vertical: verticalFilter,
          origin: valor(args, "origen")?.trim().toLowerCase(),
        },
        args.includes("--refrescar"),
      );
      return;
    }

    if (aprobar !== undefined) {
      const numero = e164(aprobar, "aprobar");
      if (!args.includes("--identidad-confirmada")) {
        throw new Error(
          "falta --identidad-confirmada; primero ejecuta --perfil y compara el negocio actual",
        );
      }
      const result = store.aprobarProspecto(numero);
      if (!result.ok) throw new Error(result.reason);
      console.info(
        `Aprobado ${numero}; ${result.affected - 1} número(s) duplicado(s) quedaron rechazados.`,
      );
      return;
    }

    const status: ApprovalStatus = args.includes("--aprobados")
      ? "approved"
      : args.includes("--rechazados")
        ? "rejected"
        : "pending";
    const verticalFilter = valor(args, "vertical")?.trim().toLowerCase();
    if (verticalFilter !== undefined && !esVerticalId(verticalFilter)) {
      throw new Error(`--vertical debe ser ${VERTICAL_IDS.join(", ")}`);
    }
    const originFilter = valor(args, "origen")?.trim().toLowerCase();
    const knownOrigins = [
      "manual",
      "meta",
      "places",
      "renipress",
      "identicole",
      "mincetur",
      "test",
    ];
    if (
      originFilter !== undefined &&
      !knownOrigins.includes(originFilter)
    ) {
      throw new Error(`--origen debe ser ${knownOrigins.join(", ")}`);
    }
    listar(store, status, entero(valor(args, "limite"), 100, "limite"), {
      vertical: verticalFilter,
      origin: originFilter,
    });
  } finally {
    store.close();
  }
}

await main();
