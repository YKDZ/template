// @ts-check

/**
 * @typedef {object} ProjectManifest
 * @property {Record<string, string>} [devDependencies]
 */

export const hooks = {
  /**
   * @param {ProjectManifest} pkg
   * @returns {ProjectManifest}
   */
  beforePacking(pkg) {
    delete pkg.devDependencies;
    return pkg;
  },
};
