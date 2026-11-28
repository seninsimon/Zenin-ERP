import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  ThemeIcon,
  UnstyledButton,
} from "@mantine/core";
import { useForm } from "@mantine/form";
import { useMediaQuery } from "@mantine/hooks";

import { changeBackColumn, errorMessage, getConversion } from "../../api/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { IconMathFunction } from "@tabler/icons-react";
import { MakeFormulaModal } from "../../features/records/MakeFormulaModal";
import { CAN_BE_FORMULA, type RecordColumn } from "../../features/records/schema";
import { useAddColumn, useTables, useUpdateColumn } from "../../api/reactQueryHooks/useTables";
import { useAccessLevels } from "../../api/reactQueryHooks/useAdmin";
import { tableTitle } from "../../layout/nav";
import type { ChoiceOption, RollupConfig } from "../../features/records/schema";
import { ChoiceOptionsEditor } from "./ChoiceOptionsEditor";
import { DefaultValueInput } from "./DefaultValueInput";
import { FormulaEditor } from "../../features/records/FormulaEditor";
import { RollupEditor } from "./RollupEditor";
import { columnTypeInfo, columnTypes, INDEXABLE_TYPES, INDEXED_HELP, optionsError, slugify } from "./columnTypes";
import classes from "./settings.module.css";
import { WithHelp } from "../../components/ui/HelpTip";

export type SchemaColumn = {
  _id?: string;
  name: string;
  label?: string;
  type: string;
  showInTable?: boolean;
  required?: boolean;
  indexed?: boolean;
  ref?: string | null;
  multiple?: boolean;
  options?: ChoiceOption[];
  default?: unknown;
  autonumber?: { prefix: string };
  formula?: { expression: string; type?: string };
  rollup?: RollupConfig;
  inline?: boolean;
  // only these levels of the table's app (and admins) see it
  onlyLevels?: string[];
};

const COLUMN_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_ -]{0,62}$/;

type Values = {
  type: string;
  label: string;
  name: string;
  required: boolean;
  indexed: boolean;
  showInTable: boolean;
  ref: string | null;
  multiple: boolean;
  options: ChoiceOption[];
  // null = no default
  default: unknown;
  prefix: string;
  expression: string;
  rollup: Partial<RollupConfig>;
  inline: boolean;
  // "Who sees this field": [] = everyone who can use the table
  onlyLevels: string[];
  limited: boolean;
};

const NEW_COLUMN: Values = {
  type: "text",
  label: "",
  name: "",
  required: false,
  indexed: false,
  showInTable: true,
  ref: null,
  multiple: false,
  options: [],
  default: null,
  prefix: "",
  expression: "",
  rollup: {},
  inline: false,
  onlyLevels: [],
  limited: false,
};

// INV-0001 for the prefix "INV-"
const autonumberExample = (prefix: string, n = 1) =>
  `${prefix.trim().split("{YYYY}").join(String(new Date().getFullYear()))}${String(n).padStart(4, "0")}`;

// column types that can have a default value (the API checks the same)
const DEFAULTABLE_TYPES = ["text", "textarea", "number", "boolean", "choice", "date", "user", "department"];

// Text columns become a Choice using the values already in them
const TEXT_TYPES = ["text", "textarea"];

// Type picker: icon + name + one-line description per column type.
function TypePicker({ value, onChange }: { value: string; onChange: (type: string) => void }) {
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} spacing="xs" role="radiogroup" aria-label="Column type">
      {columnTypes.map((t) => {
        const selected = value === t.value;
        return (
          <UnstyledButton
            key={t.value}
            role="radio"
            aria-checked={selected}
            className={classes.typeCard}
            data-selected={selected || undefined}
            onClick={() => onChange(t.value)}
          >
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <ThemeIcon variant={selected ? "filled" : "light"} size={30} radius="md" aria-hidden>
                <t.icon size={17} stroke={1.75} />
              </ThemeIcon>
              <div style={{ minWidth: 0 }}>
                <Text size="sm" fw={600}>
                  {t.label}
                </Text>
                <Text size="xs" c="dimmed" lh={1.35}>
                  {t.description}
                </Text>
              </div>
            </Group>
          </UnstyledButton>
        );
      })}
    </SimpleGrid>
  );
}

// "Add column" (no `column`) or "Edit column".
export function ColumnModal({
  opened,
  onClose,
  table,
  column,
  existingNames,
}: {
  opened: boolean;
  onClose: () => void;
  table: string;
  column?: SchemaColumn | null;
  existingNames: string[];
}) {
  const editing = Boolean(column);
  const fullScreen = useMediaQuery("(max-width: 36em)");
  const { data: tables = [] } = useTables();
  const add = useAddColumn(table);
  const update = useUpdateColumn(table, column?.name ?? "");
  // the name follows the label until the user edits the name themselves
  const [nameTouched, setNameTouched] = useState(false);

  const form = useForm<Values>({
    initialValues: NEW_COLUMN,
    validate: {
      label: (v) => (v.trim() ? null : "Enter a label"),
      name: (v) =>
        editing
          ? null
          : !v.trim()
            ? "Enter a column name"
            : !COLUMN_NAME.test(v.trim())
              ? "Use letters, numbers, _ or - (max 63 characters)"
              : existingNames.includes(v.trim())
                ? "A column with this name already exists"
                : null,
      ref: (v, values) => (!editing && values.type === "relation" && !v ? "Choose the table to link to" : null),
      options: (v, values) => (values.type === "choice" && !convertingToChoice(values.type) ? optionsError(v) : null),
      expression: (v, values) => (values.type === "formula" && !v.trim() ? "Enter a formula" : null),
      onlyLevels: (v, values) => (values.limited && !v.length ? "Choose at least one level" : null),
      rollup: (v, values) =>
        values.type !== "rollup"
          ? null
          : !v.from || !v.via
            ? "Choose the linked records"
            : v.fn && v.fn !== "count" && !v.field
              ? "Choose the field to work out"
              : null,
    },
  });

  useEffect(() => {
    if (!opened) return;
    setNameTouched(Boolean(column));
    form.setValues(
      column
        ? {
            type: column.type === "richText" ? "richtext" : column.type,
            label: column.label || column.name,
            name: column.name,
            required: Boolean(column.required),
            indexed: Boolean(column.indexed),
            showInTable: column.showInTable !== false,
            ref: column.ref ?? null,
            multiple: Boolean(column.multiple),
            options: column.options ?? [],
            default: column.default ?? null,
            prefix: column.autonumber?.prefix ?? "",
            expression: column.formula?.expression ?? "",
            rollup: column.rollup ?? {},
            inline: Boolean(column.inline),
            onlyLevels: column.onlyLevels ?? [],
            limited: Boolean(column.onlyLevels?.length),
          }
        : NEW_COLUMN
    );
    form.resetDirty();
    form.clearErrors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, column]);

  const indexable = INDEXABLE_TYPES.includes(form.values.type);
  // editing a Text column into a Choice: the options come from its values
  function convertingToChoice(type: string) {
    return editing && type === "choice" && column?.type !== "choice";
  }
  const setType = (type: string) => {
    form.setFieldValue("type", type);
    if (type !== form.values.type) form.setFieldValue("default", null); // it wouldn't fit the new type
    if (!INDEXABLE_TYPES.includes(type)) form.setFieldValue("indexed", false);
  };

  // a choice default follows its option when it's renamed, and goes when it's removed
  const setOptions = (next: ChoiceOption[]) => {
    const current = form.values.default;
    if (current !== null) {
      const follow = (label: unknown) => {
        const id = form.values.options.find((o) => o.label === label)?.id;
        return id ? next.find((o) => o.id === id)?.label : undefined;
      };
      const moved = Array.isArray(current) ? current.map(follow).filter(Boolean) : follow(current);
      form.setFieldValue("default", Array.isArray(moved) ? (moved.length ? moved : null) : (moved ?? null));
    }
    form.setFieldValue("options", next);
  };

  const submit = form.onSubmit(async (v) => {
    try {
      if (editing) {
        await update.mutateAsync({
          label: v.label.trim(),
          type: v.type,
          showInTable: v.showInTable,
          required: v.required,
          indexed: indexable && v.indexed,
          ...(v.type === "choice" && column?.type === "choice" ? { options: v.options } : {}),
          default: DEFAULTABLE_TYPES.includes(v.type) ? (v.default ?? null) : null,
          ...(v.type === "autonumber" ? { autonumber: { prefix: v.prefix } } : {}),
          ...(v.type === "formula" ? { formula: { expression: v.expression } } : {}),
          ...(v.type === "rollup" ? { rollup: { fn: "count", ...v.rollup } } : {}),
          ...(v.type === "relation" && !v.multiple ? { inline: v.inline } : {}),
          onlyLevels: v.limited ? v.onlyLevels : [],
        });
      } else {
        await add.mutateAsync({
          name: v.name.trim(),
          label: v.label.trim(),
          type: v.type,
          showInTable: v.showInTable,
          required: v.required,
          indexed: indexable && v.indexed,
          ref: v.type === "relation" ? v.ref : null,
          multiple: ["relation", "user", "department", "choice"].includes(v.type) ? v.multiple : false,
          ...(v.type === "choice" ? { options: v.options } : {}),
          ...(DEFAULTABLE_TYPES.includes(v.type) && v.default !== null ? { default: v.default } : {}),
          ...(v.type === "autonumber" ? { autonumber: { prefix: v.prefix } } : {}),
          ...(v.type === "formula" ? { formula: { expression: v.expression } } : {}),
          ...(v.type === "rollup" ? { rollup: { fn: "count", ...v.rollup } } : {}),
          ...(v.type === "relation" && !v.multiple ? { inline: v.inline } : {}),
          ...(v.limited ? { onlyLevels: v.onlyLevels } : {}),
        });
      }
      onClose();
    } catch (err) {
      const message = errorMessage(err, "Couldn't save the column");
      // formula problems belong under the formula
      form.setErrors(
        v.type === "formula" && /formula/i.test(message)
          ? { expression: message }
          : v.type === "rollup" && /total/i.test(message)
            ? { rollup: message }
            : /names each record/.test(message)
              ? { onlyLevels: message }
              : { label: message }
      );
    }
  });

  // editing: links and people store ids, so their type is fixed, and other
  // columns can't become one (existing values couldn't be converted)
  const ID_TYPES = ["relation", "user", "department", "autonumber", "formula", "rollup"];
  const fixedType = ID_TYPES.includes(column?.type ?? "");
  // Choice <-> Text only (their values are plain text)
  const allowedEditType = (type: string) => {
    if (fixedType) return type === column?.type;
    if (ID_TYPES.includes(type)) return false;
    if (column?.type === "choice") return type === "choice" || TEXT_TYPES.includes(type);
    return type !== "choice" || TEXT_TYPES.includes(column?.type ?? "");
  };
  const editTypes = columnTypes.filter((t) => allowedEditType(t.value)).map((t) => ({ value: t.value, label: t.label }));
  const typeHelp = () => {
    if (column?.type === "relation") return `Links to ${tableTitle(column.ref ?? "")}. Delete and re-add the column to link elsewhere.`;
    if (column?.type === "formula" || column?.type === "rollup") return "Worked out by Zenin on every record; nobody types it.";
    if (fixedType) return `${columnTypeInfo(column!.type).label} columns keep their type. Delete and re-add the column to change it.`;
    if (convertingToChoice(form.values.type)) {
      return "The options are made from the values already in this column. You can rename, recolour or remove them afterwards.";
    }
    if (column?.type === "choice" && form.values.type !== "choice") return "Each record keeps its choice as text.";
    if (column?.type === "choice") return "Can be changed to Text.";
    return "Changing the type doesn't convert existing values.";
  };

  // the levels of this table's app, for "Who sees this field"
  const { data: levelData } = useAccessLevels();
  const appLevels = levelData?.apps.find((a) => a.tables.includes(table))?.levels ?? [];

  const tableOptions = (tables as { tableName: string }[]).map((t) => ({
    value: t.tableName,
    label: tableTitle(t.tableName),
  }));

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={editing ? `Edit column "${column?.label || column?.name}"` : "Add column"}
      size={editing ? "md" : "xl"}
      fullScreen={fullScreen}
    >
      <form onSubmit={submit} noValidate>
        <Stack gap="md">
          {editing ? (
            <Select
              label="Type"
              data={editTypes}
              value={form.values.type}
              onChange={(v) => v && setType(v)}
              allowDeselect={false}
              disabled={fixedType}
              description={typeHelp()}
            />
          ) : (
            <Stack gap={6}>
              <Text size="sm" fw={500}>
                Type
              </Text>
              <TypePicker value={form.values.type} onChange={setType} />
            </Stack>
          )}

          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <TextInput
              label="Label"
              description="Shown to people above the field and as the column header"
              placeholder="e.g. Order date"
              withAsterisk
              data-autofocus
              {...form.getInputProps("label")}
              onChange={(e) => {
                const label = e.currentTarget.value;
                form.setFieldValue("label", label);
                if (!editing && !nameTouched) form.setFieldValue("name", slugify(label));
              }}
            />
            <TextInput
              label="Column name"
              description={editing ? "Can't be changed once created" : "Used in imports, exports and the API"}
              placeholder="e.g. order_date"
              withAsterisk={!editing}
              disabled={editing}
              {...form.getInputProps("name")}
              onChange={(e) => {
                setNameTouched(true);
                form.setFieldValue("name", e.currentTarget.value);
              }}
            />
          </SimpleGrid>

          {editing && column && <FormulaSwitch table={table} column={column} onDone={onClose} />}

          {form.values.type === "relation" && !editing && (
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
              <Select
                label={<WithHelp topic="relation">Links to table</WithHelp>}
                placeholder="Choose a table"
                data={tableOptions}
                searchable
                withAsterisk
                {...form.getInputProps("ref")}
              />
              <Switch
                mt={{ base: 0, sm: 30 }}
                label="Allow several records"
                description="e.g. several tags instead of one"
                {...form.getInputProps("multiple", { type: "checkbox" })}
              />
            </SimpleGrid>
          )}

          {form.values.type === "relation" && !form.values.multiple && form.values.ref && (
            <Switch
              label={`Edit these inside the ${tableTitle(form.values.ref)} form`}
              description={`Like an invoice's lines: add and change them while editing a ${tableTitle(form.values.ref).toLowerCase()} record`}
              {...form.getInputProps("inline", { type: "checkbox" })}
            />
          )}

          {(form.values.type === "user" || form.values.type === "department") && !editing && (
            <Switch
              label={form.values.type === "user" ? "Allow several people" : "Allow several departments"}
              description={
                form.values.type === "user"
                  ? "e.g. reviewers or team members instead of one owner"
                  : "e.g. the teams a project involves"
              }
              {...form.getInputProps("multiple", { type: "checkbox" })}
            />
          )}

          {form.values.type === "choice" && !convertingToChoice(form.values.type) && (
            <ChoiceOptionsEditor
              value={form.values.options}
              onChange={setOptions}
              error={form.errors.options as string | undefined}
              editing={editing}
            />
          )}

          {form.values.type === "choice" && !editing && (
            <Switch
              label="Allow several choices"
              description="e.g. tags or skills instead of one status"
              {...form.getInputProps("multiple", { type: "checkbox" })}
            />
          )}

          {DEFAULTABLE_TYPES.includes(form.values.type) && !convertingToChoice(form.values.type) && (
            <DefaultValueInput
              type={form.values.type}
              multiple={form.values.multiple}
              options={form.values.options}
              value={form.values.default}
              onChange={(value) => form.setFieldValue("default", value)}
            />
          )}

          {form.values.type === "formula" && (
            <FormulaEditor
              table={table}
              columnName={editing ? column?.name : undefined}
              value={form.values.expression}
              onChange={(expression) => form.setFieldValue("expression", expression)}
              error={form.errors.expression as string | undefined}
            />
          )}

          {form.values.type === "rollup" && (
            <RollupEditor
              table={table}
              value={form.values.rollup}
              onChange={(rollup) => form.setFieldValue("rollup", rollup)}
              error={form.errors.rollup as string | undefined}
            />
          )}

          {form.values.type === "autonumber" && (
            <TextInput
              label="Prefix"
              placeholder="e.g. INV-"
              description={
                editing
                  ? `A new prefix is used for new records only. Next one looks like ${autonumberExample(form.values.prefix)}.`
                  : `Records are numbered ${autonumberExample(form.values.prefix)}, ${autonumberExample(form.values.prefix, 2)}, … Add {YYYY} for the year (numbering then restarts each year).`
              }
              maxLength={30}
              {...form.getInputProps("prefix")}
            />
          )}

          <Stack gap="sm">
            {/* auto-numbers and formulas are always filled in */}
            {!["autonumber", "formula", "rollup"].includes(form.values.type) && (
              <Switch
                label="Required"
                description="Records can't be saved without a value"
                {...form.getInputProps("required", { type: "checkbox" })}
              />
            )}
            <Radio.Group
              label={<WithHelp topic="fieldLevels">Who sees this field</WithHelp>}
              value={form.values.limited ? "some" : "everyone"}
              onChange={(v) => {
                const some = v === "some";
                form.setFieldValue("limited", some);
                // Managers by default: the usual reason to limit a field
                if (some && !form.values.onlyLevels.length && appLevels.some((l) => l.level === "manager")) form.setFieldValue("onlyLevels", ["manager"]);
              }}
            >
              <Stack gap={6} mt={6}>
                <Radio value="everyone" label="Everyone who can use this table" />
                <Radio value="some" label="Only some levels" description="Admins always see it. Formulas and totals that use it are hidden from the others too." />
              </Stack>
            </Radio.Group>
            {form.values.limited && (
              <Checkbox.Group
                aria-label="Levels that see this field"
                value={form.values.onlyLevels}
                onChange={(v) => form.setFieldValue("onlyLevels", v)}
                error={form.errors.onlyLevels}
              >
                <Group gap="md" mt={-4}>
                  {appLevels.map((l) => (
                    <Checkbox key={l.level} value={l.level} label={l.name} />
                  ))}
                </Group>
              </Checkbox.Group>
            )}
            <Switch
              label="Show in the records list"
              description="Users can still show or hide it from the table's view options"
              {...form.getInputProps("showInTable", { type: "checkbox" })}
            />
            {/* only shown where it applies: fewer switches to read */}
            {indexable && (
              <Switch
                label="Indexed for fast sorting"
                description={INDEXED_HELP}
                {...form.getInputProps("indexed", { type: "checkbox" })}
              />
            )}
          </Stack>

          <Group justify="flex-end" gap="xs" mt="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={add.isPending || update.isPending}>
              {editing ? "Save column" : "Add column"}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// Editing a field: "Make it a formula…" for a typed Number / Date / Text
// field; "Change back" for one that was made a formula (schema/convert.ts).
function FormulaSwitch({ table, column, onDone }: { table: string; column: SchemaColumn; onDone: () => void }) {
  const qc = useQueryClient();
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const computed = column.type === "formula" || column.type === "rollup";
  const conversion = useQuery({
    queryKey: ["conversion", table, column.name],
    queryFn: async () => (await getConversion(table, column.name)).data.conversion,
    enabled: computed,
  });
  const label = column.label || column.name;

  if (CAN_BE_FORMULA.includes(column.type)) {
    return (
      <Group gap={6} wrap="wrap">
        <IconMathFunction size={16} color="var(--mantine-color-dimmed)" />
        <Text size="sm" c="dimmed">
          Should Zenin work {label} out from other fields?
        </Text>
        <Button size="compact-sm" variant="subtle" onClick={() => setMaking(true)}>
          Make it a formula…
        </Button>
        {making && <MakeFormulaModal table={table} column={column as unknown as RecordColumn} onClose={() => setMaking(false)} onDone={onDone} />}
      </Group>
    );
  }
  const was = conversion.data;
  if (!computed || !was) return null;
  const changeBack = async () => {
    setBusy(true);
    try {
      const { data } = await changeBackColumn(table, column.name);
      for (const key of [["schema", table], ["tableData", table], ["sheet", table], ["sheet-totals", table], ["conversion", table]]) void qc.invalidateQueries({ queryKey: key });
      notifications.show({ color: "green", message: `${label} is a ${columnTypeInfo(was.from).label} field again${data.changed ? `; ${data.changed} old value${data.changed === 1 ? "" : "s"} put back` : ""}` });
      onDone();
    } catch (err) {
      notifications.show({ title: "Couldn't change it back", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert variant="light" color="gray" icon={<IconMathFunction size={18} />} title={`Made a formula from a ${columnTypeInfo(was.from).label} field`}>
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="sm">
          Change back: people type it again{was.changed ? `, and the ${was.changed} value${was.changed === 1 ? "" : "s"} the formula changed come back` : ""}.
        </Text>
        <Button size="xs" variant="default" loading={busy} onClick={changeBack}>
          Change back
        </Button>
      </Group>
    </Alert>
  );
}
