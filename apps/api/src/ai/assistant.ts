import { visibleColumns } from "../auth/fields.js";
import { z } from "zod";
import { can, isAdmin } from "../auth/access.js";
import { listForUser } from "../controllers/records.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { searchUserOptions } from "../repo/userRepo.js";
import { pickDisplayField, valueType } from "../schema/columns.js";
import { getAllSchemas, getSchema } from "../schema/schemaRepo.js";
import type { Column, CurrentUser, TableSchema } from "../types.js";
import { metered } from "./generate.js";
import { chatWithTools, type ToolDef, type Turn } from "./toolChat.js";
import { activeAi, getAiSettings } from "./settings.js";
import { checkLimits } from "./usage.js";
import { brandName } from "../branding.js";

// Ask Zenin (docs/WORKFLOW.md): questions about the ERP's
// data, answered by the AI chosen in Settings → AI. Read-only. The AI
// searches with the asking person's permissions, through the same code as
// the record lists, so it can only see what they can see. Conversations
// aren't kept on the server: the browser sends the last turns each time.

export type { Turn };

const MAX_TURNS = 12; // earlier turns sent back for context
const RESULT_LIMIT = 25;

/* ---------------- who may use it ---------------- */

export async function canAsk(user: CurrentUser) {
  const s = await getAiSettings();
  if (!s.keys[s.provider] || !s.features.askZenin) return false;
  if (isAdmin(user) || !s.askRoles.length) return true;
  return user.roleIds.some((id) => s.askRoles.includes(id));
}

/* ---------------- the tools ---------------- */

// every value is text (numbers too), a list for in / notIn: simple types
// every provider's schema format accepts
const Scalar = z.union([z.string(), z.number(), z.boolean()]).transform(String);
const FilterInput = z.object({
  field: z.string(),
  op: z.string(),
  value: Scalar.optional(),
  values: z.array(Scalar).max(100).optional(),
  value2: Scalar.optional(),
});
const SearchInput = z.object({
  table: z.string(),
  search: z.string().max(200).optional(),
  filters: z.array(FilterInput).max(20).optional(),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().min(1).max(RESULT_LIMIT).optional(),
});
const PeopleInput = z.object({ name: z.string().max(100) });

const TOOLS: ToolDef[] = [
  {
    name: "search_records",
    description:
      "Find records in one table, as the person asking can see them. Returns the total number that match and up to `limit` records " +
      "(each with _id, link, and its fields; links and people are shown by name). Use filters for exact questions (status, dates, " +
      "people), search for words anywhere in a record. To count, read `total`.",
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "the table's key, from the list of tables" },
        search: { type: "string", description: "words to look for anywhere in the record" },
        filters: {
          type: "array",
          description: "all must match",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "a column's key, or _createdBy / _department" },
              op: { type: "string", description: "an operator allowed for the column's type (see the instructions)" },
              value: { type: "string", description: "one value: text, a number, or a date (YYYY-MM-DD, $today, $today+7, $today-30)" },
              values: { type: "array", items: { type: "string" }, description: "for in / notIn: the list of values" },
              value2: { type: "string", description: "the second value, for between" },
            },
            required: ["field", "op"],
          },
        },
        sort: { type: "string", description: "a column's key, or _createdAt / _updatedAt (default: newest first)" },
        order: { type: "string", enum: ["asc", "desc"] },
        limit: { type: "integer", description: `how many records to return, 1 to ${RESULT_LIMIT} (default 10)` },
      },
      required: ["table"],
    },
  },
  {
    name: "find_people",
    description: "Find people (accounts) by name, to filter a User column or _createdBy by them. Returns their ids.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "part of the person's name or username" } },
      required: ["name"],
    },
  },
];

const title = (tableName: string) => tableName.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const short = (v: unknown): unknown => {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 10).map(short);
  return v;
};
const FILE_TYPES = new Set(["file", "files", "image", "images"]);

async function searchRecords(user: CurrentUser, input: z.infer<typeof SearchInput>) {
  const schema = await getSchema(input.table);
  if (!schema || !can(user, schema, "view")) throw new HttpError(404, `There's no table "${input.table}" you can see. Use a key from the list of tables.`);
  const limit = input.limit ?? 10;
  const filters = (input.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.values ?? f.value, value2: f.value2 }));
  const { data, total, totalIsEstimate } = await listForUser(user, schema, {
    search: input.search,
    filters,
    sort: input.sort,
    order: input.order,
    page: 1,
    limit,
  });
  const display = pickDisplayField(schema);
  const files = new Set(schema.columns.filter((c) => FILE_TYPES.has(valueType(c))).map((c) => c.name));
  const records = data.map((row) => {
    const id = String(row._id);
    const out: Record<string, unknown> = {
      _id: id,
      title: String((display === "_id" ? id : row[display]) || id),
      link: `/table/${schema.tableName}/${id}`,
    };
    for (const [k, v] of Object.entries(row)) {
      if (k === "_id" || k === "_createdById" || k === "_departmentId" || k === "_departmentIds" || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
      out[k] = files.has(k) ? "(file attached)" : short(v);
    }
    return out;
  });
  return { total, totalIsEstimate, shown: records.length, records };
}

async function runTool(user: CurrentUser, name: string, raw: unknown): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === "search_records") {
      const input = SearchInput.safeParse(raw);
      if (!input.success) return { text: `Invalid input: ${input.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
      const result = await searchRecords(user, input.data);
      return { text: JSON.stringify(result), isError: false };
    }
    if (name === "find_people") {
      const input = PeopleInput.safeParse(raw);
      if (!input.success) return { text: "Give a name to look for", isError: true };
      const people = await searchUserOptions(input.data.name, 10);
      return { text: JSON.stringify(people.map((p) => ({ id: p.value, name: p.label, username: p.username }))), isError: false };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (error) {
    // a filter that doesn't fit the column etc.: the AI reads why and tries again
    if (error instanceof HttpError) return { text: error.message, isError: true };
    logger.error({ err: String(error), tool: name }, "Ask Zenin tool failed");
    return { text: "That search failed. Try a simpler one.", isError: true };
  }
}

/* ---------------- what the AI is told ---------------- */

const OPS: Record<string, string> = {
  text: "contains, notContains, eq, neq, isEmpty, isNotEmpty",
  number: "eq, neq, gt, gte, lt, lte, between, isEmpty, isNotEmpty",
  date: "eq, before, after, between, isEmpty, isNotEmpty",
  boolean: "isTrue, isFalse, isEmpty",
  choice: "in, notIn (values: option labels), isEmpty, isNotEmpty",
  user: 'in (values: person ids from find_people, or ["$me"] for the person asking), isEmpty, isNotEmpty',
  relation: "in (values: record _ids from the linked table, found with search_records), isEmpty, isNotEmpty",
  department: 'in (values: department ids, or ["$mine"]), isEmpty, isNotEmpty',
  file: "isEmpty, isNotEmpty",
};

function describeColumn(c: Column) {
  const type = valueType(c);
  const label = c.label && c.label !== c.name ? ` "${c.label}"` : "";
  const extra =
    type === "choice" && c.options?.length
      ? ` options: ${c.options.map((o) => o.label).join(" | ")}`
      : type === "relation" && c.ref
        ? ` → ${c.ref}`
        : "";
  return `${c.name}${label} (${FILE_TYPES.has(type) ? "file" : type})${extra}`;
}

async function instructions(user: CurrentUser) {
  const tables = (await getAllSchemas()).filter((s: TableSchema) => can(user, s, "view")).sort((a, b) => a.tableName.localeCompare(b.tableName));
  const today = new Date().toISOString().slice(0, 10);
  // fields hidden from this person aren't described (or searchable: see listForUser)
  const lines = tables.map((t) => `- ${t.tableName} (${title(t.tableName)}): ${visibleColumns(user, t).map(describeColumn).join("; ")}`);
  return `You are Ask Zenin, the assistant inside ${await brandName()}, an ERP. You answer questions about the organization's records for ${user.fullName || user.username}${
    user.departments.length ? ` (${user.departments.map((d) => d.name).join(", ")})` : ""
  }. Today is ${today}.

How to work:
- Look things up with the tools before answering; never guess or invent records, names or numbers. If the tools don't show it, say you couldn't find it.
- You can only read. If asked to add, change or delete something, say you can't do that yet and link to where they can do it themselves, e.g. [New task](/table/tasks/new).
- You see only what ${user.fullName || "this person"} may see. Don't speculate about other records.
- Prefer one precise search (with filters) over many broad ones. For "how many", use \`total\` from search_records.
- When results are cut off (total is more than shown), say how many there are in all and show the most relevant.

How to answer:
- Short and plain, for an office worker. Start with the answer.
- Link every record you mention: [its title](its link), using the link from the tool result.
- Use "- " lists for several items, **bold** sparingly. No tables, no headings, no code.

Filter operators by column type: ${Object.entries(OPS)
    .map(([k, v]) => `${k}: ${v}`)
    .join(". ")}. Dates are YYYY-MM-DD, or $today, $today+7, $today-30. "_createdBy" (who added the record) filters like a user column; "_department" like a department column.

The tables ${user.fullName || "this person"} can see (key (Title): column key "Label" (type)):
${lines.length ? lines.join("\n") : "(none)"}`;
}

/* ---------------- the question ---------------- */

// The last turns of the conversation (from the browser), cleaned up: text
// only, alternating, ending with the new question.
export function cleanTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, "Ask a question");
  const turns = raw
    .slice(-MAX_TURNS)
    .filter((t): t is Turn => Boolean(t) && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim() !== "")
    .map((t) => ({ role: t.role, content: t.content.slice(0, t.role === "user" ? 2000 : 6000) }));
  while (turns.length && turns[0].role !== "user") turns.shift();
  const merged: Turn[] = [];
  for (const t of turns) {
    const last = merged.at(-1);
    if (last?.role === t.role) last.content += `\n\n${t.content}`;
    else merged.push({ ...t });
  }
  if (!merged.length || merged.at(-1)!.role !== "user") throw new HttpError(400, "Ask a question");
  return merged;
}

export async function ask(user: CurrentUser, rawTurns: unknown): Promise<{ answer: string }> {
  if (!(await canAsk(user))) throw new HttpError(403, "Ask Zenin isn't switched on for you.");
  const turns = cleanTurns(rawTurns);
  const ai = await activeAi();
  if (!ai) throw new HttpError(503, "AI features aren't set up.");
  const who = { _id: user._id, isAdmin: isAdmin(user) };
  await checkLimits(who);
  const system = await instructions(user);
  const answer = await metered(ai, "askZenin", who, (meter) =>
    chatWithTools({ system, turns, ai, meter, tools: TOOLS, runTool: (name, input) => runTool(user, name, input) })
  );
  return { answer };
}
