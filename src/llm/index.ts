import { proveedorAnthropic } from "./anthropic.js";
import { proveedorClaudeCli } from "./claudeCli.js";
import { proveedorCodex } from "./codex.js";
import { proveedorGemini } from "./gemini.js";
import type { ProveedorLLM } from "./port.js";

const NOMBRES = ["anthropic", "codex", "claude-cli", "gemini"] as const;
type NombreProveedor = (typeof NOMBRES)[number];

export function crearProveedor(nombre?: string): ProveedorLLM {
  const elegido = nombre ?? process.env.LLM_PROVIDER ?? "anthropic";

  switch (elegido as NombreProveedor) {
    case "anthropic":
      return proveedorAnthropic();
    case "codex":
      return proveedorCodex();
    case "claude-cli":
      return proveedorClaudeCli();
    case "gemini":
      return proveedorGemini();
    default:
      throw new Error(
        `Proveedor LLM desconocido "${elegido}". Usa uno de: ${NOMBRES.join(", ")}`,
      );
  }
}

export type {
  CorteLLM,
  Efuerzo,
  HerramientaLLM,
  ProveedorLLM,
  RespuestaLLM,
  SolicitudLLM,
} from "./port.js";
