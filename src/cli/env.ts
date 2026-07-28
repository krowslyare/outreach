// Carga .env antes que nada.
//
// Importarlo PRIMERO en cada CLI no es cosmético: los módulos ESM se evalúan en
// orden, y campana.ts llama a crearProveedor() en el tope, que lee LLM_PROVIDER.
// Si esta carga quedara después, el proveedor se elegiría con el entorno vacío.
//
// Sin dependencia: process.loadEnvFile es builtin desde Node 20.6, y el
// package.json ya exige >= 22.5 por node:sqlite.

try {
  // No pisa lo que ya venga del entorno real, así que un `NUMERO_HUMANO=... npm
  // run campana` sigue mandando sobre el archivo.
  process.loadEnvFile(".env");
} catch {
  // Sin archivo no hay nada que cargar. No es un error: en un servidor las
  // variables llegan del entorno y no de un archivo en el repo.
}
