const typeOnlyPeerOwners = new Set(["valibot"]);

function readPackage(pkg: {
  name?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, unknown>;
}) {
  if (!pkg.name || !typeOnlyPeerOwners.has(pkg.name)) return pkg;
  delete pkg.peerDependencies?.typescript;
  delete pkg.peerDependenciesMeta?.typescript;
  return pkg;
}

export default { hooks: { readPackage } };
