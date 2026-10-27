// Command-line options of scripts/sim.ts. Kept apart so a test covers them: an option's value (an agent list, a model
// id) must never be read as the scenario filter, or a one-scenario replay quietly plays all sixteen and spends the
// budget for all of them.

export interface SimArgs {
  only: string[] | null; // scenario ids, e.g. ["S12"]; null plays them all
  agents: string[];
  model: boolean; // our agent uses the model
  oursModel: string | null; // another model id for our agent only
}

const VALUED = ["--agents", "--ours-model"];
const FLAGS = ["--model"];

export function parseSimArgs(argv: string[]): SimArgs {
  const unknown = argv.filter((a) => a.startsWith("--") && !VALUED.includes(a) && !FLAGS.includes(a));
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(" ")}`);
  const valueAt = new Set<number>();
  const valueOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    valueAt.add(i + 1);
    return v;
  };
  const agents = valueOf("--agents")?.split(",") ?? ["ours", "naive"];
  const oursModel = valueOf("--ours-model");
  const positional = argv.filter((a, i) => !a.startsWith("--") && !valueAt.has(i));
  if (positional.length > 1) throw new Error(`one scenario list expected, got: ${positional.join(" ")}`);
  return { only: positional.length ? positional[0].split(",") : null, agents, model: argv.includes("--model"), oursModel };
}
