# PoC-specifikation: lokal TypeScript-kodgraf med Kuzu och MCP

## Mal

Bygg en liten, korbar proof of concept som kan svara pa vilka lokala TypeScript-filer som importerar en fil och vilka filer den importerar. All grafdata ska tas fram deterministiskt fran TypeScript AST:n med `ts-morph` och lagras lokalt i Kuzu. En MCP-server ska gora fragorna tillgangliga for en kodagent.

PoC:en prioriterar ett fungerande helflode pa kort tid framfor en komplett semantisk kodmodell.

## Leverans

Projektet ska innehalla:

- `src/schema.ts`: skapar eller oppnar Kuzu-databasen och dess schema.
- `src/seed.ts`: bygger om grafen fran ett angivet `tsconfig.json`.
- `src/mcp-server.ts`: startar en MCP-server over stdio med fasta, skrivskyddade fragor.
- `package.json`: har skript for att bygga, seeda och starta servern.
- `README.md`: beskriver installation, korning och MCP-konfiguration.

Databasen lagras i `.codegraph/kuzu` och ska ligga i `.gitignore`.

## Avgransning

### Ing ar

- TypeScript- och TSX-filer som ingar i det angivna `tsconfig.json`.
- En `File`-nod per absolut filvag.
- En `IMPORTS`-relation for varje lokal import som `ts-morph` kan upplosa till en kallfil.
- Tva MCP-verktyg:
  - `get_file_dependencies`: filer som en given fil importerar.
  - `get_file_importers`: filer som importerar en given fil.
- Soksokvag med filnamn eller del av filvag, sa att agenten inte maste kanna den absoluta vagen i forvag.

### Ing ar inte

- Klasser, interfaces, metodanrop, referenser eller typberoenden.
- Externa npm-paket och oresolverade alias.
- Inkremetell uppdatering, file watcher eller VS Code-extension.
- Ett generellt Cypher-verktyg. Agenten ska inte kunna modifiera databasen genom MCP.
- Stod for flera `tsconfig.json` i samma korning.

Utvidga till symboler forst nar filberoenden har visat sig anvandbara i praktiken. En framtida symbolnod ska identifieras med `filvag + symbolnamn`, aldrig endast namn.

## Teknikval

- Node.js 20 eller senare.
- TypeScript.
- `ts-morph` for AST och importupplosning.
- `kuzu` for inbaddad grafdatabas.
- `@modelcontextprotocol/sdk` for MCP over stdio.
- `zod` for att validera MCP-indata.

Anvand ESM genom hela projektet. Undvik `require.main`; ha separata npm-skript for korbara program.

Las Kuzu till en explicit version i `package.json`. Dokumentera paketnamn, Node.js-kompatibilitet och det importerade API:t i `README.md`.

## Installation och skript

Installera beroenden:

```bash
npm install kuzu ts-morph @modelcontextprotocol/sdk zod
npm install -D typescript @types/node tsx
```

Definiera minst dessa skript:

```json
{
  "scripts": {
    "verify:kuzu": "tsx src/verify-kuzu.ts",
    "build": "tsc --noEmit",
    "seed": "tsx src/seed.ts --tsconfig ./tsconfig.json",
    "mcp": "tsx src/mcp-server.ts"
  }
}
```

`seed` far acceptera en alternativ sokvag med `--tsconfig <sokvag>`. Om den saknas ska programmet avsluta med ett tydligt felmeddelande och statuskod som inte ar noll.

## Grafmodell

### Kuzu-kompatibilitetstest

Innan schema- och seedkoden byggs ska ett litet program i `src/verify-kuzu.ts` verifiera den las-ta Kuzu-bindningen. Det ska:

1. Skapa och stanga en databas i `.codegraph/kuzu-smoke-test`.
2. Oppna en anslutning och kora en enkel lasfraga, till exempel `RETURN 1`.
3. Rensa testkatalogen vid lyckad korning.
4. Avsluta med ett tydligt fel vid kompatibilitetsfel.

Lag till skriptet `verify:kuzu` och kor det fore `build`, `seed` och MCP-verifiering.

Skapa endast detta schema:

```cypher
CREATE NODE TABLE IF NOT EXISTS File(
  path STRING,
  PRIMARY KEY (path)
);

CREATE REL TABLE IF NOT EXISTS IMPORTS(
  FROM File TO File
);
```

`path` ska vara den normaliserade absoluta sokvagen fran `sourceFile.getFilePath()`. Det ar den enda identiteten i PoC:en.

## Seedning

Seedningen ska alltid skapa en ren, konsekvent graf:

1. Las in `tsconfig.json` med `new Project({ tsConfigFilePath })`.
2. Ta bort den befintliga databaskatalogen `.codegraph/kuzu` innan en ny seedning paborjas.
3. Skapa databasen och schemat igen.
4. Iterera over `project.getSourceFiles()`.
5. Skapa en `File`-nod for varje kallfil.
6. For varje `getImportDeclarations()` ska `getModuleSpecifierSourceFile()` anvandas.
7. Skapa en `IMPORTS`-relation endast nar malfilen finns i projektets kallfiler.
8. Rapportera antal filer och relationer vid avslut.

En import som inte kan upplosas ska hoppas over och raknas i en separat varning. Detta ar forvantat for npm-paket och vissa alias i PoC:en.

Seedningen ska vara idempotent: tva korningar med samma kallkod ska ge samma graf. Eftersom databasen ateruppbyggs fran grunden ska varje nod och relation skrivas exakt en gang per korning.

## MCP-server

Servern ska oppna den befintliga Kuzu-databasen men aldrig skapa om eller seeda den. Om databasen saknas ska den returnera ett handlingsbart fel, exempelvis `Kor npm run seed forst.`

Exponera dessa verktyg:

### `get_file_dependencies`

Indata:

```json
{ "pathQuery": "src/app.ts" }
```

Beteende:

1. Soka fram filer vars `path` innehaller `pathQuery`.
2. Om ingen fil matchar: returnera ett tomt resultat med forklaring.
3. Om flera filer matchar: returnera kandidaterna och kor inte beroendefragan.
4. Om exakt en fil matchar: returnera dess normaliserade sokvag och direkt importerade filer.

### `get_file_importers`

Har samma indata- och matchningsregler som `get_file_dependencies`, men returnerar filer med en inkommande `IMPORTS`-relation.

Implementera fragorna i serverkoden. Acceptera inte godtycklig Cypher fran MCP-klienten. Alla indatavarden ska valideras med Zod och bindas som databasparametrar, inte byggas in med strangkombinering.

MCP-servern far endast skriva loggar till `stderr`; `stdout` ar reserverad for MCP-protokollet.

## Agentinstruktion

Lagg in foljande regel i den agentkonfiguration som anvander MCP-servern:

```markdown
Nar du behover forsta direkta TypeScript-filberoenden, borja med `get_file_dependencies` eller `get_file_importers`. Behandla resultatet som en aktuell strukturell signal endast efter att seedningen har korts. Kontrollera alltid relevant kallkod innan du gor en andring; grafen modellerar inte dynamiska importer, externa paket eller symbolreferenser.
```

## Korning

Fran projektroten:

```bash
npm install
npm run verify:kuzu
npm run build
npm run seed -- --tsconfig /absolut/sokvag/till/projekt/tsconfig.json
npm run mcp
```

Exempel pa MCP-konfiguration:

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/absolut/sokvag/till/codegraph"
    }
  }
}
```

## Acceptanskriterier

PoC:en ar klar nar foljande kan visas mot ett litet TypeScript-fixtureprojekt med minst tre filer och tva lokala imports:

1. `npm run verify:kuzu` skapar, fragar och rensar en lokal Kuzu-databas.
2. `npm run build` avslutas utan TypeScript-fel.
3. `npm run seed -- --tsconfig <fixture>/tsconfig.json` skapar databasen och rapporterar ratt antal filer och imports.
4. `get_file_dependencies` returnerar direkta importer for en entydigt matchad fil.
5. `get_file_importers` returnerar direkta importorer for samma fil.
6. Ett otydligt filnamn returnerar kandidater i stallet for ett godtyckligt val.
7. En seedning efter att en import tagits bort ger inget gammalt beroende i resultatet.
8. MCP-servern erbjuder inget verktyg som kan kora skrivande fragor.

## Nasta steg efter verifierad PoC

1. Stod TypeScript `paths` och monorepon med flera projekt.
2. Lagg till symbolnoder med stabil identifierare `filePath:symbolName:kind`.
3. Lagg till relationer for export, arv och implementation.
4. Lagg till en explicit `graph_status`-fraga med seedtid, kall-tsconfig och antal noder/relationer.
