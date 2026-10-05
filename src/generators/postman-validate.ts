import * as ajvDraft04 from "ajv-draft-04";
import type { ErrorObject, Options, ValidateFunction } from "ajv";
import collectionSchema from "../../schemas/postman-collection-v2.1.json" with { type: "json" };

export type ValidationResult = { valid: boolean; errors: string[] };

type AjvConstructor = new (options?: Options) => { compile(schema: object): ValidateFunction };

// ajv-draft-04 is CommonJS: under Node ESM the class is the namespace's default export,
// which its type declarations don't describe, hence the explicit constructor type.
const Ajv04 = ajvDraft04.default as unknown as AjvConstructor;

// The official v2.1 schema is JSON Schema draft-04 (vendored in schemas/ so validation works offline).
let validator: ValidateFunction | undefined;

export function validatePostmanCollection(collection: unknown): ValidationResult {
  validator ??= new Ajv04({ allErrors: true, strict: false }).compile(collectionSchema);
  const valid = validator(collection) as boolean;
  const errors = (validator.errors ?? []).map((e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`);
  return { valid, errors };
}
