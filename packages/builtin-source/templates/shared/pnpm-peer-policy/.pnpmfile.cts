type PackageManifest = {
  name?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const typeOnlyPeerOwners = new Set(["pinia", "valibot", "vue"]);

function readPackage(pkg: PackageManifest): PackageManifest {
  if (!pkg.name || !typeOnlyPeerOwners.has(pkg.name)) return pkg;

  delete pkg.peerDependencies?.typescript;
  delete pkg.peerDependenciesMeta?.typescript;
  return pkg;
}

module.exports = { hooks: { readPackage } };
