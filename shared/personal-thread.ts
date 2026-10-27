/** Work performed for another conversation or a routine is never a personal chat. */
export function isPersonalThread(task: { forConversation?: string; routineRunId?: string }): boolean {
  return !task.forConversation && !task.routineRunId;
}
