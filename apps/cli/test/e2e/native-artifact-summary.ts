import { createHash } from "node:crypto";

import type { TemplateContentMember } from "@ykdz/template-content";

export function summarizeNativeArtifacts(
  content: readonly TemplateContentMember[],
) {
  return content.map((member) => {
    const artifact = member.definition.prepareArtifact();
    const files = [...artifact.compiled, ...artifact.resources].toSorted(
      (left, right) => left.path.localeCompare(right.path),
    );
    const digest = createHash("sha256");
    for (const file of files) {
      digest.update(file.path);
      digest.update("\0");
      digest.update(String(file.mode));
      digest.update("\0");
      digest.update(file.data);
    }
    return {
      identity: member.identity,
      compiledCount: artifact.compiled.length,
      resourceCount: artifact.resources.length,
      byteCount: files.reduce((total, file) => total + file.data.byteLength, 0),
      sha256: digest.digest("hex"),
    };
  });
}
