import { useEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, Alert, Badge, Box, Button, Group, Loader, Text, Tooltip, useComputedColorScheme } from "@mantine/core";
import { IconAlertTriangle, IconArrowUpRight, IconLock, IconPlus } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { DataGrid, SelectColumn, type Column, type DataGridHandle } from "react-data-grid";
import "react-data-grid/lib/styles.css";

import { deleteData, errorMessage, getTableData, insertData, updateData, type ListFilter } from "../../api/api";
import { useBulkDelete } from "../../api/reactQueryHooks/useTables";
import { confirmDanger } from "../../components/ui/confirm";
import { BulkUpdateModal } from "./BulkUpdateModal";
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
// from Excel or Google Sheets. Others' changes come in live. Ctrl+Z (or Undo
// in the message) puts the last change back, cell by cell, only where nobody
// changed the cell since (workspace/SHEET_UNDO_PLAN.md).

const PAGE = 100;
const MAX_PASTE_ROWS = 200;
// cells the server works out, or that need more room than a cell
const READ_ONLY_TYPES = ["formula", "rollup", "autonumber", "richtext", ...FILE_TYPES];
// pickers: a choice is a change, saved at once
const PICKER_TYPES = ["choice", "user", "relation", "department", "boolean", "date"];

type Row = {
  _id: string;
  draft?: boolean;
  // locked at a status ("Paid"): read-only
  locked?: string;
  _updatedAt?: string;
  raw: Record<string, unknown>; // stored values (ids), to edit and compare
  show: Record<string, unknown>; // names, to show
};
type CellState = { state: "saving" | "saved" | "error"; message?: string };
type Conflict = { id: string; column: RecordColumn; by: string; mine: unknown; title: string };
// a block of cells, by grid position (rows from 0; columns as the grid counts them)
type Range = { r1: number; c1: number; r2: number; c2: number };
// the grid's first columns: row tick boxes, then "open the record"
const DATA_START = 2;
const MAX_CLEAR_WITHOUT_ASKING = 20;
// changes Undo remembers (this tab only)
const MAX_UNDO = 20;

// one cell changed: back to `before` while it's still `after` (as stored)
type Change = { id: string; col: string; before: unknown; after: unknown };
// one thing done in the sheet: a typed cell, a fill, a paste, Delete; and
// the records it made (pasted below the last row, a new row)
type Step = { what: string; changes: Change[]; created: string[] };
type ApiError = { response?: { status?: number; data?: { errors?: Record<string, string> } } };

const key = (id: string, col: string) => `${id}:${col}`;
const same = (a: unknown, b: unknown) => {
  const empty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
  return (empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b);
};
// what the server stored for a written cell (it sends them back); the value sent if not
const storedValue = (res: { data?: { saved?: Record<string, unknown> } }, col: string, sent: unknown) =>
  res.data?.saved && col in res.data.saved ? res.data.saved[col] : (sent ?? null);
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
  // a selected block of cells (drag, Shift+click, Shift+arrows, Ctrl+A)
  const [range, setRange] = useState<Range | null>(null);
  const dragging = useRef<{ rowIdx: number; colIdx: number } | null>(null);
  useEffect(() => {
    const stop = () => (dragging.current = null);
    // while dragging: the cell under the pointer (the grid may hold on to the
    // mouse, so cells themselves aren't told), by its row and column numbers
    const move = (e: MouseEvent) => {
      const d = dragging.current;
      if (!d) return;
      const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest("[role=gridcell]");
      const row = cell?.closest("[role=row]");
      if (!cell || !row || !grid.current?.element?.contains(cell)) return;
      const colIdx = Number(cell.getAttribute("aria-colindex")) - 1;
      const rowIdx = Number(row.getAttribute("aria-rowindex")) - 2; // row 1 is the header
      if (Number.isNaN(colIdx) || Number.isNaN(rowIdx) || rowIdx < 0 || colIdx < DATA_START) return;
      setRange(d.rowIdx === rowIdx && d.colIdx === colIdx ? null : { r1: d.rowIdx, c1: d.colIdx, r2: rowIdx, c2: colIdx });
    };
    window.addEventListener("mouseup", stop);
    window.addEventListener("mousemove", move);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("mousemove", move);
    };
  }, []);
  // ticked rows, for Delete rows / Change a field
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<string>>(() => new Set());
  const [bulkEdit, setBulkEdit] = useState(false);
  const bulkDelete = useBulkDelete(table);
  // Undo: the last changes made here, newest last
  const undoStack = useRef<Step[]>([]);
  useEffect(() => {
    undoStack.current = [];
  }, [table]);

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
        return { _id: id, _updatedAt: r._updatedAt as string | undefined, locked: (r._locked as string | undefined) ?? undefined, raw, show };
      }),
    [query.data, columns, pending]
  );
  const rows = useMemo(() => [...saved, ...drafts], [saved, drafts]);
  const total = (query.data?.total as number | undefined) ?? 0;
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r._id, i])), [rows]);
  const lastCol = DATA_START + columns.length - 1;
  const block = range && {
    top: Math.min(range.r1, range.r2),
    bottom: Math.max(range.r1, range.r2),
    left: Math.max(DATA_START, Math.min(range.c1, range.c2)),
    right: Math.min(lastCol, Math.max(range.c1, range.c2)),
  };
  const many = Boolean(block && (block.top !== block.bottom || block.left !== block.right));
  const inBlock = (rowIdx: number, colIdx: number) =>
    Boolean(many && block && rowIdx >= block.top && rowIdx <= block.bottom && colIdx >= block.left && colIdx <= block.right);
  const colAt = (colIdx: number) => columns[colIdx - DATA_START];

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
    !row.locked &&
    !READ_ONLY_TYPES.includes(c.type) && !(c.type === "relation" && c.inline) && (row.draft ? Boolean(perms.create) : Boolean(perms.edit));
  const required = columns.filter((c) => c.required && !READ_ONLY_TYPES.includes(c.type));
  const titleOf = (row: Row) => plain(row.show[columns[0]?.name]) || "this record";

  // one cell saved, from the value it started with; `done` collects it for Undo
  const saveCell = async (row: Row, column: RecordColumn, value: unknown, was: unknown, done?: Change[]) => {
    const id = row._id;
    setPending((p) => ({ ...p, [key(id, column.name)]: value }));
    setCell(id, column.name, { state: "saving" });
    try {
      const res = await updateData(table, id, { [column.name]: value, _expected: { [column.name]: was ?? null } });
      done?.push({ id, col: column.name, before: was ?? null, after: storedValue(res, column.name, value) });
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
      const res = await insertData(table, { ...row.raw, ...newRecordDepartments() });
      const created = res.data?.data?.insertedId as string | undefined;
      if (created) remember({ what: "New row", changes: [], created: [created] });
      setDrafts((d) => d.filter((x) => x._id !== row._id));
      await refetch();
    } catch (err) {
      setCell(row._id, "_row", { state: "error", message: errorMessage(err) });
    }
  };

  const onRowsChange = (next: Row[], data: { indexes: number[]; column: { key: string } }) => {
    const column = columns.find((c) => c.name === data.column.key);
    if (!column) return;
    // a typed cell, or (several rows) the fill handle: one step for Undo
    const done: Change[] = [];
    const saving: Promise<void>[] = [];
    for (const i of data.indexes) {
      const row = next[i];
      const before = rows[i];
      if (!row || !before || same(row.raw[column.name], before.raw[column.name])) continue;
      if (row.draft) {
        const updated = { ...row, show: { ...row.show, [column.name]: row.raw[column.name] } };
        setDrafts((d) => d.map((x) => (x._id === row._id ? updated : x)));
        void saveDraft(updated);
      } else saving.push(saveCell(before, column, row.raw[column.name], before.raw[column.name], done));
    }
    if (!saving.length) return;
    void Promise.all(saving).then(() => {
      if (saving.length === 1) remember({ what: `${columnLabel(column)} change`, changes: done, created: [] });
      else if (done.length) {
        const step: Step = { what: "Fill", changes: done, created: [] };
        remember(step);
        announce(step, "Filled", `${pluralize(done.length, "cell")} filled`, "green");
      }
    });
  };

  // paste a block from Excel or Google Sheets, from the active cell on; onto a
  // selected block, one copied value fills all of it (as in Excel)
  const pasteBlock = async (text: string) => {
    if (!active) return;
    let matrix = parseClipboard(text).slice(0, MAX_PASTE_ROWS);
    if (!matrix.length) return;
    const start = many && block ? { rowIdx: block.top, colIdx: block.left } : active;
    if (many && block && matrix.length === 1 && matrix[0].length === 1) {
      matrix = Array.from({ length: block.bottom - block.top + 1 }, () => Array.from({ length: block.right - block.left + 1 }, () => matrix[0][0]));
    }
    const gridColumns = columns.slice(Math.max(0, start.colIdx - DATA_START));
    const cache = newLookupCache();
    let saved = 0;
    let problems = 0;
    const step: Step = { what: "Paste", changes: [], created: [] };
    setPasting({ done: 0, total: matrix.length });
    for (const [r, cellsText] of matrix.entries()) {
      const target = rows[start.rowIdx + r];
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
            const res = await updateData(table, target._id, { ...values, _expected: expected });
            for (const col of Object.keys(values)) {
              step.changes.push({ id: target._id, col, before: expected[col] ?? null, after: storedValue(res, col, values[col]) });
              flashSaved(target._id, col);
            }
          } else if (perms.create) {
            const res = await insertData(table, { ...values, ...newRecordDepartments() });
            if (res.data?.data?.insertedId) step.created.push(res.data.data.insertedId as string);
          } else problems++;
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
    remember(step);
    announce(
      step,
      problems ? "Pasted, with some problems" : "Pasted",
      `${pluralize(saved, "row")} saved${problems ? `, ${pluralize(problems, "cell")} not: see the red cells` : ""}`,
      problems ? "yellow" : "green"
    );
  };

  // Delete: empties the selected cells (or the active one) that can be changed
  const clearCells = () => {
    const area = many && block ? block : active ? { top: active.rowIdx, bottom: active.rowIdx, left: active.colIdx, right: active.colIdx } : null;
    if (!area) return;
    const byRow = new Map<Row, RecordColumn[]>();
    for (let r = area.top; r <= area.bottom; r++) {
      const row = rows[r];
      if (!row || row.draft) continue;
      for (let c = area.left; c <= area.right; c++) {
        const column = colAt(c);
        if (column && editable(column, row) && !same(row.raw[column.name], null)) byRow.set(row, [...(byRow.get(row) ?? []), column]);
      }
    }
    const count = [...byRow.values()].reduce((n, list) => n + list.length, 0);
    if (!count) return;
    const run = async () => {
      const step: Step = { what: "Delete", changes: [], created: [] };
      for (const [row, list] of byRow) {
        const values = Object.fromEntries(list.map((c) => [c.name, c.multiple ? [] : null]));
        const expected = Object.fromEntries(list.map((c) => [c.name, row.raw[c.name] ?? null]));
        try {
          const res = await updateData(table, row._id, { ...values, _expected: expected });
          for (const c of list) {
            step.changes.push({ id: row._id, col: c.name, before: expected[c.name], after: storedValue(res, c.name, values[c.name]) });
            flashSaved(row._id, c.name);
          }
        } catch (err) {
          const errors = (err as { response?: { data?: { errors?: Record<string, string> } } }).response?.data?.errors ?? {};
          for (const c of list) setCell(row._id, c.name, { state: "error", message: errors[c.name] ?? errorMessage(err) });
        }
      }
      await refetch();
      remember(step);
      if (step.changes.length > 1) announce(step, "Emptied", `${pluralize(step.changes.length, "cell")} emptied`, "green");
    };
    if (count > MAX_CLEAR_WITHOUT_ASKING) {
      confirmDanger({
        title: `Empty ${pluralize(count, "cell")}`,
        message: "Their values are removed. Each record's history keeps what they were.",
        confirmLabel: "Empty cells",
        onConfirm: run,
      });
    } else void run();
  };

  /* ---- Undo ---- */

  const remember = (step: Step) => {
    if (!step.changes.length && !step.created.length) return;
    undoStack.current = [...undoStack.current, step].slice(-MAX_UNDO);
  };

  // a message with an Undo button for this step (paste, fill, Delete on a block)
  const announce = (step: Step, title: string, message: string, color: string) => {
    const id = `sheet-${Date.now()}-${Math.random()}`;
    notifications.show({
      id,
      title,
      color,
      message: (
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <span>{message}</span>
          <Button
            size="compact-xs"
            variant="default"
            onClick={() => {
              notifications.hide(id);
              void undo(step);
            }}
          >
            Undo
          </Button>
        </Group>
      ),
    });
  };

  // Put one record's cells back; on a clash, cell by cell so the others still go back.
  const putBack = async (id: string, list: Change[]): Promise<{ back: number; kept: number; by: string | null; failed: number }> => {
    try {
      await updateData(table, id, {
        ...Object.fromEntries(list.map((c) => [c.col, c.before])),
        _expected: Object.fromEntries(list.map((c) => [c.col, c.after])),
      });
      return { back: list.length, kept: 0, by: null, failed: 0 };
    } catch (err) {
      const res = (err as ApiError).response;
      if (res?.status === 409 && res.data?.errors?._cellConflict) {
        if (list.length === 1) return { back: 0, kept: 1, by: res.data.errors._by ?? null, failed: 0 };
        const parts = await Promise.all(list.map((c) => putBack(id, [c])));
        return parts.reduce((a, b) => ({ back: a.back + b.back, kept: a.kept + b.kept, by: a.by ?? b.by, failed: a.failed + b.failed }));
      }
      if (res?.status === 404) return { back: 0, kept: 0, by: null, failed: 0 }; // deleted since: nothing to put back
      return { back: 0, kept: 0, by: null, failed: list.length };
    }
  };

  // Undo a step (the newest one when none is given)
  const undo = async (given?: Step) => {
    const stack = undoStack.current;
    const step = given ?? stack[stack.length - 1];
    if (!step || !stack.includes(step)) {
      notifications.show({ message: given ? "That was already undone" : "Nothing to undo", color: "gray" });
      return;
    }
    undoStack.current = stack.filter((s) => s !== step);
    const byRecord = new Map<string, Change[]>();
    for (const c of step.changes) byRecord.set(c.id, [...(byRecord.get(c.id) ?? []), c]);
    const results = await Promise.all([...byRecord].map(([id, list]) => putBack(id, list)));
    const total = results.reduce((a, b) => ({ back: a.back + b.back, kept: a.kept + b.kept, by: a.by ?? b.by, failed: a.failed + b.failed }), { back: 0, kept: 0, by: null as string | null, failed: 0 });
    // records it made: removed again, if you may delete
    let removed = 0;
    let stayed = 0;
    for (const id of step.created) {
      if (!perms.delete) {
        stayed++;
        continue;
      }
      try {
        await deleteData(table, id);
        removed++;
      } catch {
        stayed++;
      }
    }
    await refetch();
    const notes = [
      total.kept ? `${pluralize(total.kept, "cell")} changed by ${total.by ?? "someone else"} since: left as they are` : "",
      total.failed ? `${pluralize(total.failed, "cell")} couldn't be put back` : "",
      stayed ? `${pluralize(stayed, "new row")} stayed (you can't delete records here)` : "",
    ].filter(Boolean);
    const did = [total.back ? `${pluralize(total.back, "cell")} put back` : "", removed ? `${pluralize(removed, "new row")} removed` : ""].filter(Boolean);
    notifications.show({
      title: notes.length ? `${step.what} partly undone` : `${step.what} undone`,
      message: [...did, ...notes].join(". ") || "Nothing needed changing",
      color: notes.length ? "yellow" : "green",
    });
  };

  // Shift+arrows: grow or shrink the block from where it started
  const extendBy = (dRow: number, dCol: number) => {
    if (!active) return;
    const from = range ?? { r1: active.rowIdx, c1: active.colIdx, r2: active.rowIdx, c2: active.colIdx };
    const r2 = Math.min(rows.length - 1, Math.max(0, from.r2 + dRow));
    const c2 = Math.min(lastCol, Math.max(DATA_START, from.c2 + dCol));
    setRange({ ...from, r2, c2 });
    grid.current?.scrollToCell({ rowIdx: r2, idx: c2 });
  };

  const gridColumns: Column<Row>[] = [
    { ...SelectColumn, frozen: true },
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
          <Tooltip label={row.locked ? `Locked (${row.locked}): open the record to reopen it` : "Open the record"}>
            <ActionIcon
              component={Link}
              to={recordPath(table, row._id)}
              size="sm"
              variant="subtle"
              color={row.locked ? "orange" : "gray"}
              aria-label={row.locked ? `Open ${titleOf(row)} (locked)` : `Open ${titleOf(row)}`}
              tabIndex={-1}
            >
              {row.locked ? <IconLock size={14} /> : <IconArrowUpRight size={14} />}
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
        const picked = inBlock(rowIndex.get(row._id) ?? -1, DATA_START + i);
        return [s ? classes[s] : "", editable(c, row) ? "" : classes.readOnly, picked ? classes.picked : ""].filter(Boolean).join(" ") || undefined;
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
      {selectedRows.size > 0 && (
        <Group gap="xs" mb="xs" p="xs" className={classes.rowBar} wrap="wrap">
          <Text size="sm" fw={500}>
            {pluralize(selectedRows.size, "row")} selected
          </Text>
          {perms.edit && (
            <Button size="xs" variant="default" onClick={() => setBulkEdit(true)}>
              Change a field
            </Button>
          )}
          {perms.delete && (
            <Button
              size="xs"
              variant="light"
              color="red"
              onClick={() =>
                confirmDanger({
                  title: `Delete ${pluralize(selectedRows.size, "record")}`,
                  message: "They're removed for everyone. The audit log keeps what they were.",
                  confirmLabel: "Delete records",
                  onConfirm: async () => {
                    await bulkDelete.mutateAsync([...selectedRows]);
                    setSelectedRows(new Set());
                    await refetch();
                  },
                })
              }
            >
              Delete rows
            </Button>
          )}
          <Button size="xs" variant="subtle" color="gray" onClick={() => setSelectedRows(new Set())}>
            Clear
          </Button>
        </Group>
      )}
      <Text size="xs" c="dimmed" mb={6}>
        {many && block
          ? `${pluralize((block.bottom - block.top + 1) * (block.right - block.left + 1), "cell")} selected: Ctrl+C copies, Ctrl+V pastes into them, Delete empties them. `
          : ""}
        Click a cell and type; Enter saves, Esc cancels. Drag or Shift+click to select cells. Paste rows from Excel or Google Sheets. Ctrl+Z undoes.
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
        selectedRows={selectedRows}
        onSelectedRowsChange={setSelectedRows}
        isRowSelectionDisabled={(r: Row) => Boolean(r.draft)}
        onCellMouseDown={(args, event) => {
          const colIdx = args.column.idx;
          if (colIdx < DATA_START) return;
          // Shift+click: the block from the active cell to here
          if (event.shiftKey && active) {
            setRange({ r1: active.rowIdx, c1: active.colIdx, r2: args.rowIdx, c2: colIdx });
            event.preventGridDefault();
            return;
          }
          dragging.current = { rowIdx: args.rowIdx, colIdx };
          setRange(null);
        }}
        // the small square at a cell's corner: drag it to copy the value down
        onFill={({ columnKey, sourceRow, targetRow }) => {
          const column = columns.find((x) => x.name === columnKey);
          if (!column || !editable(column, targetRow)) return targetRow;
          return { ...targetRow, raw: { ...targetRow.raw, [columnKey]: sourceRow.raw[columnKey] } };
        }}
        rowHeight={36}
        onActivePositionChange={({ rowIdx, column }) => setActive(column ? { rowIdx, colIdx: column.idx } : null)}
        onCellKeyDown={(args, event) => {
          if (args.mode === "ACTIVE") {
            const arrows: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
            if (event.shiftKey && arrows[event.key]) {
              extendBy(...arrows[event.key]);
              event.preventGridDefault();
              event.preventDefault();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
              setRange({ r1: 0, c1: DATA_START, r2: rows.length - 1, c2: lastCol });
              event.preventGridDefault();
              event.preventDefault();
              return;
            }
            if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
              void undo();
              event.preventGridDefault();
              event.preventDefault();
              return;
            }
            if (event.key === "Delete") {
              clearCells();
              event.preventGridDefault();
              return;
            }
            if (event.key === "Escape" || arrows[event.key]) setRange(null);
          }
          // typing on a cell replaces its value, as in Excel
          if (args.mode === "ACTIVE" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const c = columns.find((x) => x.name === args.column?.key);
            if (c && ["text", "textarea", "number"].includes(c.type)) startWith.current = { cell: key(args.row._id, c.name), char: event.key };
          }
        }}
        onCellCopy={({ row, column }, event) => {
          // a block: rows on lines, cells between tabs (pastes into Excel / Sheets)
          const text =
            many && block
              ? rows
                  .slice(block.top, block.bottom + 1)
                  .map((r) => Array.from({ length: block.right - block.left + 1 }, (_, k) => plain(r.show[colAt(block.left + k)?.name ?? ""])).join("\t"))
                  .join("\n")
              : plain(row.show[column.key]);
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
        }}
        onCellPaste={({ row }, event) => {
          const text = event.clipboardData.getData("text/plain");
          event.preventDefault();
          void pasteBlock(text);
          return row;
        }}
      />
      {bulkEdit && (
        <BulkUpdateModal
          table={table}
          columns={columns}
          ids={[...selectedRows]}
          opened
          onClose={() => setBulkEdit(false)}
          onDone={() => {
            setSelectedRows(new Set());
            void refetch();
          }}
        />
      )}
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
