// Print a read-only identity snapshot of an OmO agent directory as JSON.
import { snapshotAgentIdentity } from '../src/static-identity.mjs';

const args = process.argv.slice(2);
const value = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const agentDir = value('--agent-dir');
if (!agentDir) {
  console.error('usage: node scripts/static-identity.mjs --agent-dir <agent-dir>');
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(snapshotAgentIdentity(agentDir), null, 2));
  } catch (error) {
    console.error(`static-identity failed: ${error.message}`);
    process.exitCode = 1;
  }
}
