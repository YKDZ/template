import { z } from "zod";

export const nameSchema = z.string().trim().min(1);
