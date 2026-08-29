// @ts-check

/**
 * @typedef {object} ProjectManifest
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [scripts]
 */

export const hooks = {
  /**
   * @param {ProjectManifest} pkg
   * @returns {ProjectManifest}
   */
  beforePacking(pkg) {
    delete pkg.devDependencies;
    delete pkg.scripts;
    return pkg;
  },
};
