import { visibleColumns } from "../auth/fields.js";
import { z } from "zod";
import { can, isAdmin } from "../auth/access.js";
import { listForUser } from "../controllers/records.js";
import { HttpError } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { searchUserOptions } from "../repo/userRepo.js";
import { getRecordOptions } from "../repo/recordRepo.js";
import { recordScope } from "../auth/access.js";
import { summarize } from "../controllers/summary.js";
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
//
// Two modes (Settings → AI): "private" (the default): the AI sees only the
// question and the names of the tables and fields; Zenin runs the search or
// the summary itself and shows the results under the answer; the AI learns
// only whether anything matched. "full": the AI also reads the records.

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

/* ---------------- private mode ---------------- */

// What Zenin shows under the answer (private mode): the AI never sees these.
export type AskBlock =
  | {
      kind: "records";
      table: string;
      total: number;
      totalIsEstimate: boolean;
      rows: { id: string; title: string; link: string; details: string }[];
      url: string; // the whole list, with these filters
    }
  | { kind: "summary"; table: string; summary: Awaited<ReturnType<typeof summarize>>; url: string };

const MAX_BLOCKS = 5;
const SummaryInput = z.object({
  table: z.string(),
  group_by: z.string(),
  measure: z.string().optional(),
  search: z.string().max(200).optional(),
  filters: z.array(FilterInput).max(20).optional(),
});
const filterParam = TOOLS[0].parameters.properties as Record<string, unknown>;
const PRIVATE_TOOLS: ToolDef[] = [
  {
    name: "show_records",
    description:
      "Show the person the records of one table that match, as they may see them. Zenin finds them and lists them under your answer. " +
      "You don't see them (private mode): you only learn whether anything matched. Use filters for exact questions (status, dates, " +
      "people, linked records by name), search for words anywhere in a record.",
    parameters: { type: "object", properties: { ...filterParam }, required: ["table"] },
  },
  {
    name: "show_summary",
    description:
      "Show the person counts or totals worked out by Zenin, grouped by one column, as a small table under your answer: " +
      '"how many tasks per status", "total Amount by Customer", "invoiced per month". You don\'t see the numbers.',
    parameters: {
      type: "object",
      properties: {
        table: { type: "string", description: "the table's key" },
        group_by: { type: "string", description: "a column to group by: a choice, person, department, link, yes/no or date (by month)" },
        measure: { type: "string", description: '"count" (default), or "sum:<number column>" or "avg:<number column>"' },
        search: filterParam.search,
        filters: filterParam.filters,
      },
      required: ["table", "group_by"],
    },
  },
];

// "nameContains" on a person or a link: matched here, so names never go to the AI
async function resolveFilters(user: CurrentUser, schema: TableSchema, raw: z.infer<typeof FilterInput>[]) {
  const out: { field: string; op: string; value?: unknown; value2?: unknown; labels?: string[] }[] = [];
  for (const f of raw) {
    if (f.op !== "nameContains") {
      out.push({ field: f.field, op: f.op, value: f.values ?? f.value, value2: f.value2 });
      continue;
    }
    const text = String(f.value ?? f.values?.[0] ?? "").trim();
    const column = schema.columns.find((c) => c.name === f.field);
    let found: { value: string; label: string }[] = [];
    if (f.field === "_createdBy" || column?.type === "user") {
      found = (await searchUserOptions(text, 50)).map((p) => ({ value: p.value, label: p.label }));
    } else if (column?.type === "relation" && column.ref) {
      const ref = await getSchema(column.ref);
      if (ref && can(user, ref, "view")) {
        const rows = await getRecordOptions(ref.tableName, pickDisplayField(ref, column.displayField), { search: text, limit: 200, scope: recordScope(user, ref) });
        found = rows.map((r) => ({ value: r.value, label: r.label }));
      }
    } else throw new HttpError(400, `nameContains works on a person or a link column, not "${f.field}"`);
    // nothing by that name: a filter that matches nothing
    out.push({ field: f.field, op: "in", value: found.length ? found.map((x) => x.value) : ["__none__"], labels: found.map((x) => x.label) });
  }
  return out;
}

const listUrl = (table: string, filters: unknown[], search?: string, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams(extra);
  if (filters.length) q.set("f", JSON.stringify(filters));
  if (search) q.set("q", search);
  const qs = q.toString();
  return `/table/${encodeURIComponent(table)}${qs ? `?${qs}` : ""}`;
};

async function runPrivateTool(user: CurrentUser, name: string, raw: unknown, blocks: AskBlock[]): Promise<{ text: string; isError: boolean }> {
  try {
    if (blocks.length >= MAX_BLOCKS) return { text: "That's enough results for one answer.", isError: true };
    if (name === "show_records") {
      const input = SearchInput.safeParse(raw);
      if (!input.success) return { text: `Invalid input: ${input.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
      const schema = await getSchema(input.data.table);
      if (!schema || !can(user, schema, "view")) throw new HttpError(404, `There's no table "${input.data.table}" you can see. Use a key from the list of tables.`);
      const filters = await resolveFilters(user, schema, input.data.filters ?? []);
      const { data, total, totalIsEstimate } = await listForUser(user, schema, {
        search: input.data.search,
        filters: filters.map(({ labels: _l, ...f }) => f),
        sort: input.data.sort,
        order: input.data.order,
        page: 1,
        limit: input.data.limit ?? 10,
      });
      const display = pickDisplayField(schema);
      const shown = visibleColumns(user, schema).filter((c) => c.name !== display && !FILE_TYPES.has(valueType(c))).slice(0, 3);
      blocks.push({
        kind: "records",
        table: schema.tableName,
        total,
        totalIsEstimate,
        rows: data.map((row) => {
          const id = String(row._id);
          return {
            id,
            title: String((display === "_id" ? id : row[display]) || id),
            link: `/table/${schema.tableName}/${id}`,
            details: shown
              .map((c) => row[c.name])
              .filter((v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length))
              .map((v) => String(short(Array.isArray(v) ? v.join(", ") : v)))
              .join(" · "),
          };
        }),
        url: listUrl(schema.tableName, filters, input.data.search),
      });
      return { text: JSON.stringify({ shown: "under your answer", matched: total > 0 ? "some" : "none" }), isError: false };
    }
    if (name === "show_summary") {
      const input = SummaryInput.safeParse(raw);
      if (!input.success) return { text: `Invalid input: ${input.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`, isError: true };
      const schema = await getSchema(input.data.table);
      if (!schema || !can(user, schema, "view")) throw new HttpError(404, `There's no table "${input.data.table}" you can see. Use a key from the list of tables.`);
      const filters = await resolveFilters(user, schema, input.data.filters ?? []);
      const [fn, field] = (input.data.measure ?? "count").split(":");
      const summary = await summarize(user, schema, { groupBy: input.data.group_by, fn, field, search: input.data.search, filters: filters.map(({ labels: _l, ...f }) => f) });
      blocks.push({
        kind: "summary",
        table: schema.tableName,
        summary,
        url: listUrl(schema.tableName, filters, input.data.search, { view: "summary", group: input.data.group_by, ...(fn !== "count" && field ? { show: `${fn}:${field}` } : {}) }),
      });
      return { text: JSON.stringify({ shown: "under your answer", matched: summary.total.count > 0 ? "some" : "none" }), isError: false };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (error) {
    if (error instanceof HttpError) return { text: error.message, isError: true };
    logger.error({ err: String(error), tool: name }, "Ask Zenin tool failed");
    return { text: "That failed. Try a simpler one.", isError: true };
  }
}

// the operators in private mode: people and links by name, matched by Zenin
const privateOps = (): Record<string, string> => ({
  ...OPS,
  user: 'nameContains (value: part of the person\'s name; Zenin matches it), in (values: ["$me"] for the person asking), isEmpty, isNotEmpty',
  relation: "nameContains (value: part of the linked record's name; Zenin matches it), isEmpty, isNotEmpty",
});

async function privateInstructions(user: CurrentUser) {
  const tables = (await getAllSchemas()).filter((s: TableSchema) => can(user, s, "view")).sort((a, b) => a.tableName.localeCompare(b.tableName));
  const today = new Date().toISOString().slice(0, 10);
  const lines = tables.map((t) => `- ${t.tableName} (${title(t.tableName)}): ${visibleColumns(user, t).map(describeColumn).join("; ")}`);
  return `You are Ask Zenin, the assistant inside ${await brandName()}, an ERP, in PRIVATE MODE. Today is ${today}.

In private mode you never see the organization's records, names or numbers. You turn the person's question into a search
(show_records) or a summary (show_summary); Zenin runs it on its own server and shows the results under your answer.

How to work:
- Use the tools for every question about records. Prefer one precise call with filters.
- "How many" or "total" or "per …" questions: show_summary (group by the column that splits the answer, e.g. status or month).
  A single number ("how many open tasks"): show_summary grouped by a column with few values, such as a status.
- "Which" or "list" questions: show_records.
- You can only read. If asked to add, change or delete something, say you can't do that yet.
- If the person asks what is written inside records (summarise, explain, compare their text), say that in private mode you can
  show the records but not read them, and show them.

How to answer:
- One or two short sentences that introduce what Zenin shows, e.g. "Here are the open tickets." Never state counts, totals,
  names or values yourself: you don't know them. If a tool says nothing matched, say so plainly.
- Plain words, no tables, no headings, no code.

Filter operators by column type: ${Object.entries(privateOps())
    .map(([k, v]) => `${k}: ${v}`)
    .join(". ")}. Dates are YYYY-MM-DD, or $today, $today+7, $today-30. "_createdBy" (who added the record) filters like a user column.

The tables the person can see (key (Title): column key "Label" (type)):
${lines.length ? lines.join("\n") : "(none)"}`;
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

export async function ask(user: CurrentUser, rawTurns: unknown): Promise<{ answer: string; mode: "private" | "full"; blocks: AskBlock[] }> {
  if (!(await canAsk(user))) throw new HttpError(403, "Ask Zenin isn't switched on for you.");
  const turns = cleanTurns(rawTurns);
  const ai = await activeAi();
  if (!ai) throw new HttpError(503, "AI features aren't set up.");
  const who = { _id: user._id, isAdmin: isAdmin(user) };
  await checkLimits(who);
  const mode = (await getAiSettings()).askMode;
  if (mode === "private") {
    const blocks: AskBlock[] = [];
    const system = await privateInstructions(user);
    const answer = await metered(ai, "askZenin", who, (meter) =>
      chatWithTools({ system, turns, ai, meter, tools: PRIVATE_TOOLS, runTool: (name, input) => runPrivateTool(user, name, input, blocks) })
    );
    return { answer, mode, blocks };
  }
  const system = await instructions(user);
  const answer = await metered(ai, "askZenin", who, (meter) =>
    chatWithTools({ system, turns, ai, meter, tools: TOOLS, runTool: (name, input) => runTool(user, name, input) })
  );
  return { answer, mode, blocks: [] };
}
