# CodeGraph PoC

En lokal TypeScript-kodgraf som seedas fran `tsconfig.json` med `ts-morph` och lagras i Kuzu. MCP-delen byggs efter att seedningen ar verifierad.

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
npm run seed -- --tsconfig /absolut/sokvag/till/projekt/tsconfig.json
```

Den lokala grafen byggs om fran grunden och lagras i `.codegraph/kuzu`.

## Utforska grafen

Efter seedning kan Kuzu Explorer startas fran CodeGraphs rot. Docker Desktop maste vara igang.

```bash
npm run explorer
```

Oppna sedan `http://localhost:8000` i webblasaren. Kommandot monterar databasfilen `.codegraph/kuzu` som `/database/database.kz`, vilket ar Explorers standardsokvag.