import { proveedorAnthropic } from "./anthropic.js";
import { proveedorClaudeCli } from "./claudeCli.js";
import { proveedorCodex } from "./codex.js";
import { proveedorGemini } from "./gemini.js";
import type { ProveedorLLM } from "./port.js";

const NOMBRES = ["anthropic", "codex", "claude-cli", "gemini"] as const;
type NombreProveedor = (typeof NOMBRES)[number];

/**
 * Los dos trabajos del sistema, que NO son el mismo trabajo.
 *
 * - `compositor` escribe el primer mensaje en frío. Corre una vez por prospecto
 *   y su calidad es la mitigación principal de la tasa de bloqueo, que es lo que
 *   cuesta el número. Acá se paga por lo mejor disponible.
 * - `agente` conversa. Tiene que seguir reglas duras —no cotizar de más, escalar
 *   a tiempo, no soltar el prompt ante un mensaje que intenta manipularlo— con
 *   texto adversario del otro lado.
 *
 * A 15-20 mensajes al día la diferencia de costo entre modelos es despreciable
 * frente a perder la cuenta o mandarle a Hideki un lead que no existe. Bajar de
 * gama acá optimiza lo que no duele.
 */
export type Rol = "compositor" | "agente";

/**
 * Modelo por defecto de cada rol, por proveedor.
 *
 * Vacío significa "el default del adaptador". Solo se llenan los que se
 * midieron: poner un slug inventado en un proveedor que no se probó rompería en
 * runtime con un error del CLI, no en el typecheck.
 */
const MODELOS: Partial<
  Record<NombreProveedor, Partial<Record<Rol, string>>>
> = {
  codex: {
    // Sol es el más capaz de los tres 5.6. El mensaje en frío es donde más
    // rinde: es el único disparo que existe con esa persona.
    compositor: "gpt-5.6-sol",
    // Luna, por decisión de Hideki: la conversación es de ida y vuelta corta y
    // no necesita un frontier. Si algún día aparece un caso donde el agente
    // suelta un precio que no debía o no escala a tiempo, el sospechoso número
    // uno es éste y se sube a Terra cambiando esta línea.
    agente: "gpt-5.6-luna",
  },
};

function modeloPara(proveedor: NombreProveedor, rol: Rol): string | undefined {
  const porEnv = process.env[
    rol === "compositor" ? "LLM_MODELO_COMPOSITOR" : "LLM_MODELO_AGENTE"
  ]?.trim();
  if (porEnv !== undefined && porEnv !== "") return porEnv;
  return MODELOS[proveedor]?.[rol];
}

export function crearProveedor(rol: Rol = "agente", nombre?: string): ProveedorLLM {
  const elegido = (nombre ?? process.env.LLM_PROVIDER ?? "anthropic") as NombreProveedor;
  const modelo = modeloPara(elegido, rol);

  switch (elegido) {
    case "anthropic":
      return proveedorAnthropic(modelo === undefined ? {} : { modelo });
    case "codex":
      return proveedorCodex(modelo === undefined ? {} : { modelo });
    case "claude-cli":
      return proveedorClaudeCli();
    case "gemini":
      return proveedorGemini(modelo === undefined ? {} : { modelo });
    default:
      throw new Error(
        `Proveedor LLM desconocido "${elegido}". Usa uno de: ${NOMBRES.join(", ")}`,
      );
  }
}

/** El nombre del modelo que se usaría, para poder anunciarlo antes de correr. */
export function modeloAnunciado(rol: Rol): string {
  const proveedor = (process.env.LLM_PROVIDER ?? "anthropic") as NombreProveedor;
  return modeloPara(proveedor, rol) ?? "(default del adaptador)";
}

export type {
  CorteLLM,
  Efuerzo,
  HerramientaLLM,
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "./port.js";
