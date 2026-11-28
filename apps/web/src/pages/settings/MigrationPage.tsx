import { useEffect, useState } from "react";
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  FileInput,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCircleCheck, IconDownload, IconFileImport, IconInfoCircle, IconLink, IconMathFunction, IconTrash } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMediaQuery } from "@mantine/hooks";
import { Link, useSearchParams } from "react-router-dom";

import api, { errorMessage, type ConvertCheck } from "../../api/api";
import { confirmDanger } from "../../components/ui/confirm";
import { Page, PageHeader, Section } from "../../components/ui/Page";
import { tablePath, tableTitle } from "../../layout/nav";
import { ChangePreview } from "../../features/records/ChangePreview";
import { formatDateTime, formatNumber, pluralize } from "../../lib/format";

// Settings → Bring your data (docs/WORKFLOW.md): move data from Excel or
// CSV (from any other software, after exporting). Zenin works out the tables,
// field types and links; the admin reviews; it imports in the background and
// proves nothing was lost. Off by default.

type PlanType = "text" | "textarea" | "number" | "date" | "boolean" | "choice" | "relation";
type PlanColumn = { index: number; source: string; name: string; label: string; type: PlanType; include: boolean; options?: string[]; required?: boolean; link?: { table: string; by: number; match: number }; filled: number; unfit: number; samples: string[] };
type PlanTable = { key: string; source: string; tableName: string; include: boolean; rows: number; columns: PlanColumn[] };
// a stored procedure, function, trigger or view of the old database (part 3)
type Logic = {
  kind: "function" | "procedure" | "trigger" | "view";
  name: string;
  table?: string;
  summary?: string;
  zenin: "formula" | "total" | "automation" | "approval" | "default" | "required" | "report" | "none";
  suggestion?: string;
  needsPerson: boolean;
  explained: boolean;
};
// a calculation found in the imported data (part 4)
type Rule = {
  id: string;
  table: string;
  column: string;
  kind: "formula" | "total";
  expression?: string;
  says: string;
  hint?: string;
  checked: number;
  fits: number;
  differ: number;
  fills: number;
  used: boolean;
  changed: number;
};
type Proof = { table: string; source: string; rowsInFile: number; imported: number; totals: { label: string; file: number; zenin: number; match: boolean }[]; problems: number };
type Migration = {
  _id: string;
  name: string;
  status: "review" | "importing" | "done" | "failed";
  fileNames: string[];
  plan: { tables: PlanTable[]; logic?: Logic[] };
  createdTables: string[];
  result: { tables: Proof[]; problems: number; allMatch: boolean } | null;
  rules: Rule[] | null;
  error: string | null;
  hasProblems: boolean;
  progress: number;
  createdAt: string;
};

const TYPE_LABELS: Record<PlanType, string> = {
  text: "Text",
  textarea: "Long text",
  number: "Number",
  date: "Date",
  boolean: "Yes / No",
  choice: "Choice (a list)",
  relation: "Link",
};
const STATUS: Record<Migration["status"], { label: string; color: string }> = {
  review: { label: "To review", color: "blue" },
  importing: { label: "Importing", color: "yellow" },
  done: { label: "Imported", color: "teal" },
  failed: { label: "Failed", color: "red" },
};

async function download(id: string) {
  const { data } = await api.get<Blob>(`/migration/${id}/problems`, { responseType: "blob" });
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = "import-problems.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- review ---------------- */

function Review({ m, onChanged }: { m: Migration; onChanged: (m: Migration) => void }) {
  const [plan, setPlan] = useState(m.plan);
  const [busy, setBusy] = useState(false);
  const tableName = (key: string) => plan.tables.find((t) => t.key === key)?.tableName ?? key;

  // type and include changes are checked at once (the counts come back)
  const save = async (next: typeof plan) => {
    setPlan(next);
    try {
      const { data } = await api.put<Migration>(`/migration/${m._id}/plan`, { plan: next });
      setPlan(data.plan);
      onChanged(data);
      return true;
    } catch (err) {
      notifications.show({ title: "Couldn't use that", message: errorMessage(err), color: "red" });
      setPlan(m.plan);
      return false;
    }
  };
  const edit = (tKey: string, change: (t: PlanTable) => PlanTable) => ({ ...plan, tables: plan.tables.map((t) => (t.key === tKey ? change(t) : t)) });
  const editCol = (tKey: string, index: number, patch: Partial<PlanColumn>) =>
    edit(tKey, (t) => ({ ...t, columns: t.columns.map((c) => (c.index === index ? { ...c, ...patch } : c)) }));

  const start = async () => {
    setBusy(true);
    try {
      if (!(await save(plan))) return;
      const { data } = await api.post<Migration>(`/migration/${m._id}/import`);
      onChanged(data);
    } catch (err) {
      notifications.show({ title: "Couldn't start", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  };

  const included = plan.tables.filter((t) => t.include);
  const rows = included.reduce((s, t) => s + t.rows, 0);
  return (
    <Stack>
      <Text size="sm">
        Check what Zenin worked out. Nothing is saved until you press <b>Import</b>. Values that don't fit their type are left empty and listed in a
        file afterwards; every row is imported.
      </Text>
      {plan.tables.map((t) => (
        <Paper key={t.key} withBorder radius="md" p="md">
          <Group justify="space-between" gap="sm" mb={t.include ? "sm" : 0} wrap="wrap">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
              <Checkbox
                aria-label={`Import ${t.source}`}
                checked={t.include}
                onChange={(e) => void save(edit(t.key, (x) => ({ ...x, include: e.currentTarget.checked })))}
              />
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm" truncate>
                  {t.source}
                </Text>
                <Text size="xs" c="dimmed">
                  {pluralize(t.rows, "row")}
                </Text>
              </div>
            </Group>
            {t.include && (
              <TextInput
                size="xs"
                aria-label={`Table name for ${t.source}`}
                leftSection={<Text size="xs" c="dimmed" pl={6}>Table</Text>}
                leftSectionWidth={48}
                w={{ base: "100%", xs: 240 }}
                value={t.tableName}
                onChange={(e) => setPlan(edit(t.key, (x) => ({ ...x, tableName: e.currentTarget.value })))}
                onBlur={() => void save(plan)}
              />
            )}
          </Group>
          {t.include && (
            <Stack gap={6}>
              {t.columns.map((c) => (
                <Box key={c.index} py={6} style={{ borderTop: "1px solid var(--app-border)" }}>
                  <Group gap="sm" wrap="wrap" align="center">
                    <Checkbox
                      aria-label={`Import the column ${c.source}`}
                      checked={c.include}
                      onChange={(e) => void save(editCol(t.key, c.index, { include: e.currentTarget.checked }))}
                    />
                    <TextInput
                      size="xs"
                      aria-label={`Name of ${c.source}`}
                      value={c.label}
                      disabled={!c.include}
                      onChange={(e) => setPlan(editCol(t.key, c.index, { label: e.currentTarget.value }))}
                      onBlur={() => void save(plan)}
                      w={{ base: "calc(100% - 40px)", xs: 200 }}
                    />
                    <Select
                      size="xs"
                      aria-label={`Type of ${c.source}`}
                      w={{ base: "100%", xs: 170 }}
                      disabled={!c.include}
                      value={c.type}
                      allowDeselect={false}
                      data={(Object.keys(TYPE_LABELS) as PlanType[])
                        .filter((k) => k !== "relation" || c.type === "relation" || c.link)
                        .map((k) => ({ value: k, label: k === "relation" ? `Link to ${tableTitle(tableName(c.link?.table ?? ""))}` : TYPE_LABELS[k] }))}
                      onChange={(v) => v && void save(editCol(t.key, c.index, { type: v as PlanType }))}
                    />
                    <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 160 }}>
                      {c.source !== c.label && <>From “{c.source}”. </>}
                      {c.samples.length ? <>e.g. {c.samples.join(", ")}</> : "Empty"}
                      {c.type === "choice" && c.options && <> · {pluralize(c.options.length, "option")}</>}
                      {c.required && <> · required</>}
                      {c.type === "date" && c.samples.some((v) => /\d[ T]\d{1,2}:\d{2}/.test(v)) && <> · the time of day isn't kept</>}
                    </Text>
                  </Group>
                  {c.include && c.type === "relation" && c.link && (
                    <Text size="xs" c="teal" mt={4}>
                      <IconLink size={12} style={{ verticalAlign: -2 }} /> Links each row to its record in {tableTitle(tableName(c.link.table))} ({c.link.match}% of
                      values found)
                    </Text>
                  )}
                  {c.include && c.unfit > 0 && (
                    <Text size="xs" c="orange" mt={4}>
                      {pluralize(c.unfit, "value")} {c.type === "relation" ? "not found there" : c.unfit === 1 ? "doesn't fit" : "don't fit"}: left empty and listed after the import
                    </Text>
                  )}
                </Box>
              ))}
            </Stack>
          )}
        </Paper>
      ))}
      <Group justify="space-between" gap="sm">
        <Button
          variant="subtle"
          color="red"
          onClick={() =>
            confirmDanger({
              title: "Discard this upload?",
              message: "Nothing was imported yet. The uploaded files are deleted.",
              confirmLabel: "Discard",
              onConfirm: async () => {
                await api.delete(`/migration/${m._id}`);
                onChanged({ ...m, _id: "" });
              },
            })
          }
        >
          Discard
        </Button>
        <Button leftSection={<IconFileImport size={16} />} loading={busy} disabled={!included.length} onClick={start}>
          Import {pluralize(rows, "row")} into {pluralize(included.length, "table")}
        </Button>
      </Group>
    </Stack>
  );
}

/* ---------------- the old system's logic (part 3) ---------------- */

const EQUIVALENT: Record<Logic["zenin"], string> = {
  formula: "a formula field",
  total: "a total over linked records",
  automation: "an automation",
  approval: "an approval step and a lock",
  default: "a default value",
  required: "a required or unique field",
  report: "a summary or a report on Home",
  none: "nothing in Zenin",
};
const KIND: Record<Logic["kind"], string> = { function: "Function", procedure: "Procedure", trigger: "Trigger", view: "View" };

// The old database's procedures, functions, triggers and views: they don't
// move by themselves. The AI says what each does and what to use instead.
function LogicReport({ m, aiReady, onChanged }: { m: Migration; aiReady: boolean; onChanged: (m: Migration) => void }) {
  const [busy, setBusy] = useState(false);
  const logic = m.plan.logic ?? [];
  if (!logic.length) return null;
  const explained = logic.some((l) => l.explained);
  const people = logic.filter((l) => l.needsPerson).length;
  const explain = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<Migration>(`/migration/${m._id}/explain`);
      onChanged(data);
    } catch (err) {
      notifications.show({ title: "Couldn't explain it", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between" gap="sm" mb="xs" wrap="wrap">
        <div>
          <Text fw={600} size="sm">
            Logic from the old system: {pluralize(logic.length, "item")}
          </Text>
          <Text size="xs" c="dimmed">
            Procedures, functions, triggers and views don't move by themselves.{" "}
            {explained ? `${pluralize(people, "item")} need${people === 1 ? "s" : ""} a person to decide.` : "Each needs a look."}
          </Text>
        </div>
        {aiReady ? (
          <Button size="xs" variant="light" loading={busy} onClick={explain}>
            {explained ? "Explain again with AI" : "Explain with AI"}
          </Button>
        ) : (
          <Anchor component={Link} to="/settings/ai" size="xs">
            Set up AI to have them explained
          </Anchor>
        )}
      </Group>
      <Stack gap={0}>
        {logic.map((l) => (
          <Box key={`${l.kind}:${l.name}`} py={8} style={{ borderTop: "1px solid var(--app-border)" }}>
            <Group gap="xs" wrap="wrap">
              <Badge size="sm" variant="default">
                {KIND[l.kind]}
              </Badge>
              <Text size="sm" fw={500} style={{ wordBreak: "break-word" }}>
                {l.name}
              </Text>
              {l.table && (
                <Text size="xs" c="dimmed">
                  on {l.table}
                </Text>
              )}
              <Badge size="sm" variant="light" color={l.needsPerson ? "orange" : "teal"} ml="auto">
                {l.needsPerson ? "Needs a person" : `Use ${EQUIVALENT[l.zenin]}`}
              </Badge>
            </Group>
            {l.summary && (
              <Text size="sm" mt={4}>
                {l.summary}
              </Text>
            )}
            <Text size="xs" c="dimmed" mt={2}>
              {l.suggestion ??
                (l.zenin === "none"
                  ? "Nothing in Zenin does this by itself: a person decides what to do."
                  : `Usually ${EQUIVALENT[l.zenin]} in Zenin. Check what it does before relying on it.`)}
            </Text>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

/* ---------------- rules found in the data (part 4) ---------------- */

const fieldOf = (r: Rule) => r.says.split(" = ")[0];

// "Use it": checked again on today's records, with what would change
function UseRule({ m, rule, onClose, onChanged }: { m: Migration; rule: Rule; onClose: () => void; onChanged: (m: Migration) => void }) {
  const [busy, setBusy] = useState(false);
  const phone = useMediaQuery("(max-width: 36em)");
  const check = useQuery({
    queryKey: ["migration-rule", m._id, rule.id],
    queryFn: async () => (await api.get<ConvertCheck>(`/migration/${m._id}/rules/${encodeURIComponent(rule.id)}`)).data,
    gcTime: 0,
  });
  const p = check.data?.proof;
  const use = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<Migration>(`/migration/${m._id}/rules/${encodeURIComponent(rule.id)}/use`);
      onChanged(data);
      notifications.show({ message: `${fieldOf(rule)} is worked out by Zenin now`, color: "green" });
      onClose();
    } catch (err) {
      notifications.show({ title: "Couldn't use it", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Use this rule" size="lg" fullScreen={phone}>
      <Stack gap="sm">
        <Text fw={600}>{rule.says}</Text>
        <Text size="sm">
          {fieldOf(rule)} in {tableTitle(rule.table)} becomes {rule.kind === "total" ? "a total over the linked records" : "a formula"}. Zenin works it out on
          every record, also new ones, and nobody types it any more.
        </Text>
        {check.isLoading && <Loader size="sm" />}
        {check.error && <Alert color="red">{errorMessage(check.error)}</Alert>}
        {p && (
          <>
            <ChangePreview table={rule.table} check={check.data!} />
            <Text size="xs" c="dimmed">
              Not right? <b>Change back</b> makes it a normal field again, and puts back the values the rule changed.
            </Text>
          </>
        )}
        <Group justify="flex-end" gap="sm" mt="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={use} loading={busy} disabled={!p}>
            Use this rule
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// Calculations the old system did (Amount = Qty × Price), found by checking
// every record. Zenin finds them itself: nothing goes to the AI.
function RulesReport({ m, onChanged }: { m: Migration; onChanged: (m: Migration) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [using, setUsing] = useState<Rule | null>(null);
  const rules = m.rules;
  const run = async (key: string, path: string, done?: string) => {
    setBusy(key);
    try {
      const { data } = await api.post<Migration>(`/migration/${m._id}${path}`);
      onChanged(data);
      if (done) notifications.show({ message: done, color: "green" });
    } catch (err) {
      notifications.show({ title: "That didn't work", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(null);
    }
  };
  const inUse = rules?.filter((r) => r.used).length ?? 0;
  return (
    <Paper withBorder radius="md" p="md">
      <Group justify="space-between" gap="sm" mb="xs" wrap="nowrap" align="flex-start">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text fw={600} size="sm">
            Rules found in your data{rules?.length ? `: ${rules.length}` : ""}
          </Text>
          <Text size="xs" c="dimmed">
            Calculations the old system did, found by checking every record. Use one and Zenin works it out from now on.
            Zenin finds them itself: nothing is sent to the AI.
            {inUse ? ` ${inUse} in use.` : ""}
          </Text>
        </Box>
        {rules !== null && (
          <Button size="xs" variant="subtle" loading={busy === "look"} onClick={() => run("look", "/rules")}>
            Look again
          </Button>
        )}
      </Group>
      {rules === null ? (
        <Button size="xs" variant="light" leftSection={<IconMathFunction size={14} />} loading={busy === "look"} onClick={() => run("look", "/rules")}>
          Look for rules
        </Button>
      ) : !rules.length ? (
        <Text size="sm" c="dimmed">
          No calculations found: every field looks typed in by people. Totals, rates and dates that follow a rule would show here.
        </Text>
      ) : (
        <Stack gap={0}>
          {rules.map((r) => (
            <Group key={r.id} gap="sm" py={8} wrap="nowrap" align="flex-start" style={{ borderTop: "1px solid var(--app-border)" }}>
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Group gap="xs" wrap="wrap">
                  <Badge size="sm" variant="default">
                    {tableTitle(r.table)}
                  </Badge>
                  <Text size="sm" fw={500} style={{ wordBreak: "break-word" }}>
                    {r.says}
                  </Text>
                </Group>
                <Text size="xs" c="dimmed" mt={2}>
                  {[
                    r.hint,
                    r.used
                      ? `In use${r.changed ? `: changed ${pluralize(r.changed, "record")}` : ""}`
                      : `Fits ${formatNumber(r.fits)} of ${formatNumber(r.checked)} records${r.differ ? `; ${formatNumber(r.differ)} differ` : ""}${r.fills ? `; fills ${formatNumber(r.fills)} empty` : ""}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </Box>
              {r.used ? (
                <Group gap={6} wrap="nowrap">
                  <Badge size="sm" color="teal" variant="light">
                    In use
                  </Badge>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    loading={busy === r.id}
                    onClick={() => run(r.id, `/rules/${encodeURIComponent(r.id)}/undo`, `${fieldOf(r)} is a normal field again`)}
                  >
                    Change back
                  </Button>
                </Group>
              ) : (
                <Button size="xs" variant="light" onClick={() => setUsing(r)}>
                  Use it
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {using && <UseRule m={m} rule={using} onClose={() => setUsing(null)} onChanged={onChanged} />}
    </Paper>
  );
}

/* ---------------- result ---------------- */

function Result({ m, onRemoved }: { m: Migration; onRemoved: () => void }) {
  const r = m.result!;
  const total = r.tables.reduce((s, t) => s + t.imported, 0);
  return (
    <Stack>
      {r.allMatch ? (
        <Alert color="teal" icon={<IconCircleCheck size={18} />} title={`Imported ${pluralize(total, "row")} into ${pluralize(r.tables.length, "table")}`}>
          Every row is here, and every number column adds up to the same total as in the file.
          {r.problems ? ` ${pluralize(r.problems, "value")} didn't fit and ${r.problems === 1 ? "was" : "were"} left empty: see the list.` : ""}
        </Alert>
      ) : (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title="Imported, but something doesn't match">
          Compare the rows and totals below with the file before relying on it.
        </Alert>
      )}
      <Box style={{ overflowX: "auto" }}>
        <Table fz="sm" verticalSpacing={6} miw={420}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th scope="col">Table</Table.Th>
              <Table.Th scope="col" ta="right">Rows in file</Table.Th>
              <Table.Th scope="col" ta="right">In Zenin</Table.Th>
              <Table.Th scope="col">Totals</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {r.tables.map((t) => (
              <Table.Tr key={t.table}>
                <Table.Td>
                  <Anchor component={Link} to={tablePath(t.table)} size="sm">
                    {tableTitle(t.table)}
                  </Anchor>
                </Table.Td>
                <Table.Td ta="right" className="tabular-nums">{formatNumber(t.rowsInFile)}</Table.Td>
                <Table.Td ta="right" className="tabular-nums" c={t.imported === t.rowsInFile ? undefined : "red"}>
                  {formatNumber(t.imported)}
                </Table.Td>
                <Table.Td>
                  {t.totals.length ? (
                    t.totals.map((x) => (
                      <Text key={x.label} size="xs" c={x.match ? "teal" : "red"}>
                        {x.match ? "✓" : "✗"} {x.label}: {formatNumber(x.zenin)}
                        {x.match ? "" : ` (file: ${formatNumber(x.file)})`}
                      </Text>
                    ))
                  ) : (
                    <Text size="xs" c="dimmed">No number columns</Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
      <Group justify="space-between" gap="sm">
        <Button
          variant="subtle"
          color="red"
          leftSection={<IconTrash size={16} />}
          onClick={() =>
            confirmDanger({
              title: "Remove this import?",
              message: `Its ${pluralize(m.createdTables.length, "table")} and all their records are deleted, with the app made for them. Use this to try again.`,
              confirmLabel: "Remove import",
              onConfirm: async () => {
                await api.delete(`/migration/${m._id}`);
                onRemoved();
              },
            })
          }
        >
          Remove this import
        </Button>
        {m.hasProblems && (
          <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => download(m._id).catch((e) => notifications.show({ message: errorMessage(e), color: "red" }))}>
            Download the {pluralize(r.problems, "value")} that didn't fit
          </Button>
        )}
      </Group>
    </Stack>
  );
}

/* ---------------- page ---------------- */

export default function MigrationPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const openId = params.get("id");
  const open = (id: string | null) => setParams(id ? { id } : {}, { replace: true });
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ["migration"], queryFn: async () => (await api.get<{ enabled: boolean; aiReady: boolean; imports: Migration[] }>("/migration")).data });
  const enabled = list.data?.enabled ?? false;
  const one = useQuery({
    queryKey: ["migration", openId],
    queryFn: async () => (await api.get<Migration>(`/migration/${openId}`)).data,
    enabled: Boolean(enabled && openId),
    // while importing: every second and a half
    refetchInterval: (q) => (q.state.data?.status === "importing" ? 1500 : false),
  });
  const m = one.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["migration"] });
    // new tables and app: the sidebar, Home and Manage apps follow
    for (const key of ["tables", "apps", "dashboards", "schema"]) qc.invalidateQueries({ queryKey: [key] });
  };
  // an import just finished: the menu and the list catch up
  const status = m?.status;
  useEffect(() => {
    if (status !== "done" && status !== "failed") return;
    qc.invalidateQueries({ queryKey: ["migration"], exact: true });
    for (const key of ["tables", "apps", "dashboards", "schema"]) qc.invalidateQueries({ queryKey: [key] });
  }, [status, qc]);

  const toggle = async (on: boolean) => {
    // flips at once; put back if saving fails
    const before = qc.getQueryData<{ enabled: boolean; aiReady: boolean; imports: Migration[] }>(["migration"]);
    if (before) qc.setQueryData(["migration"], { ...before, enabled: on });
    try {
      await api.put("/migration/settings", { enabled: on });
      refresh();
      notifications.show({ message: on ? "Bring your data is on" : "Bring your data is off", color: "green" });
    } catch (err) {
      if (before) qc.setQueryData(["migration"], before);
      notifications.show({ title: "Couldn't change it", message: errorMessage(err), color: "red" });
    }
  };

  const read = async () => {
    setError(null);
    if (!files.length) return setError("Choose an Excel or CSV file");
    setReading(true);
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      const { data } = await api.post<Migration>("/migration/upload", form, { headers: { "Content-Type": "multipart/form-data" } });
      setFiles([]);
      qc.setQueryData(["migration", data._id], data);
      refresh();
      open(data._id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReading(false);
    }
  };

  return (
    <Page title="Bring your data" breadcrumbs={[{ label: "Settings", to: "/settings" }, { label: "Bring your data" }]} width="wide">
      <PageHeader
        title="Bring your data"
        description="Move your data from Excel, CSV or another system. Zenin builds the tables and links, then proves nothing was lost."
      />
      {!list.data ? (
        <Center h={200}>
          <Loader />
        </Center>
      ) : (
        <Stack gap="lg">
          <Section padding="md">
            <Switch
              label="Bring your data"
              description="Off normally. Turn it on while you move data in, and off again when you're done: it accepts large uploads."
              checked={enabled}
              onChange={(e) => void toggle(e.currentTarget.checked)}
            />
          </Section>

          {enabled && openId && (
            <Section
              title={m ? m.name : "…"}
              description={m ? `${STATUS[m.status].label} · uploaded ${formatDateTime(m.createdAt)}` : undefined}
              actions={
                <Button variant="subtle" size="xs" onClick={() => open(null)}>
                  Back to the list
                </Button>
              }
            >
              {!m ? (
                one.isError ? (
                  <Text size="sm" c="dimmed">This import doesn't exist any more.</Text>
                ) : (
                  <Loader size="sm" />
                )
              ) : m.status === "review" ? (
                <Stack>
                <LogicReport m={m} aiReady={Boolean(list.data?.aiReady)} onChanged={(next) => qc.setQueryData(["migration", next._id], next)} />
                <Review
                  key={m._id}
                  m={m}
                  onChanged={(next) => {
                    if (!next._id) {
                      refresh();
                      open(null);
                      return;
                    }
                    qc.setQueryData(["migration", next._id], next);
                    refresh();
                  }}
                />
                </Stack>
              ) : m.status === "importing" ? (
                <Stack gap="xs">
                  <Text size="sm">Importing… you can leave this page; it carries on.</Text>
                  <Progress value={m.progress} animated aria-label="Import progress" />
                </Stack>
              ) : m.status === "done" && m.result ? (
                <Stack>
                <Result
                  m={m}
                  onRemoved={() => {
                    refresh();
                    open(null);
                  }}
                />
                <RulesReport m={m} onChanged={(next) => qc.setQueryData(["migration", next._id], next)} />
                <LogicReport m={m} aiReady={Boolean(list.data?.aiReady)} onChanged={(next) => qc.setQueryData(["migration", next._id], next)} />
                </Stack>
              ) : (
                <Stack>
                  <Alert color="red" icon={<IconAlertTriangle size={18} />} title="The import failed; nothing was kept">
                    {m.error}
                  </Alert>
                  <Group>
                    <Button
                      variant="default"
                      onClick={async () => {
                        await api.delete(`/migration/${m._id}`);
                        refresh();
                        open(null);
                      }}
                    >
                      Remove it
                    </Button>
                  </Group>
                </Stack>
              )}
            </Section>
          )}

          {enabled && !openId && (
            <>
              <Section title="Upload" description="An Excel workbook (each sheet becomes a table), CSV files (each file a table), or a database dump (.sql). Up to 20 MB.">
                <Stack>
                  <FileInput
                    label="Files"
                    placeholder="Choose .xlsx, .csv or .sql files"
                    accept=".xlsx,.csv,.sql"
                    multiple
                    clearable
                    leftSection={<IconFileImport size={16} />}
                    value={files}
                    onChange={(f) => {
                      setFiles(f);
                      setError(null);
                    }}
                    error={error}
                  />
                  <Group justify="space-between" gap="sm">
                    <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 220 }}>
                      From other software (Tally, Zoho, another ERP): export your data to Excel or CSV first. From a database (MySQL, Postgres, SQL Server): a plain SQL dump with its data.
                    </Text>
                    <Button onClick={read} loading={reading} disabled={!files.length}>
                      Read the files
                    </Button>
                  </Group>
                  <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
                    <Text size="xs">
                      Data and links move automatically. Business rules from the old system (its automatic calculations, approvals and stored
                      procedures) don't. From a database dump, Zenin lists them, and the AI can explain each one and what to use in Zenin instead.
                    </Text>
                  </Alert>
                </Stack>
              </Section>

              {list.data.imports.length > 0 && (
                <Section title="Imports" padding={0}>
                  {list.data.imports.map((x) => (
                    <Group key={x._id} justify="space-between" gap="sm" px="lg" py="sm" wrap="wrap" style={{ borderTop: "1px solid var(--app-border)" }}>
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" fw={500} truncate>
                          {x.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatDateTime(x.createdAt)}
                          {x.result ? ` · ${pluralize(x.result.tables.reduce((s, t) => s + t.imported, 0), "row")} in ${pluralize(x.result.tables.length, "table")}` : ""}
                        </Text>
                      </div>
                      <Group gap="xs">
                        <Badge variant="light" color={STATUS[x.status].color}>
                          {STATUS[x.status].label}
                        </Badge>
                        <Button size="xs" variant="default" onClick={() => open(x._id)}>
                          Open
                        </Button>
                      </Group>
                    </Group>
                  ))}
                </Section>
              )}
            </>
          )}
        </Stack>
      )}
    </Page>
  );
}
