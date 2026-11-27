// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// The result fields by the id the store and the analysis file hold
// (RESULT_TYPES): what the field picker, the plot names and the probe
// messages show.
export const resultFieldMessages = defineMessages({
  "Displacement (magnitude)": {
    en: "Displacement (magnitude)",
    de: "Verschiebung (Betrag)",
    fr: "Déplacement (norme)",
    it: "Spostamento (modulo)",
    es: "Desplazamiento (magnitud)",
    pt: "Deslocamento (magnitude)",
  },
  Ux: {
    en: "Ux",
    de: "Ux",
    fr: "Ux",
    it: "Ux",
    es: "Ux",
    pt: "Ux",
  },
  Uy: {
    en: "Uy",
    de: "Uy",
    fr: "Uy",
    it: "Uy",
    es: "Uy",
    pt: "Uy",
  },
  Uz: {
    en: "Uz",
    de: "Uz",
    fr: "Uz",
    it: "Uz",
    es: "Uz",
    pt: "Uz",
  },
  "Von Mises stress": {
    en: "Von Mises stress",
    de: "Von-Mises-Spannung",
    fr: "Contrainte de von Mises",
    it: "Tensione di von Mises",
    es: "Tensión de von Mises",
    pt: "Tensão de von Mises",
  },
  "Normal stress σxx": {
    en: "Normal stress σxx",
    de: "Normalspannung σxx",
    fr: "Contrainte normale σxx",
    it: "Tensione normale σxx",
    es: "Tensión normal σxx",
    pt: "Tensão normal σxx",
  },
  "Normal stress σyy": {
    en: "Normal stress σyy",
    de: "Normalspannung σyy",
    fr: "Contrainte normale σyy",
    it: "Tensione normale σyy",
    es: "Tensión normal σyy",
    pt: "Tensão normal σyy",
  },
  "Normal stress σzz": {
    en: "Normal stress σzz",
    de: "Normalspannung σzz",
    fr: "Contrainte normale σzz",
    it: "Tensione normale σzz",
    es: "Tensión normal σzz",
    pt: "Tensão normal σzz",
  },
  "Shear stress τxy": {
    en: "Shear stress τxy",
    de: "Schubspannung τxy",
    fr: "Contrainte de cisaillement τxy",
    it: "Tensione tangenziale τxy",
    es: "Tensión cortante τxy",
    pt: "Tensão de cisalhamento τxy",
  },
  "Shear stress τyz": {
    en: "Shear stress τyz",
    de: "Schubspannung τyz",
    fr: "Contrainte de cisaillement τyz",
    it: "Tensione tangenziale τyz",
    es: "Tensión cortante τyz",
    pt: "Tensão de cisalhamento τyz",
  },
  "Shear stress τzx": {
    en: "Shear stress τzx",
    de: "Schubspannung τzx",
    fr: "Contrainte de cisaillement τzx",
    it: "Tensione tangenziale τzx",
    es: "Tensión cortante τzx",
    pt: "Tensão de cisalhamento τzx",
  },
  "Max principal stress σ1": {
    en: "Max principal stress σ1",
    de: "Größte Hauptspannung σ1",
    fr: "Contrainte principale max. σ1",
    it: "Tensione principale max σ1",
    es: "Tensión principal máx. σ1",
    pt: "Tensão principal máx. σ1",
  },
  "Min principal stress σ3": {
    en: "Min principal stress σ3",
    de: "Kleinste Hauptspannung σ3",
    fr: "Contrainte principale min. σ3",
    it: "Tensione principale min σ3",
    es: "Tensión principal mín. σ3",
    pt: "Tensão principal mín. σ3",
  },
  "Contact pressure": {
    en: "Contact pressure",
    de: "Kontaktdruck",
    fr: "Pression de contact",
    it: "Pressione di contatto",
    es: "Presión de contacto",
    pt: "Pressão de contato",
  },
  "Contact status": {
    en: "Contact status (1 = touching)",
    de: "Kontaktstatus (1 = berührt)",
    fr: "État du contact (1 = en contact)",
    it: "Stato del contatto (1 = a contatto)",
    es: "Estado del contacto (1 = en contacto)",
    pt: "Estado do contato (1 = em contato)",
  },
});

// The Results panel: adding plots, a plot's field, scale, probes and section
// cut, and the support reactions.
export const resultsMessages = defineMessages({
  staticSolveHint: {
    en: (unit: string) =>
      unit === "" ? "Static solve" : `Static solve · ${unit}`,
    de: (unit: string) =>
      unit === "" ? "Statische Berechnung" : `Statische Berechnung · ${unit}`,
    fr: (unit: string) =>
      unit === "" ? "Calcul statique" : `Calcul statique · ${unit}`,
    it: (unit: string) =>
      unit === "" ? "Calcolo statico" : `Calcolo statico · ${unit}`,
    es: (unit: string) =>
      unit === "" ? "Cálculo estático" : `Cálculo estático · ${unit}`,
    pt: (unit: string) =>
      unit === "" ? "Cálculo estático" : `Cálculo estático · ${unit}`,
  },
  runStaticFirst: {
    en: "Run a static study first",
    de: "Führen Sie zuerst eine statische Studie aus",
    fr: "Lancez d'abord une étude statique",
    it: "Esegui prima uno studio statico",
    es: "Ejecuta primero un estudio estático",
    pt: "Execute primeiro um estudo estático",
  },
  sectionCut: {
    en: "Section cut",
    de: "Schnitt",
    fr: "Coupe",
    it: "Sezione",
    es: "Corte",
    pt: "Corte",
  },
  showStaticFieldFirst: {
    en: "Show a field of the static solve first",
    de: "Zeigen Sie zuerst ein Feld der statischen Berechnung an",
    fr: "Affichez d'abord un champ du calcul statique",
    it: "Mostra prima un campo del calcolo statico",
    es: "Muestra primero un campo del cálculo estático",
    pt: "Mostre primeiro um campo do cálculo estático",
  },
  alreadyHasCut: {
    en: (plot: string) => `${plot} already has a cut`,
    de: (plot: string) => `${plot} hat bereits einen Schnitt`,
    fr: (plot: string) => `${plot} a déjà une coupe`,
    it: (plot: string) => `${plot} ha già una sezione`,
    es: (plot: string) => `${plot} ya tiene un corte`,
    pt: (plot: string) => `${plot} já tem um corte`,
  },
  cutThrough: {
    en: (plot: string) => `Cut through ${plot}`,
    de: (plot: string) => `Schnitt durch ${plot}`,
    fr: (plot: string) => `Coupe à travers ${plot}`,
    it: (plot: string) => `Sezione di ${plot}`,
    es: (plot: string) => `Corte a través de ${plot}`,
    pt: (plot: string) => `Corte através de ${plot}`,
  },
  reactions: {
    en: "Reactions",
    de: "Reaktionen",
    fr: "Réactions",
    it: "Reazioni",
    es: "Reacciones",
    pt: "Reações",
  },
  alreadyListed: {
    en: "Already listed",
    de: "Bereits aufgeführt",
    fr: "Déjà listées",
    it: "Già elencate",
    es: "Ya listadas",
    pt: "Já listadas",
  },
  reactionsHint: {
    en: "Support forces · balance check",
    de: "Lagerkräfte · Gleichgewichtsprüfung",
    fr: "Efforts d'appui · contrôle d'équilibre",
    it: "Forze vincolari · verifica dell'equilibrio",
    es: "Fuerzas en apoyos · comprobación de equilibrio",
    pt: "Forças nos apoios · verificação de equilíbrio",
  },
  density: {
    en: "Density",
    de: "Dichte",
    fr: "Densité",
    it: "Densità",
    es: "Densidad",
    pt: "Densidade",
  },
  densityHint: {
    en: "Topology optimization · material layout",
    de: "Topologieoptimierung · Materialverteilung",
    fr: "Optimisation topologique · répartition de matière",
    it: "Ottimizzazione topologica · distribuzione del materiale",
    es: "Optimización topológica · distribución de material",
    pt: "Otimização topológica · distribuição de material",
  },
  runTopOptFirst: {
    en: "Run a topology optimization first",
    de: "Führen Sie zuerst eine Topologieoptimierung aus",
    fr: "Lancez d'abord une optimisation topologique",
    it: "Esegui prima un'ottimizzazione topologica",
    es: "Ejecuta primero una optimización topológica",
    pt: "Execute primeiro uma otimização topológica",
  },
  meshRefinement: {
    en: "Mesh refinement",
    de: "Netzverfeinerung",
    fr: "Raffinement du maillage",
    it: "Raffinamento della mesh",
    es: "Refinamiento de malla",
    pt: "Refinamento da malha",
  },
  refinementHint: {
    en: "Mesh refinement study · convergence",
    de: "Netzverfeinerungsstudie · Konvergenz",
    fr: "Étude de raffinement du maillage · convergence",
    it: "Studio di raffinamento della mesh · convergenza",
    es: "Estudio de refinamiento de malla · convergencia",
    pt: "Estudo de refinamento da malha · convergência",
  },
  runRefinementFirst: {
    en: "Run a mesh refinement study first",
    de: "Führen Sie zuerst eine Netzverfeinerungsstudie aus",
    fr: "Lancez d'abord une étude de raffinement du maillage",
    it: "Esegui prima uno studio di raffinamento della mesh",
    es: "Ejecuta primero un estudio de refinamiento de malla",
    pt: "Execute primeiro um estudo de refinamento da malha",
  },
  handCheckChanged: {
    en: "The loads, supports or material changed, so the hand calculation no longer applies.",
    de: "Lasten, Lagerungen oder Werkstoff wurden geändert, daher gilt die Handrechnung nicht mehr.",
    fr: "Les charges, les appuis ou le matériau ont changé : le calcul manuel ne s'applique plus.",
    it: "Carichi, vincoli o materiale sono cambiati, quindi il calcolo manuale non vale più.",
    es: "Las cargas, los apoyos o el material cambiaron, así que el cálculo manual ya no es válido.",
    pt: "As cargas, os apoios ou o material mudaram, então o cálculo manual não vale mais.",
  },
  handCheckUnreadable: {
    en: (reason: string) =>
      `The hand calculation cannot be compared on this mesh. ${reason}`,
    de: (reason: string) =>
      `Die Handrechnung lässt sich auf diesem Netz nicht vergleichen. ${reason}`,
    fr: (reason: string) =>
      `Le calcul manuel ne peut pas être comparé sur ce maillage. ${reason}`,
    it: (reason: string) =>
      `Il calcolo manuale non può essere confrontato su questa mesh. ${reason}`,
    es: (reason: string) =>
      `El cálculo manual no se puede comparar en esta malla. ${reason}`,
    pt: (reason: string) =>
      `O cálculo manual não pode ser comparado nesta malha. ${reason}`,
  },
  handCalculation: {
    en: "hand calculation",
    de: "Handrechnung",
    fr: "calcul manuel",
    it: "calcolo manuale",
    es: "cálculo manual",
    pt: "cálculo manual",
  },
  remove: {
    en: (name: string) => `Remove ${name}`,
    de: (name: string) => `${name} entfernen`,
    fr: (name: string) => `Supprimer ${name}`,
    it: (name: string) => `Rimuovi ${name}`,
    es: (name: string) => `Quitar ${name}`,
    pt: (name: string) => `Remover ${name}`,
  },
  solveToRead: {
    en: "Solve to read this probe.",
    de: "Lösen Sie, um diese Sonde abzulesen.",
    fr: "Résolvez pour lire cette sonde.",
    it: "Risolvi per leggere questa sonda.",
    es: "Resuelve para leer esta sonda.",
    pt: "Resolva para ler esta sonda.",
  },
  cannotReadOnMesh: {
    en: (reason: string) => `Cannot be read on this mesh. ${reason}`,
    de: (reason: string) => `Auf diesem Netz nicht ablesbar. ${reason}`,
    fr: (reason: string) => `Illisible sur ce maillage. ${reason}`,
    it: (reason: string) => `Non leggibile su questa mesh. ${reason}`,
    es: (reason: string) => `No se puede leer en esta malla. ${reason}`,
    pt: (reason: string) => `Não é possível ler nesta malha. ${reason}`,
  },
  probeAt: {
    en: (point: string) => `at ${point}`,
    de: (point: string) => `bei ${point}`,
    fr: (point: string) => `en ${point}`,
    it: (point: string) => `in ${point}`,
    es: (point: string) => `en ${point}`,
    pt: (point: string) => `em ${point}`,
  },
  minAndMax: {
    en: "Min and max",
    de: "Min. und Max.",
    fr: "Min. et max.",
    it: "Min e max",
    es: "Mín. y máx.",
    pt: "Mín. e máx.",
  },
  labelInView: {
    en: "Label in view",
    de: "In Ansicht beschriften",
    fr: "Étiqueter dans la vue",
    it: "Etichetta nella vista",
    es: "Etiquetar en la vista",
    pt: "Rotular na vista",
  },
  minMaxUnreadable: {
    en: (reason: string) => `Min and max cannot be read. ${reason}`,
    de: (reason: string) =>
      `Min. und Max. lassen sich nicht ablesen. ${reason}`,
    fr: (reason: string) => `Impossible de lire le min. et le max. ${reason}`,
    it: (reason: string) => `Impossibile leggere min e max. ${reason}`,
    es: (reason: string) => `No se pueden leer el mín. y el máx. ${reason}`,
    pt: (reason: string) => `Não é possível ler o mín. e o máx. ${reason}`,
  },
  min: {
    en: "Min",
    de: "Min.",
    fr: "Min.",
    it: "Min",
    es: "Mín.",
    pt: "Mín.",
  },
  max: {
    en: "Max",
    de: "Max.",
    fr: "Max.",
    it: "Max",
    es: "Máx.",
    pt: "Máx.",
  },
  probes: {
    en: "Probes",
    de: "Sonden",
    fr: "Sondes",
    it: "Sonde",
    es: "Sondas",
    pt: "Sondas",
  },
  placeProbes: {
    en: "Place probes",
    de: "Sonden setzen",
    fr: "Placer des sondes",
    it: "Posiziona sonde",
    es: "Colocar sondas",
    pt: "Posicionar sondas",
  },
  stopPlacingProbes: {
    en: "Stop placing probes",
    de: "Sonden setzen beenden",
    fr: "Arrêter de placer des sondes",
    it: "Smetti di posizionare sonde",
    es: "Dejar de colocar sondas",
    pt: "Parar de posicionar sondas",
  },
  clickToRead: {
    en: (symbol: string) => `Click the model to read ${symbol} there.`,
    de: (symbol: string) =>
      `Klicken Sie auf das Modell, um dort ${symbol} abzulesen.`,
    fr: (symbol: string) => `Cliquez sur le modèle pour y lire ${symbol}.`,
    it: (symbol: string) =>
      `Fai clic sul modello per leggere ${symbol} in quel punto.`,
    es: (symbol: string) =>
      `Haz clic en el modelo para leer ${symbol} en ese punto.`,
    pt: (symbol: string) => `Clique no modelo para ler ${symbol} nesse ponto.`,
  },
  enterXyz: {
    en: "Enter x, y and z as numbers.",
    de: "Geben Sie x, y und z als Zahlen ein.",
    fr: "Saisissez x, y et z sous forme de nombres.",
    it: "Inserisci x, y e z come numeri.",
    es: "Introduce x, y y z como números.",
    pt: "Informe x, y e z como números.",
  },
  readAtPoint: {
    en: (symbol: string) => `Or read ${symbol} at a point (mm):`,
    de: (symbol: string) => `Oder ${symbol} an einem Punkt ablesen (mm):`,
    fr: (symbol: string) => `Ou lire ${symbol} en un point (mm) :`,
    it: (symbol: string) => `Oppure leggi ${symbol} in un punto (mm):`,
    es: (symbol: string) => `O lee ${symbol} en un punto (mm):`,
    pt: (symbol: string) => `Ou leia ${symbol} em um ponto (mm):`,
  },
  probeAxis: {
    en: (axis: string) => `Probe ${axis} (mm)`,
    de: (axis: string) => `Sonde ${axis} (mm)`,
    fr: (axis: string) => `Sonde ${axis} (mm)`,
    it: (axis: string) => `Sonda ${axis} (mm)`,
    es: (axis: string) => `Sonda ${axis} (mm)`,
    pt: (axis: string) => `Sonda ${axis} (mm)`,
  },
  add: {
    en: "Add",
    de: "Hinzufügen",
    fr: "Ajouter",
    it: "Aggiungi",
    es: "Añadir",
    pt: "Adicionar",
  },
  deletePlot: {
    en: "Delete plot",
    de: "Darstellung löschen",
    fr: "Supprimer le tracé",
    it: "Elimina grafico",
    es: "Eliminar gráfico",
    pt: "Excluir gráfico",
  },
  noRefinement: {
    en: "No refinement study — run the mesh refinement study",
    de: "Keine Verfeinerungsstudie – führen Sie die Netzverfeinerungsstudie aus",
    fr: "Pas d'étude de raffinement — lancez l'étude de raffinement du maillage",
    it: "Nessuno studio di raffinamento — esegui lo studio di raffinamento della mesh",
    es: "Sin estudio de refinamiento: ejecuta el estudio de refinamiento de malla",
    pt: "Sem estudo de refinamento — execute o estudo de refinamento da malha",
  },
  noDensity: {
    en: "No density — run the topology optimization",
    de: "Keine Dichte – führen Sie die Topologieoptimierung aus",
    fr: "Pas de densité — lancez l'optimisation topologique",
    it: "Nessuna densità — esegui l'ottimizzazione topologica",
    es: "Sin densidad: ejecuta la optimización topológica",
    pt: "Sem densidade — execute a otimização topológica",
  },
  noResults: {
    en: "No results — run the static study",
    de: "Keine Ergebnisse – führen Sie die statische Studie aus",
    fr: "Pas de résultats — lancez l'étude statique",
    it: "Nessun risultato — esegui lo studio statico",
    es: "Sin resultados: ejecuta el estudio estático",
    pt: "Sem resultados — execute o estudo estático",
  },
  field: {
    en: "Field",
    de: "Feld",
    fr: "Champ",
    it: "Campo",
    es: "Campo",
    pt: "Campo",
  },
  shellSurface: {
    en: "Shell surface",
    de: "Schalenseite",
    fr: "Face de la coque",
    it: "Superficie del guscio",
    es: "Cara de la lámina",
    pt: "Face da casca",
  },
  surfaceTop: {
    en: "Top (+normal)",
    de: "Oben (+Normale)",
    fr: "Supérieure (+normale)",
    it: "Superiore (+normale)",
    es: "Superior (+normal)",
    pt: "Superior (+normal)",
  },
  surfaceMiddle: {
    en: "Middle",
    de: "Mitte",
    fr: "Médiane",
    it: "Media",
    es: "Media",
    pt: "Média",
  },
  surfaceBottom: {
    en: "Bottom (−normal)",
    de: "Unten (−Normale)",
    fr: "Inférieure (−normale)",
    it: "Inferiore (−normale)",
    es: "Inferior (−normal)",
    pt: "Inferior (−normal)",
  },
  noStressData: {
    en: "Stress data not available — re-run the solver",
    de: "Keine Spannungsdaten – starten Sie den Löser erneut",
    fr: "Contraintes indisponibles — relancez le solveur",
    it: "Tensioni non disponibili — esegui di nuovo il solutore",
    es: "Tensiones no disponibles: vuelve a ejecutar el solucionador",
    pt: "Tensões indisponíveis — execute o solucionador novamente",
  },
  noNodalData: {
    en: "No nodal data",
    de: "Keine Knotendaten",
    fr: "Pas de données nodales",
    it: "Nessun dato nodale",
    es: "Sin datos nodales",
    pt: "Sem dados nodais",
  },
  arrowsInView: {
    en: "Arrows in view",
    de: "Pfeile in der Ansicht",
    fr: "Flèches dans la vue",
    it: "Frecce nella vista",
    es: "Flechas en la vista",
    pt: "Setas na vista",
  },
  arrows: {
    en: "Arrows",
    de: "Pfeile",
    fr: "Flèches",
    it: "Frecce",
    es: "Flechas",
    pt: "Setas",
  },
  resultant: {
    en: "Resultant",
    de: "Resultierende",
    fr: "Résultante",
    it: "Risultante",
    es: "Resultante",
    pt: "Resultante",
  },
  nodal: {
    en: "Nodal",
    de: "Je Knoten",
    fr: "Nodales",
    it: "Nodali",
    es: "Nodales",
    pt: "Nodais",
  },
  runToComputeReactions: {
    en: "Run the static solve to compute the reactions.",
    de: "Führen Sie die statische Berechnung aus, um die Reaktionen zu ermitteln.",
    fr: "Lancez le calcul statique pour obtenir les réactions.",
    it: "Esegui il calcolo statico per ottenere le reazioni.",
    es: "Ejecuta el cálculo estático para obtener las reacciones.",
    pt: "Execute o cálculo estático para obter as reações.",
  },
  deleteReactions: {
    en: "Delete reactions",
    de: "Reaktionen löschen",
    fr: "Supprimer les réactions",
    it: "Elimina reazioni",
    es: "Eliminar reacciones",
    pt: "Excluir reações",
  },
  reactionForces: {
    en: "Reaction forces",
    de: "Reaktionskräfte",
    fr: "Efforts de réaction",
    it: "Forze di reazione",
    es: "Fuerzas de reacción",
    pt: "Forças de reação",
  },
  forcesCaption: {
    en: "Forces (N)",
    de: "Kräfte (N)",
    fr: "Forces (N)",
    it: "Forze (N)",
    es: "Fuerzas (N)",
    pt: "Forças (N)",
  },
  sumOfReactions: {
    en: "Σ reactions",
    de: "Σ Reaktionen",
    fr: "Σ réactions",
    it: "Σ reazioni",
    es: "Σ reacciones",
    pt: "Σ reações",
  },
  applied: {
    en: "Applied",
    de: "Aufgebracht",
    fr: "Appliqué",
    it: "Applicato",
    es: "Aplicada",
    pt: "Aplicada",
  },
  reactionMoments: {
    en: "Reaction moments",
    de: "Reaktionsmomente",
    fr: "Moments de réaction",
    it: "Momenti di reazione",
    es: "Momentos de reacción",
    pt: "Momentos de reação",
  },
  momentsCaption: {
    en: "Moments about each support’s centre (N·mm)",
    de: "Momente um den Mittelpunkt jeder Lagerung (N·mm)",
    fr: "Moments au centre de chaque appui (N·mm)",
    it: "Momenti rispetto al centro di ogni vincolo (N·mm)",
    es: "Momentos respecto al centro de cada apoyo (N·mm)",
    pt: "Momentos em relação ao centro de cada apoio (N·mm)",
  },
  support: {
    en: (number: number) => `Support ${number}`,
    de: (number: number) => `Lagerung ${number}`,
    fr: (number: number) => `Appui ${number}`,
    it: (number: number) => `Vincolo ${number}`,
    es: (number: number) => `Apoyo ${number}`,
    pt: (number: number) => `Apoio ${number}`,
  },
  balanced: {
    en: "Balanced",
    de: "Im Gleichgewicht",
    fr: "Équilibré",
    it: "In equilibrio",
    es: "En equilibrio",
    pt: "Em equilíbrio",
  },
  offBy: {
    en: (amount: string) =>
      `Off by ${amount} N. The solve may have stopped short of its tolerance, or a coupling or tie carries load to a node no support lists.`,
    de: (amount: string) =>
      `Abweichung ${amount} N. Die Berechnung hat ihre Toleranz eventuell nicht erreicht, oder eine Kopplung oder Verbindung leitet Last an einen Knoten, den keine Lagerung enthält.`,
    fr: (amount: string) =>
      `Écart de ${amount} N. Le calcul s'est peut-être arrêté avant sa tolérance, ou un couplage ou une liaison transmet de la charge à un nœud qu'aucun appui ne contient.`,
    it: (amount: string) =>
      `Scarto di ${amount} N. Il calcolo potrebbe essersi fermato prima della tolleranza, oppure un accoppiamento o un vincolo tie porta carico a un nodo che nessun vincolo contiene.`,
    es: (amount: string) =>
      `Diferencia de ${amount} N. Puede que el cálculo se detuviera antes de su tolerancia, o que un acoplamiento o una unión lleve carga a un nodo que ningún apoyo incluye.`,
    pt: (amount: string) =>
      `Diferença de ${amount} N. O cálculo pode ter parado antes da tolerância, ou um acoplamento ou ligação leva carga a um nó que nenhum apoio inclui.`,
  },
  loadOnSupports: {
    en: (amount: string) =>
      `${amount} N of the load acts on supported nodes and goes straight into the support.`,
    de: (amount: string) =>
      `${amount} N der Last greifen an gelagerten Knoten an und gehen direkt in die Lagerung.`,
    fr: (amount: string) =>
      `${amount} N de la charge agissent sur des nœuds en appui et passent directement dans l'appui.`,
    it: (amount: string) =>
      `${amount} N del carico agiscono su nodi vincolati e passano direttamente al vincolo.`,
    es: (amount: string) =>
      `${amount} N de la carga actúan sobre nodos apoyados y pasan directamente al apoyo.`,
    pt: (amount: string) =>
      `${amount} N da carga atuam em nós apoiados e vão diretamente para o apoio.`,
  },
  notInMesh: {
    en: "not in the mesh",
    de: "nicht im Netz",
    fr: "absent du maillage",
    it: "non nella mesh",
    es: "fuera de la malla",
    pt: "fora da malha",
  },
  legendRange: {
    en: "Legend range",
    de: "Legendenbereich",
    fr: "Plage de la légende",
    it: "Intervallo della legenda",
    es: "Rango de la leyenda",
    pt: "Faixa da legenda",
  },
  useFieldRange: {
    en: "Use the field's own min and max",
    de: "Min. und Max. des Feldes verwenden",
    fr: "Utiliser le min. et le max. du champ",
    it: "Usa il min e il max del campo",
    es: "Usar el mín. y el máx. del campo",
    pt: "Usar o mín. e o máx. do campo",
  },
  auto: {
    en: "Auto",
    de: "Auto",
    fr: "Auto",
    it: "Auto",
    es: "Auto",
    pt: "Auto",
  },
  close: {
    en: "Close",
    de: "Schließen",
    fr: "Fermer",
    it: "Chiudi",
    es: "Cerrar",
    pt: "Fechar",
  },
  legendMinimum: {
    en: "Legend minimum",
    de: "Legendenminimum",
    fr: "Minimum de la légende",
    it: "Minimo della legenda",
    es: "Mínimo de la leyenda",
    pt: "Mínimo da legenda",
  },
  legendMaximum: {
    en: "Legend maximum",
    de: "Legendenmaximum",
    fr: "Maximum de la légende",
    it: "Massimo della legenda",
    es: "Máximo de la leyenda",
    pt: "Máximo da legenda",
  },
  limitsNotNumbers: {
    en: "Both limits must be numbers",
    de: "Beide Grenzen müssen Zahlen sein",
    fr: "Les deux limites doivent être des nombres",
    it: "Entrambi i limiti devono essere numeri",
    es: "Ambos límites deben ser números",
    pt: "Os dois limites devem ser números",
  },
  limitsNotFinite: {
    en: "Limits must be finite",
    de: "Grenzen müssen endlich sein",
    fr: "Les limites doivent être finies",
    it: "I limiti devono essere finiti",
    es: "Los límites deben ser finitos",
    pt: "Os limites devem ser finitos",
  },
  maxNotAboveMin: {
    en: "Max must be greater than min",
    de: "Max. muss größer als Min. sein",
    fr: "Le max. doit être supérieur au min.",
    it: "Il max deve essere maggiore del min",
    es: "El máx. debe ser mayor que el mín.",
    pt: "O máx. deve ser maior que o mín.",
  },
  outsideRange: {
    en: "Values outside the range take the end colours.",
    de: "Werte außerhalb des Bereichs erhalten die Endfarben.",
    fr: "Les valeurs hors plage prennent les couleurs extrêmes.",
    it: "I valori fuori intervallo prendono i colori degli estremi.",
    es: "Los valores fuera del rango toman los colores extremos.",
    pt: "Valores fora da faixa recebem as cores das extremidades.",
  },
  deformationScale: {
    en: "Deformation scale",
    de: "Verformungsmaßstab",
    fr: "Échelle de déformation",
    it: "Scala di deformazione",
    es: "Escala de deformación",
    pt: "Escala de deformação",
  },
  deformationFactor: {
    en: "Deformation factor",
    de: "Verformungsfaktor",
    fr: "Facteur de déformation",
    it: "Fattore di deformazione",
    es: "Factor de deformación",
    pt: "Fator de deformação",
  },
  clearForAuto: {
    en: "Clear to use the automatic factor",
    de: "Leeren, um den automatischen Faktor zu verwenden",
    fr: "Videz le champ pour utiliser le facteur automatique",
    it: "Svuota per usare il fattore automatico",
    es: "Vacía el campo para usar el factor automático",
    pt: "Apague para usar o fator automático",
  },
  noteAuto: {
    en: " (auto)",
    de: " (auto)",
    fr: " (auto)",
    it: " (auto)",
    es: " (auto)",
    pt: " (auto)",
  },
  noteUndeformed: {
    en: " (undeformed)",
    de: " (unverformt)",
    fr: " (non déformé)",
    it: " (indeformata)",
    es: " (sin deformar)",
    pt: " (indeformada)",
  },
  noteTrueScale: {
    en: " (true scale)",
    de: " (maßstäblich)",
    fr: " (échelle réelle)",
    it: " (scala reale)",
    es: " (escala real)",
    pt: " (escala real)",
  },
  enterNumber: {
    en: "Enter a number",
    de: "Geben Sie eine Zahl ein",
    fr: "Saisissez un nombre",
    it: "Inserisci un numero",
    es: "Introduce un número",
    pt: "Informe um número",
  },
  enterFactor: {
    en: "Enter a factor of 0 or more",
    de: "Geben Sie einen Faktor von 0 oder mehr ein",
    fr: "Saisissez un facteur supérieur ou égal à 0",
    it: "Inserisci un fattore pari a 0 o superiore",
    es: "Introduce un factor de 0 o más",
    pt: "Informe um fator de 0 ou mais",
  },
  densityThreshold: {
    en: "Density threshold",
    de: "Dichteschwelle",
    fr: "Seuil de densité",
    it: "Soglia di densità",
    es: "Umbral de densidad",
    pt: "Limiar de densidade",
  },
  smoothNote: {
    en: "Shows the surface where the density crosses the cutoff (the level set's own boundary at 0.50).",
    de: "Zeigt die Fläche, an der die Dichte die Schwelle kreuzt (beim Level-Set dessen eigene Grenze bei 0,50).",
    fr: "Affiche la surface où la densité franchit le seuil (pour la méthode level set, sa propre frontière à 0,50).",
    it: "Mostra la superficie in cui la densità attraversa la soglia (per il level set, il suo confine a 0,50).",
    es: "Muestra la superficie donde la densidad cruza el umbral (en el level set, su propio contorno en 0,50).",
    pt: "Mostra a superfície onde a densidade cruza o limiar (no level set, sua própria fronteira em 0,50).",
  },
  elementsNote: {
    en: "Elements below the cutoff are hidden, revealing the optimized shape.",
    de: "Elemente unter der Schwelle werden ausgeblendet und legen die optimierte Form frei.",
    fr: "Les éléments sous le seuil sont masqués et révèlent la forme optimisée.",
    it: "Gli elementi sotto la soglia sono nascosti e rivelano la forma ottimizzata.",
    es: "Los elementos por debajo del umbral se ocultan y revelan la forma optimizada.",
    pt: "Os elementos abaixo do limiar ficam ocultos, revelando a forma otimizada.",
  },
  smooth: {
    en: "Smooth",
    de: "Glatt",
    fr: "Lisse",
    it: "Liscia",
    es: "Suave",
    pt: "Suave",
  },
  elements: {
    en: "Elements",
    de: "Elemente",
    fr: "Éléments",
    it: "Elementi",
    es: "Elementos",
    pt: "Elementos",
  },
  visibleElements: {
    en: "Visible elements",
    de: "Sichtbare Elemente",
    fr: "Éléments visibles",
    it: "Elementi visibili",
    es: "Elementos visibles",
    pt: "Elementos visíveis",
  },
  along: {
    en: "Along",
    de: "Entlang",
    fr: "Selon",
    it: "Lungo",
    es: "Según",
    pt: "Ao longo de",
  },
  sectionAxis: {
    en: "Section axis",
    de: "Schnittachse",
    fr: "Axe de coupe",
    it: "Asse della sezione",
    es: "Eje del corte",
    pt: "Eixo do corte",
  },
  sectionPosition: {
    en: "Section position",
    de: "Schnittposition",
    fr: "Position de la coupe",
    it: "Posizione della sezione",
    es: "Posición del corte",
    pt: "Posição do corte",
  },
  flip: {
    en: "Flip",
    de: "Umkehren",
    fr: "Inverser",
    it: "Inverti",
    es: "Invertir",
    pt: "Inverter",
  },
  sectionCannotDraw: {
    en: (reason: string) => `The section cannot be drawn: ${reason}`,
    de: (reason: string) =>
      `Der Schnitt kann nicht gezeichnet werden: ${reason}`,
    fr: (reason: string) => `La coupe ne peut pas être tracée : ${reason}`,
    it: (reason: string) => `Impossibile disegnare la sezione: ${reason}`,
    es: (reason: string) => `No se puede dibujar el corte: ${reason}`,
    pt: (reason: string) => `Não é possível desenhar o corte: ${reason}`,
  },
  showRangeOnCut: {
    en: "Show min and max on the cut",
    de: "Min. und Max. auf dem Schnitt zeigen",
    fr: "Afficher le min. et le max. sur la coupe",
    it: "Mostra min e max sulla sezione",
    es: "Mostrar mín. y máx. en el corte",
    pt: "Mostrar mín. e máx. no corte",
  },
  minOnCut: {
    en: (symbol: string) => `Min ${symbol} on the cut`,
    de: (symbol: string) => `Min. ${symbol} auf dem Schnitt`,
    fr: (symbol: string) => `Min. ${symbol} sur la coupe`,
    it: (symbol: string) => `Min ${symbol} sulla sezione`,
    es: (symbol: string) => `Mín. ${symbol} en el corte`,
    pt: (symbol: string) => `Mín. ${symbol} no corte`,
  },
  maxOnCut: {
    en: (symbol: string) => `Max ${symbol} on the cut`,
    de: (symbol: string) => `Max. ${symbol} auf dem Schnitt`,
    fr: (symbol: string) => `Max. ${symbol} sur la coupe`,
    it: (symbol: string) => `Max ${symbol} sulla sezione`,
    es: (symbol: string) => `Máx. ${symbol} en el corte`,
    pt: (symbol: string) => `Máx. ${symbol} no corte`,
  },
  planeMissesModel: {
    en: "The plane does not cut the model.",
    de: "Die Ebene schneidet das Modell nicht.",
    fr: "Le plan ne coupe pas le modèle.",
    it: "Il piano non taglia il modello.",
    es: "El plano no corta el modelo.",
    pt: "O plano não corta o modelo.",
  },
  deleteSectionCut: {
    en: "Delete section cut",
    de: "Schnitt löschen",
    fr: "Supprimer la coupe",
    it: "Elimina sezione",
    es: "Eliminar corte",
    pt: "Excluir corte",
  },
  resultOfOtherMesh: {
    en: (values: number, nodes: number) =>
      `The result has ${values} displacement values for ${nodes} nodes; it belongs to a different mesh.`,
    de: (values: number, nodes: number) =>
      `Das Ergebnis hat ${values} Verschiebungswerte für ${nodes} Knoten; es gehört zu einem anderen Netz.`,
    fr: (values: number, nodes: number) =>
      `Le résultat a ${values} valeurs de déplacement pour ${nodes} nœuds ; il appartient à un autre maillage.`,
    it: (values: number, nodes: number) =>
      `Il risultato ha ${values} valori di spostamento per ${nodes} nodi; appartiene a un'altra mesh.`,
    es: (values: number, nodes: number) =>
      `El resultado tiene ${values} valores de desplazamiento para ${nodes} nodos; pertenece a otra malla.`,
    pt: (values: number, nodes: number) =>
      `O resultado tem ${values} valores de deslocamento para ${nodes} nós; ele pertence a outra malha.`,
  },
  noVonMises: {
    en: "The result has no von Mises stress.",
    de: "Das Ergebnis enthält keine Von-Mises-Spannung.",
    fr: "Le résultat ne contient pas de contrainte de von Mises.",
    it: "Il risultato non contiene la tensione di von Mises.",
    es: "El resultado no contiene la tensión de von Mises.",
    pt: "O resultado não contém a tensão de von Mises.",
  },
  noField: {
    en: (field: string) =>
      `The result has no ${`${field}`.toLowerCase()}; solve again to compute it.`,
    de: (field: string) =>
      `Das Ergebnis enthält kein Feld „${field}“; lösen Sie erneut, um es zu berechnen.`,
    fr: (field: string) =>
      `Le résultat ne contient pas le champ « ${field} » ; résolvez à nouveau pour le calculer.`,
    it: (field: string) =>
      `Il risultato non contiene il campo «${field}»; risolvi di nuovo per calcolarlo.`,
    es: (field: string) =>
      `El resultado no contiene el campo «${field}»; vuelve a resolver para calcularlo.`,
    pt: (field: string) =>
      `O resultado não contém o campo “${field}”; resolva novamente para calculá-lo.`,
  },
  noSurfaceTriangles: {
    en: "The mesh has no surface triangles to place a probe on",
    de: "Das Netz hat keine Oberflächendreiecke, auf die eine Sonde gesetzt werden kann",
    fr: "Le maillage n'a aucun triangle de surface où placer une sonde",
    it: "La mesh non ha triangoli di superficie su cui posizionare una sonda",
    es: "La malla no tiene triángulos de superficie donde colocar una sonda",
    pt: "A malha não tem triângulos de superfície para posicionar uma sonda",
  },
  noNodes: {
    en: "The mesh has no nodes.",
    de: "Das Netz hat keine Knoten.",
    fr: "Le maillage n'a aucun nœud.",
    it: "La mesh non ha nodi.",
    es: "La malla no tiene nodos.",
    pt: "A malha não tem nós.",
  },
  probeNodeGone: {
    en: (node: number) =>
      `Its triangle refers to node ${node}, which is not in the mesh`,
    de: (node: number) =>
      `Ihr Dreieck verweist auf Knoten ${node}, der nicht im Netz ist`,
    fr: (node: number) =>
      `Son triangle renvoie au nœud ${node}, absent du maillage`,
    it: (node: number) =>
      `Il suo triangolo fa riferimento al nodo ${node}, che non è nella mesh`,
    es: (node: number) =>
      `Su triángulo hace referencia al nodo ${node}, que no está en la malla`,
    pt: (node: number) =>
      `Seu triângulo se refere ao nó ${node}, que não está na malha`,
  },
  probeFaceGone: {
    en: "Its CAD face has no triangles on this mesh",
    de: "Ihre CAD-Fläche hat auf diesem Netz keine Dreiecke",
    fr: "Sa face CAO n'a aucun triangle sur ce maillage",
    it: "La sua faccia CAD non ha triangoli su questa mesh",
    es: "Su cara CAD no tiene triángulos en esta malla",
    pt: "Sua face CAD não tem triângulos nesta malha",
  },
  sectionStale: {
    en: (values: number, nodes: number) =>
      `displacement result carries ${values} values for ${nodes} nodes — the result is stale or belongs to a different mesh`,
    de: (values: number, nodes: number) =>
      `das Verschiebungsergebnis hat ${values} Werte für ${nodes} Knoten – es ist veraltet oder gehört zu einem anderen Netz`,
    fr: (values: number, nodes: number) =>
      `le résultat de déplacement a ${values} valeurs pour ${nodes} nœuds — il est périmé ou appartient à un autre maillage`,
    it: (values: number, nodes: number) =>
      `il risultato di spostamento ha ${values} valori per ${nodes} nodi — è superato o appartiene a un'altra mesh`,
    es: (values: number, nodes: number) =>
      `el resultado de desplazamiento tiene ${values} valores para ${nodes} nodos: está desactualizado o pertenece a otra malla`,
    pt: (values: number, nodes: number) =>
      `o resultado de deslocamento tem ${values} valores para ${nodes} nós — está desatualizado ou pertence a outra malha`,
  },
  percentile: {
    en: (percent: number) => `P${percent}`,
    de: (percent: number) => `P${percent}`,
    fr: (percent: number) => `P${percent}`,
    it: (percent: number) => `P${percent}`,
    es: (percent: number) => `P${percent}`,
    pt: (percent: number) => `P${percent}`,
  },
  percentileHint: {
    en: (percent: number) =>
      `${percent}th percentile by volume: ${100 - percent} % of the model is stressed above it. Unlike the max, it does not grow at a singularity when the mesh is refined.`,
    de: (percent: number) =>
      `${percent}. Perzentil nach Volumen: ${100 - percent} % des Modells sind höher beansprucht. Anders als das Maximum wächst es an einer Singularität nicht, wenn das Netz verfeinert wird.`,
    fr: (percent: number) =>
      `${percent}e centile en volume : ${100 - percent} % du modèle est plus sollicité. Contrairement au max., il ne croît pas à une singularité quand le maillage est raffiné.`,
    it: (percent: number) =>
      `${percent}° percentile per volume: il ${100 - percent} % del modello è sollecitato di più. A differenza del max, non cresce in una singolarità quando la mesh viene raffinata.`,
    es: (percent: number) =>
      `Percentil ${percent} por volumen: el ${100 - percent} % del modelo está más solicitado. A diferencia del máx., no crece en una singularidad al refinar la malla.`,
    pt: (percent: number) =>
      `Percentil ${percent} por volume: ${100 - percent} % do modelo está mais solicitado. Ao contrário do máx., não cresce numa singularidade quando a malha é refinada.`,
  },
  percentileUnreadable: {
    en: (reason: string) => `The percentiles cannot be read. ${reason}`,
    de: (reason: string) =>
      `Die Perzentile lassen sich nicht ablesen. ${reason}`,
    fr: (reason: string) => `Impossible de lire les centiles. ${reason}`,
    it: (reason: string) => `Impossibile leggere i percentili. ${reason}`,
    es: (reason: string) => `No se pueden leer los percentiles. ${reason}`,
    pt: (reason: string) => `Não é possível ler os percentis. ${reason}`,
  },
  percentileUnknownNode: {
    en: (element: number, node: number) =>
      `element ${element} references node ${node}, which the mesh does not have`,
    de: (element: number, node: number) =>
      `Element ${element} verweist auf Knoten ${node}, den das Netz nicht hat`,
    fr: (element: number, node: number) =>
      `l'élément ${element} référence le nœud ${node}, absent du maillage`,
    it: (element: number, node: number) =>
      `l'elemento ${element} fa riferimento al nodo ${node}, che la mesh non ha`,
    es: (element: number, node: number) =>
      `el elemento ${element} hace referencia al nodo ${node}, que la malla no tiene`,
    pt: (element: number, node: number) =>
      `o elemento ${element} referencia o nó ${node}, que a malha não tem`,
  },
  percentileNoThickness: {
    en: (element: number) =>
      `shell element ${element} has no thickness, so its volume is unknown`,
    de: (element: number) =>
      `Schalenelement ${element} hat keine Dicke, sein Volumen ist daher unbekannt`,
    fr: (element: number) =>
      `l'élément coque ${element} n'a pas d'épaisseur, son volume est donc inconnu`,
    it: (element: number) =>
      `l'elemento guscio ${element} non ha spessore, quindi il suo volume è ignoto`,
    es: (element: number) =>
      `el elemento lámina ${element} no tiene espesor, así que su volumen es desconocido`,
    pt: (element: number) =>
      `o elemento de casca ${element} não tem espessura, logo o seu volume é desconhecido`,
  },
  peakAt: {
    en: "Max at",
    de: "Max. bei",
    fr: "Max. en",
    it: "Max in",
    es: "Máx. en",
    pt: "Máx. em",
  },
  show: {
    en: "Show",
    de: "Zeigen",
    fr: "Afficher",
    it: "Mostra",
    es: "Mostrar",
    pt: "Mostrar",
  },
  peakSupport: {
    en: (name: string) => `support “${name}”`,
    de: (name: string) => `der Lagerung „${name}“`,
    fr: (name: string) => `l'appui « ${name} »`,
    it: (name: string) => `il vincolo «${name}»`,
    es: (name: string) => `el apoyo «${name}»`,
    pt: (name: string) => `o apoio «${name}»`,
  },
  peakLoad: {
    en: (name: string) => `load “${name}”`,
    de: (name: string) => `der Last „${name}“`,
    fr: (name: string) => `la charge « ${name} »`,
    it: (name: string) => `il carico «${name}»`,
    es: (name: string) => `la carga «${name}»`,
    pt: (name: string) => `a carga «${name}»`,
  },
  peakOnBoundary: {
    en: (places: string, p99: string | undefined) =>
      `On ${places}: likely a singularity. Use P99${p99 ? ` = ${p99}` : ""}.`,
    de: (places: string, p99: string | undefined) =>
      `An ${places}: wahrscheinlich eine Singularität. P99${p99 ? ` = ${p99}` : ""} verwenden.`,
    fr: (places: string, p99: string | undefined) =>
      `Sur ${places} : singularité probable. Utilisez P99${p99 ? ` = ${p99}` : ""}.`,
    it: (places: string, p99: string | undefined) =>
      `Presso ${places}: probabile singolarità. Usa P99${p99 ? ` = ${p99}` : ""}.`,
    es: (places: string, p99: string | undefined) =>
      `En ${places}: probable singularidad. Use P99${p99 ? ` = ${p99}` : ""}.`,
    pt: (places: string, p99: string | undefined) =>
      `Sobre ${places}: provável singularidade. Use P99${p99 ? ` = ${p99}` : ""}.`,
  },
  peakUnreadable: {
    en: (reason: string) => `The location of the max cannot be read. ${reason}`,
    de: (reason: string) =>
      `Der Ort des Maximums lässt sich nicht ablesen. ${reason}`,
    fr: (reason: string) => `Impossible de lire la position du max. ${reason}`,
    it: (reason: string) =>
      `Impossibile leggere la posizione del max. ${reason}`,
    es: (reason: string) => `No se puede leer la posición del máx. ${reason}`,
    pt: (reason: string) => `Não é possível ler a posição do máx. ${reason}`,
  },
  peakUnknownNode: {
    en: (owner: string, node: number) =>
      `${owner} refers to node ${node}, which the mesh does not have`,
    de: (owner: string, node: number) =>
      `${owner} verweist auf Knoten ${node}, den das Netz nicht hat`,
    fr: (owner: string, node: number) =>
      `${owner} référence le nœud ${node}, absent du maillage`,
    it: (owner: string, node: number) =>
      `${owner} fa riferimento al nodo ${node}, che la mesh non ha`,
    es: (owner: string, node: number) =>
      `${owner} hace referencia al nodo ${node}, que la malla no tiene`,
    pt: (owner: string, node: number) =>
      `${owner} referencia o nó ${node}, que a malha não tem`,
  },
  peakElement: {
    en: (element: number) => `Shell element ${element}`,
    de: (element: number) => `Schalenelement ${element}`,
    fr: (element: number) => `L'élément coque ${element}`,
    it: (element: number) => `L'elemento guscio ${element}`,
    es: (element: number) => `El elemento lámina ${element}`,
    pt: (element: number) => `O elemento de casca ${element}`,
  },
  sectionNoNodes: {
    en: "the model has no nodes to cut",
    de: "das Modell hat keine Knoten zum Schneiden",
    fr: "le modèle n'a aucun nœud à couper",
    it: "il modello non ha nodi da tagliare",
    es: "el modelo no tiene nodos que cortar",
    pt: "o modelo não tem nós para cortar",
  },
});
