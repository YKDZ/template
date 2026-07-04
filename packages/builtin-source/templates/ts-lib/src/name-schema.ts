import * as v from "valibot";

export const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1));
