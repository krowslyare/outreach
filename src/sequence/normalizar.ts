const CONECTORES = new Set(["de", "del", "la", "las", "los", "y", "e", "en"]);
const SIGLAS_CONOCIDAS = new Set(["SAC", "EIRL", "SA", "SRL"]);

const SUFIJOS_LEGALES = [
  /(?:\s+|,\s*)S\.?\s*A\.?\s*C\.?$/iu,
  /(?:\s+|,\s*)E\.?\s*I\.?\s*R\.?\s*L\.?$/iu,
  /(?:\s+|,\s*)S\.?\s*R\.?\s*L\.?$/iu,
  /(?:\s+|,\s*)S\.?\s*A\.?$/iu,
];

function quitarSufijosLegales(nombre: string): string {
  let resultado = nombre.trim();
  let cambio = true;

  // Se itera porque algunos registros acumulan más de una forma societaria.
  // Ninguna de ellas ayuda a reconocer la marca en una conversación.
  while (cambio) {
    cambio = false;
    for (const patron of SUFIJOS_LEGALES) {
      const sinSufijo = resultado.replace(patron, "").trim();
      if (sinSufijo !== resultado) {
        resultado = sinSufijo;
        cambio = true;
        break;
      }
    }
  }

  return resultado;
}

function capitalizarSegmento(segmento: string): string {
  const letras = [...segmento.toLocaleLowerCase("es-PE")];
  const primeraLetra = letras.findIndex((caracter) => /\p{L}/u.test(caracter));
  if (primeraLetra === -1) return segmento;
  letras[primeraLetra] = letras[primeraLetra]!.toLocaleUpperCase("es-PE");
  return letras.join("");
}

function titleCasePalabra(palabra: string): string {
  const canonica = palabra.replace(/[^\p{L}]/gu, "").toLocaleUpperCase("es-PE");
  if (SIGLAS_CONOCIDAS.has(canonica)) return canonica;

  const minuscula = palabra.toLocaleLowerCase("es-PE");
  if (CONECTORES.has(minuscula)) return minuscula;

  // Los guiones forman parte de varios nombres públicos. Capitalizar cada
  // tramo evita convertir "MARÍA-JOSÉ" en el poco natural "María-josé".
  return palabra
    .split("-")
    .map(capitalizarSegmento)
    .join("-");
}

export function normalizarNombre(raw: string): string {
  const sinSufijo = quitarSufijosLegales(raw.replace(/\s+/g, " "));
  return sinSufijo
    .split(" ")
    .filter((palabra) => palabra.length > 0)
    .map(titleCasePalabra)
    .join(" ");
}

const RUBROS_NATURALES = new Map<string, string>([
  [
    "CONSULTORIOS MEDICOS Y DE OTROS PROFESIONALES DE LA SALUD",
    "consultorio",
  ],
  ["CENTRO ODONTOLOGICO", "centro odontológico"],
  ["POLICLINICOS", "policlínico"],
  ["PATOLOGIA CLINICA", "laboratorio"],
  ["DIAGNOSTICO POR IMAGENES", "centro de diagnóstico por imágenes"],
  ["CENTROS DE SALUD O CENTROS MEDICOS", "centro médico"],
]);

export function rubroNatural(clasificacion: string): string {
  const clave = clasificacion.trim().replace(/\s+/g, " ").toLocaleUpperCase("es-PE");
  // El fallback nunca refleja el padrón: una categoría nueva debe degradar a
  // lenguaje seguro, no filtrarse tal cual al mensaje.
  return RUBROS_NATURALES.get(clave) ?? "consultorio";
}
