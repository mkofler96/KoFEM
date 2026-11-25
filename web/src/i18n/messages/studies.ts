// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// Studies: adding one, picking its static case, and the mesh refinement study
// with its settings, progress, verdict and chart.
export const studiesMessages = defineMessages({
  staticKind: {
    en: "Static",
    de: "Statisch",
    fr: "Statique",
    it: "Statico",
    es: "Estático",
    pt: "Estático",
  },
  staticHint: {
    en: "Linear-elastic response to the supports and loads",
    de: "Linear-elastische Antwort auf Lagerungen und Lasten",
    fr: "Réponse élastique linéaire aux appuis et aux charges",
    it: "Risposta elastica lineare a vincoli e carichi",
    es: "Respuesta elástica lineal a los apoyos y las cargas",
    pt: "Resposta elástica linear aos apoios e cargas",
  },
  topOptKind: {
    en: "Topology optimization",
    de: "Topologieoptimierung",
    fr: "Optimisation topologique",
    it: "Ottimizzazione topologica",
    es: "Optimización topológica",
    pt: "Otimização topológica",
  },
  topOptNeedsStatic: {
    en: "Add a static study first — an optimization works on a static case",
    de: "Fügen Sie zuerst eine statische Studie hinzu – eine Optimierung arbeitet auf einem statischen Lastfall",
    fr: "Ajoutez d'abord une étude statique — une optimisation travaille sur un cas statique",
    it: "Aggiungi prima uno studio statico — un'ottimizzazione lavora su un caso statico",
    es: "Añade primero un estudio estático: una optimización trabaja sobre un caso estático",
    pt: "Adicione primeiro um estudo estático — uma otimização trabalha sobre um caso estático",
  },
  topOptHint: {
    en: "Material layout that best carries a static case",
    de: "Materialverteilung, die einen statischen Lastfall am besten trägt",
    fr: "Répartition de matière qui porte au mieux un cas statique",
    it: "Distribuzione di materiale che meglio sostiene un caso statico",
    es: "Distribución de material que mejor soporta un caso estático",
    pt: "Distribuição de material que melhor suporta um caso estático",
  },
  refinementKind: {
    en: "Mesh refinement",
    de: "Netzverfeinerung",
    fr: "Raffinement du maillage",
    it: "Raffinamento della mesh",
    es: "Refinamiento de malla",
    pt: "Refinamento de malha",
  },
  refinementNeedsStatic: {
    en: "Add a static study first — a refinement study checks a static case",
    de: "Fügen Sie zuerst eine statische Studie hinzu – eine Verfeinerungsstudie prüft einen statischen Lastfall",
    fr: "Ajoutez d'abord une étude statique — une étude de raffinement vérifie un cas statique",
    it: "Aggiungi prima uno studio statico — uno studio di raffinamento verifica un caso statico",
    es: "Añade primero un estudio estático: un estudio de refinamiento comprueba un caso estático",
    pt: "Adicione primeiro um estudo estático — um estudo de refinamento verifica um caso estático",
  },
  refinementHint: {
    en: "Solve a static case on finer meshes to check the result settles",
    de: "Einen statischen Lastfall auf feineren Netzen lösen, um zu prüfen, ob sich das Ergebnis einstellt",
    fr: "Résoudre un cas statique sur des maillages plus fins pour vérifier que le résultat se stabilise",
    it: "Risolvi un caso statico su mesh più fini per verificare che il risultato si stabilizzi",
    es: "Resolver un caso estático en mallas más finas para comprobar que el resultado se estabiliza",
    pt: "Resolver um caso estático em malhas mais finas para verificar se o resultado se estabiliza",
  },
  staticCase: {
    en: "Static case",
    de: "Statischer Lastfall",
    fr: "Cas statique",
    it: "Caso statico",
    es: "Caso estático",
    pt: "Caso estático",
  },
  cancel: {
    en: "Cancel",
    de: "Abbrechen",
    fr: "Annuler",
    it: "Annulla",
    es: "Cancelar",
    pt: "Cancelar",
  },
  addOptimization: {
    en: "Add optimization",
    de: "Optimierung hinzufügen",
    fr: "Ajouter l'optimisation",
    it: "Aggiungi ottimizzazione",
    es: "Añadir optimización",
    pt: "Adicionar otimização",
  },
  addRefinement: {
    en: "Add refinement study",
    de: "Verfeinerungsstudie hinzufügen",
    fr: "Ajouter l'étude de raffinement",
    it: "Aggiungi studio di raffinamento",
    es: "Añadir estudio de refinamiento",
    pt: "Adicionar estudo de refinamento",
  },
  deleteStudy: {
    en: "Delete study",
    de: "Studie löschen",
    fr: "Supprimer l'étude",
    it: "Elimina studio",
    es: "Eliminar estudio",
    pt: "Excluir estudo",
  },
  pickStaticStudy: {
    en: "— pick a static study —",
    de: "— statische Studie wählen —",
    fr: "— choisir une étude statique —",
    it: "— scegli uno studio statico —",
    es: "— elige un estudio estático —",
    pt: "— escolha um estudo estático —",
  },
  density: {
    en: "Density",
    de: "Dichte",
    fr: "Densité",
    it: "Densità",
    es: "Densidad",
    pt: "Densidade",
  },
  pickStaticToRefine: {
    en: "Pick the static study to refine.",
    de: "Wählen Sie die statische Studie, die verfeinert wird.",
    fr: "Choisissez l'étude statique à raffiner.",
    it: "Scegli lo studio statico da raffinare.",
    es: "Elige el estudio estático que refinar.",
    pt: "Escolha o estudo estático a refinar.",
  },
  notReady: {
    en: (study: string, reason: string) =>
      `${study} is not ready to solve: ${reason}.`,
    de: (study: string, reason: string) =>
      `${study} ist nicht bereit zum Lösen: ${reason}.`,
    fr: (study: string, reason: string) =>
      `${study} n'est pas prête à être résolue : ${reason}.`,
    it: (study: string, reason: string) =>
      `${study} non è pronto per la risoluzione: ${reason}.`,
    es: (study: string, reason: string) =>
      `${study} no está listo para resolverse: ${reason}.`,
    pt: (study: string, reason: string) =>
      `${study} não está pronto para ser resolvido: ${reason}.`,
  },
  studySettings: {
    en: "Study settings",
    de: "Studieneinstellungen",
    fr: "Paramètres de l'étude",
    it: "Impostazioni dello studio",
    es: "Ajustes del estudio",
    pt: "Configurações do estudo",
  },
  levels: {
    en: "Levels",
    de: "Stufen",
    fr: "Niveaux",
    it: "Livelli",
    es: "Niveles",
    pt: "Níveis",
  },
  refineBy: {
    en: "Refine by",
    de: "Verfeinern um",
    fr: "Raffiner d'un facteur",
    it: "Raffina di",
    es: "Refinar por",
    pt: "Refinar por",
  },
  targetError: {
    en: "Target error (%)",
    de: "Zielfehler (%)",
    fr: "Erreur cible (%)",
    it: "Errore obiettivo (%)",
    es: "Error objetivo (%)",
    pt: "Erro alvo (%)",
  },
  elementOrder: {
    en: "Element order",
    de: "Elementordnung",
    fr: "Ordre des éléments",
    it: "Ordine degli elementi",
    es: "Orden de los elementos",
    pt: "Ordem dos elementos",
  },
  quadratic: {
    en: "Quadratic (2nd order)",
    de: "Quadratisch (2. Ordnung)",
    fr: "Quadratique (2e ordre)",
    it: "Quadratico (2° ordine)",
    es: "Cuadrático (2.º orden)",
    pt: "Quadrático (2ª ordem)",
  },
  linear: {
    en: "Linear (1st order)",
    de: "Linear (1. Ordnung)",
    fr: "Linéaire (1er ordre)",
    it: "Lineare (1° ordine)",
    es: "Lineal (1.er orden)",
    pt: "Linear (1ª ordem)",
  },
  runningStudy: {
    en: "Running study…",
    de: "Studie läuft…",
    fr: "Étude en cours…",
    it: "Studio in corso…",
    es: "Ejecutando estudio…",
    pt: "Executando estudo…",
  },
  runStudy: {
    en: "▶  Run mesh refinement study",
    de: "▶  Netzverfeinerungsstudie starten",
    fr: "▶  Lancer l'étude de raffinement",
    it: "▶  Avvia studio di raffinamento",
    es: "▶  Ejecutar estudio de refinamiento",
    pt: "▶  Executar estudo de refinamento",
  },
  plan: {
    en: (sizes: string) =>
      `Solves at ${sizes} mm and checks that the result settles.`,
    de: (sizes: string) =>
      `Löst bei ${sizes} mm und prüft, ob sich das Ergebnis einstellt.`,
    fr: (sizes: string) =>
      `Résout à ${sizes} mm et vérifie que le résultat se stabilise.`,
    it: (sizes: string) =>
      `Risolve a ${sizes} mm e verifica che il risultato si stabilizzi.`,
    es: (sizes: string) =>
      `Resuelve a ${sizes} mm y comprueba que el resultado se estabiliza.`,
    pt: (sizes: string) =>
      `Resolve em ${sizes} mm e verifica se o resultado se estabiliza.`,
  },
  listTwo: {
    en: (head: string, last: string) => `${head} and ${last}`,
    de: (head: string, last: string) => `${head} und ${last}`,
    fr: (head: string, last: string) => `${head} et ${last}`,
    it: (head: string, last: string) => `${head} e ${last}`,
    es: (head: string, last: string) => `${head} y ${last}`,
    pt: (head: string, last: string) => `${head} e ${last}`,
  },
  meshing: {
    en: "Meshing…",
    de: "Vernetzen…",
    fr: "Maillage…",
    it: "Generazione mesh…",
    es: "Mallando…",
    pt: "Gerando malha…",
  },
  solving: {
    en: "Solving…",
    de: "Lösen…",
    fr: "Résolution…",
    it: "Risoluzione…",
    es: "Resolviendo…",
    pt: "Resolvendo…",
  },
  waiting: {
    en: "Waiting",
    de: "Wartet",
    fr: "En attente",
    it: "In attesa",
    es: "En espera",
    pt: "Aguardando",
  },
  openLevel: {
    en: "Open this level in 3D",
    de: "Diese Stufe in 3D öffnen",
    fr: "Ouvrir ce niveau en 3D",
    it: "Apri questo livello in 3D",
    es: "Abrir este nivel en 3D",
    pt: "Abrir este nível em 3D",
  },
  elements: {
    en: (count: string) => `${count} elements`,
    de: (count: string) => `${count} Elemente`,
    fr: (count: string) => `${count} éléments`,
    it: (count: string) => `${count} elementi`,
    es: (count: string) => `${count} elementos`,
    pt: (count: string) => `${count} elementos`,
  },
  currentMesh: {
    en: " · current mesh",
    de: " · aktuelles Netz",
    fr: " · maillage actuel",
    it: " · mesh attuale",
    es: " · malla actual",
    pt: " · malha atual",
  },
  stressRising: {
    en: "The peak stress keeps rising as the mesh refines: a sharp corner, support or point load. Judge the stress away from it.",
    de: "Die Spitzenspannung steigt bei jeder Verfeinerung weiter: eine scharfe Ecke, Lagerung oder Punktlast. Beurteilen Sie die Spannung abseits davon.",
    fr: "La contrainte maximale continue d'augmenter à chaque raffinement : un angle vif, un appui ou une charge ponctuelle. Évaluez la contrainte à l'écart de ce point.",
    it: "La tensione di picco continua a crescere a ogni raffinamento: uno spigolo vivo, un vincolo o un carico concentrato. Valuta la tensione lontano da lì.",
    es: "La tensión máxima sigue subiendo al refinar la malla: una esquina viva, un apoyo o una carga puntual. Evalúa la tensión lejos de ese punto.",
    pt: "A tensão de pico continua subindo a cada refinamento: um canto vivo, um apoio ou uma carga pontual. Avalie a tensão longe desse ponto.",
  },
  convergenceChart: {
    en: "Convergence chart",
    de: "Konvergenzdiagramm",
    fr: "Graphique de convergence",
    it: "Grafico di convergenza",
    es: "Gráfico de convergencia",
    pt: "Gráfico de convergência",
  },
  stale: {
    en: "The model changed since this study, so its levels no longer match it. Run the study again to open them.",
    de: "Das Modell hat sich seit dieser Studie geändert, ihre Stufen passen also nicht mehr dazu. Starten Sie die Studie erneut, um sie zu öffnen.",
    fr: "Le modèle a changé depuis cette étude : ses niveaux ne lui correspondent plus. Relancez l'étude pour les ouvrir.",
    it: "Il modello è cambiato dopo questo studio, quindi i suoi livelli non corrispondono più. Ripeti lo studio per aprirli.",
    es: "El modelo cambió desde este estudio, así que sus niveles ya no le corresponden. Vuelve a ejecutar el estudio para abrirlos.",
    pt: "O modelo mudou desde este estudo, então seus níveis não correspondem mais a ele. Execute o estudo novamente para abri-los.",
  },
  openingLevel: {
    en: "Opening a level makes it the model's mesh.",
    de: "Wird eine Stufe geöffnet, wird sie zum Netz des Modells.",
    fr: "Ouvrir un niveau en fait le maillage du modèle.",
    it: "Aprire un livello lo rende la mesh del modello.",
    es: "Abrir un nivel lo convierte en la malla del modelo.",
    pt: "Abrir um nível o torna a malha do modelo.",
  },
  ratioHalves: {
    en: "2 (halves the size)",
    de: "2 (halbiert die Größe)",
    fr: "2 (divise la taille par deux)",
    it: "2 (dimezza la dimensione)",
    es: "2 (reduce el tamaño a la mitad)",
    pt: "2 (reduz o tamanho pela metade)",
  },
  levelsError: {
    en: (min: number, max: number) =>
      `Levels is a whole number from ${min} to ${max}.`,
    de: (min: number, max: number) =>
      `Stufen ist eine ganze Zahl von ${min} bis ${max}.`,
    fr: (min: number, max: number) =>
      `Le nombre de niveaux est un entier de ${min} à ${max}.`,
    it: (min: number, max: number) =>
      `I livelli sono un numero intero da ${min} a ${max}.`,
    es: (min: number, max: number) =>
      `Los niveles son un número entero de ${min} a ${max}.`,
    pt: (min: number, max: number) =>
      `Níveis é um número inteiro de ${min} a ${max}.`,
  },
  ratioError: {
    en: (min: number, max: number) =>
      `The ratio is between ${min} and ${max}: above 1 to refine, at most 2 to keep the finest mesh solvable.`,
    de: (min: number, max: number) =>
      `Das Verhältnis liegt zwischen ${min} und ${max}: über 1, um zu verfeinern, höchstens 2, damit das feinste Netz lösbar bleibt.`,
    fr: (min: number, max: number) =>
      `Le rapport est compris entre ${min} et ${max} : au-dessus de 1 pour raffiner, au plus 2 pour que le maillage le plus fin reste soluble.`,
    it: (min: number, max: number) =>
      `Il rapporto è tra ${min} e ${max}: sopra 1 per raffinare, al massimo 2 perché la mesh più fine resti risolvibile.`,
    es: (min: number, max: number) =>
      `La relación está entre ${min} y ${max}: por encima de 1 para refinar, como mucho 2 para que la malla más fina siga siendo resoluble.`,
    pt: (min: number, max: number) =>
      `A razão fica entre ${min} e ${max}: acima de 1 para refinar, no máximo 2 para que a malha mais fina continue solucionável.`,
  },
  toleranceError: {
    en: (min: number, max: number) => `The target is ${min} to ${max} %.`,
    de: (min: number, max: number) =>
      `Das Ziel liegt zwischen ${min} und ${max} %.`,
    fr: (min: number, max: number) =>
      `La cible est comprise entre ${min} et ${max} %.`,
    it: (min: number, max: number) => `L'obiettivo è tra ${min} e ${max} %.`,
    es: (min: number, max: number) =>
      `El objetivo está entre ${min} y ${max} %.`,
    pt: (min: number, max: number) => `A meta fica entre ${min} e ${max} %.`,
  },
  movedNothing: {
    en: (size: string) =>
      `The solve at ${size} mm moved nothing (max displacement 0): the loads act only where the supports hold the part. Check the supports and loads.`,
    de: (size: string) =>
      `Die Berechnung bei ${size} mm hat nichts verschoben (max. Verschiebung 0): die Lasten wirken nur dort, wo die Lagerungen das Teil halten. Prüfen Sie Lagerungen und Lasten.`,
    fr: (size: string) =>
      `Le calcul à ${size} mm n'a rien déplacé (déplacement max. 0) : les charges n'agissent que là où les appuis tiennent la pièce. Vérifiez les appuis et les charges.`,
    it: (size: string) =>
      `Il calcolo a ${size} mm non ha spostato nulla (spostamento max 0): i carichi agiscono solo dove i vincoli tengono il pezzo. Controlla vincoli e carichi.`,
    es: (size: string) =>
      `El cálculo a ${size} mm no desplazó nada (desplazamiento máx. 0): las cargas solo actúan donde los apoyos sujetan la pieza. Revisa los apoyos y las cargas.`,
    pt: (size: string) =>
      `A análise em ${size} mm não deslocou nada (deslocamento máx. 0): as cargas atuam apenas onde os apoios seguram a peça. Verifique os apoios e as cargas.`,
  },
  addedBody: {
    en: (size: string, body: number) =>
      `The mesh at ${size} mm added body ${body}: choose its material in the Geometry step, then run the study again.`,
    de: (size: string, body: number) =>
      `Das Netz bei ${size} mm hat Körper ${body} hinzugefügt: wählen Sie seinen Werkstoff im Schritt Geometrie und starten Sie die Studie erneut.`,
    fr: (size: string, body: number) =>
      `Le maillage à ${size} mm a ajouté le corps ${body} : choisissez son matériau à l'étape Géométrie, puis relancez l'étude.`,
    it: (size: string, body: number) =>
      `La mesh a ${size} mm ha aggiunto il corpo ${body}: scegli il suo materiale nel passo Geometria, poi ripeti lo studio.`,
    es: (size: string, body: number) =>
      `La malla a ${size} mm añadió el cuerpo ${body}: elige su material en el paso Geometría y vuelve a ejecutar el estudio.`,
    pt: (size: string, body: number) =>
      `A malha em ${size} mm adicionou o corpo ${body}: escolha o material dele na etapa Geometria e execute o estudo novamente.`,
  },
  addedBodies: {
    en: (size: string, bodies: string) =>
      `The mesh at ${size} mm added bodies ${bodies}: choose their materials in the Geometry step, then run the study again.`,
    de: (size: string, bodies: string) =>
      `Das Netz bei ${size} mm hat die Körper ${bodies} hinzugefügt: wählen Sie ihre Werkstoffe im Schritt Geometrie und starten Sie die Studie erneut.`,
    fr: (size: string, bodies: string) =>
      `Le maillage à ${size} mm a ajouté les corps ${bodies} : choisissez leurs matériaux à l'étape Géométrie, puis relancez l'étude.`,
    it: (size: string, bodies: string) =>
      `La mesh a ${size} mm ha aggiunto i corpi ${bodies}: scegli i loro materiali nel passo Geometria, poi ripeti lo studio.`,
    es: (size: string, bodies: string) =>
      `La malla a ${size} mm añadió los cuerpos ${bodies}: elige sus materiales en el paso Geometría y vuelve a ejecutar el estudio.`,
    pt: (size: string, bodies: string) =>
      `A malha em ${size} mm adicionou os corpos ${bodies}: escolha os materiais deles na etapa Geometria e execute o estudo novamente.`,
  },
  converged: {
    en: (error: string) => `Converged: max |U| within ${error}`,
    de: (error: string) => `Konvergiert: max |U| innerhalb ${error}`,
    fr: (error: string) => `Convergé : max |U| à ${error} près`,
    it: (error: string) => `A convergenza: max |U| entro ${error}`,
    es: (error: string) => `Convergió: max |U| dentro de ${error}`,
    pt: (error: string) => `Convergiu: max |U| dentro de ${error}`,
  },
  notConverged: {
    en: (error: string, target: string) =>
      `Not converged: max |U| still ${error} off (target ${target} %)`,
    de: (error: string, target: string) =>
      `Nicht konvergiert: max |U| noch ${error} entfernt (Ziel ${target} %)`,
    fr: (error: string, target: string) =>
      `Non convergé : max |U| encore à ${error} (cible ${target} %)`,
    it: (error: string, target: string) =>
      `Non a convergenza: max |U| ancora a ${error} (obiettivo ${target} %)`,
    es: (error: string, target: string) =>
      `No convergió: max |U| aún a ${error} (objetivo ${target} %)`,
    pt: (error: string, target: string) =>
      `Não convergiu: max |U| ainda a ${error} (meta ${target} %)`,
  },
  noGeometry: {
    en: "The study re-meshes the geometry, and this model has none (an opened analysis keeps only its mesh). Re-import the STEP file to run it.",
    de: "Die Studie vernetzt die Geometrie neu, und dieses Modell hat keine (eine geöffnete Analyse behält nur ihr Netz). Importieren Sie die STEP-Datei neu, um sie zu starten.",
    fr: "L'étude remaille la géométrie, et ce modèle n'en a pas (une analyse ouverte ne garde que son maillage). Réimportez le fichier STEP pour la lancer.",
    it: "Lo studio rigenera la mesh della geometria, e questo modello non ne ha (un'analisi aperta conserva solo la sua mesh). Reimporta il file STEP per avviarlo.",
    es: "El estudio vuelve a mallar la geometría, y este modelo no la tiene (un análisis abierto solo conserva su malla). Vuelve a importar el archivo STEP para ejecutarlo.",
    pt: "O estudo gera novamente a malha da geometria, e este modelo não tem geometria (uma análise aberta guarda só a malha). Importe o arquivo STEP novamente para executá-lo.",
  },
  notFaces: {
    en: (groups: string) =>
      `Only supports, loads and couplings picked as whole CAD faces follow onto a new mesh. Pick these again as faces to run the study: ${groups}.`,
    de: (groups: string) =>
      `Nur Lagerungen, Lasten und Kopplungen, die als ganze CAD-Flächen gewählt wurden, gehen auf ein neues Netz über. Wählen Sie diese erneut als Flächen, um die Studie zu starten: ${groups}.`,
    fr: (groups: string) =>
      `Seuls les appuis, charges et couplages sélectionnés comme faces CAO entières suivent sur un nouveau maillage. Sélectionnez-les à nouveau comme faces pour lancer l'étude : ${groups}.`,
    it: (groups: string) =>
      `Solo vincoli, carichi e accoppiamenti scelti come facce CAD intere seguono su una nuova mesh. Selezionali di nuovo come facce per avviare lo studio: ${groups}.`,
    es: (groups: string) =>
      `Solo los apoyos, cargas y acoplamientos seleccionados como caras CAD completas pasan a una malla nueva. Vuelve a seleccionarlos como caras para ejecutar el estudio: ${groups}.`,
    pt: (groups: string) =>
      `Apenas apoios, cargas e acoplamentos selecionados como faces CAD inteiras passam para uma malha nova. Selecione-os novamente como faces para executar o estudo: ${groups}.`,
  },
  settingsInvalid: {
    en: (errors: string) => `The study settings are invalid: ${errors}`,
    de: (errors: string) => `Die Studieneinstellungen sind ungültig: ${errors}`,
    fr: (errors: string) =>
      `Les paramètres de l'étude ne sont pas valides : ${errors}`,
    it: (errors: string) =>
      `Le impostazioni dello studio non sono valide: ${errors}`,
    es: (errors: string) => `Los ajustes del estudio no son válidos: ${errors}`,
    pt: (errors: string) =>
      `As configurações do estudo são inválidas: ${errors}`,
  },
  modelChanged: {
    en: "The model changed while the study ran (a material, body, support, load, coupling or solver setting). Run the study again to compare levels of one model.",
    de: "Das Modell hat sich während der Studie geändert (ein Werkstoff, Körper, eine Lagerung, Last, Kopplung oder Löser-Einstellung). Starten Sie die Studie erneut, um Stufen eines Modells zu vergleichen.",
    fr: "Le modèle a changé pendant l'étude (un matériau, un corps, un appui, une charge, un couplage ou un paramètre du solveur). Relancez l'étude pour comparer les niveaux d'un même modèle.",
    it: "Il modello è cambiato durante lo studio (un materiale, corpo, vincolo, carico, accoppiamento o impostazione del solutore). Ripeti lo studio per confrontare livelli di un unico modello.",
    es: "El modelo cambió mientras se ejecutaba el estudio (un material, cuerpo, apoyo, carga, acoplamiento o ajuste del solucionador). Vuelve a ejecutar el estudio para comparar niveles de un mismo modelo.",
    pt: "O modelo mudou durante o estudo (um material, corpo, apoio, carga, acoplamento ou configuração do solucionador). Execute o estudo novamente para comparar níveis de um mesmo modelo.",
  },
  levelOf: {
    en: (level: number, levels: number) => `Level ${level} of ${levels}`,
    de: (level: number, levels: number) => `Stufe ${level} von ${levels}`,
    fr: (level: number, levels: number) => `Niveau ${level} sur ${levels}`,
    it: (level: number, levels: number) => `Livello ${level} di ${levels}`,
    es: (level: number, levels: number) => `Nivel ${level} de ${levels}`,
    pt: (level: number, levels: number) => `Nível ${level} de ${levels}`,
  },
  tooManyNodes: {
    en: (size: string, nodes: string, budget: string) =>
      `The mesh at ${size} mm would have about ${nodes} nodes, more than a browser solves comfortably (${budget}).`,
    de: (size: string, nodes: string, budget: string) =>
      `Das Netz bei ${size} mm hätte etwa ${nodes} Knoten, mehr als ein Browser bequem löst (${budget}).`,
    fr: (size: string, nodes: string, budget: string) =>
      `Le maillage à ${size} mm aurait environ ${nodes} nœuds, plus qu'un navigateur ne résout confortablement (${budget}).`,
    it: (size: string, nodes: string, budget: string) =>
      `La mesh a ${size} mm avrebbe circa ${nodes} nodi, più di quanti un browser risolva comodamente (${budget}).`,
    es: (size: string, nodes: string, budget: string) =>
      `La malla a ${size} mm tendría unos ${nodes} nodos, más de los que un navegador resuelve con holgura (${budget}).`,
    pt: (size: string, nodes: string, budget: string) =>
      `A malha em ${size} mm teria cerca de ${nodes} nós, mais do que um navegador resolve com folga (${budget}).`,
  },
  coarsen: {
    en: (note: string) =>
      `${note} Coarsen the mesh to run the study from a coarser start.`,
    de: (note: string) =>
      `${note} Vergröbern Sie das Netz, um die Studie von einem gröberen Start aus zu beginnen.`,
    fr: (note: string) =>
      `${note} Grossissez le maillage pour lancer l'étude à partir d'un départ plus grossier.`,
    it: (note: string) =>
      `${note} Rendi la mesh più grossolana per avviare lo studio da un punto di partenza più grossolano.`,
    es: (note: string) =>
      `${note} Usa una malla más gruesa para empezar el estudio desde un punto más grueso.`,
    pt: (note: string) =>
      `${note} Use uma malha mais grossa para começar o estudo de um ponto mais grosso.`,
  },
  stoppedAfter: {
    en: (levels: number, note: string) =>
      `Stopped after ${levels} levels. ${note}`,
    de: (levels: number, note: string) =>
      `Nach ${levels} Stufen angehalten. ${note}`,
    fr: (levels: number, note: string) =>
      `Arrêtée après ${levels} niveaux. ${note}`,
    it: (levels: number, note: string) =>
      `Fermato dopo ${levels} livelli. ${note}`,
    es: (levels: number, note: string) =>
      `Detenido tras ${levels} niveles. ${note}`,
    pt: (levels: number, note: string) =>
      `Parado após ${levels} níveis. ${note}`,
  },
  meshingAt: {
    en: (level: string, size: string) => `${level} · meshing at ${size} mm`,
    de: (level: string, size: string) => `${level} · Vernetzen bei ${size} mm`,
    fr: (level: string, size: string) => `${level} · maillage à ${size} mm`,
    it: (level: string, size: string) =>
      `${level} · generazione mesh a ${size} mm`,
    es: (level: string, size: string) => `${level} · mallando a ${size} mm`,
    pt: (level: string, size: string) =>
      `${level} · gerando malha em ${size} mm`,
  },
  solvingNodes: {
    en: (level: string, nodes: string) => `${level} · solving ${nodes} nodes`,
    de: (level: string, nodes: string) =>
      `${level} · Lösen von ${nodes} Knoten`,
    fr: (level: string, nodes: string) =>
      `${level} · résolution de ${nodes} nœuds`,
    it: (level: string, nodes: string) =>
      `${level} · risoluzione di ${nodes} nodi`,
    es: (level: string, nodes: string) =>
      `${level} · resolviendo ${nodes} nodos`,
    pt: (level: string, nodes: string) => `${level} · resolvendo ${nodes} nós`,
  },
  overlaps: {
    en: (size: string) =>
      `The mesh at ${size} mm found overlapping bodies — see the Mesh step.`,
    de: (size: string) =>
      `Das Netz bei ${size} mm enthält sich überlappende Körper – siehe Schritt Netz.`,
    fr: (size: string) =>
      `Le maillage à ${size} mm a trouvé des corps qui se chevauchent — voir l'étape Maillage.`,
    it: (size: string) =>
      `La mesh a ${size} mm ha trovato corpi sovrapposti — vedi il passo Mesh.`,
    es: (size: string) =>
      `La malla a ${size} mm encontró cuerpos superpuestos: consulta el paso Malla.`,
    pt: (size: string) =>
      `A malha em ${size} mm encontrou corpos sobrepostos — veja a etapa Malha.`,
  },
  groupsLost: {
    en: (size: string) =>
      `Supports or loads did not follow onto the mesh at ${size} mm.`,
    de: (size: string) =>
      `Lagerungen oder Lasten sind nicht auf das Netz bei ${size} mm übergegangen.`,
    fr: (size: string) =>
      `Des appuis ou des charges n'ont pas suivi sur le maillage à ${size} mm.`,
    it: (size: string) =>
      `Vincoli o carichi non sono passati sulla mesh a ${size} mm.`,
    es: (size: string) =>
      `Algunos apoyos o cargas no pasaron a la malla a ${size} mm.`,
    pt: (size: string) =>
      `Apoios ou cargas não passaram para a malha em ${size} mm.`,
  },
  displacement: {
    en: "Displacement",
    de: "Verschiebung",
    fr: "Déplacement",
    it: "Spostamento",
    es: "Desplazamiento",
    pt: "Deslocamento",
  },
  stress: {
    en: "Stress",
    de: "Spannung",
    fr: "Contrainte",
    it: "Tensione",
    es: "Tensión",
    pt: "Tensão",
  },
  chartField: {
    en: "Chart field",
    de: "Diagrammgröße",
    fr: "Grandeur du graphique",
    it: "Grandezza del grafico",
    es: "Magnitud del gráfico",
    pt: "Grandeza do gráfico",
  },
  studyStopped: {
    en: "The study stopped — see the panel",
    de: "Die Studie wurde angehalten – siehe Seitenleiste",
    fr: "L'étude s'est arrêtée — voir le panneau",
    it: "Lo studio si è fermato — vedi il pannello",
    es: "El estudio se detuvo: consulta el panel",
    pt: "O estudo parou — veja o painel",
  },
  firstLevel: {
    en: "The first level is on its way…",
    de: "Die erste Stufe ist unterwegs…",
    fr: "Le premier niveau est en cours…",
    it: "Il primo livello è in arrivo…",
    es: "El primer nivel está en camino…",
    pt: "O primeiro nível está a caminho…",
  },
  noLevel: {
    en: "No level to plot.",
    de: "Keine Stufe zum Darstellen.",
    fr: "Aucun niveau à tracer.",
    it: "Nessun livello da tracciare.",
    es: "No hay ningún nivel que trazar.",
    pt: "Nenhum nível para plotar.",
  },
  againstElements: {
    en: (axis: string) => `${axis} against element count`,
    de: (axis: string) => `${axis} über der Elementanzahl`,
    fr: (axis: string) => `${axis} en fonction du nombre d'éléments`,
    it: (axis: string) => `${axis} in funzione del numero di elementi`,
    es: (axis: string) => `${axis} frente al número de elementos`,
    pt: (axis: string) => `${axis} em função do número de elementos`,
  },
  openLevelAt: {
    en: (size: string) => `Open the ${size} mm level in 3D`,
    de: (size: string) => `Die Stufe ${size} mm in 3D öffnen`,
    fr: (size: string) => `Ouvrir le niveau ${size} mm en 3D`,
    it: (size: string) => `Apri il livello ${size} mm in 3D`,
    es: (size: string) => `Abrir el nivel de ${size} mm en 3D`,
    pt: (size: string) => `Abrir o nível de ${size} mm em 3D`,
  },
  levelAt: {
    en: (size: string) => `${size} mm level`,
    de: (size: string) => `Stufe ${size} mm`,
    fr: (size: string) => `Niveau ${size} mm`,
    it: (size: string) => `Livello ${size} mm`,
    es: (size: string) => `Nivel de ${size} mm`,
    pt: (size: string) => `Nível de ${size} mm`,
  },
  elementsAxis: {
    en: "Elements (log scale)",
    de: "Elemente (log. Skala)",
    fr: "Éléments (échelle log.)",
    it: "Elementi (scala log.)",
    es: "Elementos (escala log.)",
    pt: "Elementos (escala log.)",
  },
  extrapolated: {
    en: (value: string, target: string) =>
      `Extrapolated ${value} mm · ${target}`,
    de: (value: string, target: string) =>
      `Extrapoliert ${value} mm · ${target}`,
    fr: (value: string, target: string) => `Extrapolé ${value} mm · ${target}`,
    it: (value: string, target: string) =>
      `Estrapolato ${value} mm · ${target}`,
    es: (value: string, target: string) =>
      `Extrapolado ${value} mm · ${target}`,
    pt: (value: string, target: string) =>
      `Extrapolado ${value} mm · ${target}`,
  },
  ofFinest: {
    en: (target: string) => `${target} of the finest level`,
    de: (target: string) => `${target} der feinsten Stufe`,
    fr: (target: string) => `${target} du niveau le plus fin`,
    it: (target: string) => `${target} del livello più fine`,
    es: (target: string) => `${target} del nivel más fino`,
    pt: (target: string) => `${target} do nível mais fino`,
  },
});
