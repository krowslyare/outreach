import type { PerfilNegocioWhatsApp } from "../wa/client.js";

const GENERICAS = new Set([
  "centro",
  "clinica",
  "consultorio",
  "consultorios",
  "dental",
  "dentista",
  "odontologico",
  "odontologica",
  "odontologia",
  "medico",
  "medica",
  "salud",
  "veterinaria",
  "veterinario",
  "spa",
  "peru",
  "sac",
  "eirl",
  "de",
  "del",
  "la",
  "las",
  "el",
  "los",
  "y",
]);

function normalizar(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("es-PE")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

function tokensEspecificos(value: string): string[] {
  return normalizar(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !GENERICAS.has(token));
}

/**
 * Alertas conservadoras: sirven para detener al operador, nunca para aprobar.
 * Un perfil puede omitir nombre o distrito, así que la ausencia de coincidencia
 * no es una sentencia automática; la confirmación sigue siendo humana.
 */
export function alertasDeIdentidad(
  expected: { name: string; district: string },
  profile: PerfilNegocioWhatsApp,
): string[] {
  const alerts: string[] = [];
  const expectedTokens = tokensEspecificos(expected.name);
  const observed = normalizar(
    [
      profile.description,
      profile.category ?? "",
      profile.address ?? "",
      ...profile.websites,
    ].join(" "),
  );
  if (
    expectedTokens.length > 0 &&
    !expectedTokens.some((token) => observed.includes(token))
  ) {
    alerts.push("el perfil no contiene ninguna parte específica del nombre esperado");
  }

  if (
    profile.address !== null &&
    profile.address.trim() !== "" &&
    !normalizar(profile.address).includes(normalizar(expected.district))
  ) {
    alerts.push(
      `la dirección del perfil no contiene el distrito esperado (${expected.district})`,
    );
  }
  return alerts;
}
