const path = require("node:path");
const { openDatabase } = require("../src/platform/database");
const { createAuthService } = require("../src/platform/auth");
const { createCatalogService } = require("../src/platform/catalog");
const { createLibraryService } = require("../src/platform/library");

const root = path.resolve(__dirname, "..");
const db = openDatabase(path.join(root, "var", "doscloud.db"));
const auth = createAuthService({ db, usersRoot: path.join(root, "user-data", "users") });
const catalog = createCatalogService({ db, manifestsRoot: path.join(root, "catalog", "manifests") });
const library = createLibraryService({ db, catalog, packagesRoot: path.join(root, "catalog", "packages"), auth });

auth.seedDemoUsers();
const demoLibraries = {
  alice: ["keen1", "doom"],
  bob: ["wolf3d", "duke1"],
  carol: ["duke3d", "raptor"],
  dave: ["secret-agent", "blake-stone"],
  erin: ["wacky-wheels", "cosmo"],
};

for (const [username, games] of Object.entries(demoLibraries)) {
  const user = auth.getUserByUsername(username);
  for (const gameId of games) library.install(user, gameId);
  console.log(username + ": " + games.join(", "));
}

console.log("Demo password: doscloud");
console.log("Catalog games: " + catalog.count());
db.close();
