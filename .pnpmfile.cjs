// TypeDoc reads the code with the TypeScript compiler API, which TypeScript 7
// does not have yet: it gets TypeScript 6.0 of its own, while the build and
// typecheck use 7. Remove this once TypeDoc supports TypeScript 7.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === "typedoc") {
        delete pkg.peerDependencies?.typescript;
        pkg.dependencies = { ...pkg.dependencies, typescript: "~6.0.3" };
      }
      return pkg;
    },
  },
};
