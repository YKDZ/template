// @ts-check

/**
 * @typedef {object} ProjectManifest
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [scripts]
 * @property {Record<string, string>} [imports]
 */

export const hooks = {
  /**
   * @param {ProjectManifest} pkg
   * @returns {ProjectManifest}
   */
  beforePacking(pkg) {
    const tooling = pkg.imports?.["#tooling/*"];
    if (
      typeof tooling === "string" &&
      tooling.endsWith("/*") &&
      Object.hasOwn(pkg.devDependencies ?? {}, tooling.slice(0, -2))
    ) {
      delete pkg.imports?.["#tooling/*"];
      if (Object.keys(pkg.imports ?? {}).length === 0) delete pkg.imports;
    }
    delete pkg.devDependencies;
    delete pkg.scripts;
    return pkg;
  },
};
