# Grafen som läsguide — implementationsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Göra CodeGraph till ett verktyg som besvarar frågan i stället för att lokalisera den — grafsvar med radintervall, ärlig täckning och en färskhetssignal, så att en agent kan läsa 30 rader i stället för hela filen och veta när svaret inte går att lita på.

**Architecture:** Sex ändringar i befintlig struktur, ingen ny arkitektur. Sökvägsupplösningen samlas i en modul som alla tre ingångar delar. Seedern tar flera `tsconfig.json` och löser importer mot unionen av deras filer. Noder får radintervall och räknare för det de inte kunde upplösa. En metadatatabell bär färskhet. Frågelagret kollapsar från fyra smala verktyg till `find_symbol` + `neighbors` + `graph_status`. Sist blir databasanslutningen varm, med omöppning när seedern bytt fil.

**Tech Stack:** Node.js ≥20, TypeScript (ESM, NodeNext), `ts-morph` 27, `kuzu` 0.11.3 (låst), `@modelcontextprotocol/sdk` 1.25, `zod` 4, `tsx` för körning, `node:assert/strict` för tester.

**Spec:** Ingen skriven spec — den tidigare `instructions.md` är borttagen som otillräcklig. Underlaget är:
- Utvärderingsnoten *"Utvärdering: CodeGraph som agentverktyg (2026-08-29)"* — https://spote.cloud/app/note/5b617ed0-3b28-4f2f-8290-66367484b548
- [docs/architecture.md](../../architecture.md) — nuläget, uppdateras i Task 8

## Global Constraints

- **Node.js ≥ 20.** ESM genomgående. Inga `require`, inget `require.main`.
- **Kuzu låst till `0.11.3`.** Ändra inte versionen i denna plan.
- **MCP-servern är skrivskyddad.** Inget verktyg får exponera godtycklig Cypher, och inget verktyg får skriva till grafen.
- **Klientvärden binds alltid som databasparametrar.** Enda tillåtna interpolationen i en fråga är relations- och riktningsnamn som kommer från en Zod-`enum` i serverkoden — aldrig från ett fritt strängfält.
- **`stdout` tillhör MCP-protokollet.** All loggning från `src/mcp-server.ts` går till `stderr`.
- **Seedning bygger om från grunden.** Ingen inkrementell uppdatering införs i denna plan.
- **Verifieringskommandon:** `npm run build` (tsc --noEmit), `npm run test:seed`, plus de nya testskripten varje task lägger till.
- **Språk:** dokumentation och användarvända meddelanden på svenska; kod, identifierare och committexter på engelska.

## Ordningsberoenden som inte får kastas om

- **Task 5 (färskhet) före Task 6 (nya verktyg).** Radintervall gör svaren precisa och därmed farligare när grafen är gammal: en sökväg överlever att en rad läggs till ovanför, ett radnummer gör det inte. Radintervall får inte nå en agent innan `graph_status` finns.
- **Task 1 före Task 2.** Multi-tsconfig skriver till den sökväg Task 1 definierar.
- **Task 7 sist.** Den varma anslutningen är enbart en optimering och är den enda ändringen som kan servera gammal data tyst om den byggs slarvigt.

## Filstruktur

| Fil | Ansvar | Task |
|---|---|---|
| `src/paths.ts` | **Ny.** Enda källan till var grafen ligger. Uppåtvandrande sökning. | 1 |
| `src/config.ts` | **Ny.** Läser/skriver `.codegraph/config.json` med tsconfig-listan. | 2 |
| `src/graph-meta.ts` | **Ny.** Skriver och läser `GraphMeta`, samt git-jämförelsen. | 5 |
| `src/schema.ts` | Schemadefinition och anslutningar. Växer med kolumner och `GraphMeta`. | 3, 4, 5 |
| `src/seed.ts` | Extraktion. Tar en lista tsconfig, skriver radintervall och räknare. | 2, 3, 4, 5 |
| `src/mcp-server.ts` | Frågelager. Byter verktygsuppsättning, får varm anslutning. | 1, 5, 6, 7 |
| `src/cli.ts` | `init` / `seed`. Använder `paths.ts` och `config.ts`. | 1, 2 |
| `test/fixtures/imports/` | Enkelprojektfixtur. Får en `export type`. | 3 |
| `test/fixtures/monorepo/` | **Ny.** Två paket, två tsconfig, korspaketimport. | 2 |

---

### Task 1: Delad databassökväg (monorepo-buggen)

**Bakgrund:** Idag räknas databassökvägen ut på tre olika sätt. `src/cli.ts:8` använder alltid `cwd`; `src/seed.ts:32` defaultar till tsconfig-katalogen; `src/mcp-server.ts:12` använder `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`. I ett monorepo vinner `CLAUDE_PROJECT_DIR` (repo-roten) över `cwd` i `.mcp.json` (`apps/app`), så servern letade i repo-roten efter en graf som CLI:t hade skrivit under `apps/app`. Felet är tyst: svaret blir "Ingen graf hittades" trots att en graf finns, eller — värre — en helt annan grafs data.

Fixen är en enda regel som alla tre delar: vandra uppåt från startkatalogen tills en `.codegraph/kuzu` hittas, precis som git hittar `.git`. Det subsumerar det som `CLAUDE_PROJECT_DIR` var tänkt att lösa (graf i repo-roten, server startad i en underkatalog) utan att vara bunden till en leverantörsspecifik miljövariabel, och det löser samtidigt fallet där grafen ligger i underkatalogen.

**Files:**
- Create: `src/paths.ts`
- Create: `test/paths-smoke.ts`
- Modify: `src/mcp-server.ts:11-20` (`getDatabasePath`, `requireDatabase`), `src/mcp-server.ts:79-88` (`withConnection`)
- Modify: `src/cli.ts:8` (`databasePath`)
- Modify: `package.json` (nytt skript `test:paths`)
- Delete: `test/anders.ts`

**Interfaces:**
- Produces: `graphDatabasePathFor(directory: string): string`, `findGraphDatabase(startDirectory: string): string | undefined`, `searchedDirectories(startDirectory: string): string[]`, konstanterna `GRAPH_DIRECTORY = ".codegraph"` och `GRAPH_FILE = "kuzu"`. Task 2, 5 och 7 använder alla tre funktionerna.

- [ ] **Step 1: Ta bort det trasiga testet**

`test/anders.ts` är en föråldrad kopia av `test/seed-smoke.ts`. Den asserterar en `SeedSummary` med tre fält mot dagens nio, och pekar `databasePath` till `path.join('../.codegraph','kuzu')` som `seedCodebase` resolvar relativt `cwd` — den skriver alltså en databas i repots *föräldrakatalog* och städar aldrig upp den. Den ingår inte i något npm-skript.

```bash
git rm test/anders.ts
```

- [ ] **Step 2: Skriv det failande testet**

Skapa `test/paths-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGraphDatabase, graphDatabasePathFor, searchedDirectories } from "../src/paths.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-paths-"));
const nested = path.join(root, "apps", "app", "src");
await mkdir(nested, { recursive: true });

try {
  // Ingen graf någonstans i kedjan.
  assert.equal(findGraphDatabase(nested), undefined);

  // Graf i repo-roten hittas från en djup underkatalog.
  await mkdir(path.join(root, ".codegraph"), { recursive: true });
  await writeFile(path.join(root, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(root, ".codegraph", "kuzu"));

  // En närmare graf vinner över en i roten.
  const appRoot = path.join(root, "apps", "app");
  await mkdir(path.join(appRoot, ".codegraph"), { recursive: true });
  await writeFile(path.join(appRoot, ".codegraph", "kuzu"), "");
  assert.equal(findGraphDatabase(nested), path.join(appRoot, ".codegraph", "kuzu"));

  // graphDatabasePathFor räknar ut sökvägen utan att kräva att den finns.
  assert.equal(
    graphDatabasePathFor(path.join(root, "packages", "pdf")),
    path.join(root, "packages", "pdf", ".codegraph", "kuzu"),
  );

  // Felmeddelandet ska kunna räkna upp var det letades, rot inkluderad.
  const searched = searchedDirectories(nested);
  assert.ok(searched.includes(nested));
  assert.ok(searched.includes(root));
  assert.equal(searched[0], nested);
  assert.equal(searched.at(-1), path.parse(root).root);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Paths smoke test passed.");
```

- [ ] **Step 3: Kör testet och se att det failar**

Run: `npx tsx test/paths-smoke.ts`
Expected: FAIL — `Cannot find module '../src/paths.js'`

- [ ] **Step 4: Implementera `src/paths.ts`**

```ts
import { existsSync } from "node:fs";
import path from "node:path";

export const GRAPH_DIRECTORY = ".codegraph";
export const GRAPH_FILE = "kuzu";

// Sökvägen en graf SKULLE ha i den här katalogen. Kräver inte att den finns.
export function graphDatabasePathFor(directory: string): string {
  return path.join(path.resolve(directory), GRAPH_DIRECTORY, GRAPH_FILE);
}

// Letar uppåt efter en befintlig graf, som git letar efter .git. Närmast vinner.
// Detta är den enda regeln för var grafen ligger — CLI, seeder och MCP-server
// delar den, annars skriver den ena dit den andra inte läser.
export function findGraphDatabase(startDirectory: string): string | undefined {
  for (const directory of searchedDirectories(startDirectory)) {
    const candidate = graphDatabasePathFor(directory);

    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

// Katalogkedjan från startDirectory upp till filsystemsroten, för felmeddelanden.
export function searchedDirectories(startDirectory: string): string[] {
  const directories: string[] = [];
  let directory = path.resolve(startDirectory);

  while (true) {
    directories.push(directory);
    const parent = path.dirname(directory);

    if (parent === directory) {
      return directories;
    }

    directory = parent;
  }
}
```

- [ ] **Step 5: Kör testet och se att det passerar**

Run: `npx tsx test/paths-smoke.ts`
Expected: PASS — `Paths smoke test passed.`

- [ ] **Step 6: Koppla in `paths.ts` i MCP-servern**

Ersätt `src/mcp-server.ts` rad 11–20 (funktionerna `getDatabasePath` och `requireDatabase`) med:

```ts
function getDatabasePath() {
  const databasePath = findGraphDatabase(process.cwd());

  if (!databasePath) {
    const searched = searchedDirectories(process.cwd())
      .map((directory) => `- ${directory}`)
      .join("\n");
    throw new Error(
      `Ingen graf hittades. Sökte efter .codegraph/kuzu i:\n${searched}\nKör 'codegraph init' i projektets rot.`,
    );
  }

  return databasePath;
}
```

Uppdatera importen på rad 4–7 — `existsSync` behövs inte längre:

```ts
import { Connection, Database } from "kuzu";
import { z } from "zod";
import { findGraphDatabase, searchedDirectories } from "./paths.js";
import { openGraphDatabase, singleResult } from "./schema.js";
```

Ta bort raden `requireDatabase(databasePath);` ur `withConnection` (rad 80) — `getDatabasePath` kastar redan när grafen saknas, och `findGraphDatabase` har verifierat att filen finns.

`process.env.CLAUDE_PROJECT_DIR` ska inte finnas kvar någonstans i filen. Verifiera:

```bash
grep -n "CLAUDE_PROJECT_DIR\|existsSync" src/mcp-server.ts || echo "borta"
```

- [ ] **Step 7: Koppla in `paths.ts` i CLI:t**

I `src/cli.ts`, ersätt rad 8:

```ts
const databasePath = path.join(projectRoot, ".codegraph", "kuzu");
```

med:

```ts
// init skapar alltid grafen i den katalog kommandot körs från — det är den
// explicita installationsgesten. seed återanvänder en befintlig graf var den
// än ligger uppåt, så att seedning från en underkatalog i ett monorepo inte
// skapar en andra, konkurrerande graf.
const initDatabasePath = graphDatabasePathFor(projectRoot);
const seedDatabasePath = findGraphDatabase(projectRoot) ?? initDatabasePath;
```

Lägg till importen överst:

```ts
import { findGraphDatabase, graphDatabasePathFor } from "./paths.js";
```

Uppdatera `seed()` (rad 64–70) så att den tar sökvägen som argument, och låt `init()` skicka in sin:

```ts
async function seed(databasePath: string) {
  await requireTsconfig();
  const summary = await seedCodebase(tsconfigPath, databasePath);
  console.log(
    `Seeded ${summary.files} files, ${summary.types} types, ${summary.functions} functions, and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports). ${summary.calls} calls resolved (${summary.unresolvedCalls} unresolved calls). ${summary.mocks} mocks resolved (${summary.unresolvedMocks} unresolved mocks).`,
  );
  console.log(`Grafen ligger i ${databasePath}`);
}
```

I `init()` byt `await seed();` mot `await seed(initDatabasePath);`, och i `main()` byt `await seed();` mot `await seed(seedDatabasePath);`.

- [ ] **Step 8: Verifiera hela kedjan**

```bash
npm run build
npx tsx test/paths-smoke.ts
npm run test:seed
```
Expected: tsc utan fel, båda testerna PASS.

- [ ] **Step 9: Lägg till testskriptet**

I `package.json`, under `scripts`, efter `"test:seed"`:

```json
"test:paths": "tsx test/paths-smoke.ts",
```

- [ ] **Step 10: Commit**

```bash
git add src/paths.ts test/paths-smoke.ts src/mcp-server.ts src/cli.ts package.json
git rm --cached test/anders.ts 2>/dev/null || true
git commit -m "fix: resolve graph database path by walking up from cwd

CLI, seeder and MCP server each computed the database path differently.
In a monorepo CLAUDE_PROJECT_DIR (repo root) beat the .mcp.json cwd
(apps/app), so the server looked for a graph the CLI had written
elsewhere and reported it as missing. All three now share one rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Flera tsconfig i en graf

**Bakgrund:** Seedern hänger på en enda `tsconfig.json`. I Accounting-repot kom bara `apps/app` med (188 av ~200 filer) medan `packages/pdf` stod utanför trots att appen importerar därifrån. Konsekvensen är inte bara ofullständighet: en `pathQuery` mot en fil i `packages/` svarar "Ingen fil matchar", vilket läses som "filen finns inte" i stället för "filen är inte indexerad".

Fixen är att seeda flera projekt till samma graf och lösa importer mot **unionen** av deras källfiler, inte mot ett projekt i taget.

**Files:**
- Create: `src/config.ts`
- Create: `test/fixtures/monorepo/packages/core/tsconfig.json`, `test/fixtures/monorepo/packages/core/src/core.ts`
- Create: `test/fixtures/monorepo/apps/web/tsconfig.json`, `test/fixtures/monorepo/apps/web/src/web.ts`
- Create: `test/monorepo-smoke.ts`
- Modify: `src/seed.ts:26-44` (signatur och projektinläsning)
- Modify: `src/cli.ts` (`init` skriver config, `seed` läser den)
- Modify: `package.json` (skript `test:monorepo`)

**Interfaces:**
- Consumes: `graphDatabasePathFor`, `findGraphDatabase` från Task 1.
- Produces: `readTsconfigPaths(projectRoot: string): Promise<string[]>` och `writeTsconfigPaths(projectRoot: string, tsconfigPaths: string[]): Promise<void>` i `src/config.ts`. `seedCodebase(tsconfigPaths: string[], databasePath: string): Promise<SeedSummary>` — **signaturen ändras från en sträng till en lista, och `databasePath` blir obligatorisk.** Task 3, 4 och 5 bygger vidare på listformen.

- [ ] **Step 1: Skapa monorepo-fixturen**

`test/fixtures/monorepo/packages/core/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  },
  "include": ["src/**/*.ts"]
}
```

`test/fixtures/monorepo/packages/core/src/core.ts`:

```ts
export function renderPdf(title: string) {
  return `PDF: ${title}`;
}
```

`test/fixtures/monorepo/apps/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true
  },
  "include": ["src/**/*.ts"]
}
```

`test/fixtures/monorepo/apps/web/src/web.ts` — importerar över paketgränsen med en relativ sökväg. `ts-morph` kan resolva den till en källfil, men filen ligger utanför `apps/web`s egen `include`, vilket är precis situationen som gör den osynlig idag:

```ts
import { renderPdf } from "../../../packages/core/src/core.js";

export function handleRequest() {
  return renderPdf("faktura");
}
```

- [ ] **Step 2: Skriv det failande testet**

Skapa `test/monorepo-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeGraphDatabase, openGraphDatabase, singleResult } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixture = path.resolve("test/fixtures/monorepo");
const appTsconfig = path.join(fixture, "apps", "web", "tsconfig.json");
const coreTsconfig = path.join(fixture, "packages", "core", "tsconfig.json");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-monorepo-"));

try {
  // Bara app-projektet: core-filen är inte indexerad, importen räknas som oupplöst.
  const appOnlyPath = path.join(temporaryDirectory, "app-only");
  const appOnly = await seedCodebase([appTsconfig], appOnlyPath);
  assert.equal(appOnly.files, 1);
  assert.equal(appOnly.imports, 0);
  assert.equal(appOnly.unresolvedImports, 1);

  // Båda projekten: core-filen blir en nod och korspaketimporten blir en kant.
  const bothPath = path.join(temporaryDirectory, "both");
  const both = await seedCodebase([appTsconfig, coreTsconfig], bothPath);
  assert.equal(both.files, 2);
  assert.equal(both.imports, 1);
  assert.equal(both.unresolvedImports, 0);

  const { database, connection } = openGraphDatabase(bothPath);
  try {
    const result = singleResult(await connection.query(`
      MATCH (source:File)-[:IMPORTS]->(target:File)
      RETURN source.fileName AS sourceName, target.fileName AS targetName
    `));
    const rows = await result.getAll();
    await result.close();
    assert.deepEqual(rows, [{ sourceName: "web.ts", targetName: "core.ts" }]);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Monorepo smoke test passed.");
```

- [ ] **Step 3: Kör testet och se att det failar**

Run: `npx tsx test/monorepo-smoke.ts`
Expected: FAIL — `seedCodebase` tar en sträng, inte en lista; TypeScript-fel eller `path.resolve` på en array.

- [ ] **Step 4: Gör seedern flerprojekts**

I `src/seed.ts`, ersätt rad 26–39 (signaturen och projektinläsningen) med:

```ts
export async function seedCodebase(
  tsconfigPaths: string[],
  databasePath: string,
): Promise<SeedSummary> {
  if (tsconfigPaths.length === 0) {
    throw new Error("Minst en tsconfig.json måste anges.");
  }

  const resolvedDatabasePath = path.resolve(databasePath);
  const projects = tsconfigPaths.map((tsconfigPath) => {
    const resolvedTsconfigPath = path.resolve(tsconfigPath);
    return {
      project: new Project({ tsConfigFilePath: resolvedTsconfigPath }),
      projectRoot: path.dirname(resolvedTsconfigPath),
    };
  });

  // En fil kan ingå i flera projekt. Dedupliceras på sökväg så att varje fil
  // besöks exakt en gång, annars dubbelräknas dess importer och funktioner.
  const sourceFileByPath = new Map<string, SourceFile>();

  for (const { project, projectRoot } of projects) {
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();

      if (isInHiddenRootDirectory(filePath, projectRoot)) {
        continue;
      }

      if (!sourceFileByPath.has(filePath)) {
        sourceFileByPath.set(filePath, sourceFile);
      }
    }
  }

  const sourceFiles = [...sourceFileByPath.values()];
  // Unionen över alla projekt. Att lösa importer mot den här mängden — och
  // inte mot ett projekt i taget — är hela poängen: det är så en import från
  // apps/web till packages/core blir en kant i stället för en oupplöst räknare.
  const projectFilePaths = new Set(sourceFileByPath.keys());
```

Lägg till `SourceFile` i importen från `ts-morph` på rad 3:

```ts
import { FunctionDeclaration, MethodDeclaration, Project, SourceFile, SyntaxKind, ts } from "ts-morph";
```

Ta bort raden `const resolvedTsconfigPath = path.resolve(tsconfigPath);` och `const projectRoot = ...` som nu ligger i loopen ovan, samt filtreringen på rad 36–38 som ersatts.

- [ ] **Step 5: Rätta mock-passets projektreferenser**

Mock-passet på rad 103–104 använder `project.getCompilerOptions()` från en enda `project`-variabel som inte längre finns. Varje fil måste resolvas med sitt eget projekts inställningar. Ersätt raderna:

```ts
const compilerOptions = project.getCompilerOptions();
const moduleResolutionHost = project.getModuleResolutionHost();
```

med en uppslagning per fil. Lägg till, direkt efter `const projectFilePaths = ...`:

```ts
// Varje fil ska resolvas med sitt eget projekts compiler-options.
const projectByFilePath = new Map<string, (typeof projects)[number]["project"]>();

for (const { project } of projects) {
  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();

    if (!projectByFilePath.has(filePath)) {
      projectByFilePath.set(filePath, project);
    }
  }
}
```

och inuti mock-loopen, före `ts.resolveModuleName`, ersätt användningen:

```ts
const owningProject = projectByFilePath.get(sourceFile.getFilePath());

if (!owningProject) {
  unresolvedMocks += 1;
  continue;
}

const resolution = ts.resolveModuleName(
  moduleSpecifier,
  sourceFile.getFilePath(),
  owningProject.getCompilerOptions(),
  owningProject.getModuleResolutionHost(),
);
const resolvedPath = resolution.resolvedModule
  ? owningProject.getSourceFile(resolution.resolvedModule.resolvedFileName)?.getFilePath()
  : undefined;
```

- [ ] **Step 6: Ta bort `main()` ur seed.ts**

Rad 292–316 (`getTsconfigPath`, `main` och `require.main`-ekvivalenten med `import.meta.url`) är död kod nu när CLI:t är den enda ingången. Ta bort hela blocket från och med `function getTsconfigPath(` till filens slut.

- [ ] **Step 7: Uppdatera det befintliga smoke-testet till listformen**

I `test/seed-smoke.ts` rad 16, byt:

```ts
const summary = await seedCodebase(path.join(fixtureDirectory, "tsconfig.json"), databasePath);
```

till:

```ts
const summary = await seedCodebase([path.join(fixtureDirectory, "tsconfig.json")], databasePath);
```

- [ ] **Step 8: Kör testerna**

Run: `npx tsx test/monorepo-smoke.ts && npm run test:seed && npm run build`
Expected: båda testerna PASS, tsc utan fel.

- [ ] **Step 9: Implementera `src/config.ts`**

```ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { GRAPH_DIRECTORY } from "./paths.js";

interface CodeGraphConfig {
  tsconfigs: string[];
}

function configPathFor(projectRoot: string) {
  return path.join(path.resolve(projectRoot), GRAPH_DIRECTORY, "config.json");
}

// Sökvägarna lagras relativt projektroten så att .codegraph/config.json kan
// checkas in och delas i ett team utan att bära någons hemkatalog.
export async function readTsconfigPaths(projectRoot: string): Promise<string[]> {
  const configPath = configPathFor(projectRoot);

  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as CodeGraphConfig;

    if (!Array.isArray(config.tsconfigs) || config.tsconfigs.length === 0) {
      throw new Error(`${configPath} saknar en icke-tom "tsconfigs"-lista.`);
    }

    return config.tsconfigs.map((entry) => path.resolve(projectRoot, entry));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [path.join(path.resolve(projectRoot), "tsconfig.json")];
    }

    throw error;
  }
}

export async function writeTsconfigPaths(projectRoot: string, tsconfigPaths: string[]) {
  const configPath = configPathFor(projectRoot);
  await mkdir(path.dirname(configPath), { recursive: true });
  const config: CodeGraphConfig = {
    tsconfigs: tsconfigPaths.map((entry) => path.relative(path.resolve(projectRoot), path.resolve(entry))),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}
```

- [ ] **Step 10: Låt CLI:t ta `--tsconfig` flera gånger**

I `src/cli.ts`, lägg till importen:

```ts
import { readTsconfigPaths, writeTsconfigPaths } from "./config.js";
```

Lägg till en flaggparser ovanför `main()`:

```ts
// --tsconfig kan upprepas: codegraph init --tsconfig tsconfig.json --tsconfig packages/pdf/tsconfig.json
function parseTsconfigFlags(argumentsList: string[]): string[] {
  const paths: string[] = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== "--tsconfig") {
      continue;
    }

    const value = argumentsList[index + 1];

    if (!value) {
      throw new Error("--tsconfig kräver en sökväg.");
    }

    paths.push(path.resolve(projectRoot, value));
  }

  return paths;
}
```

Byt ut `requireTsconfig` så att den validerar varje angiven sökväg:

```ts
async function requireTsconfigs(tsconfigPaths: string[]) {
  for (const tsconfigPath of tsconfigPaths) {
    try {
      await access(tsconfigPath);
    } catch {
      throw new Error(`Hittar ingen tsconfig.json på ${tsconfigPath}.`);
    }
  }
}
```

Byt `seed` och `init`:

```ts
async function seed(databasePath: string, tsconfigPaths: string[]) {
  await requireTsconfigs(tsconfigPaths);
  const summary = await seedCodebase(tsconfigPaths, databasePath);
  console.log(
    `Seeded ${summary.files} files, ${summary.types} types, ${summary.functions} functions, and ${summary.imports} imports (${summary.unresolvedImports} unresolved imports). ${summary.calls} calls resolved (${summary.unresolvedCalls} unresolved calls). ${summary.mocks} mocks resolved (${summary.unresolvedMocks} unresolved mocks).`,
  );
  console.log(`Grafen ligger i ${databasePath}`);
}

async function init(tsconfigPaths: string[]) {
  const resolved = tsconfigPaths.length > 0 ? tsconfigPaths : [tsconfigPath];
  await requireTsconfigs(resolved);
  await ensureGitignore();
  await ensureMcpConfiguration();
  await writeTsconfigPaths(projectRoot, resolved);
  await seed(initDatabasePath, resolved);
  console.log(`CodeGraph ar installerat i ${projectRoot}.`);
}
```

och `main()`:

```ts
async function main() {
  const command = process.argv[2];
  const flagged = parseTsconfigFlags(process.argv.slice(3));

  if (command === "init") {
    await init(flagged);
    return;
  }

  if (command === "seed") {
    const tsconfigPaths = flagged.length > 0 ? flagged : await readTsconfigPaths(projectRoot);
    await seed(seedDatabasePath, tsconfigPaths);
    return;
  }

  throw new Error("Använd: codegraph init [--tsconfig <sökväg>]... eller codegraph seed [--tsconfig <sökväg>]...");
}
```

- [ ] **Step 11: Verifiera mot fixturen och det egna repot**

```bash
npm run build
npx tsx test/monorepo-smoke.ts
npm run test:seed
npx tsx src/cli.ts seed --tsconfig ./tsconfig.json
```
Expected: testerna PASS; seedningen av CodeGraph självt rapporterar filer och skriver ut grafens sökväg.

- [ ] **Step 12: Lägg till testskriptet och committa**

I `package.json`: `"test:monorepo": "tsx test/monorepo-smoke.ts",`

```bash
git add src/config.ts src/seed.ts src/cli.ts package.json test/fixtures/monorepo test/monorepo-smoke.ts test/seed-smoke.ts
git commit -m "feat: seed multiple tsconfigs into one graph

Resolving imports against the union of all seeded projects' source files
turns cross-package imports from unresolved counters into real edges.
Previously only the single tsconfig's project was indexed, so files in
sibling packages were absent and queries on them read as 'file not found'
rather than 'file not indexed'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Radintervall och typalias

**Bakgrund:** Största enskilda vinsten enligt utvärderingen, och den saknas helt. Utan radnummer slutar varje grafsvar med att hela filen läses; med `line`/`endLine` blir det ~30 rader i stället för ~400. `ts-morph` ger `getStartLineNumber()` och `getEndLineNumber()` gratis i den loop som redan finns — verifierat mot fixturen: `app.ts:start` rad 9–11, `Application.start` rad 4–6.

Samtidigt fångar `Type` idag bara klasser och interface. Repots `export type`-alias är osynliga, och det är typerna som bär domänen. `sourceFile.getTypeAliases()` är en rad i samma array.

**Files:**
- Modify: `src/schema.ts:16-18` (kolumner på `Type` och `Function`)
- Modify: `src/seed.ts` (typpasset och funktionspasset)
- Modify: `test/fixtures/imports/src/format.ts` (lägg till ett typalias)
- Modify: `test/seed-smoke.ts` (förväntade värden)

**Interfaces:**
- Consumes: `seedCodebase(tsconfigPaths, databasePath)` från Task 2.
- Produces: `Type` och `Function` har `line INT64` och `endLine INT64`. `Type.kind` får värdet `"typeAlias"` utöver `"class"` och `"interface"`. Task 6 läser dessa kolumner.

- [ ] **Step 1: Lägg ett typalias i fixturen**

Lägg till sist i `test/fixtures/imports/src/format.ts`:

```ts
export type FormatterOptions = {
  uppercase: boolean;
};
```

- [ ] **Step 2: Skriv de failande assertionerna**

I `test/seed-smoke.ts`, byt `types: 2` till `types: 3` i `assert.deepEqual(summary, {...})`, och ersätt typ-assertionen (rad 64–67) med en som kräver radintervall:

```ts
    assert.deepEqual(typeRows, [
      { fileName: "app.ts", name: "Application", kind: "class", line: 3, endLine: 7 },
      { fileName: "format.ts", name: "FormatterOptions", kind: "typeAlias", line: 9, endLine: 11 },
      { fileName: "format.ts", name: "Formatter", kind: "interface", line: 1, endLine: 3 },
    ]);
```

Uppdatera frågan strax ovanför (rad 56–60) så att den hämtar kolumnerna:

```ts
    const typeResult = singleResult(await connection.query(`
      MATCH (file:File)-[:DECLARES]->(type:Type)
      RETURN file.fileName AS fileName, type.name AS name, type.kind AS kind,
             type.line AS line, type.endLine AS endLine
      ORDER BY fileName, name
    `));
```

Lägg till en ny assertion för funktionernas radintervall, efter typ-assertionen:

```ts
    const functionResult = singleResult(await connection.query(`
      MATCH (fn:Function)
      RETURN fn.name AS name, fn.kind AS kind, fn.line AS line, fn.endLine AS endLine
      ORDER BY name, line
    `));
    const functionRows = await functionResult.getAll();
    await functionResult.close();

    assert.deepEqual(functionRows, [
      { name: "formatMessage", kind: "function", line: 5, endLine: 7 },
      { name: "start", kind: "method", line: 4, endLine: 6 },
      { name: "start", kind: "function", line: 9, endLine: 11 },
    ]);
```

- [ ] **Step 3: Kör testet och se att det failar**

Run: `npm run test:seed`
Expected: FAIL — `types` är 2 (aliaset saknas) och `line` är `undefined` (kolumnen finns inte).

- [ ] **Step 4: Lägg till kolumnerna i schemat**

I `src/schema.ts`, byt rad 16 och 18:

```ts
  await execute(connection, "CREATE NODE TABLE Type(path STRING, name STRING, kind STRING, line INT64, endLine INT64, PRIMARY KEY (path));");
```

```ts
  await execute(connection, "CREATE NODE TABLE Function(path STRING, name STRING, kind STRING, line INT64, endLine INT64, PRIMARY KEY (path));");
```

- [ ] **Step 5: Skriv radintervall och typalias i seedern**

I `src/seed.ts`, ersätt de förberedda satserna `insertType`, `insertFunction` och `insertMethod` (rad 55–69):

```ts
    const insertType = await connection.prepare(`
      MATCH (file:File {path: $filePath})
      MERGE (type:Type {path: $typePath, name: $name, kind: $kind, line: $line, endLine: $endLine})
      MERGE (file)-[:DECLARES]->(type)
    `);
    const insertFunction = await connection.prepare(`
      MATCH (file:File {path: $filePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine})
      MERGE (file)-[:HAS_FUNCTION]->(fn)
    `);
    const insertMethod = await connection.prepare(`
      MATCH (type:Type {path: $typePath})
      MERGE (fn:Function {path: $fnPath, name: $name, kind: $kind, line: $line, endLine: $endLine})
      MERGE (type)-[:HAS_METHOD]->(fn)
    `);
```

Ersätt typpassets `declarations`-array (rad 142–145) så att den bär deklarationsnoden och typalias:

```ts
      const declarations = [
        ...sourceFile.getClasses().map((declaration) => ({ declaration, name: declaration.getName(), kind: "class" })),
        ...sourceFile.getInterfaces().map((declaration) => ({ declaration, name: declaration.getName(), kind: "interface" })),
        ...sourceFile.getTypeAliases().map((declaration) => ({ declaration, name: declaration.getName(), kind: "typeAlias" })),
      ];

      for (const { declaration, name, kind } of declarations) {
        if (!name) {
          continue;
        }

        const result = singleResult(await connection.execute(insertType, {
          filePath,
          typePath: `${filePath}:${name}`,
          name,
          kind,
          line: declaration.getStartLineNumber(),
          endLine: declaration.getEndLineNumber(),
        }));
        await result.close();
        types += 1;
      }
```

I funktionspasset, lägg till raderna i båda `execute`-anropen:

```ts
        const result = singleResult(await connection.execute(insertFunction, {
          filePath,
          fnPath,
          name,
          kind: "function",
          line: declaration.getStartLineNumber(),
          endLine: declaration.getEndLineNumber(),
        }));
```

```ts
          const result = singleResult(await connection.execute(insertMethod, {
            typePath,
            fnPath,
            name,
            kind: "method",
            line: method.getStartLineNumber(),
            endLine: method.getEndLineNumber(),
          }));
```

- [ ] **Step 6: Kör testerna**

Run: `npm run build && npm run test:seed && npx tsx test/monorepo-smoke.ts`
Expected: alla PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/seed.ts test/seed-smoke.ts test/fixtures/imports/src/format.ts
git commit -m "feat: record line ranges on Type and Function, index type aliases

Line ranges are what let a graph answer end a question instead of
starting a file read. Type aliases were invisible even though they carry
most of the domain vocabulary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Ärliga tomma svar

**Bakgrund:** Systemet har tre separata "tom lista"-fällor som alla returnerar samma form som ett äkta noll: en mock av ett externt paket faller bort tyst, en fil utanför de seedade projekten ger "Ingen fil matchar", och ett anrop till en arrow-const blir ingen kant. Det är samma designbrist tre gånger — **ett resultat som inte kunde upplösas är omöjligt att skilja från ett äkta noll.**

Seedern räknar redan `unresolvedImports`, `unresolvedMocks` och `unresolvedCalls`, men kastar bort siffrorna efter utskriften. Fixen är att persistera dem per nod så att frågelagret kan svara "den här filen mockar 0 interna moduler, men 2 mockar kunde inte upplösas".

Det här är också varför `CALLS` inte exponeras som ett eget verktyg: "vem anropar den här funktionen" med tomt svar är den mest handlingsutlösande tomma listan som finns — en agent som tror den är sann tar bort funktionen.

**Files:**
- Modify: `src/schema.ts:13,18` (kolumner på `File` och `Function`)
- Modify: `src/seed.ts` (räkna per nod, skriv med `SET` efter passen)
- Modify: `test/seed-smoke.ts`

**Interfaces:**
- Consumes: schemat från Task 3.
- Produces: `File.unresolvedImports INT64`, `File.unresolvedMocks INT64`, `Function.unresolvedCalls INT64`. Task 6 returnerar dem i varje svar.

- [ ] **Step 1: Skriv de failande assertionerna**

I `test/seed-smoke.ts`, lägg till efter funktions-assertionen:

```ts
    const unresolvedResult = singleResult(await connection.query(`
      MATCH (file:File)
      RETURN file.fileName AS fileName,
             file.unresolvedImports AS unresolvedImports,
             file.unresolvedMocks AS unresolvedMocks
      ORDER BY fileName
    `));
    const unresolvedRows = await unresolvedResult.getAll();
    await unresolvedResult.close();

    // index.ts importerar node:path, som ligger utanför projektet.
    assert.deepEqual(unresolvedRows, [
      { fileName: "app.ts", unresolvedImports: 0, unresolvedMocks: 0 },
      { fileName: "format.ts", unresolvedImports: 0, unresolvedMocks: 0 },
      { fileName: "index.ts", unresolvedImports: 1, unresolvedMocks: 0 },
    ]);
```

- [ ] **Step 2: Kör testet och se att det failar**

Run: `npm run test:seed`
Expected: FAIL — `unresolvedImports` är `undefined`.

- [ ] **Step 3: Lägg till kolumnerna**

I `src/schema.ts`, byt rad 13 och 18:

```ts
  await execute(connection, "CREATE NODE TABLE File(path STRING, fileName STRING, unresolvedImports INT64, unresolvedMocks INT64, PRIMARY KEY (path));");
```

```ts
  await execute(connection, "CREATE NODE TABLE Function(path STRING, name STRING, kind STRING, line INT64, endLine INT64, unresolvedCalls INT64, PRIMARY KEY (path));");
```

- [ ] **Step 4: Räkna per nod och skriv efter passen**

I `src/seed.ts`, lägg till två förberedda satser bland de övriga:

```ts
    const setFileUnresolved = await connection.prepare(`
      MATCH (file:File {path: $path})
      SET file.unresolvedImports = $unresolvedImports, file.unresolvedMocks = $unresolvedMocks
    `);
    const setFunctionUnresolved = await connection.prepare(`
      MATCH (fn:Function {path: $path})
      SET fn.unresolvedCalls = $unresolvedCalls
    `);
```

Initiera `File`-noder med nollor — `insertFile` byts till:

```ts
    const insertFile = await connection.prepare(
      "MERGE (file:File {path: $path, fileName: $fileName, unresolvedImports: 0, unresolvedMocks: 0})",
    );
```

och `insertFunction` / `insertMethod` får `unresolvedCalls: 0` i sina `MERGE`-mönster, på samma sätt som `line`/`endLine` i Task 3.

Deklarera räknarkartorna före importpasset:

```ts
    // Per nod, inte bara totalt: frågelagret måste kunna säga "den här filen
    // har 2 oupplösta importer" så att en tom lista går att skilja från
    // en lista som inte kunde byggas.
    const unresolvedImportsByFile = new Map<string, number>();
    const unresolvedMocksByFile = new Map<string, number>();
    const unresolvedCallsByFunction = new Map<string, number>();
```

I importpassets `if (!targetFile || ...)`-gren, före `continue`:

```ts
          const filePath = sourceFile.getFilePath();
          unresolvedImportsByFile.set(filePath, (unresolvedImportsByFile.get(filePath) ?? 0) + 1);
          unresolvedImports += 1;
          continue;
```

Motsvarande i mock-passets båda `unresolvedMocks += 1`-grenar med `unresolvedMocksByFile`, och i anropspassets `if (!calleePath)`-gren med `unresolvedCallsByFunction` nycklad på `callerPath`.

Efter anropspasset, före `return`:

```ts
    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      const result = singleResult(await connection.execute(setFileUnresolved, {
        path: filePath,
        unresolvedImports: unresolvedImportsByFile.get(filePath) ?? 0,
        unresolvedMocks: unresolvedMocksByFile.get(filePath) ?? 0,
      }));
      await result.close();
    }

    for (const functionPath of functionPathByDeclaration.values()) {
      const result = singleResult(await connection.execute(setFunctionUnresolved, {
        path: functionPath,
        unresolvedCalls: unresolvedCallsByFunction.get(functionPath) ?? 0,
      }));
      await result.close();
    }
```

- [ ] **Step 5: Kör testerna**

Run: `npm run build && npm run test:seed && npx tsx test/monorepo-smoke.ts`
Expected: alla PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schema.ts src/seed.ts test/seed-smoke.ts
git commit -m "feat: persist per-node unresolved counts

An empty result and an unresolvable one had the same shape. Storing what
each file and function could not resolve lets the query layer distinguish
'mocks nothing' from 'mocks only external packages'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Färskhetssignal (`GraphMeta` + `graph_status`)

**Bakgrund:** Avgör om verktyget används alls — en graf som inte går att lita på grepas förbi ändå, och har då kostat utan att spara. Ett självsäkert fel svar är dyrare än ett långsamt. Efter Task 3 bär svaren radnummer, som åldras onådigt: en enda infogad rad ovanför gör svaret tyst fel. Den här tasken måste därför ligga före Task 6, som är där radintervallen först når en agent.

`graph_status` rapporterar också **vilken databassökväg som lösts upp**, vilket är det som gjorde monorepo-felet i Task 1 svårt att diagnosticera.

**Files:**
- Create: `src/graph-meta.ts`
- Create: `test/graph-meta-smoke.ts`
- Modify: `src/schema.ts` (tabellen `GraphMeta`)
- Modify: `src/seed.ts` (skriv metadata sist)
- Modify: `src/mcp-server.ts` (verktyget `graph_status`)
- Modify: `package.json`

**Interfaces:**
- Consumes: `SeedSummary` från Task 2, `findGraphDatabase` från Task 1.
- Produces: `writeGraphMeta(connection, meta)`, `readGraphMeta(connection): Promise<GraphMeta>`, `describeFreshness(meta, projectRoot): Promise<FreshnessReport>`.

- [ ] **Step 1: Skriv det failande testet**

Skapa `test/graph-meta-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGraphMeta } from "../src/graph-meta.js";
import { closeGraphDatabase, openGraphDatabase } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-meta-"));
const databasePath = path.join(temporaryDirectory, "kuzu");
const tsconfigPath = path.join(fixtureDirectory, "tsconfig.json");

try {
  const before = Date.now();
  const summary = await seedCodebase([tsconfigPath], databasePath);
  const { database, connection } = openGraphDatabase(databasePath);

  try {
    const meta = await readGraphMeta(connection);

    assert.deepEqual(meta.tsconfigs, [tsconfigPath]);
    assert.deepEqual(meta.counts, summary);
    assert.ok(Date.parse(meta.seededAt) >= before - 1000, "seededAt ska ligga vid seedningstillfället");
    assert.equal(typeof meta.commit, "string");
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Graph meta smoke test passed.");
```

- [ ] **Step 2: Kör testet och se att det failar**

Run: `npx tsx test/graph-meta-smoke.ts`
Expected: FAIL — `Cannot find module '../src/graph-meta.js'`

- [ ] **Step 3: Lägg till tabellen**

I `src/schema.ts`, efter `CALLS`-raden:

```ts
  await execute(connection, "CREATE NODE TABLE GraphMeta(key STRING, value STRING, PRIMARY KEY (key));");
```

- [ ] **Step 4: Implementera `src/graph-meta.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Connection } from "kuzu";
import { singleResult } from "./schema.js";
import type { SeedSummary } from "./seed.js";

const run = promisify(execFile);

export interface GraphMeta {
  seededAt: string;
  commit: string;
  tsconfigs: string[];
  counts: SeedSummary;
}

export interface FreshnessReport extends GraphMeta {
  databasePath: string;
  ageMinutes: number;
  currentCommit: string;
  changedFiles: string[];
  stale: boolean;
}

// Tomt värde när katalogen inte är ett git-repo — färskhet ska degradera,
// inte krascha.
async function git(projectRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd: projectRoot });
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function currentCommit(projectRoot: string): Promise<string> {
  return git(projectRoot, ["rev-parse", "HEAD"]);
}

export async function writeGraphMeta(connection: Connection, meta: GraphMeta) {
  const statement = await connection.prepare(
    "MERGE (m:GraphMeta {key: $key}) SET m.value = $value",
  );

  const entries: [string, string][] = [
    ["seededAt", meta.seededAt],
    ["commit", meta.commit],
    ["tsconfigs", JSON.stringify(meta.tsconfigs)],
    ["counts", JSON.stringify(meta.counts)],
  ];

  for (const [key, value] of entries) {
    const result = singleResult(await connection.execute(statement, { key, value }));
    await result.close();
  }
}

export async function readGraphMeta(connection: Connection): Promise<GraphMeta> {
  const result = singleResult(await connection.query("MATCH (m:GraphMeta) RETURN m.key AS key, m.value AS value"));
  const rows = await result.getAll();
  await result.close();

  const values = new Map(rows.map((row) => [row.key as string, row.value as string]));

  return {
    seededAt: values.get("seededAt") ?? "",
    commit: values.get("commit") ?? "",
    tsconfigs: JSON.parse(values.get("tsconfigs") ?? "[]") as string[],
    counts: JSON.parse(values.get("counts") ?? "{}") as SeedSummary,
  };
}

export async function describeFreshness(
  connection: Connection,
  databasePath: string,
  projectRoot: string,
): Promise<FreshnessReport> {
  const meta = await readGraphMeta(connection);
  const now = await currentCommit(projectRoot);

  // Ändrade filer sedan seedningen: både committade ändringar och working tree.
  const committed = meta.commit && now && meta.commit !== now
    ? await git(projectRoot, ["diff", "--name-only", meta.commit, now])
    : "";
  const working = await git(projectRoot, ["status", "--porcelain"]);
  const changedFiles = [
    ...committed.split("\n").filter(Boolean),
    ...working.split("\n").filter(Boolean).map((line) => line.slice(3)),
  ];
  const unique = [...new Set(changedFiles)].filter((file) => /\.tsx?$/.test(file)).sort();

  const seededAtMs = Date.parse(meta.seededAt);

  return {
    ...meta,
    databasePath,
    ageMinutes: Number.isNaN(seededAtMs) ? -1 : Math.round((Date.now() - seededAtMs) / 60000),
    currentCommit: now,
    changedFiles: unique,
    stale: unique.length > 0,
  };
}
```

- [ ] **Step 5: Skriv metadata i seedern**

I `src/seed.ts`, lägg till importen:

```ts
import { currentCommit, writeGraphMeta } from "./graph-meta.js";
```

Ersätt `return { files: ..., ... };` med:

```ts
    const summary: SeedSummary = {
      files: sourceFiles.length,
      imports,
      unresolvedImports,
      mocks,
      unresolvedMocks,
      types,
      functions,
      calls,
      unresolvedCalls,
    };

    await writeGraphMeta(connection, {
      seededAt: new Date().toISOString(),
      commit: await currentCommit(path.dirname(resolvedDatabasePath)),
      tsconfigs: tsconfigPaths.map((entry) => path.resolve(entry)),
      counts: summary,
    });

    return summary;
```

- [ ] **Step 6: Kör testet och se att det passerar**

Run: `npx tsx test/graph-meta-smoke.ts && npm run build && npm run test:seed`
Expected: alla PASS.

- [ ] **Step 7: Exponera `graph_status`**

I `src/mcp-server.ts`, lägg till importen `import { describeFreshness } from "./graph-meta.js";` och registrera verktyget:

```ts
server.registerTool(
  "graph_status",
  {
    description:
      "Returnerar grafens färskhet: när den seedades, mot vilken commit, vilka tsconfig som ingick, hur många TypeScript-filer som ändrats sedan dess, och var databasen ligger. Anropa detta innan du litar på ett radintervall från grafen.",
    inputSchema: {},
  },
  async () =>
    withConnection(getDatabasePath(), async (connection) => {
      const databasePath = getDatabasePath();
      const report = await describeFreshness(connection, databasePath, path.dirname(path.dirname(databasePath)));
      return textResult(JSON.stringify(report, null, 2));
    }),
);
```

- [ ] **Step 8: Verifiera verktyget manuellt**

```bash
npm run build
npx tsx src/cli.ts seed --tsconfig ./tsconfig.json
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"graph_status","arguments":{}}}' \
  | npx tsx src/mcp-server.ts 2>/dev/null
```
Expected: ett JSON-svar där `databasePath` pekar på repots `.codegraph/kuzu`, `stale` är `false` direkt efter seedning, och `counts.files` matchar seedningens utskrift.

- [ ] **Step 9: Lägg till testskript och committa**

I `package.json`: `"test:meta": "tsx test/graph-meta-smoke.ts",`

```bash
git add src/graph-meta.ts src/schema.ts src/seed.ts src/mcp-server.ts test/graph-meta-smoke.ts package.json
git commit -m "feat: add graph_status freshness signal

Line ranges make answers precise and therefore dangerous when the graph
is old: a path survives an inserted line, a line number does not. This
lands before the new tools expose ranges to an agent. The report also
names the resolved database path, which is what made the monorepo path
mismatch hard to diagnose.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `find_symbol` + `neighbors` ersätter de fyra verktygen

**Bakgrund:** De fyra nuvarande verktygen är fyra nästan identiska wrappers kring samma `resolveFileQuery`, parametriserade på två axlar (relation, riktning). Varje verktygsschema ligger permanent i agentens kontext, och den nuvarande formen skalar linjärt med antalet kanttyper — `CALLS`, `DECLARES`, `HAS_FUNCTION` och `HAS_METHOD` skulle betyda åtta verktyg till.

Viktigare: kostnadsenheten är modellvarv, inte millisekunder. Ett verktyg som tar en *lista* sökvägar och returnerar en delgraf med radintervall besvarar på ett varv vad fyra smala verktyg behöver fyra varv till.

`CALLS` exponeras här, aldrig som ett eget verktyg, och alltid tillsammans med `unresolvedCalls` från Task 4.

Verifierat att Kuzu klarar det som behövs: `list_contains($paths, f.path)` med en array-parameter fungerar, liksom variabellånga sökvägar `[:CALLS*1..3]`.

**Files:**
- Modify: `src/mcp-server.ts` (ersätt rad 22–143)
- Create: `test/tools-smoke.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: alla kolumner från Task 3 och 4, `graph_status` från Task 5.
- Produces: MCP-verktygen `find_symbol`, `neighbors`, `graph_status`. De fyra `get_file_*`-verktygen tas bort.

- [ ] **Step 1: Skriv det failande testet**

Skapa `test/tools-smoke.ts`. Det testar frågefunktionerna direkt, inte över stdio:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSymbol, queryNeighbors } from "../src/mcp-server.js";
import { closeGraphDatabase, openGraphDatabase } from "../src/schema.js";
import { seedCodebase } from "../src/seed.js";

const fixtureDirectory = path.resolve("test/fixtures/imports");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codegraph-tools-"));
const databasePath = path.join(temporaryDirectory, "kuzu");

try {
  await seedCodebase([path.join(fixtureDirectory, "tsconfig.json")], databasePath);
  const { database, connection } = openGraphDatabase(databasePath);

  try {
    const symbols = await findSymbol(connection, "formatMessage");
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "formatMessage");
    assert.equal(symbols[0].nodeType, "Function");
    assert.equal(symbols[0].line, 5);
    assert.equal(symbols[0].endLine, 7);

    // Anropare av formatMessage: både metoden och den fristående funktionen.
    const callers = await queryNeighbors(connection, {
      paths: [symbols[0].path],
      edges: ["CALLS"],
      direction: "in",
      depth: 1,
    });
    assert.deepEqual(callers.nodes.map((node) => node.name).sort(), ["start", "start"]);
    assert.ok(callers.nodes.every((node) => typeof node.line === "number"));

    // Filgrannar i båda riktningarna på ett anrop.
    const appPath = symbols[0].path.split(":")[0].replace("format.ts", "app.ts");
    const around = await queryNeighbors(connection, {
      paths: [appPath],
      edges: ["IMPORTS"],
      direction: "both",
      depth: 1,
    });
    assert.deepEqual(
      around.nodes.map((node) => path.basename(node.path)).sort(),
      ["format.ts", "index.ts"],
    );

    // Ärligt tomt: index.ts mockar inget internt, men rapporterar sina oupplösta.
    const indexPath = appPath.replace("app.ts", "index.ts");
    const mocks = await queryNeighbors(connection, {
      paths: [indexPath],
      edges: ["MOCKS"],
      direction: "out",
      depth: 1,
    });
    assert.deepEqual(mocks.nodes, []);
    assert.equal(mocks.unresolved[indexPath].unresolvedImports, 1);
  } finally {
    await closeGraphDatabase(database, connection);
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

console.log("Tools smoke test passed.");
```

- [ ] **Step 2: Kör testet och se att det failar**

Run: `npx tsx test/tools-smoke.ts`
Expected: FAIL — `findSymbol` och `queryNeighbors` exporteras inte.

- [ ] **Step 3: Ersätt frågelagret**

I `src/mcp-server.ts`, ta bort `findMatchingFiles`, `findRelatedFiles` och `resolveFileQuery` (rad 22–77) samt alla fyra `server.registerTool`-anrop för `get_file_*` (rad 97–143). Lägg in i stället:

```ts
const NODE_TABLES = ["File", "Type", "Function"] as const;
const EDGE_TYPES = ["IMPORTS", "MOCKS", "CALLS", "DECLARES", "HAS_FUNCTION", "HAS_METHOD"] as const;
type EdgeType = (typeof EDGE_TYPES)[number];

export interface SymbolMatch {
  nodeType: (typeof NODE_TABLES)[number];
  path: string;
  name: string;
  kind: string;
  line: number | null;
  endLine: number | null;
}

export interface NeighborQuery {
  paths: string[];
  edges: EdgeType[];
  direction: "out" | "in" | "both";
  depth: number;
}

export interface NeighborResult {
  nodes: SymbolMatch[];
  unresolved: Record<string, { unresolvedImports: number; unresolvedMocks: number; unresolvedCalls: number }>;
}

async function rows(connection: Connection, statement: string, parameters: Record<string, unknown>) {
  const prepared = await connection.prepare(statement);
  const result = singleResult(await connection.execute(prepared, parameters));
  const all = await result.getAll();
  await result.close();
  return all;
}

// Söker på både namn och sökväg över alla tre nodtyper. File saknar name/kind/line
// och normaliseras därför till fileName respektive null.
export async function findSymbol(connection: Connection, query: string): Promise<SymbolMatch[]> {
  const matches: SymbolMatch[] = [];

  const fileRows = await rows(
    connection,
    `MATCH (n:File) WHERE n.path CONTAINS $query OR n.fileName CONTAINS $query
     RETURN n.path AS path, n.fileName AS name ORDER BY path`,
    { query },
  );
  for (const row of fileRows) {
    matches.push({ nodeType: "File", path: row.path as string, name: row.name as string, kind: "file", line: null, endLine: null });
  }

  for (const table of ["Type", "Function"] as const) {
    const nodeRows = await rows(
      connection,
      `MATCH (n:${table}) WHERE n.path CONTAINS $query OR n.name CONTAINS $query
       RETURN n.path AS path, n.name AS name, n.kind AS kind, n.line AS line, n.endLine AS endLine
       ORDER BY path`,
      { query },
    );
    for (const row of nodeRows) {
      matches.push({
        nodeType: table,
        path: row.path as string,
        name: row.name as string,
        kind: row.kind as string,
        line: row.line as number,
        endLine: row.endLine as number,
      });
    }
  }

  return matches;
}

// Kant- och riktningsnamn interpoleras, men kommer uteslutande från EDGE_TYPES
// och en Zod-enum i verktygsschemat — aldrig från ett fritt strängfält.
// Sökvägslistan binds som parameter.
export async function queryNeighbors(connection: Connection, query: NeighborQuery): Promise<NeighborResult> {
  const seen = new Map<string, SymbolMatch>();
  const depth = Math.min(Math.max(query.depth, 1), 3);

  for (const edge of query.edges) {
    if (!EDGE_TYPES.includes(edge)) {
      throw new Error(`Okänd kanttyp: ${edge}`);
    }

    const patterns =
      query.direction === "both"
        ? [`-[:${edge}*1..${depth}]->`, `<-[:${edge}*1..${depth}]-`]
        : query.direction === "out"
          ? [`-[:${edge}*1..${depth}]->`]
          : [`<-[:${edge}*1..${depth}]-`];

    for (const pattern of patterns) {
      for (const table of NODE_TABLES) {
        const nameExpression = table === "File" ? "target.fileName" : "target.name";
        const kindExpression = table === "File" ? "'file'" : "target.kind";
        const lineExpression = table === "File" ? "NULL" : "target.line";
        const endLineExpression = table === "File" ? "NULL" : "target.endLine";

        let found: Record<string, unknown>[];
        try {
          found = await rows(
            connection,
            `MATCH (source)${pattern}(target:${table})
             WHERE list_contains($paths, source.path)
             RETURN DISTINCT target.path AS path, ${nameExpression} AS name, ${kindExpression} AS kind,
                    ${lineExpression} AS line, ${endLineExpression} AS endLine
             ORDER BY path`,
            { paths: query.paths },
          );
        } catch {
          // Kanttypen kan inte gå till den här nodtabellen; hoppa över.
          continue;
        }

        for (const row of found) {
          const key = `${table}:${row.path as string}`;
          if (!seen.has(key)) {
            seen.set(key, {
              nodeType: table,
              path: row.path as string,
              name: row.name as string,
              kind: row.kind as string,
              line: (row.line as number | null) ?? null,
              endLine: (row.endLine as number | null) ?? null,
            });
          }
        }
      }
    }
  }

  // Vad frågans utgångsnoder INTE kunde upplösa. Utan detta är en tom
  // nodlista omöjlig att skilja från en lista som inte gick att bygga.
  const unresolved: NeighborResult["unresolved"] = {};

  const fileCounts = await rows(
    connection,
    `MATCH (f:File) WHERE list_contains($paths, f.path)
     RETURN f.path AS path, f.unresolvedImports AS imports, f.unresolvedMocks AS mocks`,
    { paths: query.paths },
  );
  for (const row of fileCounts) {
    unresolved[row.path as string] = {
      unresolvedImports: row.imports as number,
      unresolvedMocks: row.mocks as number,
      unresolvedCalls: 0,
    };
  }

  const functionCounts = await rows(
    connection,
    `MATCH (fn:Function) WHERE list_contains($paths, fn.path)
     RETURN fn.path AS path, fn.unresolvedCalls AS calls`,
    { paths: query.paths },
  );
  for (const row of functionCounts) {
    unresolved[row.path as string] = {
      unresolvedImports: 0,
      unresolvedMocks: 0,
      unresolvedCalls: row.calls as number,
    };
  }

  return { nodes: [...seen.values()], unresolved };
}
```

- [ ] **Step 4: Registrera de två verktygen**

```ts
server.registerTool(
  "find_symbol",
  {
    description:
      "Hittar filer, typer och funktioner vars namn eller sökväg innehåller söksträngen. Returnerar sökväg och radintervall, så att du kan läsa exakt rätt rader i stället för hela filen. Börja här i stället för att grepa efter ett namn.",
    inputSchema: { query: z.string().min(1) },
  },
  async ({ query }) =>
    withConnection(getDatabasePath(), async (connection) => {
      const matches = await findSymbol(connection, query);

      if (matches.length === 0) {
        return textResult(
          `Inget matchar "${query}". Grafen innehåller bara de tsconfig-projekt som seedades — kör graph_status för att se vilka.`,
        );
      }

      return textResult(JSON.stringify(matches, null, 2));
    }),
);

server.registerTool(
  "neighbors",
  {
    description:
      "Expanderar en eller flera noder längs valda kanttyper och returnerar grannarna med radintervall. edges: IMPORTS, MOCKS, CALLS, DECLARES, HAS_FUNCTION, HAS_METHOD. direction 'in' besvarar 'vem anropar/importerar/mockar detta'. Svaret innehåller alltid unresolved-räknare: en tom nodlista med unresolved > 0 betyder att grafen inte kunde upplösa relationen, inte att den saknas.",
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(50),
      edges: z.array(z.enum(EDGE_TYPES)).min(1),
      direction: z.enum(["out", "in", "both"]).default("out"),
      depth: z.number().int().min(1).max(3).default(1),
    },
  },
  async ({ paths, edges, direction, depth }) =>
    withConnection(getDatabasePath(), async (connection) => {
      const result = await queryNeighbors(connection, { paths, edges, direction, depth });
      return textResult(JSON.stringify(result, null, 2));
    }),
);
```

- [ ] **Step 5: Gör `main()` villkorlig**

Testet importerar `src/mcp-server.ts`, som annars startar stdio-transporten vid import. Byt slutet av filen:

```ts
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codegraph MCP-server startad over stdio.");
}

// Starta bara transporten när filen körs som program, inte när ett test importerar den.
if (process.argv[1] && process.argv[1].endsWith("mcp-server.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Kör testerna**

Run: `npm run build && npx tsx test/tools-smoke.ts && npm run test:seed && npx tsx test/monorepo-smoke.ts && npx tsx test/graph-meta-smoke.ts`
Expected: alla PASS.

- [ ] **Step 7: Verifiera verktygslistan över stdio**

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npx tsx src/mcp-server.ts 2>/dev/null | tail -1
```
Expected: exakt tre verktyg — `graph_status`, `find_symbol`, `neighbors`. Inget `get_file_*`.

- [ ] **Step 8: Uppdatera README**

I `README.md`, ersätt stycket som börjar `Servern exponerar fyra skrivskyddade verktyg:` och dess punktlista med:

```markdown
Servern exponerar tre skrivskyddade verktyg:

- `graph_status`: när grafen seedades, mot vilken commit, vilka tsconfig som ingick, och hur många TypeScript-filer som ändrats sedan dess. Anropa detta innan du litar på ett radintervall.
- `find_symbol`: hittar filer, typer och funktioner på namn eller sökvägsdel, och returnerar radintervall.
- `neighbors`: expanderar noder längs `IMPORTS`, `MOCKS`, `CALLS`, `DECLARES`, `HAS_FUNCTION` eller `HAS_METHOD`, i valfri riktning och till djup 1–3.

Varje `neighbors`-svar bär `unresolved`-räknare. En tom nodlista med `unresolved > 0` betyder att grafen inte kunde upplösa relationen — inte att den saknas.
```

- [ ] **Step 9: Lägg till testskript och committa**

I `package.json`: `"test:tools": "tsx test/tools-smoke.ts",`

```bash
git add src/mcp-server.ts test/tools-smoke.ts package.json README.md
git commit -m "feat: replace four narrow tools with find_symbol and neighbors

The four get_file_* tools were wrappers around one function parameterized
on relation and direction, and adding CALLS would have meant four more.
neighbors takes a list of paths and a depth, so one model turn answers what
previously took four. Every response carries unresolved counts, so CALLS can
be exposed without an empty list reading as 'nobody calls this'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Varm databasanslutning med omöppning

**Bakgrund:** `withConnection` gör `new Database()` → fråga → `close()` vid varje verktygsanrop. Mätt: 36–64 ms per anrop mot 0,5 ms med en varm anslutning — 70x.

**Men den naiva versionen är en tyst datafel-bugg, uppmätt och inte antagen.** I ett experiment mot Kuzu 0.11.3 höll process A en öppen anslutning medan seedern raderade och byggde om databasfilen. A fortsatte svara med den **gamla** grafen utan att kasta fel, medan en ny läsare såg rätt data. Samma experiment visade att seedern *kan* skriva medan servern är öppen — Kuzu tar inget exklusivt lås — så det finns inget hinder mot en varm anslutning, den måste bara upptäcka bytet.

Detektionen är `stat` på databasfilen: seedern skapar en ny fil, så både inod och mtime ändras. En `stat` kostar mikrosekunder mot 37 ms för en öppning.

**Files:**
- Modify: `src/mcp-server.ts` (`withConnection`)
- Modify: `src/seed.ts` (städa `.wal`)
- Create: `test/warm-connection-smoke.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `findGraphDatabase` från Task 1, frågefunktionerna från Task 6.
- Produces: `withConnection` beter sig oförändrat utåt.

- [ ] **Step 1: Skriv det failande testet**

Skapa `test/warm-connection-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeCachedConnection, withConnection } from "../src/mcp-server.js";
import { findSymbol } from "../src/mcp-server.js";
import { seedCodebase } from "../src/seed.js";

const root = await mkdtemp(path.join(os.tmpdir(), "codegraph-warm-"));
const source = path.join(root, "src");
await mkdir(source, { recursive: true });
await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
  compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", strict: true },
  include: ["src/**/*.ts"],
}));
const databasePath = path.join(root, ".codegraph", "kuzu");
const tsconfigPath = path.join(root, "tsconfig.json");

try {
  await writeFile(path.join(source, "a.ts"), "export function before() { return 1; }\n");
  await seedCodebase([tsconfigPath], databasePath);

  const first = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.equal(first.length, 1, "ska hitta before() efter första seedningen");

  // Andra anropet ska träffa den varma anslutningen.
  const cached = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.equal(cached.length, 1);

  // Seeda om med annat innehåll. En varm anslutning utan detektion
  // fortsätter servera den gamla grafen här — tyst.
  await writeFile(path.join(source, "a.ts"), "export function after() { return 2; }\n");
  await seedCodebase([tsconfigPath], databasePath);

  const stale = await withConnection(databasePath, (connection) => findSymbol(connection, "before"));
  assert.deepEqual(stale, [], "before() ska vara borta efter omseedning");

  const fresh = await withConnection(databasePath, (connection) => findSymbol(connection, "after"));
  assert.equal(fresh.length, 1, "after() ska finnas efter omseedning");
} finally {
  await closeCachedConnection();
  await rm(root, { recursive: true, force: true });
}

console.log("Warm connection smoke test passed.");
```

- [ ] **Step 2: Kör testet och se att det failar**

Run: `npx tsx test/warm-connection-smoke.ts`
Expected: FAIL — `closeCachedConnection` och `withConnection` exporteras inte.

- [ ] **Step 3: Implementera cachen**

I `src/mcp-server.ts`, ersätt `withConnection` och `closeDatabase` (rad 79–93) med:

```ts
interface CachedConnection {
  databasePath: string;
  inode: number;
  modifiedMs: number;
  database: Database;
  connection: Connection;
}

let cached: CachedConnection | undefined;

// Att öppna en 26 MB Kuzu-fil kostar ~37 ms; en stat kostar mikrosekunder.
// Kuzu tar inget exklusivt lås, så seedern kan skriva medan servern lever —
// men en öppen anslutning fortsätter då servera den GAMLA grafen utan att
// kasta fel. Inod och mtime är det som avslöjar att seedern bytt fil.
export async function withConnection<T>(
  databasePath: string,
  run: (connection: Connection) => Promise<T>,
): Promise<T> {
  const stats = statSync(databasePath);

  if (
    cached &&
    cached.databasePath === databasePath &&
    cached.inode === stats.ino &&
    cached.modifiedMs === stats.mtimeMs
  ) {
    return run(cached.connection);
  }

  await closeCachedConnection();
  const { database, connection } = openGraphDatabase(databasePath);
  cached = { databasePath, inode: stats.ino, modifiedMs: stats.mtimeMs, database, connection };

  return run(connection);
}

export async function closeCachedConnection() {
  if (!cached) {
    return;
  }

  const { database, connection } = cached;
  cached = undefined;
  await connection.close();
  await database.close();
}
```

Lägg till `statSync` i importen:

```ts
import { statSync } from "node:fs";
```

- [ ] **Step 4: Städa WAL-filen i seedern**

Kuzu skriver en `<databas>.wal` bredvid databasfilen och tar bort den vid ren stängning. Om en serverprocess dödas mitt i ett anrop blir filen kvar, och seedern raderar bara själva databasfilen — då ligger en WAL från en annan databas kvar bredvid en nyseedad fil. I `src/seed.ts`, ersätt raden:

```ts
  await rm(resolvedDatabasePath, { force: true, recursive: true });
```

med:

```ts
  await rm(resolvedDatabasePath, { force: true, recursive: true });
  await rm(`${resolvedDatabasePath}.wal`, { force: true });
```

- [ ] **Step 5: Stäng anslutningen vid avslut**

I `main()` i `src/mcp-server.ts`, efter `await server.connect(transport);`:

```ts
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void closeCachedConnection().finally(() => process.exit(0));
    });
  }
```

- [ ] **Step 6: Kör testerna**

Run: `npm run build && npx tsx test/warm-connection-smoke.ts && npx tsx test/tools-smoke.ts && npm run test:seed && npx tsx test/monorepo-smoke.ts && npx tsx test/graph-meta-smoke.ts`
Expected: alla PASS. Om `warm-connection-smoke` failar på `stale` betyder det att detektionen inte greps — kontrollera att `statSync` läses *före* cache-jämförelsen.

- [ ] **Step 7: Lägg till testskript, samla alla tester och committa**

I `package.json`:

```json
"test:warm": "tsx test/warm-connection-smoke.ts",
"test": "npm run test:paths && npm run test:seed && npm run test:monorepo && npm run test:meta && npm run test:tools && npm run test:warm",
```

Run: `npm test`
Expected: alla sex PASS.

```bash
git add src/mcp-server.ts src/seed.ts test/warm-connection-smoke.ts package.json
git commit -m "perf: keep the database connection warm, reopen when the file changes

Opening the database per call cost 36-64ms against 0.5ms warm. A naive
cache is a silent-wrong bug: measured against Kuzu 0.11.3, an open
connection keeps serving the pre-reseed graph without error. Inode and
mtime detect the swap for the price of a stat.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Uppdatera arkitekturdokumentet

**Bakgrund:** [docs/architecture.md](../../architecture.md) beskriver nuläget och uppdateras efter genomförda ändringar, inte i förväg. Efter Task 1–7 är avsnitt 2 (systemöversikt), 3 (moduler), 4 (datamodell), 5 (flöden), 7 (begränsningar), 8 (test) och 9 (nästa steg) inaktuella.

**Files:**
- Modify: `docs/architecture.md`

- [ ] **Step 1: Uppdatera modul- och datamodellavsnitten**

Genomför i `docs/architecture.md`:
- Avsnitt 2: lägg `src/paths.ts`, `src/config.ts` och `src/graph-meta.ts` i flödesdiagrammet; ändra `mcp["src/mcp-server.ts<br/>4 read-only tools"]` till `3 read-only tools`.
- Avsnitt 3: nytt underavsnitt för `src/paths.ts` (uppåtvandrande upplösning, ersätter `CLAUDE_PROJECT_DIR`), `src/config.ts` och `src/graph-meta.ts`. Uppdatera `src/mcp-server.ts`-avsnittet med den nya verktygstabellen och den varma anslutningen.
- Avsnitt 4: `line`/`endLine`/`unresolved*` i ER-diagrammet och identitetstabellen; `typeAlias` som tredje `kind`.
- Avsnitt 5: seedningssekvensen tar nu en lista tsconfig och skriver `GraphMeta` sist; frågesekvensen visar cache-träff och omöppning.

- [ ] **Step 2: Skriv om avsnitt 7 (begränsningar)**

Stryk det som åtgärdats: "Ett `tsconfig.json` per körning", "En databasrundtur per nod och kant" (kvarstår för seedning men inte för frågor), och de tre tomma-listan-fällorna som nu rapporteras. Behåll och skärp: `CALLS` täcker bara två deklarationsformer, `unresolvedCalls` är brus, överlagringar dubbelräknas, deklarationssammanslagning kolliderar på `Type.path`, substrängsmatchning saknar ankare, ingen inkrementell uppdatering. Lägg till: korspaketimporter som går via byggda `.d.ts` blir fortfarande oupplösta.

- [ ] **Step 3: Skriv om avsnitt 8 och 9**

Avsnitt 8: tabellen med sex testskript och `npm test`. Avsnitt 9: ersätt listan med det som faktiskt återstår efter denna plan — se "Medvetet utanför planen" nedan.

- [ ] **Step 4: Verifiera och committa**

```bash
npm test
git add docs/architecture.md
git commit -m "docs: update architecture document for the reader-router work

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Medvetet utanför planen

| Punkt | Varför inte nu |
|---|---|
| **Skill-lager för routing** | Utvärderingen såg agenten välja grep även med grafverktyg tillgängliga, och diagnosticerade det som saknad routing. En konkurrerande förklaring är att grep *returnerar innehåll* medan grafen returnerade *sökvägar* — alltså en affordansbrist, inte en vanebrist. Task 3 och 6 åtgärdar affordansen. Mät om reflexen finns kvar innan skillet skrivs; annars skrivs halva innehållet som kompensation för något som redan är löst. Skillet ska hur som helst bara bära fällorna, inte en verktygsreferens. |
| **FTS-index** | Kuzu har en fulltextextension och den löser troligen merparten av de frågor `find_symbol` inte täcker. Vänta tills `find_symbol` har visat var den går bet. |
| **Embeddings / vektorindex** | Verifierat att Kuzu 0.11.3 klarar det i samma databas. Men nuvarande arkitektur bygger om grafen från grunden vid varje seedning, så embeddings betyder omembedding varje gång. En innehållshash-cache måste då leva utanför databasfilen, eller så måste rebuild-modellen bytas mot inkrementell uppdatering. Det är ett eget projekt, inte "steget efter FTS". |
| **CLI-query-kommandon** | Argumentet är komponerbarhet i ett Bash-anrop. Men det bygger ett andra frågelager parallellt med MCP-verktygen, kräver att `tsx` kompileras bort för att vara snabbt nog (362 ms tomt anrop), och kräver att agenten vet att CLI:t finns. `neighbors` med en sökvägslista ger det mesta av samma batchning inom en mekanism som redan är upptäckbar. |
| **Inkrementell seedning** | Kräver kaskaderande radering av `File`-noder och ett mtime-/hash-index. Förutsättning för embeddings, inte för något i denna plan. |
| **`.d.ts` → källa** | Korspaketimporter som TypeScript resolvar till byggda deklarationsfiler blir oupplösta även efter Task 2. Kan lösas via `declarationMap`, men Task 4 gör åtminstone bortfallet synligt. |

## Egengranskning

**Täckning mot underlaget.** Utvärderingens sju prioriteringar: radnummer (Task 3), exponera `CALLS` (Task 6), `find_symbol` (Task 6), relativa sökvägar (**ej åtgärdad** — `find_symbol` och `neighbors` returnerar fortfarande absoluta sökvägar; kosmetiskt och lätt att lägga till senare med projektroten från `graph_status`), färskhetssignal (Task 5), täckning (Task 2 för multi-tsconfig, Task 3 för typalias), färre och bredare verktyg (Task 6). Varm anslutning (Task 7). Databassökväg i monorepo, uttryckligen begärd (Task 1). Skill-lager, FTS och vektorer är medvetet utanför, med skäl.

**Typkonsistens.** `seedCodebase(tsconfigPaths: string[], databasePath: string)` används i den formen i Task 2–7 och i alla fyra testfiler. `SymbolMatch` returneras av både `findSymbol` och `queryNeighbors.nodes`. `findGraphDatabase` returnerar `string | undefined` och kontrolleras i båda anropsställena. `GraphMeta.counts` är `SeedSummary`, som inte ändrar form i planen.

**En risk att hålla ögonen på:** `queryNeighbors` kör en fråga per (kant × riktning × nodtabell) och sväljer fel från kombinationer som schemat inte tillåter, till exempel `IMPORTS` mot `Function`. Det är rätt beteende men döljer också äkta frågefel. Om Task 6 blir svårfelsökt: logga det svalda felet till `stderr` i stället för att bara `continue`.
