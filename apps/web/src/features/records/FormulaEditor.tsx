import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Code, Group, Input, SegmentedControl, Stack, Text, Textarea, UnstyledButton } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconAlertCircle, IconCircleCheck, IconSparkles } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";

import { checkFormula, errorMessage, formulaWithAi, getAiBuilders } from "../../api/api";
import { useSchema } from "../../api/reactQueryHooks/useTables";
import { columnLabel, type RecordColumn, type TableSchemaInfo } from "./schema";
import { FormulaBuilder } from "./FormulaBuilder";
import { recipesFor, tidyFormula, type ResultType } from "./formulaText";
import { formatDate, formatNumber } from "../../lib/format";
import { WithHelp } from "../../components/ui/HelpTip";

// Columns a formula can use
const USABLE = ["text", "textarea", "number", "date", "boolean", "autonumber", "formula"];
const KIND: Record<string, string> = { number: "a number", text: "text", date: "a date", boolean: "yes / no" };

const showSample = (type: string, value: unknown) =>
  value === null || value === undefined || value === ""
    ? "empty"
    : type === "number"
      ? formatNumber(value)
      : type === "date"
        ? formatDate(value)
        : type === "boolean"
          ? value
            ? "Yes"
            : "No"
          : `"${String(value)}"`;

// The "Formula" field (column settings, Make it a formula). Two ways, one
// result:
// - Click to build (the default for a new formula): ready-made recipes with
//   lists of fields that fit, so there's nothing to mistype (FormulaBuilder);
// - Write it yourself: the expression, buttons that insert a field, and a
//   live check as you type. Excel-style typing (=Qty*Price, qty × price) is
//   turned into a real formula when you leave the box (tidyFormula).
// `showCheck` false: the caller checks it itself (Make it a formula checks
// every record). `resultType`: only recipes that give this kind of value.
export function FormulaEditor({
  table,
  columnName,
  value,
  onChange,
  error,
  showCheck = true,
  autoFocus,
  resultType,
  targetLabel = "This field",
}: {
  table: string;
  columnName?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  showCheck?: boolean;
  autoFocus?: boolean;
  resultType?: ResultType;
  targetLabel?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const schema = useSchema(table).data as TableSchemaInfo | undefined;
  const usable = (schema?.columns ?? []).filter(
    (c: RecordColumn) => c.name !== columnName && (USABLE.includes(c.type) || (c.type === "choice" && !c.multiple))
  );

  const columns = (schema?.columns ?? []) as RecordColumn[];
  const canBuild = recipesFor(columns, columnName, resultType).length > 0;
  // Describe it: when an AI key is set and "Formulas with AI" is on
  const canDescribe = Boolean(
    useQuery({ queryKey: ["aiBuilders"], queryFn: async () => (await getAiBuilders()).data, staleTime: 60_000 }).data?.formula
  );
  // a new formula starts with the recipes; an existing one opens as written
  const [chosen, setChosen] = useState<"build" | "describe" | "write">(() => (value.trim() ? "write" : "build"));
  const mode = chosen === "build" && !canBuild ? "write" : chosen === "describe" && !canDescribe ? "write" : chosen;
  const ways = [
    ...(canBuild ? [{ value: "build", label: "Pick" }] : []),
    ...(canDescribe ? [{ value: "describe", label: "Describe it" }] : []),
    { value: "write", label: "Write it" },
  ];

  // Describe it: the AI writes it; Zenin's own check (below, or every record
  // in Make it a formula) says whether it fits before anything is saved
  const [wish, setWish] = useState("");
  const [asking, setAsking] = useState(false);
  const [written, setWritten] = useState<{ expression: string; says: string } | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const describe = async () => {
    setAsking(true);
    setAiError(null);
    try {
      const { data } = await formulaWithAi(table, { description: wish, column: columnName, label: targetLabel, resultType });
      setWritten(data);
      onChange(data.expression);
    } catch (err) {
      setWritten(null);
      onChange("");
      setAiError(errorMessage(err, "The AI couldn't write it"));
    } finally {
      setAsking(false);
    }
  };

  const [debounced] = useDebouncedValue(tidyFormula(value, columns), 500);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (!showCheck || !debounced.trim()) return;
    checkFormula(table, debounced, columnName)
      .then(({ data }) => {
        if (!active) return;
        const sample = data.hasRecords ? ` On the latest record: ${showSample(data.type, data.sample)}.` : "";
        setCheck({ ok: true, text: `Gives ${KIND[data.type] ?? data.type}.${sample}` });
      })
      .catch((err) => active && setCheck({ ok: false, text: errorMessage(err, "This formula has a problem") }));
    return () => {
      active = false;
    };
  }, [debounced, table, columnName, showCheck]);

  // put {field} where the cursor is, then the cursor right after it (set as
  // soon as the new text is on screen, before the next key press)
  const caret = useRef<number | null>(null);
  const insert = (name: string) => {
    const el = ref.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    caret.current = start + token.length;
    onChange(value.slice(0, start) + token + value.slice(end));
  };
  useLayoutEffect(() => {
    if (caret.current === null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  const header = (
    <Group justify="space-between" gap="xs" wrap="wrap">
      <Input.Label required>
        <WithHelp topic="formula">Formula</WithHelp>
      </Input.Label>
      {ways.length > 1 && (
        <SegmentedControl
          size="xs"
          aria-label="How to make the formula"
          data={ways}
          value={mode}
          onChange={(v) => {
            setChosen(v as typeof chosen);
            // the choices and Describe it start fresh; Write it keeps what's there to change
            if (v !== "write") onChange("");
            setWritten(null);
            setAiError(null);
          }}
        />
      )}
    </Group>
  );
  const checkLine = showCheck && check && value.trim() && !error && (
    <Group gap={6} wrap="nowrap" align="flex-start">
      {check.ok ? (
        <IconCircleCheck size={16} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0, marginTop: 2 }} />
      ) : (
        <IconAlertCircle size={16} color="var(--mantine-color-error)" style={{ flexShrink: 0, marginTop: 2 }} />
      )}
      <Text size="sm" c={check.ok ? undefined : "var(--mantine-color-error)"}>
        {check.text}
      </Text>
    </Group>
  );
  const errorLine = error && (
    <Text size="sm" c="var(--mantine-color-error)">
      {error}
    </Text>
  );

  if (mode === "describe") {
    return (
      <Stack gap={6}>
        {header}
        <Textarea
          aria-label="What should it do?"
          placeholder="e.g. 10% discount when Qty is over 100, otherwise nothing"
          description="Say it in your own words, in English or Malayalam. The AI gets only this and the field names, never records."
          autosize
          minRows={2}
          maxRows={5}
          maxLength={500}
          value={wish}
          autoFocus={autoFocus}
          onChange={(e) => setWish(e.currentTarget.value)}
        />
        <Group gap="xs">
          <Button size="xs" variant="light" leftSection={<IconSparkles size={14} />} loading={asking} disabled={wish.trim().length < 3} onClick={describe}>
            {written ? "Write it again" : "Write the formula"}
          </Button>
          {written && (
            <Button size="xs" variant="subtle" onClick={() => setChosen("write")}>
              Change it by hand
            </Button>
          )}
        </Group>
        {aiError && (
          <Text size="sm" c="var(--mantine-color-error)">
            {aiError}
          </Text>
        )}
        {written && (
          <Stack gap={2}>
            <Text size="sm" fw={600}>
              {targetLabel} = {written.says}
            </Text>
            <Text size="xs" c="dimmed">
              The AI wrote <Code>{written.expression}</Code>. Check it below before using it.
            </Text>
          </Stack>
        )}
        {checkLine}
        {errorLine}
      </Stack>
    );
  }

  if (mode === "build") {
    return (
      <Stack gap={6}>
        {header}
        <FormulaBuilder columns={columns} target={columnName} targetLabel={targetLabel} resultType={resultType} onChange={onChange} />
        {checkLine}
        {errorLine}
      </Stack>
    );
  }

  return (
    <Stack gap={6}>
      {header}
      <Textarea
        ref={ref}
        aria-label="Formula"
        description="Click a field below, or type its name. + − × ÷ and ROUND, MIN, MAX, ABS, IF, DAYS, ADD_DAYS, CONCAT, BLANK"
        placeholder="e.g. Basic + Allowances - Deductions"
        autosize
        minRows={2}
        maxRows={6}
        styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)" } }}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.currentTarget.value)}
        // Excel-style typing becomes the real formula: =Qty*Price -> {qty} * {price}
        onBlur={() => {
          const tidy = tidyFormula(value, columns);
          if (tidy !== value) onChange(tidy);
        }}
        error={error}
      />
      {usable.length > 0 && (
        <Input.Wrapper label="Insert a field" labelProps={{ size: "xs", c: "dimmed", fw: 500 }}>
          <Group gap={6} mt={4}>
            {usable.map((c) => (
              <UnstyledButton
                key={c.name}
                onClick={() => insert(c.name)}
                px={8}
                py={2}
                fz="xs"
                style={{ border: "1px solid var(--app-border)", borderRadius: "var(--mantine-radius-sm)" }}
                aria-label={`Insert ${columnLabel(c)}`}
              >
                {columnLabel(c)}
              </UnstyledButton>
            ))}
          </Group>
        </Input.Wrapper>
      )}
      <Text size="xs" c="dimmed">
        Examples: <code>Qty * Rate</code> · <code>DAYS(To, From) + 1</code> · <code>{'IF(Stock < Reorder level, "Low", "")'}</code>
      </Text>
      {checkLine}
    </Stack>
  );
}
