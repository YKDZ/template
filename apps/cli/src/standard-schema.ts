import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";

/** 为领域 rawCheck 指定官方 JSON Schema 投影策略。 */
export function standardSchema<
  T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: T, ignoreActions: string[] = []) {
  const converted = toStandardJsonSchema(schema);
  const adapted: typeof converted = {
    "~standard": {
      ...converted["~standard"],
      jsonSchema: {
        input: (options) =>
          converted["~standard"].jsonSchema.input({
            ...options,
            libraryOptions: { ...options.libraryOptions, ignoreActions },
          }),
        output: (options) =>
          converted["~standard"].jsonSchema.output({
            ...options,
            libraryOptions: { ...options.libraryOptions, ignoreActions },
          }),
      },
    },
  };
  return adapted;
}
