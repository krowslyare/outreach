import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { captionVisual, cargarVisualesAprobados } from "./visual.js";

function png(ancho: number, alto: number): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.writeUInt32BE(ancho, 16);
  buffer.writeUInt32BE(alto, 20);
  return buffer;
}

function fixture(ancho = 1664, alto = 936): string {
  const dir = mkdtempSync(join(tmpdir(), "outreach-visuales-"));
  writeFileSync(join(dir, "hero.png"), png(ancho, alto));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 1,
      visuales: [
        {
          e164: "+51900000001",
          paso: "fu1",
          nombre: "Clínica Demo",
          imagen: "./hero.png",
        },
      ],
    }),
  );
  return join(dir, "manifest.json");
}

describe("cargarVisualesAprobados", () => {
  it("carga un PNG 16:9 y resuelve la ruta desde el manifiesto", () => {
    const visual = cargarVisualesAprobados(fixture()).get("+51900000001");
    expect(visual).toMatchObject({
      paso: "fu1",
      nombre: "Clínica Demo",
      ancho: 1664,
      alto: 936,
    });
    expect(visual?.ruta).toMatch(/hero\.png$/u);
    expect(visual?.imagen).toBeInstanceOf(Uint8Array);
  });

  it("falla cerrado si la imagen no es 16:9 exacto", () => {
    expect(() => cargarVisualesAprobados(fixture(1664, 935))).toThrow(
      "debe ser 16:9 exacto",
    );
  });

  it("rechaza números duplicados", () => {
    const manifest = fixture();
    const dir = manifest.replace(/\/manifest\.json$/u, "");
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        visuales: [
          { e164: "+51900000001", paso: "first", imagen: "./hero.png" },
          { e164: "+51900000001", paso: "fu1", imagen: "./hero.png" },
        ],
      }),
    );
    expect(dir).not.toBe("");
    expect(() => cargarVisualesAprobados(manifest)).toThrow("e164 duplicado");
  });

  it("rechaza un nombre comercial con saltos de línea", () => {
    const manifest = fixture();
    writeFileSync(
      manifest,
      JSON.stringify({
        version: 1,
        visuales: [
          {
            e164: "+51900000001",
            paso: "fu1",
            nombre: "Clínica\ninyectada",
            imagen: "./hero.png",
          },
        ],
      }),
    );
    expect(() => cargarVisualesAprobados(manifest)).toThrow(
      "nombre debe tener entre 2 y 80 caracteres",
    );
  });
});

describe("captionVisual", () => {
  it("presenta el concepto inicial sin fingir que es el resultado final", () => {
    const caption = captionVisual("CLÍNICA DENTAL BÓCARE S.A.C.", "fu1");
    expect(caption).toContain("hace unos días");
    expect(caption).toContain("propuesta visual inicial");
    expect(caption).toContain("el resultado final sería incluso mejor");
    expect(caption).toContain("Bócare");
    expect(caption.match(/\?/gu)).toHaveLength(1);
  });

  it("usa una apertura propia para un visual-first", () => {
    const caption = captionVisual("PETYLAB", "first");
    expect(caption).toContain("estuve revisando la presencia de Petylab");
    expect(caption).not.toContain("hace unos días");
  });

  it("conserva la capitalización de un nombre comercial aprobado", () => {
    const caption = captionVisual("COE Oral Lima", "fu1", true);
    expect(caption).toContain("web de COE Oral Lima");
    expect(caption).toContain("para COE Oral Lima?");
  });
});
