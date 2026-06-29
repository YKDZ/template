export type Greeting = {
  message: string;
};

export function greet(name: string): Greeting {
  return { message: `Hello, ${name}` };
}
