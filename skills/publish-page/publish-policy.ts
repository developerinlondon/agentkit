export function shouldCommitCanonical(arguments_: string[]): boolean {
  return arguments_.includes("--git") && !arguments_.includes("--no-git");
}
