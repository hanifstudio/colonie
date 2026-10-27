import { describe, expect, it } from "vitest";
import { commandProblem } from "../agent-guard.mjs";

const blocked = (command) => expect(commandProblem(command), command).not.toBeNull();
const allowed = (command) => expect(commandProblem(command), command).toBeNull();

describe("the agent guard", () => {
  it("allows ordinary pushes while refusing destructive pushes and other publishing", () => {
    allowed("git push");
    allowed("git push origin main");
    allowed("git -C . push");
    blocked("cd x && git -c a=b push --force");
    blocked("git push -f origin main");
    blocked("git push --force-with-lease origin main");
    blocked("git push --delete origin main");
    blocked("git push origin +main");
    blocked("git push origin :main");
    blocked("git push --mirror");
    blocked("gh pr create --fill");
    allowed("git status && git log --oneline -3");
    allowed("gh pr view 12");
    allowed("git stash push -m wip && git stash pop");
    allowed("git stash push -m wip && git push");
  });

  it("refuses skipping or moving the commit hook", () => {
    blocked("git commit --no-verify -m x");
    blocked("git commit -nm x");
    blocked("git commit -a -n -m x");
    blocked("git config core.hooksPath /dev/null");
    blocked("git -c core.hooksPath=/dev/null commit -m x");
    blocked("git config --unset core.hooksPath");
    allowed("git config core.hooksPath");
    allowed("git config core.hooksPath scripts/git-hooks");
    allowed("git commit -m 'fix the -n flag parsing'");
  });

  it("reads a heredoc body as text, not as commands", () => {
    allowed("git commit -q -F - <<'EOF'\nDeny git push and --no-verify; never touch ~/.colonie.\nEOF\ngit log -1");
    blocked("git commit -F - <<'EOF'\nmessage\nEOF\ngit commit --no-verify -m x");
    blocked("python3 - <<'EOF'\nopen('/Users/x/.colonie/config.json').read()\nEOF");
    allowed("cat > deploy/Dockerfile <<'EOF'\nRUN rm -rf /var/lib/apt/lists/*\nEOF");
    blocked("bash <<'EOF'\nrm -rf ~/Documents\nEOF");
    blocked("sh -s <<EOF\ngit push --force\nEOF");
  });

  it("refuses the owner's real data and credentials", () => {
    blocked("ls ~/.colonie");
    blocked("sqlite3 $HOME/.colonie/messages.db .tables");
    blocked("cat /Users/someone/.colonie-workspaces/a/config.json");
    blocked("cat ~/.codex/auth.json");
    blocked("security find-generic-password -s x");
    allowed("ls ~/.colonie-dev-data");
    allowed("ls .colonie-dev/team");
    allowed("node electron/colonie.mjs");
  });

  it("allows recursive removal only of temp folders and paths inside the repo", () => {
    blocked("rm -rf ~");
    blocked("rm -rf /Users/someone/Documents");
    blocked("rm -r ../other-project");
    blocked("rm -rf $HOME/x");
    blocked("rm -rf .");
    allowed("rm -rf /tmp/claude-501/x /private/tmp/y");
    allowed("rm -rf $TMPDIR/probe");
    allowed("rm -rf dist release/colonie");
    allowed("rm -rf $H $D");
    allowed("rm file.txt /Users/someone/single-file");
  });
});
