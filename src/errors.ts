import type { Diagnostic } from "./types";

export interface ErrorLocation {
  file?: string;
  line?: number;
  column?: number;
  ids?: string[];
}

/** Base class for every error thrown by AppNav. */
export class AppNavError extends Error {
  readonly code: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly ids?: string[];
  readonly cause?: unknown;

  constructor(code: string, message: string, location: ErrorLocation = {}, cause?: unknown) {
    const where =
      location.line !== undefined
        ? ` (${location.file ?? "<input>"}:${location.line}${location.column !== undefined ? `:${location.column}` : ""})`
        : "";
    super(`${message}${where}`);
    this.name = new.target.name;
    this.code = code;
    this.file = location.file;
    this.line = location.line;
    this.column = location.column;
    this.ids = location.ids;
    this.cause = cause;
  }
}

export class ParseError extends AppNavError {
  constructor(message: string, location: ErrorLocation = {}, code = "PARSE_ERROR") {
    super(code, message, location);
  }
}

export class UnsupportedVersionError extends AppNavError {
  constructor(version: string | number, location: ErrorLocation = {}) {
    super("UNSUPPORTED_VERSION", `Unsupported NAVGRAPH version: ${version}`, location);
  }
}

export class ValidationError extends AppNavError {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[], file?: string) {
    const errors = diagnostics.filter((d) => d.severity === "error");
    const head = errors[0];
    const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : "";
    super(
      "VALIDATION_ERROR",
      `${head ? head.message : "Validation failed"}${more}`,
      { file, line: head?.line, column: head?.column, ids: head?.ids },
    );
    this.diagnostics = diagnostics;
  }
}

export class SchemaError extends AppNavError {
  constructor(message: string, ids?: string[]) {
    super("SCHEMA_ERROR", message, { ids });
  }
}

export class VariableError extends AppNavError {
  constructor(message: string, location: ErrorLocation = {}, code = "VARIABLE_ERROR") {
    super(code, message, location);
  }
}

export class ConditionError extends AppNavError {
  constructor(message: string, location: ErrorLocation = {}, code = "CONDITION_ERROR") {
    super(code, message, location);
  }
}

export class UnknownScreenError extends AppNavError {
  constructor(id: string) {
    super("UNKNOWN_SCREEN", `Unknown screen: ${id}`, { ids: [id] });
  }
}

export class NoPathError extends AppNavError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string, algorithm: string) {
    super("NO_PATH", `No path from "${from}" to "${to}" using ${algorithm}`, { ids: [from, to] });
    this.from = from;
    this.to = to;
  }
}

export class ExtensionError extends AppNavError {
  readonly extension: string;
  constructor(extension: string, message: string, cause?: unknown, ids?: string[]) {
    super("EXTENSION_ERROR", `Extension "${extension}": ${message}`, { ids }, cause);
    this.extension = extension;
  }
}

/** Thrown by the synchronous builders when an extension returns a promise. */
export class AsyncExtensionError extends AppNavError {
  constructor(what: string) {
    super(
      "ASYNC_IN_SYNC",
      `${what} returned a promise but a synchronous API was used. Use the async variant instead.`,
    );
  }
}

export class ActionHandlerError extends AppNavError {
  constructor(code: string, message: string, ids?: string[], cause?: unknown) {
    super(code, message, { ids }, cause);
  }
}

export class FileLoadError extends AppNavError {
  constructor(message: string, path?: string, cause?: unknown) {
    super("FILE_LOAD_ERROR", message, { file: path }, cause);
  }
}

export function toDiagnostic(err: AppNavError, severity: "error" | "warning" = "error"): Diagnostic {
  return {
    severity,
    code: err.code,
    message: err.message,
    file: err.file,
    line: err.line,
    column: err.column,
    ids: err.ids,
  };
}
