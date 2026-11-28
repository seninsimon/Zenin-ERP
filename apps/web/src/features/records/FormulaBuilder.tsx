import { useState } from "react";
import { ActionIcon, Button, Checkbox, Chip, Group, NumberInput, Radio, Select, Stack, Text } from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";

import { buildRecipe, fieldsFor, newRecipe, recipesFor, SEPARATORS, type Recipe, type RecipeKind, type ResultType } from "./formulaText";
import { columnLabel, type RecordColumn } from "./schema";

// Click-to-build formulas: pick what Zenin should do, then fill the blanks
// from lists that only offer fields that fit. Writes the formula itself, so
// there's nothing to mistype. (Write it yourself is in FormulaEditor.)

const MAX_FIELDS = 6;

export function FormulaBuilder({
  columns,
  target,
  targetLabel,
  resultType,
  onChange,
}: {
  columns: RecordColumn[];
  target?: string; // the field being worked out: never offered
  targetLabel: string;
  resultType?: ResultType; // only recipes that give this
  onChange: (expression: string) => void;
}) {
  const offered = recipesFor(columns, target, resultType);
  const [recipe, setRecipe] = useState<Recipe>(() => newRecipe(offered[0]?.kind ?? "multiply"));
  const built = buildRecipe(recipe, columns, targetLabel);

  if (!offered.length) return null;
  // every change writes the formula again ("" while a blank is empty)
  const update = (next: Recipe) => {
    setRecipe(next);
    onChange(buildRecipe(next, columns, targetLabel)?.expression ?? "");
  };
  const set = (patch: Partial<Recipe>) => update({ ...recipe, ...patch });
  const options = (kind: RecipeKind) => fieldsFor(kind, columns, target).map((c) => ({ value: c.name, label: columnLabel(c) }));
  const pick = (i: number, label: string, kind: RecipeKind = recipe.kind) => (
    <Select
      key={i}
      aria-label={label}
      placeholder="Choose a field"
      data={options(kind)}
      value={recipe.fields[i] ?? null}
      onChange={(v) => set({ fields: recipe.fields.map((f, k) => (k === i ? v : f)) })}
      allowDeselect={false}
      w={170}
      comboboxProps={{ withinPortal: true }}
    />
  );
  const sign = { multiply: "×", add: "+", subtract: "−", join: "+" } as Record<RecipeKind, string>;
  const many = recipe.kind === "multiply" || recipe.kind === "add" || recipe.kind === "subtract" || recipe.kind === "join";

  return (
    <Stack gap="sm">
      <div>
        <Text size="sm" fw={500} mb={6}>
          What should Zenin do?
        </Text>
        <Chip.Group multiple={false} value={recipe.kind} onChange={(v) => update(newRecipe(v as RecipeKind))}>
          <Group gap={6}>
            {offered.map((r) => (
              <Chip key={r.kind} value={r.kind} size="sm" variant="outline">
                {r.label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      </div>

      {many && (
        <Group gap="xs" align="center" wrap="wrap">
          {recipe.fields.map((_, i) => (
            <Group key={i} gap={6} wrap="nowrap">
              {i > 0 && (
                <Text fw={600} c="dimmed" w={14} ta="center">
                  {sign[recipe.kind]}
                </Text>
              )}
              {pick(i, `Field ${i + 1}`)}
              {i >= 2 && (
                <ActionIcon variant="subtle" color="gray" aria-label={`Remove field ${i + 1}`} onClick={() => set({ fields: recipe.fields.filter((__, k) => k !== i) })}>
                  <IconX size={14} />
                </ActionIcon>
              )}
            </Group>
          ))}
          {recipe.fields.length < Math.min(MAX_FIELDS, options(recipe.kind).length) && (
            <Button size="compact-sm" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => set({ fields: [...recipe.fields, null] })}>
              Another field
            </Button>
          )}
        </Group>
      )}

      {recipe.kind === "join" && (
        <Select
          label="Between them"
          data={SEPARATORS.map((s) => ({ value: s.value, label: s.label }))}
          value={recipe.separator}
          onChange={(v) => set({ separator: v ?? " " })}
          allowDeselect={false}
          w={170}
        />
      )}

      {recipe.kind === "percent" && (
        <Group gap="xs" align="center" wrap="wrap">
          <NumberInput aria-label="Percentage" placeholder="18" value={recipe.percent} onChange={(v) => set({ percent: v === "" ? "" : Number(v) })} w={90} decimalScale={4} />
          <Text fw={500}>% of</Text>
          {pick(0, "Percentage of which field")}
        </Group>
      )}

      {recipe.kind === "days" && (
        <Stack gap={6}>
          <Group gap="xs" align="center" wrap="wrap">
            <Text size="sm">From</Text>
            {pick(0, "From date")}
            <Text size="sm">to</Text>
            {pick(1, "To date")}
          </Group>
          <Checkbox
            label="Count both the first and the last day (leave days: yes; hotel nights: no)"
            checked={recipe.countBoth}
            onChange={(e) => set({ countBoth: e.currentTarget.checked })}
          />
        </Stack>
      )}

      {recipe.kind === "dateplus" && (
        <Stack gap={6}>
          <Group gap="xs" align="center" wrap="wrap">
            {pick(0, "Date")}
            <Text fw={600} c="dimmed">
              +
            </Text>
            {recipe.daysFrom === "number" ? (
              <NumberInput aria-label="Days" value={recipe.days} onChange={(v) => set({ days: v === "" ? "" : Number(v) })} w={90} allowDecimal={false} />
            ) : (
              <Select
                aria-label="Days from a field"
                placeholder="Choose a field"
                data={options("multiply")}
                value={recipe.daysField}
                onChange={(v) => set({ daysField: v })}
                allowDeselect={false}
                w={170}
              />
            )}
            <Text size="sm">days</Text>
          </Group>
          <Radio.Group value={recipe.daysFrom} onChange={(v) => set({ daysFrom: v as Recipe["daysFrom"] })}>
            <Group gap="md">
              <Radio value="number" label="A fixed number of days" size="xs" />
              {options("multiply").length > 0 && <Radio value="field" label="Days from a field (like Credit days)" size="xs" />}
            </Group>
          </Radio.Group>
        </Stack>
      )}

      {["multiply", "add", "subtract", "percent"].includes(recipe.kind) && (
        <Group gap="xs" align="center">
          <Checkbox label="Round to" checked={recipe.round} onChange={(e) => set({ round: e.currentTarget.checked })} />
          <NumberInput
            aria-label="Decimals"
            value={recipe.decimals}
            onChange={(v) => set({ decimals: Math.max(0, Math.min(4, Number(v) || 0)) })}
            min={0}
            max={4}
            w={64}
            size="xs"
            disabled={!recipe.round}
            allowDecimal={false}
          />
          <Text size="sm">decimals</Text>
        </Group>
      )}

      <Text size="sm" fw={600} c={built ? undefined : "dimmed"}>
        {built ? built.says : "Fill in the blanks above."}
      </Text>
    </Stack>
  );
}
