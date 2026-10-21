import path from "node:path";

import { currentAcceptedPublicationArtifact } from "./accepted-artifacts.ts";
import { runDirectOidcPublication } from "./publish.ts";

const repositoryRoot = path.resolve(
  process.env.PUBLICATION_REPOSITORY_ROOT ?? process.cwd(),
);
const artifact = await currentAcceptedPublicationArtifact({
  repositoryRoot,
  environment: process.env,
  packageRoot: process.cwd(),
});
function configuredDistTag(): string | undefined {
  const encoded = process.env.PUBLICATION_DIST_TAGS;
  if (encoded === undefined) return process.env.PUBLICATION_DIST_TAG;
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("PUBLICATION_DIST_TAGS 必须是有效的 JSON 对象。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PUBLICATION_DIST_TAGS 必须是有效的 JSON 对象。");
  }
  const tag = (value as Record<string, unknown>)[artifact.packageName];
  if (tag !== undefined && (typeof tag !== "string" || tag.length === 0)) {
    throw new Error(
      `PUBLICATION_DIST_TAGS 中 ${artifact.packageName} 的渠道无效。`,
    );
  }
  return typeof tag === "string" ? tag : process.env.PUBLICATION_DIST_TAG;
}
const configuredCredentialMode = process.env.PUBLICATION_CREDENTIAL_MODE;
const distTag = configuredDistTag();
if (
  configuredCredentialMode !== undefined &&
  configuredCredentialMode !== "oidc" &&
  configuredCredentialMode !== "interactive"
) {
  throw new Error("PUBLICATION_CREDENTIAL_MODE 只接受 oidc 或 interactive。");
}
if (
  configuredCredentialMode === "interactive" &&
  process.env.GITHUB_ACTIONS === "true"
) {
  throw new Error("GitHub Actions 发布必须使用 OIDC 凭据。");
}
await runDirectOidcPublication({
  repositoryRoot,
  packageRoot: artifact.packageRoot,
  artifactDirectory: path.dirname(artifact.artifactPath),
  environment: process.env,
  ...(configuredCredentialMode === undefined
    ? {}
    : { credentialMode: configuredCredentialMode }),
  ...(distTag === undefined ? {} : { distTag }),
});
