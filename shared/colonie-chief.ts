// The Colonie Chief contract, shared by the server and the renderer. Types
// only: no Node and no server imports, so ChiefControls/ChiefActivity can
// import this from the browser bundle. The server owns the role and the
// assignment ledger (server/colonie/chief/); the renderer only reads views and
// posts the explicit role transfer.

/** One bot as the Chief tools and control surface see it. */
export interface ChiefBot {
  id: string;
  name: string;
  title: string;
  description: string;
  chiefOfStaff?: boolean;
  hidden?: boolean;
  modelSelection: { instanceId: string; model: string };
}

/** Who asked: the source conversation and the turn that is running. */
export interface ChiefActor {
  botId: string;
  threadId: string;
  turnId: string;
}

export type ChiefAssignmentStatus =
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** One delegated task: a fresh target conversation owned by the source turn. */
export interface ChiefAssignment {
  id: string;
  chiefBotId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  targetBotId: string;
  targetThreadId?: string;
  message: string;
  context?: string;
  status: ChiefAssignmentStatus;
  createdAt: string;
  updatedAt: string;
  result?: string;
  error?: string;
}

/** The public control surface: the one Chief, its revision and its work. */
export interface ChiefView {
  chief: ChiefBot | null;
  revision: string;
  assignments: ChiefAssignment[];
}

/** Exactly what a delegated child dispatch carries about its assignment. */
export interface AcpAssignmentContext {
  id: string;
  chiefBotId: string;
  chiefName: string;
  sourceThreadId: string;
  context?: string;
}