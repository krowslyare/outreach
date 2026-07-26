import { describe, expect, it } from "vitest";

import type { RawProspect } from "../types.js";
import {
  dedupeByMobile,
  filterSharedPhones,
  filterProspects,
  normalizePhone,
  parseRenipress,
} from "./renipress.js";

const HEADER =
  "INSTITUCION;COD_IPRESS;NOMBRE;CLASIFICACION;TIPO_ESTABLECIMIENTO;DEPARTAMENTO;PROVINCIA;DISTRITO;UBIGEO;DIRECCION;CO_DISA;COD_RED;COD_MICRORRED;DISA;RED;MICRORED;COD_UE;UNIDAD_EJECUTORA;CATEGORIA;TELEFONO;HORARIO;INICIO_ACTIVIDAD;ESTADO;SITUACION;CONDICION;NORTE;ESTE;IMAGEN_1;FE_ACT_IMAGEN_1;IMAGEN_2;FE_ACT_IMAGEN_2;IMAGEN_3;FE_ACT_IMAGEN_3";

function csvRow(values: Partial<Record<string, string>>): string {
  const columns = HEADER.split(";");
  return columns
    .map((column) => `"${(values[column] ?? "").replaceAll('"', '""')}"`)
    .join(";");
}

function prospect(sourceId: string, phone: string): RawProspect {
  return {
    source: "renipress",
    sourceId,
    name: `Clínica ${sourceId}`,
    classification: "CENTRO ODONTOLOGICO",
    category: null,
    district: "MIRAFLORES",
    ubigeo: "150122",
    address: "Av. Ejemplo 123",
    lat: -12.0675439,
    lng: -77.0368198,
    phones: normalizePhone(phone),
  };
}

describe("normalizePhone", () => {
  it("separa formatos reales, normaliza y deduplica móviles", () => {
    expect(
      normalizePhone("987 654 321 / 01-4455667 y 987654321; 4455667"),
    ).toEqual([
      { raw: "987 654 321", e164: "+51987654321", kind: "mobile" },
      { raw: "01-4455667", e164: null, kind: "unknown" },
      { raw: "4455667", e164: "+514455667", kind: "landline" },
    ]);
  });

  it("conserva teléfono basura como unknown para auditoría", () => {
    expect(normalizePhone("SIN TELEFONO | 123")).toEqual([
      { raw: "SIN TELEFONO", e164: null, kind: "unknown" },
      { raw: "123", e164: null, kind: "unknown" },
    ]);
  });
});

describe("parseRenipress y filterProspects", () => {
  it("mapea el CSV citado, respeta punto y coma entre comillas y filtra privados", () => {
    const privateRow = csvRow({
      INSTITUCION: "PRIVADO",
      COD_IPRESS: "000123",
      NOMBRE: 'CENTRO "SONRISA"',
      CLASIFICACION: "CENTRO ODONTOLOGICO",
      CATEGORIA: "-",
      DISTRITO: "Miraflores",
      UBIGEO: "150122",
      DIRECCION: "Av. Uno; piso 2",
      TELEFONO: "999111222, 4455667",
      NORTE: "-12.0675439",
      ESTE: "-77.0368198",
    });
    const publicRow = csvRow({
      INSTITUCION: "GOBIERNO REGIONAL",
      COD_IPRESS: "000124",
      NOMBRE: "CENTRO PÚBLICO",
      CLASIFICACION: "CENTRO ODONTOLOGICO",
      DISTRITO: "MIRAFLORES",
      TELEFONO: "999333444",
    });
    const parsed = parseRenipress(`${HEADER}\n${privateRow}\n${publicRow}\n`);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      source: "renipress",
      sourceId: "000123",
      name: 'CENTRO "SONRISA"',
      category: null,
      address: "Av. Uno; piso 2",
      lat: -12.0675439,
      lng: -77.0368198,
    });
    expect(
      filterProspects(parsed, {
        districts: new Set(["MIRAFLORES"]),
        classifications: ["ODONTOLOG"],
        requireMobile: true,
      }).map((row) => row.sourceId),
    ).toEqual(["000123"]);
  });

  it("convierte coordenadas vacías, inválidas o fuera de Perú a null", () => {
    const empty = csvRow({
      INSTITUCION: "PRIVADO",
      COD_IPRESS: "1",
      NORTE: "",
      ESTE: "",
    });
    const outsidePeru = csvRow({
      INSTITUCION: "PRIVADO",
      COD_IPRESS: "2",
      NORTE: "-33.4489",
      ESTE: "-70.6693",
    });
    const invalid = csvRow({
      INSTITUCION: "PRIVADO",
      COD_IPRESS: "3",
      NORTE: "SUR",
      ESTE: "OESTE",
    });

    const parsed = parseRenipress(
      `${HEADER}\n${empty}\n${outsidePeru}\n${invalid}\n`,
    );

    expect(parsed.map(({ lat, lng }) => ({ lat, lng }))).toEqual([
      { lat: null, lng: null },
      { lat: null, lng: -70.6693 },
      { lat: null, lng: null },
    ]);
  });
});

describe("filterSharedPhones", () => {
  it("cuenta sobre el universo nacional y descarta si cualquier móvil supera el tope", () => {
    const shared = "999111222";
    const localOnly = "988111222";
    const universe = [
      prospect("LIMA-1", `${localOnly}, ${shared}`),
      prospect("LIMA-2", localOnly),
      prospect("CUSCO-1", shared),
      prospect("PIURA-1", shared),
      prospect("TACNA-1", shared),
      prospect("LIMA-3", "977111222"),
    ];
    const selected = [universe[0]!, universe[1]!, universe[5]!];

    const result = filterSharedPhones(universe, selected, 3);

    expect(result.kept.map((row) => row.sourceId)).toEqual([
      "LIMA-2",
      "LIMA-3",
    ]);
    expect(result.dropped).toEqual([{ e164: "+51999111222", count: 4 }]);
  });

  it("acepta números presentes en exactamente tres establecimientos", () => {
    const selected = [
      prospect("1", "999111222"),
      prospect("2", "999111222"),
      prospect("3", "999111222"),
    ];
    const universe = [...selected, prospect("3", "999111222")];

    expect(filterSharedPhones(universe, selected).kept).toHaveLength(3);
    expect(filterSharedPhones(universe, selected).dropped).toEqual([]);
  });
});

describe("dedupeByMobile", () => {
  it("conserva determinísticamente el sourceId menor y reporta la colisión", () => {
    const result = dedupeByMobile([
      prospect("B-20", "999111222"),
      prospect("A-10", "999111222"),
      prospect("C-30", "SIN TELEFONO"),
    ]);

    expect(result.kept.map((row) => row.sourceId)).toEqual(["A-10", "C-30"]);
    expect(result.collisions).toEqual([
      { e164: "+51999111222", sourceIds: ["A-10", "B-20"] },
    ]);
  });
});
