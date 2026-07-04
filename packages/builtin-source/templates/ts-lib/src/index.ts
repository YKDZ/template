import * as v from "valibot";

import { nameSchema } from "#/name-schema";

export type Greeting = {
  message: string;
};

export function greet(name: string): Greeting {
  return { message: `Hello, ${v.parse(nameSchema, name)}` };
}
