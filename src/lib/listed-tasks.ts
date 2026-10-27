// Which of a bot's threads are its own conversations, listed under it: not a
// routine's detached run, and not its work for a group or DM (reached from
// that conversation instead).
export { isPersonalThread as listedTask } from "../../shared/personal-thread";
