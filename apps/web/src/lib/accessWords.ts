// Access in plain words, the same way on every screen.

const join = (words: string[], last: string) =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} ${last} ${words[words.length - 1]}`;
// "Kochi, Thrissur and Delhi"
const joinAnd = (words: string[]) => join(words, "and");
// "Kochi or Thrissur": one of them is enough
const joinOr = (words: string[]) => join(words, "or");

type Rights = { view: boolean; create: boolean; edit: boolean; delete: boolean };

// "Everything", "View only", "View, add and edit"
export function rightsInWords(r: Rights): string {
  if (!r.view) return "No access";
  if (r.create && r.edit && r.delete) return "Everything";
  const verbs = [r.create && "add", r.edit && "edit", r.delete && "delete"].filter(Boolean) as string[];
  if (!verbs.length) return "View only";
  return verbs.length === 1 ? `View and ${verbs[0]}` : `View, ${joinAnd(verbs)}`;
}

// whose records: "only their own", "only Kochi's records", "all records"
export function scopeInWords(own: boolean, departments: string[] | null): string {
  if (own) return "only their own records";
  if (departments === null) return "all records";
  return `only ${joinAnd(departments)}'s records`;
}

export { joinAnd, joinOr };
