import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";

/** 上游执行器要求失败结果不带 value；保留 Valibot 的验证及官方 JSON Schema 投影。 */
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
      validate(value) {
        const result = converted["~standard"].validate(value);
        if (result instanceof Promise)
          return result.then((resolved) =>
            resolved.issues === undefined
              ? resolved
              : { issues: resolved.issues },
          );
        return result.issues === undefined ? result : { issues: result.issues };
      },
    },
  };
  return adapted;
}
