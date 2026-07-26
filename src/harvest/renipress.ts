import { readFile } from "node:fs/promises";

import type { Phone, RawProspect } from "../types.js";

export const DISTRITOS_LIMA_ALTO = new Set([
  "SANTIAGO DE SURCO",
  "MIRAFLORES",
  "SAN ISIDRO",
  "LA MOLINA",
  "SAN BORJA",
  "JESUS MARIA",
  "LINCE",
  "MAGDALENA DEL MAR",
  "BARRANCO",
  "PUEBLO LIBRE",
  "SURQUILLO",
]);

export const CLASIFICACIONES_MARGEN = [
  "ODONTOLOG",
  "CONSULTORIOS MEDICOS",
  "POLICLINICO",
  "CENTROS DE SALUD O CENTROS MEDICOS",
  "DIAGNOSTICO POR IMAGENES",
  "PATOLOGIA",
] as const;

export interface ProspectFilterOptions {
  districts?: Set<string>;
  classifications?: readonly string[];
  requireMobile?: boolean;
}

interface RenipressMetadata {
  institution: string;
}

const RENIPRESS_METADATA = Symbol("renipressMetadata");

type ProspectWithMetadata = RawProspect & {
  [RENIPRESS_METADATA]?: RenipressMetadata;
};

function normalizeComparable(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleUpperCase("es-PE");
}

function parseCoordinate(
  raw: string,
  minimum: number,
  maximum: number,
): number | null {
  if (raw === "") return null;

  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

export function normalizePhone(raw: string): Phone[] {
  const seen = new Set<string>();
  const phones: Phone[] = [];

  for (const part of raw.split(/[,/;|]|\s+y\s+/iu)) {
    const value = part.trim();
    if (!value) continue;

    const digits = value.replace(/\D/g, "");
    let kind: Phone["kind"] = "unknown";
    let e164: string | null = null;

    if (digits.length === 9 && digits.startsWith("9")) {
      kind = "mobile";
      e164 = `+51${digits}`;
    } else if (digits.length === 7 || digits.length === 8) {
      kind = "landline";
      e164 = `+51${digits}`;
    }

    // Los valores inválidos no tienen E.164; usamos sus dígitos (o texto)
    // como llave para no repetir la misma basura dentro de una celda.
    const dedupeKey = e164 ?? `unknown:${digits || normalizeComparable(value)}`;
    if (seen.has(dedupeKey)) continue;

    seen.add(dedupeKey);
    phones.push({ raw: value, e164, kind });
  }

  return phones;
}

function parseDelimitedRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];

    if (quoted) {
      if (character === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ";") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (quoted) {
    throw new Error("CSV RENIPRESS inválido: campo entre comillas sin cerrar");
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function parseRenipress(csvText: string): RawProspect[] {
  const rows = parseDelimitedRows(csvText);
  const header = rows.shift();

  if (!header) return [];

  // El BOM puede aparecer al inicio incluso después de decodificar latin-1.
  header[0] = header[0]?.replace(/^\uFEFF/, "") ?? "";
  const columnIndex = new Map(header.map((column, index) => [column.trim(), index]));
  const requiredColumns = [
    "INSTITUCION",
    "COD_IPRESS",
    "NOMBRE",
    "CLASIFICACION",
    "CATEGORIA",
    "DISTRITO",
    "UBIGEO",
    "DIRECCION",
    "TELEFONO",
    "NORTE",
    "ESTE",
  ];

  for (const column of requiredColumns) {
    if (!columnIndex.has(column)) {
      throw new Error(`CSV RENIPRESS inválido: falta la columna ${column}`);
    }
  }

  const get = (row: string[], column: string): string =>
    row[columnIndex.get(column) ?? -1]?.trim() ?? "";

  return rows
    .filter((row) => row.some((value) => value.trim() !== ""))
    .map((row) => {
      const category = get(row, "CATEGORIA");
      const prospect: ProspectWithMetadata = {
        source: "renipress",
        sourceId: get(row, "COD_IPRESS"),
        name: get(row, "NOMBRE"),
        classification: get(row, "CLASIFICACION"),
        category: category === "" || category === "-" ? null : category,
        district: get(row, "DISTRITO"),
        ubigeo: get(row, "UBIGEO"),
        address: get(row, "DIRECCION"),
        // RENIPRESS llama NORTE/ESTE a coordenadas que ya están en grados
        // decimales. El rango evita confundir basura o coordenadas de otro país.
        lat: parseCoordinate(get(row, "NORTE"), -18, 0),
        lng: parseCoordinate(get(row, "ESTE"), -82, -68),
        phones: normalizePhone(get(row, "TELEFONO")),
      };

      // INSTITUCION no forma parte del contrato público. La metadata no
      // enumerable permite filtrar sin contaminar serializaciones ni tipos.
      Object.defineProperty(prospect, RENIPRESS_METADATA, {
        value: { institution: get(row, "INSTITUCION") },
        enumerable: false,
      });

      return prospect;
    });
}

export function filterProspects(
  rows: RawProspect[],
  opts: ProspectFilterOptions = {},
): RawProspect[] {
  const districts = opts.districts
    ? new Set([...opts.districts].map(normalizeComparable))
    : null;
  const classifications = opts.classifications?.map(normalizeComparable);

  return rows.filter((row) => {
    const metadata = (row as ProspectWithMetadata)[RENIPRESS_METADATA];
    if (!metadata || !normalizeComparable(metadata.institution).includes("PRIVADO")) {
      return false;
    }

    if (districts && !districts.has(normalizeComparable(row.district))) {
      return false;
    }

    const classification = normalizeComparable(row.classification);
    if (
      classifications &&
      !classifications.some((candidate) => classification.includes(candidate))
    ) {
      return false;
    }

    return !opts.requireMobile || row.phones.some((phone) => phone.kind === "mobile");
  });
}

export function filterSharedPhones(
  universe: RawProspect[],
  selected: RawProspect[],
  maxEstablishments = 3,
): {
  kept: RawProspect[];
  dropped: Array<{ e164: string; count: number }>;
} {
  const establishmentsByMobile = new Map<string, Set<string>>();

  for (const prospect of universe) {
    // Un teléfono cuenta una sola vez por COD_IPRESS, aunque una fuente
    // defectuosa repita el teléfono o incluso la fila completa.
    const mobiles = new Set(
      prospect.phones
        .filter(
          (phone): phone is Phone & { e164: string } =>
            phone.kind === "mobile" && phone.e164 !== null,
        )
        .map((phone) => phone.e164),
    );

    for (const e164 of mobiles) {
      const sourceIds = establishmentsByMobile.get(e164) ?? new Set<string>();
      sourceIds.add(prospect.sourceId);
      establishmentsByMobile.set(e164, sourceIds);
    }
  }

  const droppedByMobile = new Map<string, number>();
  const kept = selected.filter((prospect) => {
    let shouldDrop = false;

    for (const phone of prospect.phones) {
      if (phone.kind !== "mobile" || phone.e164 === null) continue;

      const count = establishmentsByMobile.get(phone.e164)?.size ?? 0;
      if (count > maxEstablishments) {
        shouldDrop = true;
        droppedByMobile.set(phone.e164, count);
      }
    }

    // Si cualquiera de los móviles pertenece a un gestor, no hay un número
    // confiable al cual escribirle en nombre de este establecimiento.
    return !shouldDrop;
  });

  const dropped = [...droppedByMobile]
    .map(([e164, count]) => ({ e164, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.e164.localeCompare(right.e164),
    );

  return { kept, dropped };
}

export function dedupeByMobile(rows: RawProspect[]): {
  kept: RawProspect[];
  collisions: Array<{ e164: string; sourceIds: string[] }>;
} {
  const sorted = [...rows].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
  );
  const firstByMobile = new Map<string, RawProspect>();
  const sourceIdsByMobile = new Map<string, string[]>();
  const kept: RawProspect[] = [];

  for (const row of sorted) {
    const mobile = row.phones.find(
      (phone): phone is Phone & { e164: string } =>
        phone.kind === "mobile" && phone.e164 !== null,
    );

    if (!mobile) {
      kept.push(row);
      continue;
    }

    const sourceIds = sourceIdsByMobile.get(mobile.e164) ?? [];
    sourceIds.push(row.sourceId);
    sourceIdsByMobile.set(mobile.e164, sourceIds);

    if (!firstByMobile.has(mobile.e164)) {
      firstByMobile.set(mobile.e164, row);
      kept.push(row);
    }
  }

  const collisions = [...sourceIdsByMobile]
    .filter(([, sourceIds]) => sourceIds.length > 1)
    .map(([e164, sourceIds]) => ({ e164, sourceIds }));

  return { kept, collisions };
}

export async function loadRenipress(path: string): Promise<RawProspect[]> {
  const bytes = await readFile(path);
  const csvText = new TextDecoder("latin1").decode(bytes);
  return parseRenipress(csvText);
}
