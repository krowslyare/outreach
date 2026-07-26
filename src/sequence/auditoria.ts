export interface ContextoAuditoria {
  clasificacion: string;
  aperturasRecientes: string[];
}

export type ResultadoAuditoria =
  | { ok: true }
  | { ok: false; motivos: string[] };

const SIGLAS_PERMITIDAS = new Set(["SAC", "EIRL", "SRL", "SA", "DNI", "RUC"]);

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
  const contieneTaxonomia =
    textoMinuscula.includes("y de otros profesionales") ||
    textoMinuscula.includes("profesionales de la salud") ||
    (clasificacionCruda.length > 0 &&
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
    /S\/\s*\d/iu.test(texto) ||
    /\bsoles\s*\d/iu.test(texto) ||
    (/\bmensual\b/iu.test(texto) && /\d/u.test(texto));
  if (mencionaPrecio) {
    motivos.push("menciona un precio en el primer contacto");
  }

  if (texto.length > 700) {
    motivos.push(`supera el máximo de 700 caracteres (${texto.length})`);
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
