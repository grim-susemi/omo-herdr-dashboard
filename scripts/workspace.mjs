// Verify the isolated W workspace contract and print it as JSON.
//
// Read-only: it never creates, resets, checks out or removes anything. Exit 0
// means the integration root carries the task ownership marker, the linked
// worktree is registered on the requested branch, and no source was modified.
import { OWNER_MARKER_VALUE, verifyWorkspace } from '../src/workspace.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const integrationRoot = value('--integration-root');
const worktreePath = value('--worktree');
const branch = value('--branch');

if (!integrationRoot || !worktreePath || !branch) {
  console.error('usage: node scripts/workspace.mjs --integration-root <dir> --worktree <dir> --branch <name>');
  process.exitCode = 2;
} else {
  const status = verifyWorkspace({ integrationRoot, worktreePath, branch });
  const checks = {
    ownedIntegrationRoot: status.integrationRoot.ownerMarker === OWNER_MARKER_VALUE,
    integrationRootIsRepository: status.integrationRoot.isGitRepository === true,
    worktreeRegistered: status.worktree.registered === true,
    worktreeBranchMatches: status.worktree.branch === `refs/heads/${branch}`,
  };
  const report = { schema: 'omo-herdr-todo/workspace/1', ok: Object.values(checks).every(Boolean), checks, ...status };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
