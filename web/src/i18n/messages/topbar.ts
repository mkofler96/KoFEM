// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// The top bar: its buttons, the site menu and the Settings menu.
export const topbarMessages = defineMessages({
  en: {
    home: "KoFEM home",
    devBuild: "Development build of the next KoFEM — results may change",
    workspace: "Workspace",
    untitled: "Untitled",
    newAnalysis: "New analysis",
    confirmNewAnalysis:
      "Start a new analysis? Unsaved changes will be lost — save the current analysis first if you want to keep it.",
    saveAnalysisTitle: "Save analysis (.vtu)",
    saveAnalysis: "Save analysis",
    loadAnalysisTitle: "Load analysis (.vtu) or problem report (.zip)",
    loadAnalysis: "Load analysis",
    loadFailed: (reason: string) => `Could not load analysis: ${reason}`,
    settings: "Settings",
    language: "Language",
    siteMenu: "Site menu",
    siteMenuTitle: "Examples and theory",
    site: "Site",
    backTo: (example: string) => `Back to ${example}`,
    examples: "Examples",
    theory: "Theory",
    confirmLeave:
      "Leave the app? Unsaved changes will be lost — save the current analysis first if you want to keep it.",
  },
  de: {
    home: "KoFEM-Startseite",
    devBuild:
      "Entwicklungsversion des nächsten KoFEM – Ergebnisse können sich ändern",
    workspace: "Arbeitsbereich",
    untitled: "Unbenannt",
    newAnalysis: "Neue Analyse",
    confirmNewAnalysis:
      "Neue Analyse beginnen? Nicht gespeicherte Änderungen gehen verloren – speichern Sie die aktuelle Analyse zuerst, wenn Sie sie behalten möchten.",
    saveAnalysisTitle: "Analyse speichern (.vtu)",
    saveAnalysis: "Analyse speichern",
    loadAnalysisTitle: "Analyse (.vtu) oder Problembericht (.zip) laden",
    loadAnalysis: "Analyse laden",
    loadFailed: (reason: string) =>
      `Analyse konnte nicht geladen werden: ${reason}`,
    settings: "Einstellungen",
    language: "Sprache",
    siteMenu: "Seitenmenü",
    siteMenuTitle: "Beispiele und Theorie",
    site: "Website",
    backTo: (example: string) => `Zurück zu ${example}`,
    examples: "Beispiele",
    theory: "Theorie",
    confirmLeave:
      "Die App verlassen? Nicht gespeicherte Änderungen gehen verloren – speichern Sie die aktuelle Analyse zuerst, wenn Sie sie behalten möchten.",
  },
  fr: {
    home: "Accueil KoFEM",
    devBuild:
      "Version de développement du prochain KoFEM — les résultats peuvent changer",
    workspace: "Espace de travail",
    untitled: "Sans titre",
    newAnalysis: "Nouvelle analyse",
    confirmNewAnalysis:
      "Commencer une nouvelle analyse ? Les modifications non enregistrées seront perdues — enregistrez d'abord l'analyse en cours si vous voulez la conserver.",
    saveAnalysisTitle: "Enregistrer l'analyse (.vtu)",
    saveAnalysis: "Enregistrer l'analyse",
    loadAnalysisTitle:
      "Ouvrir une analyse (.vtu) ou un rapport de problème (.zip)",
    loadAnalysis: "Ouvrir une analyse",
    loadFailed: (reason: string) => `Impossible d'ouvrir l'analyse : ${reason}`,
    settings: "Paramètres",
    language: "Langue",
    siteMenu: "Menu du site",
    siteMenuTitle: "Exemples et théorie",
    site: "Site",
    backTo: (example: string) => `Retour à ${example}`,
    examples: "Exemples",
    theory: "Théorie",
    confirmLeave:
      "Quitter l'application ? Les modifications non enregistrées seront perdues — enregistrez d'abord l'analyse en cours si vous voulez la conserver.",
  },
  it: {
    home: "Home di KoFEM",
    devBuild:
      "Versione di sviluppo del prossimo KoFEM — i risultati possono cambiare",
    workspace: "Area di lavoro",
    untitled: "Senza titolo",
    newAnalysis: "Nuova analisi",
    confirmNewAnalysis:
      "Iniziare una nuova analisi? Le modifiche non salvate andranno perse — salva prima l'analisi corrente se vuoi conservarla.",
    saveAnalysisTitle: "Salva analisi (.vtu)",
    saveAnalysis: "Salva analisi",
    loadAnalysisTitle: "Apri analisi (.vtu) o segnalazione di problema (.zip)",
    loadAnalysis: "Apri analisi",
    loadFailed: (reason: string) => `Impossibile aprire l'analisi: ${reason}`,
    settings: "Impostazioni",
    language: "Lingua",
    siteMenu: "Menu del sito",
    siteMenuTitle: "Esempi e teoria",
    site: "Sito",
    backTo: (example: string) => `Torna a ${example}`,
    examples: "Esempi",
    theory: "Teoria",
    confirmLeave:
      "Uscire dall'app? Le modifiche non salvate andranno perse — salva prima l'analisi corrente se vuoi conservarla.",
  },
  es: {
    home: "Inicio de KoFEM",
    devBuild:
      "Versión de desarrollo del próximo KoFEM: los resultados pueden cambiar",
    workspace: "Espacio de trabajo",
    untitled: "Sin título",
    newAnalysis: "Nuevo análisis",
    confirmNewAnalysis:
      "¿Empezar un nuevo análisis? Se perderán los cambios no guardados: guarda primero el análisis actual si quieres conservarlo.",
    saveAnalysisTitle: "Guardar análisis (.vtu)",
    saveAnalysis: "Guardar análisis",
    loadAnalysisTitle: "Abrir análisis (.vtu) o informe de problema (.zip)",
    loadAnalysis: "Abrir análisis",
    loadFailed: (reason: string) => `No se pudo abrir el análisis: ${reason}`,
    settings: "Ajustes",
    language: "Idioma",
    siteMenu: "Menú del sitio",
    siteMenuTitle: "Ejemplos y teoría",
    site: "Sitio",
    backTo: (example: string) => `Volver a ${example}`,
    examples: "Ejemplos",
    theory: "Teoría",
    confirmLeave:
      "¿Salir de la aplicación? Se perderán los cambios no guardados: guarda primero el análisis actual si quieres conservarlo.",
  },
  pt: {
    home: "Início do KoFEM",
    devBuild:
      "Versão de desenvolvimento do próximo KoFEM — os resultados podem mudar",
    workspace: "Área de trabalho",
    untitled: "Sem título",
    newAnalysis: "Nova análise",
    confirmNewAnalysis:
      "Iniciar uma nova análise? As alterações não salvas serão perdidas — salve primeiro a análise atual se quiser mantê-la.",
    saveAnalysisTitle: "Salvar análise (.vtu)",
    saveAnalysis: "Salvar análise",
    loadAnalysisTitle: "Abrir análise (.vtu) ou relatório de problema (.zip)",
    loadAnalysis: "Abrir análise",
    loadFailed: (reason: string) =>
      `Não foi possível abrir a análise: ${reason}`,
    settings: "Configurações",
    language: "Idioma",
    siteMenu: "Menu do site",
    siteMenuTitle: "Exemplos e teoria",
    site: "Site",
    backTo: (example: string) => `Voltar a ${example}`,
    examples: "Exemplos",
    theory: "Teoria",
    confirmLeave:
      "Sair do aplicativo? As alterações não salvas serão perdidas — salve primeiro a análise atual se quiser mantê-la.",
  },
});
