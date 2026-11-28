import { useState } from "react";
import { Alert, Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useDebouncedValue, useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { checkConvert, convertToFormula, errorMessage } from "../../api/api";
import { useSchema } from "../../api/reactQueryHooks/useTables";
import { ChangePreview } from "./ChangePreview";
import { tidyFormula, type ResultType } from "./formulaText";
import { FormulaEditor } from "./FormulaEditor";
import { columnLabel, type RecordColumn, type TableSchemaInfo } from "./schema";

// Make a typed field (Number, Date, Text) a formula for the whole column:
// from the column settings, or = in the spreadsheet. Checked on every record
// as you type; Change back (column settings) undoes it.

export function MakeFormulaModal({ table, column, onClose, onDone }: { table: string; column: RecordColumn; onClose: () => void; onDone?: () => void }) {
  const qc = useQueryClient();
  const phone = useMediaQuery("(max-width: 36em)");
  const [expression, setExpression] = useState("");
  const [busy, setBusy] = useState(false);
  const schema = useSchema(table).data as TableSchemaInfo | undefined;
  // Excel-style typing (=Qty*Price) becomes the real formula
  const formula = tidyFormula(expression, schema?.columns ?? []);
  const [debounced] = useDebouncedValue(formula, 500);
  const check = useQuery({
    queryKey: ["convert-check", table, column.name, debounced],
    queryFn: async () => (await checkConvert(table, column.name, debounced)).data,
    enabled: Boolean(debounced),
    retry: false,
    gcTime: 0,
  });
  const label = columnLabel(column);
  const ready = Boolean(check.data && debounced === formula);

  const make = async () => {
    setBusy(true);
    try {
      const { data } = await convertToFormula(table, column.name, formula);
      for (const key of [["schema", table], ["tableData", table], ["sheet", table], ["sheet-totals", table]]) void qc.invalidateQueries({ queryKey: key });
      notifications.show({
        color: "green",
        title: `${label} is a formula now`,
        message: `${data.changed ? `${data.changed} record${data.changed === 1 ? "" : "s"} changed. ` : ""}To undo: its column settings → Change back.`,
      });
      onDone?.();
      onClose();
    } catch (err) {
      notifications.show({ title: "Couldn't make it a formula", message: errorMessage(err), color: "red" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={`Make ${label} a formula`} size="lg" fullScreen={phone}>
      <Stack gap="sm">
        <Text size="sm">
          Write it once for the whole column. Zenin works out {label} on every record, also new ones, and nobody types it any more.
        </Text>
        <FormulaEditor
          table={table}
          columnName={column.name}
          value={expression}
          onChange={setExpression}
          showCheck={false}
          autoFocus
          resultType={column.type as ResultType}
          targetLabel={label}
        />
        {check.isFetching && !check.data && <Loader size="sm" />}
        {check.error && debounced && (
          <Alert color="red" variant="light">
            {errorMessage(check.error)}
          </Alert>
        )}
        {check.data && !check.error && <ChangePreview table={table} check={check.data} />}
        <Group justify="flex-end" gap="sm" mt="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={make} loading={busy} disabled={!ready || Boolean(check.error)}>
            Make it a formula
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
