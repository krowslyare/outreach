export interface ContextoAuditoria {
  clasificacion: string;
  aperturasRecientes: string[];
  paso?: "first" | "fu1" | "fu2";
}

export type ResultadoAuditoria =
  | { ok: true }
  | { ok: false; motivos: string[] };

const SIGLAS_PERMITIDAS = new Set(["SAC", "EIRL", "SRL", "SA", "DNI", "RUC"]);
const TAXONOMIAS_CRUDAS = new Set([
  "CONSULTORIOS MEDICOS Y DE OTROS PROFESIONALES DE LA SALUD",
  "CENTRO ODONTOLOGICO",
  "POLICLINICOS",
  "PATOLOGIA CLINICA",
  "DIAGNOSTICO POR IMAGENES",
  "CENTROS DE SALUD O CENTROS MEDICOS",
]);

function sinAcentos(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleUpperCase("es-PE");
}

function primerasCincoPalabras(texto: string): string | null {
  const normalizadas =
    texto
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("es-PE")
      .match(/[\p{L}\p{N}]+/gu) ?? [];

  if (normalizadas.length < 5) return null;
  return normalizadas.slice(0, 5).join(" ");
}

export function auditarMensaje(
  texto: string,
  contexto: ContextoAuditoria,
): ResultadoAuditoria {
  const motivos: string[] = [];
  const textoMinuscula = texto.toLocaleLowerCase("es-PE");
  const clasificacionCruda = contexto.clasificacion.trim();
  const clasificacionNormalizada = sinAcentos(clasificacionCruda);
  const contieneTaxonomia =
    textoMinuscula.includes("y de otros profesionales") ||
    textoMinuscula.includes("profesionales de la salud") ||
    (TAXONOMIAS_CRUDAS.has(clasificacionNormalizada) &&
      textoMinuscula.includes(clasificacionCruda.toLocaleLowerCase("es-PE")));

  if (contieneTaxonomia) {
    motivos.push("contiene taxonomía cruda del padrón");
  }

  const palabras = texto.match(/\p{L}+/gu) ?? [];
  const noPermitidas = palabras.filter((palabra) => {
    const esSostenida =
      palabra.length >= 4 &&
      palabra === palabra.toLocaleUpperCase("es-PE") &&
      palabra !== palabra.toLocaleLowerCase("es-PE");
    return esSostenida && !SIGLAS_PERMITIDAS.has(palabra);
  });
  if (noPermitidas.length > 0) {
    motivos.push(
      `contiene mayúscula sostenida no permitida: ${[...new Set(noPermitidas)].join(", ")}`,
    );
  }

  const mencionaPrecio =
    // "S/ 500" y también "S/. 500": el punto tras la barra es la forma más
    // común de escribirlo en Perú y sin contemplarlo el precio se colaba.
    /S\/\.?\s*\d/iu.test(texto) ||
    // "soles 500" y "500 soles". El monto va antes tanto o más seguido que
    // después, y solo se cubría un orden.
    /\bsoles\s*\d/iu.test(texto) ||
    /\d[\d.,]*\s*soles\b/iu.test(texto) ||
    (/\bmensual(?:es|idad)?\b/iu.test(texto) && /\d/u.test(texto));
  if (mencionaPrecio) {
    motivos.push("menciona un precio en el primer contacto");
  }

  if (texto.length > 700) {
    motivos.push(`supera el máximo de 700 caracteres (${texto.length})`);
  }

  if (contexto.paso === "first") {
    const preguntas = texto.match(/\?/gu)?.length ?? 0;
    if (preguntas !== 1) {
      motivos.push(`el primer contacto debe tener una sola pregunta (${preguntas})`);
    } else if (!texto.trimEnd().endsWith("?")) {
      motivos.push("la pregunta del primer contacto debe ir al final");
    }
  }

  const apertura = primerasCincoPalabras(texto);
  const repiteApertura =
    apertura !== null &&
    contexto.aperturasRecientes.some(
      (reciente) => primerasCincoPalabras(reciente) === apertura,
    );
  if (repiteApertura) {
    motivos.push("repite las primeras cinco palabras de una apertura reciente");
  }

  return motivos.length === 0 ? { ok: true } : { ok: false, motivos };
}
