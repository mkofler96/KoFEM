// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineMessages } from "../messages";

// The modal questions: deleting a boundary object, continuing a solve past
// its iteration limit, and loading an example.
export const dialogMessages = defineMessages({
  deleteTitle: {
    en: (name: string) => `Delete ${name}?`,
    de: (name: string) => `${name} löschen?`,
    fr: (name: string) => `Supprimer ${name} ?`,
    it: (name: string) => `Eliminare ${name}?`,
    es: (name: string) => `¿Eliminar ${name}?`,
    pt: (name: string) => `Excluir ${name}?`,
  },
  cannotUndo: {
    en: "This cannot be undone.",
    de: "Dies kann nicht rückgängig gemacht werden.",
    fr: "Cette action est irréversible.",
    it: "L'operazione non può essere annullata.",
    es: "Esta acción no se puede deshacer.",
    pt: "Esta ação não pode ser desfeita.",
  },
  dontAskAgain: {
    en: "Don't ask again this session",
    de: "In dieser Sitzung nicht mehr fragen",
    fr: "Ne plus demander pendant cette session",
    it: "Non chiedere più in questa sessione",
    es: "No volver a preguntar en esta sesión",
    pt: "Não perguntar novamente nesta sessão",
  },
  cancel: {
    en: "Cancel",
    de: "Abbrechen",
    fr: "Annuler",
    it: "Annulla",
    es: "Cancelar",
    pt: "Cancelar",
  },
  delete: {
    en: "Delete",
    de: "Löschen",
    fr: "Supprimer",
    it: "Elimina",
    es: "Eliminar",
    pt: "Excluir",
  },
  keepSolving: {
    en: "Keep solving?",
    de: "Weiter lösen?",
    fr: "Poursuivre la résolution ?",
    it: "Continuare la soluzione?",
    es: "¿Seguir resolviendo?",
    pt: "Continuar resolvendo?",
  },
  limitReached: {
    en: "The iteration limit was reached, but the residual is still falling. Continue from the current solution or stop and discard it.",
    de: "Die Iterationsgrenze ist erreicht, aber das Residuum sinkt noch. Setzen Sie die Rechnung mit der aktuellen Lösung fort oder brechen Sie ab und verwerfen Sie sie.",
    fr: "La limite d'itérations est atteinte, mais le résidu diminue encore. Poursuivez à partir de la solution actuelle, ou arrêtez et abandonnez-la.",
    it: "È stato raggiunto il limite di iterazioni, ma il residuo sta ancora diminuendo. Continua dalla soluzione corrente oppure interrompi e scartala.",
    es: "Se alcanzó el límite de iteraciones, pero el residuo sigue bajando. Continúa desde la solución actual o detén el cálculo y descártala.",
    pt: "O limite de iterações foi atingido, mas o resíduo ainda está caindo. Continue a partir da solução atual ou pare e descarte-a.",
  },
  iterationsSolving: {
    en: (iterations: string, minutes: string) =>
      `${iterations} iterations · ${minutes} min solving`,
    de: (iterations: string, minutes: string) =>
      `${iterations} Iterationen · ${minutes} min Rechenzeit`,
    fr: (iterations: string, minutes: string) =>
      `${iterations} itérations · ${minutes} min de calcul`,
    it: (iterations: string, minutes: string) =>
      `${iterations} iterazioni · ${minutes} min di calcolo`,
    es: (iterations: string, minutes: string) =>
      `${iterations} iteraciones · ${minutes} min de cálculo`,
    pt: (iterations: string, minutes: string) =>
      `${iterations} iterações · ${minutes} min de cálculo`,
  },
  residual: {
    en: (residual: string, target: string) =>
      `Relative residual ${residual} · target ${target}`,
    de: (residual: string, target: string) =>
      `Relatives Residuum ${residual} · Ziel ${target}`,
    fr: (residual: string, target: string) =>
      `Résidu relatif ${residual} · cible ${target}`,
    it: (residual: string, target: string) =>
      `Residuo relativo ${residual} · obiettivo ${target}`,
    es: (residual: string, target: string) =>
      `Residuo relativo ${residual} · objetivo ${target}`,
    pt: (residual: string, target: string) =>
      `Resíduo relativo ${residual} · meta ${target}`,
  },
  extraIterations: {
    en: "Extra iterations",
    de: "Zusätzliche Iterationen",
    fr: "Itérations supplémentaires",
    it: "Iterazioni aggiuntive",
    es: "Iteraciones adicionales",
    pt: "Iterações adicionais",
  },
  stop: {
    en: "Stop",
    de: "Abbrechen",
    fr: "Arrêter",
    it: "Interrompi",
    es: "Detener",
    pt: "Parar",
  },
  continue: {
    en: "Continue",
    de: "Fortsetzen",
    fr: "Poursuivre",
    it: "Continua",
    es: "Continuar",
    pt: "Continuar",
  },
  invalidExample: {
    en: (id: string) => `Invalid example id: "${id}"`,
    de: (id: string) => `Ungültige Beispiel-ID: „${id}“`,
    fr: (id: string) => `Identifiant d'exemple invalide : « ${id} »`,
    it: (id: string) => `ID esempio non valido: "${id}"`,
    es: (id: string) => `ID de ejemplo no válido: "${id}"`,
    pt: (id: string) => `ID de exemplo inválido: "${id}"`,
  },
  exampleFailed: {
    en: (reason: string) => `Could not load example: ${reason}`,
    de: (reason: string) => `Beispiel konnte nicht geladen werden: ${reason}`,
    fr: (reason: string) => `Impossible d'ouvrir l'exemple : ${reason}`,
    it: (reason: string) => `Impossibile aprire l'esempio: ${reason}`,
    es: (reason: string) => `No se pudo abrir el ejemplo: ${reason}`,
    pt: (reason: string) => `Não foi possível abrir o exemplo: ${reason}`,
  },
});
