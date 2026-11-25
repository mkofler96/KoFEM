// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// The 3D view: its legends, the Fit View button, the sample guide strip.
export const viewportMessages = defineMessages({
  editLegendRange: {
    en: "Edit legend range",
    de: "Legendenbereich bearbeiten",
    fr: "Modifier la plage de la légende",
    it: "Modifica intervallo della legenda",
    es: "Editar rango de la leyenda",
    pt: "Editar faixa da legenda",
  },
  manualRange: {
    en: "manual range",
    de: "manueller Bereich",
    fr: "plage manuelle",
    it: "intervallo manuale",
    es: "rango manual",
    pt: "faixa manual",
  },
  density: {
    en: "Density ρ",
    de: "Dichte ρ",
    fr: "Densité ρ",
    it: "Densità ρ",
    es: "Densidad ρ",
    pt: "Densidade ρ",
  },
  cutoff: {
    en: (value: string) => `cutoff ${value}`,
    de: (value: string) => `Schwelle ${value}`,
    fr: (value: string) => `seuil ${value}`,
    it: (value: string) => `soglia ${value}`,
    es: (value: string) => `umbral ${value}`,
    pt: (value: string) => `limiar ${value}`,
  },
  meshCannotDraw: {
    en: (reason: string) =>
      `The mesh cannot be drawn: ${reason}. Reload the page to try again.`,
    de: (reason: string) =>
      `Das Netz kann nicht gezeichnet werden: ${reason}. Laden Sie die Seite neu, um es erneut zu versuchen.`,
    fr: (reason: string) =>
      `Le maillage ne peut pas être affiché : ${reason}. Rechargez la page pour réessayer.`,
    it: (reason: string) =>
      `Impossibile disegnare la mesh: ${reason}. Ricarica la pagina per riprovare.`,
    es: (reason: string) =>
      `No se puede dibujar la malla: ${reason}. Recarga la página para intentarlo de nuevo.`,
    pt: (reason: string) =>
      `Não é possível desenhar a malha: ${reason}. Recarregue a página para tentar novamente.`,
  },
  fitView: {
    en: "Fit View",
    de: "Einpassen",
    fr: "Ajuster la vue",
    it: "Adatta vista",
    es: "Ajustar vista",
    pt: "Ajustar vista",
  },
  sampleGuide: {
    en: "Sample guide",
    de: "Beispielanleitung",
    fr: "Guide de l'exemple",
    it: "Guida all'esempio",
    es: "Guía del ejemplo",
    pt: "Guia do exemplo",
  },
  sample: {
    en: "Sample",
    de: "Beispiel",
    fr: "Exemple",
    it: "Esempio",
    es: "Ejemplo",
    pt: "Exemplo",
  },
  meshTitle: {
    en: "Mesh",
    de: "Netz",
    fr: "Maillage",
    it: "Mesh",
    es: "Malla",
    pt: "Malha",
  },
  meshHow: {
    en: "Fill the solid with elements: press Generate mesh.",
    de: "Füllen Sie den Körper mit Elementen: Klicken Sie auf Netz erzeugen.",
    fr: "Remplissez le solide d'éléments : cliquez sur Générer le maillage.",
    it: "Riempi il solido di elementi: premi Genera mesh.",
    es: "Rellena el sólido con elementos: pulsa Generar malla.",
    pt: "Preencha o sólido com elementos: clique em Gerar malha.",
  },
  meshAction: {
    en: "Open mesh",
    de: "Netz öffnen",
    fr: "Ouvrir le maillage",
    it: "Apri mesh",
    es: "Abrir malla",
    pt: "Abrir malha",
  },
  supportTitle: {
    en: "Fix bolt holes",
    de: "Bohrungen lagern",
    fr: "Fixer les trous",
    it: "Vincola i fori",
    es: "Fijar agujeros",
    pt: "Fixar furos",
  },
  supportHow: {
    en: "Add a support, click the three highlighted holes, then Apply.",
    de: "Fügen Sie eine Lagerung hinzu, klicken Sie die drei markierten Bohrungen an, dann auf Lagerung anwenden.",
    fr: "Ajoutez un appui, cliquez sur les trois trous en surbrillance, puis sur Appliquer l'appui.",
    it: "Aggiungi un vincolo, fai clic sui tre fori evidenziati, poi su Applica vincolo.",
    es: "Añade un apoyo, haz clic en los tres agujeros resaltados y luego en Aplicar apoyo.",
    pt: "Adicione um apoio, clique nos três furos destacados e depois em Aplicar apoio.",
  },
  supportAction: {
    en: "Add support",
    de: "Lagerung hinzufügen",
    fr: "Ajouter un appui",
    it: "Aggiungi vincolo",
    es: "Añadir apoyo",
    pt: "Adicionar apoio",
  },
  loadTitle: {
    en: "Load hub",
    de: "Nabe belasten",
    fr: "Charger le moyeu",
    it: "Carica il mozzo",
    es: "Cargar el buje",
    pt: "Carregar o cubo",
  },
  loadHow: {
    en: (force: string) =>
      `Add a load, click the highlighted bore, set Fy = ${force}, then Apply.`,
    de: (force: string) =>
      `Fügen Sie eine Last hinzu, klicken Sie die markierte Bohrung an, setzen Sie Fy = ${force}, dann auf Last anwenden.`,
    fr: (force: string) =>
      `Ajoutez une charge, cliquez sur l'alésage en surbrillance, réglez Fy = ${force}, puis cliquez sur Appliquer la charge.`,
    it: (force: string) =>
      `Aggiungi un carico, fai clic sul foro evidenziato, imposta Fy = ${force}, poi fai clic su Applica carico.`,
    es: (force: string) =>
      `Añade una carga, haz clic en el agujero resaltado, fija Fy = ${force} y luego pulsa Aplicar carga.`,
    pt: (force: string) =>
      `Adicione uma carga, clique no furo destacado, defina Fy = ${force} e depois clique em Aplicar carga.`,
  },
  loadAction: {
    en: "Add load",
    de: "Last hinzufügen",
    fr: "Ajouter une charge",
    it: "Aggiungi carico",
    es: "Añadir carga",
    pt: "Adicionar carga",
  },
  runTitle: {
    en: "Run",
    de: "Berechnen",
    fr: "Calculer",
    it: "Calcola",
    es: "Calcular",
    pt: "Calcular",
  },
  runHow: {
    en: "Add a static study and press Run.",
    de: "Fügen Sie eine statische Studie hinzu und starten Sie die Berechnung.",
    fr: "Ajoutez une étude statique et lancez le calcul.",
    it: "Aggiungi uno studio statico e avvia l'analisi.",
    es: "Añade un estudio estático y ejecuta el cálculo.",
    pt: "Adicione um estudo estático e execute a análise.",
  },
  runAction: {
    en: "Open study",
    de: "Studie öffnen",
    fr: "Ouvrir l'étude",
    it: "Apri studio",
    es: "Abrir estudio",
    pt: "Abrir estudo",
  },
  done: {
    en: "Done",
    de: "Fertig",
    fr: "Terminé",
    it: "Fatto",
    es: "Listo",
    pt: "Pronto",
  },
  doneTip: {
    en: "The colours show how far each point moves under the load. Try von Mises stress in the Results panel to see where the bracket works hardest.",
    de: "Die Farben zeigen, wie weit sich jeder Punkt unter der Last verschiebt. Wählen Sie im Ergebnisbereich die Von-Mises-Spannung, um zu sehen, wo die Konsole am stärksten beansprucht wird.",
    fr: "Les couleurs montrent de combien chaque point se déplace sous la charge. Essayez la contrainte de von Mises dans le panneau Résultats pour voir où la ferrure travaille le plus.",
    it: "I colori mostrano quanto si sposta ogni punto sotto il carico. Prova la tensione di von Mises nel pannello Risultati per vedere dove la staffa lavora di più.",
    es: "Los colores muestran cuánto se desplaza cada punto bajo la carga. Prueba la tensión de von Mises en el panel Resultados para ver dónde trabaja más el soporte.",
    pt: "As cores mostram quanto cada ponto se desloca sob a carga. Experimente a tensão de von Mises no painel Resultados para ver onde o suporte trabalha mais.",
  },
  closeGuide: {
    en: "Close the guide",
    de: "Anleitung schließen",
    fr: "Fermer le guide",
    it: "Chiudi la guida",
    es: "Cerrar la guía",
    pt: "Fechar o guia",
  },
});

// What is meshed and loaded, as the status bar and the pre-flight checks
// summarize it (lib/modelDisplay).
export const modelSummaryMessages = defineMessages({
  faceLoads: {
    en: (count: number) => `${count} face load${count > 1 ? "s" : ""}`,
    de: (count: number) =>
      count > 1 ? `${count} Flächenlasten` : `${count} Flächenlast`,
    fr: (count: number) =>
      count > 1 ? `${count} charges surfaciques` : `${count} charge surfacique`,
    it: (count: number) =>
      count > 1 ? `${count} carichi su faccia` : `${count} carico su faccia`,
    es: (count: number) =>
      count > 1 ? `${count} cargas en caras` : `${count} carga en cara`,
    pt: (count: number) =>
      count > 1 ? `${count} cargas em faces` : `${count} carga em face`,
  },
  nodalLoadDofs: {
    en: (count: number) => `${count} nodal load DOF${count > 1 ? "s" : ""}`,
    de: (count: number) =>
      count > 1
        ? `${count} belastete Knoten-FHG`
        : `${count} belasteter Knoten-FHG`,
    fr: (count: number) =>
      count > 1 ? `${count} DDL nodaux chargés` : `${count} DDL nodal chargé`,
    it: (count: number) =>
      count > 1
        ? `${count} GDL nodali caricati`
        : `${count} GDL nodale caricato`,
    es: (count: number) =>
      count > 1
        ? `${count} GDL nodales cargados`
        : `${count} GDL nodal cargado`,
    pt: (count: number) =>
      count > 1
        ? `${count} GDL nodais carregados`
        : `${count} GDL nodal carregado`,
  },
  loadsApplied: {
    en: (parts: string) => `Loads applied · ${parts}`,
    de: (parts: string) => `Lasten aufgebracht · ${parts}`,
    fr: (parts: string) => `Charges appliquées · ${parts}`,
    it: (parts: string) => `Carichi applicati · ${parts}`,
    es: (parts: string) => `Cargas aplicadas · ${parts}`,
    pt: (parts: string) => `Cargas aplicadas · ${parts}`,
  },
  noMesh: {
    en: "No mesh",
    de: "Kein Netz",
    fr: "Pas de maillage",
    it: "Nessuna mesh",
    es: "Sin malla",
    pt: "Sem malha",
  },
  meshReady: {
    en: (nodes: number, elements: number) =>
      `Mesh ready · ${nodes} nodes · ${elements} elements`,
    de: (nodes: number, elements: number) =>
      `Netz bereit · ${nodes} Knoten · ${elements} Elemente`,
    fr: (nodes: number, elements: number) =>
      `Maillage prêt · ${nodes} nœuds · ${elements} éléments`,
    it: (nodes: number, elements: number) =>
      `Mesh pronta · ${nodes} nodi · ${elements} elementi`,
    es: (nodes: number, elements: number) =>
      `Malla lista · ${nodes} nodos · ${elements} elementos`,
    pt: (nodes: number, elements: number) =>
      `Malha pronta · ${nodes} nós · ${elements} elementos`,
  },
});
