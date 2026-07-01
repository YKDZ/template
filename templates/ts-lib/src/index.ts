import * as v from "valibot";

export type Greeting = {
  message: string;
};

const nameSchema = v.pipe(v.string(), v.trim(), v.minLength(1));

export function greet(name: string): Greeting {
  return { message: `Hello, ${v.parse(nameSchema, name)}` };
}
