import type { Analysis } from "../core/schema.js";
import { apiSlug } from "./format.js";
import { buildMarkdown } from "./markdown.js";
import { buildSequenceDiagram } from "./mermaid.js";
import { buildPostmanCollection, buildPostmanEnvironment } from "./postman.js";
import { validatePostmanCollection, type ValidationResult } from "./postman-validate.js";

export { apiSlug, buildMarkdown, buildSequenceDiagram, buildPostmanCollection, buildPostmanEnvironment, validatePostmanCollection };

export type OutputFiles = {
  slug: string;
  /** File name -> contents. The collection is omitted if it fails validation. */
  files: Record<string, string>;
  postmanValidation: ValidationResult;
};

/** Renders every output file in memory; callers decide where to write them. */
export function buildOutputs(analysis: Analysis): OutputFiles {
  const collection = buildPostmanCollection(analysis);
  const postmanValidation = validatePostmanCollection(collection);
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

  const files: Record<string, string> = {
    "analysis.json": json(analysis),
    "analysis.md": buildMarkdown(analysis),
    "postman_environment.json": json(buildPostmanEnvironment(analysis)),
    "sequence.mmd": buildSequenceDiagram(analysis),
  };
  if (postmanValidation.valid) files["postman_collection.json"] = json(collection);

  return { slug: apiSlug(analysis), files, postmanValidation };
}
