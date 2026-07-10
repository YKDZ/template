import type { PresetProjection } from "@ykdz/template-core/preset-projection";

import { rustBinPresetProjection } from "./rust-bin/projection.ts";
import { tsLibPresetProjection } from "./ts-lib/projection.ts";
import { vikeAppPresetProjection } from "./vike-app/projection.ts";
import { vueAppPresetProjection } from "./vue-app/projection.ts";
import { vueHonoAppPresetProjection } from "./vue-hono-app/projection.ts";

const testOnlyPresetProjections: readonly PresetProjection[] = [
  tsLibPresetProjection,
  vueAppPresetProjection,
  vikeAppPresetProjection,
  vueHonoAppPresetProjection,
  rustBinPresetProjection,
];

export function findBuiltInPresetProjection(
  name: string,
): PresetProjection | undefined {
  return testOnlyPresetProjections.find(
    (projection) => projection.metadata.name === name,
  );
}
