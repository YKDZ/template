// @template-anchor db-package-import

declare global {
  namespace Telefunc {
    interface Context {
      db: Database;
    }
  }
}
