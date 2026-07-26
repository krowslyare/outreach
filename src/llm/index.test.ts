import { afterEach, describe, expect, it } from "vitest";

import { crearProveedor } from "./index.js";

const original = process.env.LLM_PROVIDER;

afterEach(() => {
  if (original === undefined) {
    delete process.env.LLM_PROVIDER;
  } else {
    process.env.LLM_PROVIDER = original;
  }
});

describe("crearProveedor", () => {
  it.each(["anthropic", "codex", "claude-cli", "gemini"])(
    "crea el proveedor %s",
    (nombre) => {
      expect(crearProveedor(nombre).nombre).toBe(nombre);
    },
  );

  it("usa anthropic por defecto", () => {
    delete process.env.LLM_PROVIDER;
    expect(crearProveedor().nombre).toBe("anthropic");
  });

  it("lee LLM_PROVIDER", () => {
    process.env.LLM_PROVIDER = "gemini";
    expect(crearProveedor().nombre).toBe("gemini");
  });

  it("falla con un mensaje claro ante un nombre inválido", () => {
    expect(() => crearProveedor("otro")).toThrow(
      'Proveedor LLM desconocido "otro". Usa uno de: anthropic, codex, claude-cli, gemini',
    );
  });
});
