# Translations

The solver app speaks English, German, French, Italian, Spanish and Brazilian
Portuguese (KOF-468). It opens in the browser's language when it speaks it;
Settings → Language overrides that and is kept in `localStorage`.

## Adding text

Every string a user sees goes in a catalog in `messages/`, one file per part
of the UI. Each message holds its six languages together, so a change to the
English sits next to the translations it makes stale. English fixes the
argument types; the type requires every other language with the same
signature, so a missing translation does not compile.
`tests/unit/i18n.test.ts` also checks every catalog at runtime.

```ts
export const meshMessages = defineMessages({
  nodes: {
    en: "Nodes",
    de: "Knoten",
    fr: "Nœuds",
    it: "Nodi",
    es: "Nodos",
    pt: "Nós",
  },
  bodies: {
    en: (n: number) => (n === 1 ? "1 body" : `${n} bodies`),
    de: (n: number) => (n === 1 ? "1 Körper" : `${n} Körper`),
    // fr, it, es, pt …
  },
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

## Changing text

`translations.lock.json` records a fingerprint of every message in every
language. `tests/unit/i18n-lock.test.ts` fails until the lock matches the
catalogs, and `bun run i18n:lock` updates it. It refuses a message whose
English changed while a translation stayed the same: that translation no
longer says what the English says. Update the translations, or, when the
English change needs none (a typo, a reworded English idiom), confirm it:

```sh
bun run i18n:lock --confirm mesh.ts:meshMessages.nodes
```

## Errors and analytics

Analytics sorts errors by their English text (`lib/analytics.ts`). Every
translated message is remembered with its English (`english.ts`), so an
error a user reads in German is still categorised; the solver worker sends
the English of its errors along. Neither text leaves the browser.

The worker has no storage of its own: `workers/sharedWorker.ts` sends the
current language with every request.

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

### More terms

| English                          | Deutsch                                | Français                                | Italiano                                   | Español                                   | Português (BR)                         |
| -------------------------------- | -------------------------------------- | --------------------------------------- | ------------------------------------------ | ----------------------------------------- | -------------------------------------- |
| interface (bonded)               | Kontaktfläche (fest verbunden)         | interface (collé)                       | interfaccia (incollato)                    | interfaz (pegado)                         | interface (colado)                     |
| suppressed                       | unterdrückt                            | supprimé                                | soppresso                                  | suprimido                                 | suprimido                              |
| section cut                      | Schnitt                                | coupe                                   | sezione                                    | corte                                     | corte                                  |
| probe                            | Sonde                                  | sonde                                   | sonda                                      | sonda                                     | sonda                                  |
| reference point                  | Referenzpunkt                          | point de référence                      | punto di riferimento                       | punto de referencia                       | ponto de referência                    |
| distributing / kinematic         | verteilend / kinematisch               | distribué / cinématique                 | distribuito / cinematico                   | distribuido / cinemático                  | distribuído / cinemático               |
| design / keep solid / keep empty | Design / Voll erhalten / Leer erhalten | Conception / Garder plein / Garder vide | Progetto / Mantieni pieno / Mantieni vuoto | Diseño / Mantener sólido / Mantener vacío | Projeto / Manter sólido / Manter vazio |
| compliance                       | Nachgiebigkeit                         | souplesse                               | cedevolezza                                | flexibilidad                              | flexibilidade                          |
| pre-flight check                 | Vorabprüfung                           | vérification préalable                  | controllo preliminare                      | comprobación previa                       | verificação prévia                     |
| DOF                              | Freiheitsgrad (FHG)                    | DDL                                     | GdL                                        | GDL                                       | GL                                     |
| wireframe                        | Drahtgitter                            | filaire                                 | wireframe                                  | alámbrico                                 | aramado                                |

In Italian a tie stays _tie_ ("vincolo tie"), as _vincolo_ is a support.
A guide or hint that names a button uses that button's exact label.
