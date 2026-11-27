// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// A static study: its pre-flight checks, the solver settings and the run, the
// solver's notes on the chosen method, and the engine and solver failures the
// panels show.
export const solveMessages = defineMessages({
  preflight: {
    en: "Pre-flight check",
    de: "Vorabprüfung",
    fr: "Vérification préalable",
    it: "Controllo preliminare",
    es: "Comprobación previa",
    pt: "Verificação prévia",
  },
  checkPassed: {
    en: "passed",
    de: "bestanden",
    fr: "réussi",
    it: "superato",
    es: "correcto",
    pt: "aprovado",
  },
  checkFailed: {
    en: "failed",
    de: "nicht bestanden",
    fr: "échoué",
    it: "non superato",
    es: "fallido",
    pt: "reprovado",
  },
  solverSettings: {
    en: "Solver settings",
    de: "Löser-Einstellungen",
    fr: "Paramètres du solveur",
    it: "Impostazioni del solutore",
    es: "Ajustes del solucionador",
    pt: "Configurações do solucionador",
  },
  step: {
    en: "Step",
    de: "Schritt",
    fr: "Étape",
    it: "Passo",
    es: "Paso",
    pt: "Etapa",
  },
  staticStep: {
    en: (study: string) => `Static · ${study}`,
    de: (study: string) => `Statisch · ${study}`,
    fr: (study: string) => `Statique · ${study}`,
    it: (study: string) => `Statico · ${study}`,
    es: (study: string) => `Estático · ${study}`,
    pt: (study: string) => `Estático · ${study}`,
  },
  solver: {
    en: "Solver",
    de: "Löser",
    fr: "Solveur",
    it: "Solutore",
    es: "Solucionador",
    pt: "Solucionador",
  },
  solverHint: {
    en: "Both solve the same equations to the same accuracy. AMG multigrid needs far fewer iterations on large and thin-walled models.",
    de: "Beide lösen dieselben Gleichungen mit derselben Genauigkeit. AMG-Mehrgitter braucht bei großen und dünnwandigen Modellen weit weniger Iterationen.",
    fr: "Les deux résolvent les mêmes équations avec la même précision. Le multigrille AMG demande beaucoup moins d'itérations sur les modèles grands et à parois minces.",
    it: "Entrambi risolvono le stesse equazioni con la stessa precisione. Il multigrid AMG richiede molte meno iterazioni su modelli grandi e a parete sottile.",
    es: "Ambos resuelven las mismas ecuaciones con la misma precisión. El multimalla AMG necesita muchas menos iteraciones en modelos grandes y de pared delgada.",
    pt: "Ambos resolvem as mesmas equações com a mesma precisão. O multigrid AMG precisa de muito menos iterações em modelos grandes e de parede fina.",
  },
  methodAmg: {
    en: "AMG multigrid (recommended)",
    de: "AMG-Mehrgitter (empfohlen)",
    fr: "Multigrille AMG (recommandé)",
    it: "Multigrid AMG (consigliato)",
    es: "Multimalla AMG (recomendado)",
    pt: "Multigrid AMG (recomendado)",
  },
  methodGaussSeidel: {
    en: "Gauss–Seidel",
    de: "Gauß-Seidel",
    fr: "Gauss–Seidel",
    it: "Gauss–Seidel",
    es: "Gauss–Seidel",
    pt: "Gauss–Seidel",
  },
  largeDeformation: {
    en: "Large deformation",
    de: "Große Verformungen",
    fr: "Grandes déformations",
    it: "Grandi deformazioni",
    es: "Grandes deformaciones",
    pt: "Grandes deformações",
  },
  largeDeformationHint: {
    en: "Follow large displacements and rotations. Slower than the linear solve.",
    de: "Große Verschiebungen und Drehungen verfolgen. Langsamer als die lineare Lösung.",
    fr: "Suivre les grands déplacements et rotations. Plus lent que le calcul linéaire.",
    it: "Segue grandi spostamenti e rotazioni. Più lento della soluzione lineare.",
    es: "Sigue grandes desplazamientos y rotaciones. Más lento que el cálculo lineal.",
    pt: "Acompanha grandes deslocamentos e rotações. Mais lento que a solução linear.",
  },
  largeDeformationNote: {
    en: "Materials act as Neo-Hookean with the same E and ν. Loads keep their direction. The solve stops if the part buckles.",
    de: "Werkstoffe verhalten sich neo-hookesch mit demselben E und ν. Lasten behalten ihre Richtung. Die Lösung bricht ab, wenn das Bauteil knickt.",
    fr: "Les matériaux se comportent en néo-hookéen avec les mêmes E et ν. Les charges gardent leur direction. Le calcul s'arrête si la pièce flambe.",
    it: "I materiali si comportano come neo-hookeani con gli stessi E e ν. I carichi mantengono la loro direzione. La soluzione si ferma se il pezzo si instabilizza.",
    es: "Los materiales se comportan como neo-hookeanos con los mismos E y ν. Las cargas mantienen su dirección. El cálculo se detiene si la pieza pandea.",
    pt: "Os materiais se comportam como neo-hookeanos com os mesmos E e ν. As cargas mantêm sua direção. A solução para se a peça flambar.",
  },
  loadIncrements: {
    en: "Load increments",
    de: "Laststufen",
    fr: "Incréments de charge",
    it: "Incrementi di carico",
    es: "Incrementos de carga",
    pt: "Incrementos de carga",
  },
  loadIncrementsInvalid: {
    en: (max: number) => `Enter a whole number from 1 to ${max}.`,
    de: (max: number) => `Geben Sie eine ganze Zahl von 1 bis ${max} ein.`,
    fr: (max: number) => `Saisissez un nombre entier de 1 à ${max}.`,
    it: (max: number) => `Inserisci un numero intero da 1 a ${max}.`,
    es: (max: number) => `Introduce un número entero de 1 a ${max}.`,
    pt: (max: number) => `Digite um número inteiro de 1 a ${max}.`,
  },
  output: {
    en: "Output",
    de: "Ausgabe",
    fr: "Sorties",
    it: "Output",
    es: "Salida",
    pt: "Saída",
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
  solving: {
    en: "Solving…",
    de: "Wird gelöst…",
    fr: "Résolution…",
    it: "Risoluzione…",
    es: "Resolviendo…",
    pt: "Resolvendo…",
  },
  runStaticSolve: {
    en: "▶  Run static solve",
    de: "▶  Statische Berechnung starten",
    fr: "▶  Lancer le calcul statique",
    it: "▶  Avvia analisi statica",
    es: "▶  Ejecutar cálculo estático",
    pt: "▶  Executar análise estática",
  },
  noMaterial: {
    en: "No material assigned",
    de: "Kein Werkstoff zugewiesen",
    fr: "Aucun matériau affecté",
    it: "Nessun materiale assegnato",
    es: "Ningún material asignado",
    pt: "Nenhum material atribuído",
  },
  deletedMaterial: {
    en: "A body references a deleted material — reassign body materials",
    de: "Ein Körper verweist auf einen gelöschten Werkstoff – Werkstoffe der Körper neu zuweisen",
    fr: "Un corps fait référence à un matériau supprimé — réaffectez les matériaux des corps",
    it: "Un corpo fa riferimento a un materiale eliminato — riassegna i materiali dei corpi",
    es: "Un cuerpo hace referencia a un material eliminado: reasigna los materiales de los cuerpos",
    pt: "Um corpo faz referência a um material excluído — atribua novamente os materiais dos corpos",
  },
  materialsAssigned: {
    en: (bodies: number, materials: number) =>
      `Materials assigned · ${bodies} bodies · ${materials} material${materials > 1 ? "s" : ""}`,
    de: (bodies: number, materials: number) =>
      `Werkstoffe zugewiesen · ${bodies} Körper · ${materials} ${materials > 1 ? "Werkstoffe" : "Werkstoff"}`,
    fr: (bodies: number, materials: number) =>
      `Matériaux affectés · ${bodies} corps · ${materials} matériau${materials > 1 ? "x" : ""}`,
    it: (bodies: number, materials: number) =>
      `Materiali assegnati · ${bodies} corpi · ${materials} ${materials > 1 ? "materiali" : "materiale"}`,
    es: (bodies: number, materials: number) =>
      `Materiales asignados · ${bodies} cuerpos · ${materials} material${materials > 1 ? "es" : ""}`,
    pt: (bodies: number, materials: number) =>
      `Materiais atribuídos · ${bodies} corpos · ${materials} ${materials > 1 ? "materiais" : "material"}`,
  },
  materialAssigned: {
    en: (name: string, young: string) =>
      `Material assigned · ${name} · E=${young} MPa`,
    de: (name: string, young: string) =>
      `Werkstoff zugewiesen · ${name} · E=${young} MPa`,
    fr: (name: string, young: string) =>
      `Matériau affecté · ${name} · E=${young} MPa`,
    it: (name: string, young: string) =>
      `Materiale assegnato · ${name} · E=${young} MPa`,
    es: (name: string, young: string) =>
      `Material asignado · ${name} · E=${young} MPa`,
    pt: (name: string, young: string) =>
      `Material atribuído · ${name} · E=${young} MPa`,
  },
  noBoundaryConditions: {
    en: "No boundary conditions",
    de: "Keine Randbedingungen",
    fr: "Aucune condition aux limites",
    it: "Nessuna condizione al contorno",
    es: "Sin condiciones de contorno",
    pt: "Nenhuma condição de contorno",
  },
  bcsApplied: {
    en: (nodes: number) => `BCs applied · ${nodes} nodes fixed`,
    de: (nodes: number) => `Randbedingungen gesetzt · ${nodes} Knoten gelagert`,
    fr: (nodes: number) =>
      `Conditions aux limites appliquées · ${nodes} nœuds bloqués`,
    it: (nodes: number) =>
      `Condizioni al contorno applicate · ${nodes} nodi vincolati`,
    es: (nodes: number) =>
      `Condiciones de contorno aplicadas · ${nodes} nodos fijados`,
    pt: (nodes: number) =>
      `Condições de contorno aplicadas · ${nodes} nós fixados`,
  },
  prescribedDrives: {
    en: "Prescribed displacement drives the model",
    de: "Eine vorgegebene Verschiebung belastet das Modell",
    fr: "Un déplacement imposé sollicite le modèle",
    it: "Uno spostamento imposto sollecita il modello",
    es: "Un desplazamiento impuesto solicita el modelo",
    pt: "Um deslocamento prescrito solicita o modelo",
  },
  temperatureDrives: {
    en: "Temperature change drives the model",
    de: "Eine Temperaturänderung belastet das Modell",
    fr: "Une variation de température sollicite le modèle",
    it: "Una variazione di temperatura sollecita il modello",
    es: "Un cambio de temperatura solicita el modelo",
    pt: "Uma variação de temperatura solicita o modelo",
  },
  nothingDrives: {
    en: "No loads, prescribed displacement or temperature change",
    de: "Keine Lasten, vorgegebene Verschiebung oder Temperaturänderung",
    fr: "Aucune charge, aucun déplacement imposé ni variation de température",
    it: "Nessun carico, spostamento imposto o variazione di temperatura",
    es: "Sin cargas, desplazamiento impuesto ni cambio de temperatura",
    pt: "Nenhuma carga, deslocamento prescrito ou variação de temperatura",
  },
  solverError: {
    en: (reason: string) => `Solver error: ${reason}`,
    de: (reason: string) => `Löserfehler: ${reason}`,
    fr: (reason: string) => `Erreur du solveur : ${reason}`,
    it: (reason: string) => `Errore del solutore: ${reason}`,
    es: (reason: string) => `Error del solucionador: ${reason}`,
    pt: (reason: string) => `Erro do solucionador: ${reason}`,
  },
  amgOrder: {
    en: "it supports linear and quadratic elements only",
    de: "er unterstützt nur lineare und quadratische Elemente",
    fr: "il ne prend en charge que les éléments linéaires et quadratiques",
    it: "supporta solo elementi lineari e quadratici",
    es: "solo admite elementos lineales y cuadráticos",
    pt: "ele aceita apenas elementos lineares e quadráticos",
  },
  amgShellOnly: {
    en: "it does not support shell-only models",
    de: "er unterstützt keine reinen Schalenmodelle",
    fr: "il ne prend pas en charge les modèles entièrement en coques",
    it: "non supporta modelli composti solo da gusci",
    es: "no admite modelos solo de láminas",
    pt: "ele não aceita modelos só de cascas",
  },
  amgElementTypes: {
    en: "it supports tetrahedral and hexahedral meshes only",
    de: "er unterstützt nur Tetraeder- und Hexaedernetze",
    fr: "il ne prend en charge que les maillages tétraédriques et hexaédriques",
    it: "supporta solo mesh tetraedriche ed esaedriche",
    es: "solo admite mallas de tetraedros y hexaedros",
    pt: "ele aceita apenas malhas de tetraedros e hexaedros",
  },
  amgShellsWithHexes: {
    en: "it supports shells mixed with tetrahedra only",
    de: "er unterstützt Schalen nur zusammen mit Tetraedern",
    fr: "il ne prend en charge les coques qu'associées à des tétraèdres",
    it: "supporta i gusci solo insieme a tetraedri",
    es: "solo admite láminas combinadas con tetraedros",
    pt: "ele aceita cascas apenas combinadas com tetraedros",
  },
  amgCouplings: {
    en: "it supports surface-to-point couplings on tetrahedral meshes only",
    de: "er unterstützt Flächen-Punkt-Kopplungen nur auf Tetraedernetzen",
    fr: "il ne prend en charge les couplages surface-point que sur des maillages tétraédriques",
    it: "supporta gli accoppiamenti superficie-punto solo su mesh tetraedriche",
    es: "solo admite acoplamientos superficie-punto en mallas de tetraedros",
    pt: "ele aceita acoplamentos superfície-ponto apenas em malhas de tetraedros",
  },
  amgShellBodies: {
    en: "it does not support bodies solved as shells",
    de: "er unterstützt keine als Schale gerechneten Körper",
    fr: "il ne prend pas en charge les corps calculés en coque",
    it: "non supporta corpi calcolati come gusci",
    es: "no admite cuerpos calculados como láminas",
    pt: "ele não aceita corpos calculados como cascas",
  },
  gaussSeidelShells: {
    en: "it does not support shells",
    de: "er unterstützt keine Schalen",
    fr: "il ne prend pas en charge les coques",
    it: "non supporta i gusci",
    es: "no admite láminas",
    pt: "ele não aceita cascas",
  },
  incompleteCholesky: {
    en: "an incomplete Cholesky preconditioner",
    de: "einem unvollständigen Cholesky-Vorkonditionierer",
    fr: "un préconditionneur de Cholesky incomplet",
    it: "un precondizionatore di Cholesky incompleto",
    es: "un precondicionador de Cholesky incompleto",
    pt: "um precondicionador de Cholesky incompleto",
  },
  methodUnavailable: {
    en: (method: string, reason: string, used: string) =>
      `${method} is not available for this model (${reason}). It will solve with ${used}.`,
    de: (method: string, reason: string, used: string) =>
      `${method} ist für dieses Modell nicht verfügbar (${reason}). Gelöst wird mit ${used}.`,
    fr: (method: string, reason: string, used: string) =>
      `${method} n'est pas disponible pour ce modèle (${reason}). Le calcul utilisera ${used}.`,
    it: (method: string, reason: string, used: string) =>
      `${method} non è disponibile per questo modello (${reason}). Verrà usato ${used}.`,
    es: (method: string, reason: string, used: string) =>
      `${method} no está disponible para este modelo (${reason}). Se resolverá con ${used}.`,
    pt: (method: string, reason: string, used: string) =>
      `${method} não está disponível para este modelo (${reason}). A análise usará ${used}.`,
  },
  outOfMemory: {
    en: "The solver ran out of memory. Use a coarser mesh, or linear elements instead of quadratic ones, and solve again.",
    de: "Dem Löser ist der Speicher ausgegangen. Verwenden Sie ein gröberes Netz oder lineare statt quadratischer Elemente und lösen Sie erneut.",
    fr: "Le solveur manque de mémoire. Utilisez un maillage plus grossier, ou des éléments linéaires au lieu de quadratiques, puis relancez le calcul.",
    it: "Il solutore ha esaurito la memoria. Usa una mesh più grossolana, o elementi lineari invece che quadratici, e ripeti l'analisi.",
    es: "El solucionador se quedó sin memoria. Usa una malla más gruesa, o elementos lineales en lugar de cuadráticos, y vuelve a calcular.",
    pt: "O solucionador ficou sem memória. Use uma malha mais grossa, ou elementos lineares em vez de quadráticos, e resolva novamente.",
  },
  rustPanic: {
    en: (panic: string) =>
      `The Rust solver stopped on an internal error (a bug, please report it): ${panic}`,
    de: (panic: string) =>
      `Der Rust-Löser wurde durch einen internen Fehler angehalten (ein Bug, bitte melden): ${panic}`,
    fr: (panic: string) =>
      `Le solveur Rust s'est arrêté sur une erreur interne (un bug, merci de le signaler) : ${panic}`,
    it: (panic: string) =>
      `Il solutore Rust si è fermato per un errore interno (un bug, segnalalo per favore): ${panic}`,
    es: (panic: string) =>
      `El solucionador Rust se detuvo por un error interno (un fallo, por favor notifícalo): ${panic}`,
    pt: (panic: string) =>
      `O solucionador Rust parou em um erro interno (um bug, por favor relate): ${panic}`,
  },
  cgNotConverged: {
    en: (residual: string, iterations: number, target: string) =>
      `CG did not converge: relative residual ${residual} after ${iterations} iterations (target ${target}) and is no longer improving. The partial result was discarded — check that the model is fully constrained, or refine the mesh.`,
    de: (residual: string, iterations: number, target: string) =>
      `CG ist nicht konvergiert: relatives Residuum ${residual} nach ${iterations} Iterationen (Ziel ${target}), und es verbessert sich nicht mehr. Das Teilergebnis wurde verworfen – prüfen Sie, ob das Modell vollständig gelagert ist, oder verfeinern Sie das Netz.`,
    fr: (residual: string, iterations: number, target: string) =>
      `Le CG n'a pas convergé : résidu relatif ${residual} après ${iterations} itérations (cible ${target}), et il ne s'améliore plus. Le résultat partiel a été abandonné — vérifiez que le modèle est entièrement maintenu, ou raffinez le maillage.`,
    it: (residual: string, iterations: number, target: string) =>
      `Il CG non è andato a convergenza: residuo relativo ${residual} dopo ${iterations} iterazioni (obiettivo ${target}) e non migliora più. Il risultato parziale è stato scartato — verifica che il modello sia completamente vincolato, o raffina la mesh.`,
    es: (residual: string, iterations: number, target: string) =>
      `El CG no convergió: residuo relativo ${residual} tras ${iterations} iteraciones (objetivo ${target}) y ya no mejora. Se descartó el resultado parcial: comprueba que el modelo esté totalmente sujeto, o refina la malla.`,
    pt: (residual: string, iterations: number, target: string) =>
      `O CG não convergiu: resíduo relativo ${residual} após ${iterations} iterações (meta ${target}) e não melhora mais. O resultado parcial foi descartado — verifique se o modelo está totalmente vinculado, ou refine a malha.`,
  },
  stoppedByUser: {
    en: "Solve stopped by user. The partial result was discarded.",
    de: "Berechnung vom Benutzer abgebrochen. Das Teilergebnis wurde verworfen.",
    fr: "Calcul arrêté par l'utilisateur. Le résultat partiel a été abandonné.",
    it: "Analisi interrotta dall'utente. Il risultato parziale è stato scartato.",
    es: "Cálculo detenido por el usuario. Se descartó el resultado parcial.",
    pt: "Análise interrompida pelo usuário. O resultado parcial foi descartado.",
  },
  engineFailed: {
    en: "Solver engine failed to load. Retry in the status bar.",
    de: "Die Löser-Engine konnte nicht geladen werden. Erneut versuchen über die Statusleiste.",
    fr: "Le moteur de calcul n'a pas pu être chargé. Réessayez depuis la barre d'état.",
    it: "Impossibile caricare il motore di calcolo. Riprova dalla barra di stato.",
    es: "No se pudo cargar el motor de cálculo. Reinténtalo desde la barra de estado.",
    pt: "Não foi possível carregar o motor de cálculo. Tente de novo pela barra de status.",
  },
  engineLoading: {
    en: "Waits for the solver engine to finish loading.",
    de: "Wartet, bis die Löser-Engine geladen ist.",
    fr: "Attend la fin du chargement du moteur de calcul.",
    it: "Attende che il motore di calcolo finisca di caricarsi.",
    es: "Espera a que termine de cargarse el motor de cálculo.",
    pt: "Aguarda o motor de cálculo terminar de carregar.",
  },
  hintOffline: {
    en: "you are offline",
    de: "Sie sind offline",
    fr: "vous êtes hors ligne",
    it: "sei offline",
    es: "no tienes conexión",
    pt: "você está offline",
  },
  hintEngineMissing: {
    en: "engine file missing, reload the page",
    de: "Engine-Datei fehlt, Seite neu laden",
    fr: "fichier du moteur introuvable, rechargez la page",
    it: "file del motore mancante, ricarica la pagina",
    es: "falta el archivo del motor, recarga la página",
    pt: "arquivo do motor ausente, recarregue a página",
  },
  hintHttp: {
    en: (status: string) => `server answered HTTP ${status}`,
    de: (status: string) => `Server antwortete mit HTTP ${status}`,
    fr: (status: string) => `le serveur a répondu HTTP ${status}`,
    it: (status: string) => `il server ha risposto HTTP ${status}`,
    es: (status: string) => `el servidor respondió HTTP ${status}`,
    pt: (status: string) => `o servidor respondeu HTTP ${status}`,
  },
  hintDownloadBlocked: {
    en: "download blocked or interrupted",
    de: "Download blockiert oder unterbrochen",
    fr: "téléchargement bloqué ou interrompu",
    it: "download bloccato o interrotto",
    es: "descarga bloqueada o interrumpida",
    pt: "download bloqueado ou interrompido",
  },
  hintCorrupted: {
    en: "download corrupted, reload the page",
    de: "Download beschädigt, Seite neu laden",
    fr: "téléchargement corrompu, rechargez la page",
    it: "download danneggiato, ricarica la pagina",
    es: "descarga dañada, recarga la página",
    pt: "download corrompido, recarregue a página",
  },
  hintMemory: {
    en: "not enough memory, close other tabs",
    de: "nicht genug Speicher, andere Tabs schließen",
    fr: "mémoire insuffisante, fermez d'autres onglets",
    it: "memoria insufficiente, chiudi altre schede",
    es: "memoria insuficiente, cierra otras pestañas",
    pt: "memória insuficiente, feche outras abas",
  },
  hintEngineDidNotStart: {
    en: "engine did not start",
    de: "Engine ist nicht gestartet",
    fr: "le moteur n'a pas démarré",
    it: "il motore non si è avviato",
    es: "el motor no se inició",
    pt: "o motor não iniciou",
  },
  hintWorkerDidNotStart: {
    en: "worker did not start, reload the page",
    de: "Worker ist nicht gestartet, Seite neu laden",
    fr: "le worker n'a pas démarré, rechargez la page",
    it: "il worker non si è avviato, ricarica la pagina",
    es: "el worker no se inició, recarga la página",
    pt: "o worker não iniciou, recarregue a página",
  },
});
