# CodeGraph PoC

En lokal TypeScript-kodgraf som seedas fran en eller flera `tsconfig.json` med `ts-morph`, lagras i Kuzu och gors tillganglig for en kodagent via en MCP-server over stdio.

## Kom igang

Forutsatter Node.js 20 eller senare.

```bash
npm install
npm run verify:kuzu
npm run build
npm link
```

`verify:kuzu` kontrollerar att den las-ta Kuzu-bindningen fungerar. `npm link` installerar CLI:t lokalt sa att det kan anvandas fran andra projekt.

CLI:t anvander CodeGraphs egen lokala `tsx`-installation. `tsx` behover darfor inte installeras globalt.

Om `codegraph` darefter ger `command not found` saknas npm:s globala bin-katalog i din shell-`PATH`. Lagga till den en gang i zsh:

```bash
printf '\nexport PATH="$(npm prefix -g)/bin:$PATH"\n' >> ~/.zshrc
source ~/.zshrc
```

Kontrollera installationen:

```bash
command -v codegraph
```

Ga sedan till projektet som ska analyseras och kor:

```bash
cd /sokvag/till/projektet
codegraph init
```

Kommandot hittar `tsconfig.json` i aktuell katalog, skapar `.codegraph/kuzu`, lagger till `.codegraph/kuzu*` i `.gitignore`, skriver projektets tsconfig-sokvagar till `.codegraph/config.json`, och skapar eller uppdaterar projektets `.mcp.json` med MCP-serverns korrekta sokvagar. Kor `codegraph seed` fran samma katalog nar koden andras.

For ett monorepo med flera tsconfig, ange varje sokvag med en upprepad `--tsconfig`-flagga:

```bash
codegraph init --tsconfig tsconfig.json --tsconfig packages/pdf/tsconfig.json
```

Sokvagarna sparas relativt projektets rot i `.codegraph/config.json`, sa filen kan checkas in och delas med teamet. `codegraph seed` utan flaggor laser om samma lista fran `.codegraph/config.json`; ange `--tsconfig` igen om listan ska andras.

Lagg till servern i din MCP-klient, till exempel:

```json
{
  "mcpServers": {
    "codegraph": {
      "type": "stdio",
      "command": "/absolut/sokvag/till/node",
      "args": [
        "/absolut/sokvag/till/CodeGraph/node_modules/tsx/dist/cli.mjs",
        "/absolut/sokvag/till/CodeGraph/src/mcp-server.ts"
      ],
      "cwd": "/sokvag/till/projektet"
    }
  }
}
```

### Claude Code

Efter `codegraph init` ar servern registrerad i projektets `.mcp.json`. Starta Claude Code fran projektets rot:

```bash
cd /sokvag/till/projektet
claude
```

Godkann projektets MCP-server nar Claude Code fragar. `codegraph init` anvander projektomfattande konfiguration, sa `.mcp.json` kan delas med teamet om den innehaller den lokala installationens sokvagar.

Claude Code satter `CLAUDE_PROJECT_DIR` till den aktiva kodbasens rot. MCP-servern anvander automatiskt `<kodbas>/.codegraph/kuzu`.

Verifiera installationen:

```bash
claude mcp list
claude mcp get codegraph
```

Servern exponerar tre skrivskyddade verktyg:

- `graph_status`: när grafen seedades, mot vilken commit, vilka tsconfig som ingick, och hur många TypeScript-filer som ändrats sedan dess. Anropa detta innan du litar på ett radintervall.
- `find_symbol`: hittar filer, typer och funktioner på namn eller sökvägsdel, och returnerar radintervall. Matchningen är delsträng och skiftlägesokänslig — `party` hittar både `partyTools` och `createParty`, men inte `parties`. Sök på stammen när du är osäker.
- `neighbors`: expanderar noder längs `IMPORTS`, `MOCKS`, `CALLS`, `DECLARES`, `HAS_FUNCTION` eller `HAS_METHOD`, i valfri riktning och till djup 1–3.

Varje `neighbors`-svar bär `counts`-räknare per sökväg. `unresolvedImports`/`unresolvedMocks`/`unresolvedCalls` räknar det grafen faktiskt missade: en tom nodlista med en sådan räknare > 0 betyder att relationen inte kunde upplösas — inte att den saknas. `externalCalls` räknar anrop som lämnar de seedade projekten (`node_modules`, TypeScripts lib) och är alltid stort i en riktig kodbas; det säger ingenting om grafens kvalitet och ska inte läsas som skuld.

## Forutsattningar

- Node.js 20 eller senare.

```bash
npm install
```

## Verifiera seedningen

```bash
npm run build
npm run test:seed
```

`test:seed` skapar en tillfallig Kuzu-databas fran fixtureprojektet i `test/fixtures/imports`. Testet verifierar att tre TypeScript-filer, tva lokala importrelationer och en oresolverad Node.js-import rapporteras korrekt. Databasen rensas nar testet avslutas.

## Seeda ett projekt

```bash
cd /sokvag/till/projektet
codegraph seed
```

Den lokala grafen byggs om fran grunden och lagras i projektets `.codegraph/kuzu`.

## Utforska grafen

Efter seedning kan Kuzu Explorer startas fran CodeGraphs rot. Docker Desktop maste vara igang.

```bash
npm run explorer
```

Oppna sedan `http://localhost:8000` i webblasaren. Kommandot monterar databasfilen `.codegraph/kuzu` som `/database/database.kz`, vilket ar Explorers standardsokvag.