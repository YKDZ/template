import type { PresetProjection } from "@ykdz/template-core/preset-projection";

import { honoApiPresetProjection } from "./hono-api/projection.js";
import { rustBinPresetProjection } from "./rust-bin/projection.js";
import { tsLibPresetProjection } from "./ts-lib/projection.js";
import { vikeAppPresetProjection } from "./vike-app/projection.js";
import { vueAppPresetProjection } from "./vue-app/projection.js";
import { vueHonoAppPresetProjection } from "./vue-hono-app/projection.js";

const testOnlyPresetProjections: readonly PresetProjection[] = [
  tsLibPresetProjection,
  honoApiPresetProjection,
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
