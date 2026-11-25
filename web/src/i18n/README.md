# Translations

The solver app speaks English, German, French, Italian, Spanish and Brazilian
Portuguese (KOF-468). It opens in the browser's language when it speaks it;
Settings → Language overrides that and is kept in `localStorage`.

## Adding text

Every string a user sees goes in a catalog in `messages/`, one file per part
of the UI. English fixes the keys and argument types; the type requires each
other language to have every message with the same signature, so a missing
translation does not compile. `tests/unit/i18n.test.ts` also checks every
catalog at runtime.

```ts
export const meshMessages = defineMessages({
  en: {
    nodes: "Nodes",
    bodies: (n: number) => (n === 1 ? "1 body" : `${n} bodies`),
  },
  de: {
    nodes: "Knoten",
    bodies: (n: number) => (n === 1 ? "1 Körper" : `${n} Körper`),
  },
  // fr, it, es, pt …
});
```

- In a component: `const text = useT(meshMessages)`, then `text.nodes`.
- Outside React (store actions, library functions): `tr(meshMessages).nodes`.
  The text is in the language current when it is built.
- Numbers shown with digit grouping: `toLocaleString(useIntlTag())`, or
  `intlTag()` outside React.
- Message functions take strings and numbers only, and build whole
  sentences: each language orders words and forms plurals its own way.

Translate what the user reads, never what the code compares: keys and values
the store or a saved file holds (result type ids such as `"Von Mises stress"`,
element types, units, `data-testid`s, analytics parameters) stay as they are,
and are translated only where they are displayed.

## Glossary

Use these terms so the app reads as one voice.

| English               | Deutsch               | Français                 | Italiano                    | Español                 | Português (BR)          |
| --------------------- | --------------------- | ------------------------ | --------------------------- | ----------------------- | ----------------------- |
| analysis              | Analyse               | analyse                  | analisi                     | análisis                | análise                 |
| geometry              | Geometrie             | géométrie                | geometria                   | geometría               | geometria               |
| body / region         | Körper / Bereich      | corps / région           | corpo / regione             | cuerpo / región         | corpo / região          |
| face / edge           | Fläche / Kante        | face / arête             | faccia / spigolo            | cara / arista           | face / aresta           |
| mesh / to mesh        | Netz / vernetzen      | maillage / mailler       | mesh / generare la mesh     | malla / mallar          | malha / gerar a malha   |
| node / element        | Knoten / Element      | nœud / élément           | nodo / elemento             | nodo / elemento         | nó / elemento           |
| material              | Werkstoff             | matériau                 | materiale                   | material                | material                |
| boundary conditions   | Randbedingungen       | conditions aux limites   | condizioni al contorno      | condiciones de contorno | condições de contorno   |
| support               | Lagerung              | appui                    | vincolo                     | apoyo                   | apoio                   |
| fixed                 | fest eingespannt      | encastré                 | incastro                    | empotrado               | engastado               |
| load / force          | Last / Kraft          | charge / force           | carico / forza              | carga / fuerza          | carga / força           |
| pressure / moment     | Druck / Moment        | pression / moment        | pressione / momento         | presión / momento       | pressão / momento       |
| shell / solid         | Schale / Volumen      | coque / volumique        | guscio / solido             | lámina / sólido         | casca / sólido          |
| tie / coupling        | Verbindung / Kopplung | liaison / couplage       | vincolo tie / accoppiamento | unión / acoplamiento    | ligação / acoplamento   |
| solve / solver        | lösen / Löser         | résoudre / solveur       | risolvere / solutore        | resolver / solucionador | resolver / solucionador |
| results               | Ergebnisse            | résultats                | risultati                   | resultados              | resultados              |
| displacement          | Verschiebung          | déplacement              | spostamento                 | desplazamiento          | deslocamento            |
| stress / strain       | Spannung / Dehnung    | contrainte / déformation | tensione / deformazione     | tensión / deformación   | tensão / deformação     |
| von Mises stress      | Von-Mises-Spannung    | contrainte de von Mises  | tensione di von Mises       | tensión de von Mises    | tensão de von Mises     |
| reaction force        | Reaktionskraft        | réaction d'appui         | reazione vincolare          | reacción                | reação de apoio         |
| deformation scale     | Verformungsmaßstab    | échelle de déformation   | scala di deformazione       | escala de deformación   | escala de deformação    |
| topology optimization | Topologieoptimierung  | optimisation topologique | ottimizzazione topologica   | optimización topológica | otimização topológica   |
| study / refinement    | Studie / Verfeinerung | étude / raffinement      | studio / raffinamento       | estudio / refinamiento  | estudo / refinamento    |
| save / open           | speichern / öffnen    | enregistrer / ouvrir     | salva / apri                | guardar / abrir         | salvar / abrir          |

Address the user as _Sie_ in German and _vous_ in French; Italian, Spanish
and Portuguese use the informal _tu_ / _tú_ / _você_ forms common in software.
