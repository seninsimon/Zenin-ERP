import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Text, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconAlertTriangle, IconArrowUpRight, IconPlus } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { DataGrid, type Column, type DataGridHandle } from "react-data-grid";
import "react-data-grid/lib/styles.css";

import { errorMessage, getTableData, insertData, updateData, type ListFilter } from "../../api/api";
import { FieldValue } from "../../components/ui/FieldValue";
import { recordPath, tableTitle } from "../../layout/nav";
import { formatNumber, pluralize } from "../../lib/format";
import { useLiveChanges, useLiveHeldBack } from "../live/live";
import { CompactFields } from "./fields/compact";
import { FieldInput } from "./fields/FieldInput";
import { newLookupCache, parseClipboard, PasteProblem, pastedValue } from "./pasteValues";
import { columnLabel, FILE_TYPES, type RecordColumn, type TableSchemaInfo } from "./schema";
import classes from "./spreadsheet.module.css";

// The Spreadsheet view (workspace/SPREADSHEET_PLAN.md): the table's records as
// a grid. Click a cell and type; each cell saves on its own through the normal
// save (same checks, same history), telling the server the value it started
// from, so a change someone made meanwhile is never overwritten. Paste a block
// from Excel or Google Sheets. Others' changes come in live.

const PAGE = 100;
const MAX_PASTE_ROWS = 200;
// cells the server works out, or that need more room than a cell
const READ_ONLY_TYPES = ["formula", "rollup", "autonumber", "richtext", ...FILE_TYPES];
// pickers: a choice is a change, saved at once
const PICKER_TYPES = ["choice", "user", "relation", "department", "boolean", "date"];

type Row = {
  _id: string;
  draft?: boolean;
  _updatedAt?: string;
  raw: Record<string, unknown>; // stored values (ids), to edit and compare
  show: Record<string, unknown>; // names, to show
};
type CellState = { state: "saving" | "saved" | "error"; message?: string };
type Conflict = { id: string; column: RecordColumn; by: string; mine: unknown; title: string };

const key = (id: string, col: string) => `${id}:${col}`;
const same = (a: unknown, b: unknown) => {
  const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  return (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b);
};
const plain = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

/* ---------------- one cell being edited ---------------- */

function CellEditor({
  row,
  column,
  onRowChange,
  startWith,
  onStarted,
}: {
  row: Row;
  column: RecordColumn;
  onRowChange: (row: Row, commit?: boolean) => void;
  // the key that opened the editor replaces the value, as in Excel
  startWith: string | null;
  onStarted: () => void;
}) {
  // opened by typing: it starts empty, and the key typed lands in it (as in
  // Excel, typing replaces the value); opened with Enter or a double click: the value
  const [value, setValue] = useState<unknown>(() => (startWith === null ? (row.raw[column.name] ?? null) : null));
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    onStarted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const input = box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:not([type=hidden]), textarea");
    input?.focus();

  }, [startWith]);
  const change = (v: unknown) => {
    setValue(v);
    const next = { ...row, raw: { ...row.raw, [column.name]: v } };
    // pickers save at once; typing saves on Enter, Tab or clicking elsewhere
    onRowChange(next, PICKER_TYPES.includes(column.type));
  };
  return (
    <Box ref={box} className={classes.editor}>
      <CompactFields.Provider value>
        <FieldInput id={`sheet-${row._id}-${column.name}`} column={column} value={value} onChange={change} />
      </CompactFields.Provider>
    </Box>
  );
}

/* ---------------- the grid ---------------- */

export function SpreadsheetView({
  table,
  schema,
  search,
  filters,
  sort,
  order,
}: {
  table: string;
  schema: TableSchemaInfo;
  search: string;
  filters: ListFilter[];
  // the same order as the Table view
  sort?: string;
  order?: "asc" | "desc";
}) {
  const scheme = useComputedColorScheme("light");
  const heldBack = useLiveHeldBack();
  const [page, setPage] = useState(1);
  const perms = schema.permissions ?? {};
  const columns = schema.columns;

  // the page of records; every few seconds while live updates are held back
  const query = useQuery({
    queryKey: ["sheet", table, page, search, filters, sort, order],
    queryFn: async () => (await getTableData(table, { page, limit: PAGE, search: search || undefined, filters, sort, order, withRaw: true })).data,
    placeholderData: keepPreviousData,
    refetchInterval: heldBack ? 5_000 : false,
  });
  // others' changes: refresh at once (the cell being edited stays as it is)
  const since = useRef(Date.now());
  const changes = useLiveChanges(table, since.current);
  const { refetch } = query;
  useEffect(() => {
    if (changes.length) void refetch();
  }, [changes.length, refetch]);

  const [pending, setPending] = useState<Record<string, unknown>>({}); // typed, not saved yet
  const [cells, setCells] = useState<Record<string, CellState>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [drafts, setDrafts] = useState<Row[]>([]);
  const [pasting, setPasting] = useState<{ done: number; total: number } | null>(null);
  const [active, setActive] = useState<{ rowIdx: number; colIdx: number } | null>(null);
  // the key that opened a cell's editor ("7"), for that cell only
  const startWith = useRef<{ cell: string; char: string } | null>(null);
  const grid = useRef<DataGridHandle>(null);

  const saved: Row[] = useMemo(
    () =>
      ((query.data?.data ?? []) as Record<string, unknown>[]).map((r) => {
        const id = String(r._id);
        const raw = { ...((r._raw as Record<string, unknown>) ?? {}) };
        const show = { ...r };
        for (const c of columns) {
          const k = key(id, c.name);
          if (k in pending) {
            raw[c.name] = pending[k];
            // names of picked links and people come with the next refresh
            show[c.name] = ["user", "relation", "department"].includes(c.type) ? "…" : pending[k];
          }
        }
        return { _id: id, _updatedAt: r._updatedAt as string | undefined, raw, show };
      }),
    [query.data, columns, pending]
  );
  const rows = useMemo(() => [...saved, ...drafts], [saved, drafts]);
  const total = (query.data?.total as number | undefined) ?? 0;

  const setCell = (id: string, col: string, state: CellState | null) =>
    setCells((all) => {
      const next = { ...all };
      if (state) next[key(id, col)] = state;
      else delete next[key(id, col)];
      return next;
    });
  const flashSaved = (id: string, col: string) => {
    setCell(id, col, { state: "saved" });
    setTimeout(() => setCells((all) => (all[key(id, col)]?.state === "saved" ? Object.fromEntries(Object.entries(all).filter(([k]) => k !== key(id, col))) : all)), 1500);
  };
  const dropPending = (id: string, col: string) =>
    setPending((p) => {
      const next = { ...p };
      delete next[key(id, col)];
      return next;
    });

  // new rows: the departments they go to (split tables need one)
  const newRecordDepartments = () => {
    const mine = schema.allowedDepartments ?? [];
    return schema.byDepartment !== false && mine.length > 1 ? { _departmentIds: [mine[0]._id] } : {};
  };
  const editable = (c: RecordColumn, row: Row) =>
    !READ_ONLY_TYPES.includes(c.type) && !(c.type === "relation" && c.inline) && (row.draft ? Boolean(perms.create) : Boolean(perms.edit));
  const required = columns.filter((c) => c.required && !READ_ONLY_TYPES.includes(c.type));
  const titleOf = (row: Row) => plain(row.show[columns[0]?.name]) || "this record";

  // one cell saved, from the value it started with
  const saveCell = async (row: Row, column: RecordColumn, value: unknown, was: unknown) => {
    const id = row._id;
    setPending((p) => ({ ...p, [key(id, column.name)]: value }));
    setCell(id, column.name, { state: "saving" });
    try {
      await updateData(table, id, { [column.name]: value, _expected: { [column.name]: was ?? null } });
      flashSaved(id, column.name);
    } catch (err) {
      const errors = (err as { response?: { status?: number; data?: { errors?: Record<string, string> } } }).response?.data?.errors;
      if ((err as { response?: { status?: number } }).response?.status === 409 && errors?._cellConflict) {
        setCell(id, column.name, null);
        setConflicts((c) => [...c.filter((x) => !(x.id === id && x.column.name === column.name)), { id, column, by: errors._by ?? "Someone", mine: value, title: titleOf(row) }]);
      } else setCell(id, column.name, { state: "error", message: errors?.[column.name] ?? errorMessage(err) });
    } finally {
      await refetch();
      dropPending(id, column.name);
    }
  };

  // a new row: made once its required fields are filled in
  const saveDraft = async (row: Row) => {
    const missing = required.filter((c) => same(row.raw[c.name], null));
    if (missing.length) return;
    setCell(row._id, "_row", { state: "saving" });
    try {
      await insertData(table, { ...row.raw, ...newRecordDepartments() });
      setDrafts((d) => d.filter((x) => x._id !== row._id));
      await refetch();
    } catch (err) {
      setCell(row._id, "_row", { state: "error", message: errorMessage(err) });
    }
  };

  const onRowsChange = (next: Row[], data: { indexes: number[]; column: { key: string } }) => {
    const column = columns.find((c) => c.name === data.column.key);
    if (!column) return;
    for (const i of data.indexes) {
      const row = next[i];
      const before = rows[i];
      if (!row || !before || same(row.raw[column.name], before.raw[column.name])) continue;
      if (row.draft) {
        const updated = { ...row, show: { ...row.show, [column.name]: row.raw[column.name] } };
        setDrafts((d) => d.map((x) => (x._id === row._id ? updated : x)));
        void saveDraft(updated);
      } else void saveCell(before, column, row.raw[column.name], before.raw[column.name]);
    }
  };

  // paste a block from Excel or Google Sheets, from the active cell on
  const pasteBlock = async (text: string) => {
    if (!active) return;
    const matrix = parseClipboard(text).slice(0, MAX_PASTE_ROWS);
    if (!matrix.length) return;
    const gridColumns = columns.slice(Math.max(0, active.colIdx - 1));
    const cache = newLookupCache();
    let saved = 0;
    let problems = 0;
    setPasting({ done: 0, total: matrix.length });
    for (const [r, cellsText] of matrix.entries()) {
      const target = rows[active.rowIdx + r];
      const values: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      const id = target && !target.draft ? target._id : `paste-${r}`;
      for (const [c, text] of cellsText.entries()) {
        const column = gridColumns[c];
        if (!column) continue;
        if (!editable(column, target ?? { _id: "", draft: true, raw: {}, show: {} })) continue; // read-only cells are skipped
        try {
          values[column.name] = await pastedValue(column, text, cache);
          if (target && !target.draft) expected[column.name] = target.raw[column.name] ?? null;
        } catch (e) {
          problems++;
          if (target && !target.draft) setCell(target._id, column.name, { state: "error", message: e instanceof PasteProblem ? e.message : errorMessage(e) });
        }
      }
      if (Object.keys(values).length) {
        try {
          if (target && !target.draft) {
            await updateData(table, target._id, { ...values, _expected: expected });
            Object.keys(values).forEach((col) => flashSaved(target._id, col));
          } else if (perms.create) await insertData(table, { ...values, ...newRecordDepartments() });
          else problems++;
          saved++;
        } catch (err) {
          problems++;
          const errors = (err as { response?: { data?: { errors?: Record<string, string> } } }).response?.data?.errors ?? {};
          for (const col of Object.keys(values)) if (errors[col] && !id.startsWith("paste-")) setCell(id, col, { state: "error", message: errors[col] });
        }
      }
      setPasting({ done: r + 1, total: matrix.length });
    }
    setPasting(null);
    await refetch();
    notifications.show({
      title: problems ? "Pasted, with some problems" : "Pasted",
      message: `${pluralize(saved, "row")} saved${problems ? `, ${pluralize(problems, "cell")} not: see the red cells` : ""}`,
      color: problems ? "yellow" : "green",
    });
  };

  const gridColumns: Column<Row>[] = [
    {
      key: "_open",
      name: "",
      width: 44,
      frozen: true,
      renderCell: ({ row }) =>
        row.draft ? (
          <Tooltip label={cells[key(row._id, "_row")]?.message ?? `New: fill ${required.map(columnLabel).join(", ") || "a cell"} to save it`}>
            <Badge size="xs" color={cells[key(row._id, "_row")]?.state === "error" ? "red" : "blue"} variant="light">
              {cells[key(row._id, "_row")]?.state === "saving" ? "…" : "New"}
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip label="Open the record">
            <ActionIcon component={Link} to={recordPath(table, row._id)} size="sm" variant="subtle" color="gray" aria-label={`Open ${titleOf(row)}`} tabIndex={-1}>
              <IconArrowUpRight size={14} />
            </ActionIcon>
          </Tooltip>
        ),
    },
    ...columns.map((c, i): Column<Row> => ({
      key: c.name,
      name: columnLabel(c),
      frozen: i === 0,
      resizable: true,
      width: c.type === "boolean" ? 90 : c.type === "number" || c.type === "date" ? 130 : 180,
      editable: (row) => editable(c, row),
      cellClass: (row) => {
        const s = cells[key(row._id, c.name)]?.state;
        return [s ? classes[s] : "", editable(c, row) ? "" : classes.readOnly].filter(Boolean).join(" ") || undefined;
      },
      renderCell: ({ row }) => {
        const s = cells[key(row._id, c.name)];
        const content = <FieldValue column={c} value={row.show[c.name]} />;
        return s?.state === "error" ? (
          <Tooltip label={s.message} multiline maw={280}>
            <span className={classes.cellText}>{content}</span>
          </Tooltip>
        ) : (
          content
        );
      },
      renderEditCell: ({ row, onRowChange }) => {
        const opened = startWith.current?.cell === key(row._id, c.name) ? startWith.current.char : null;
        return <CellEditor row={row} column={c} onRowChange={onRowChange} startWith={opened} onStarted={() => (startWith.current = null)} />;
      },
      editorOptions: { commitOnOutsideClick: !PICKER_TYPES.includes(c.type), closeOnExternalRowChange: false },
    })),
  ];

  const conflict = conflicts[0];
  const resolve = async (useMine: boolean) => {
    if (!conflict) return;
    setConflicts((c) => c.slice(1));
    if (!useMine) return;
    const { data } = await refetch();
    const now = ((data?.data ?? []) as Record<string, unknown>[]).find((r) => r._id === conflict.id);
    const row = saved.find((r) => r._id === conflict.id);
    if (row && now) await saveCell(row, conflict.column, conflict.mine, (now._raw as Record<string, unknown>)?.[conflict.column.name]);
  };

  if (query.isLoading) return <Loader size="sm" />;
  if (query.error) return <Alert color="red">{errorMessage(query.error)}</Alert>;

  return (
    <Box>
      {conflict && (
        <Alert color="yellow" icon={<IconAlertTriangle size={16} />} mb="sm" title={`${conflict.by} changed ${columnLabel(conflict.column)} on ${conflict.title} a moment ago`}>
          <Group gap="xs" justify="space-between" wrap="wrap">
            <Text size="sm">Your change wasn't saved, so theirs isn't lost. The cell shows their value now.</Text>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={() => void resolve(false)}>
                Keep theirs
              </Button>
              <Button size="xs" color="yellow" onClick={() => void resolve(true)}>
                Use mine ({plain(conflict.mine) || "empty"})
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
      <Text size="xs" c="dimmed" mb={6}>
        Click a cell and type; Enter saves, Esc cancels. Paste rows from Excel or Google Sheets.
        {heldBack ? " Others' changes show every few seconds." : " Others' changes show as they happen."}
        {schema.byDepartment !== false && (schema.allowedDepartments?.length ?? 0) > 1 && ` New rows go to ${schema.allowedDepartments![0].name}.`}
      </Text>
      <DataGrid
        ref={grid}
        aria-label={`${tableTitle(table)}: spreadsheet`}
        className={`${classes.sheet} ${scheme === "dark" ? "rdg-dark" : "rdg-light"}`}
        columns={gridColumns}
        rows={rows}
        getRowKey={(r: Row) => r._id}
        onRowsChange={onRowsChange}
        rowHeight={36}
        onActivePositionChange={({ rowIdx, column }) => setActive(column ? { rowIdx, colIdx: column.idx } : null)}
        onCellKeyDown={(args, event) => {
          // typing on a cell replaces its value, as in Excel
          if (args.mode === "ACTIVE" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const c = columns.find((x) => x.name === args.column?.key);
            if (c && ["text", "textarea", "number"].includes(c.type)) startWith.current = { cell: key(args.row._id, c.name), char: event.key };
          }
        }}
        onCellCopy={({ row, column }, event) => {
          event.clipboardData.setData("text/plain", plain(row.show[column.key]));
          event.preventDefault();
        }}
        onCellPaste={({ row }, event) => {
          const text = event.clipboardData.getData("text/plain");
          event.preventDefault();
          void pasteBlock(text);
          return row;
        }}
      />
      <Group justify="space-between" mt="sm" gap="xs" wrap="wrap">
        <Group gap="xs">
          {perms.create && (
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlus size={14} />}
              onClick={() => setDrafts((d) => [...d, { _id: `draft-${Date.now()}`, draft: true, raw: {}, show: {} }])}
            >
              Add row
            </Button>
          )}
          {pasting && (
            <Text size="sm" c="dimmed">
              Pasting {pasting.done} of {pasting.total}…
            </Text>
          )}
        </Group>
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {total ? `${formatNumber((page - 1) * PAGE + 1)}–${formatNumber(Math.min(page * PAGE, total))} of ${formatNumber(total)}` : "No records"}
          </Text>
          <Button size="xs" variant="default" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button size="xs" variant="default" disabled={page * PAGE >= total} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </Group>
      </Group>
    </Box>
  );
}
