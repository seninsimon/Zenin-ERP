import { Alert, Anchor, Box, Table, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "react-router-dom";

import type { ConvertCheck } from "../../api/api";
import { recordPath } from "../../layout/nav";
import { formatNumber, pluralize } from "../../lib/format";

// What making a field a formula does to today's records: how many fit, and
// the ones that change (now → becomes). Used by Make it a formula and by
// "Use it" on a rule found in imported data.

const shown = (v: string | null) => (v === null || v === "" ? "empty" : /^-?\d+(\.\d+)?$/.test(v) ? formatNumber(Number(v)) : v);

export function ChangePreview({ table, check }: { table: string; check: ConvertCheck }) {
  const p = check.proof;
  if (!p) return null;
  return (
    <>
      <Text size="sm">
        {p.checked
          ? `Checked on every record: it fits ${formatNumber(p.fits)} of ${formatNumber(p.checked)}.`
          : "No record has a value here yet."}
        {p.fills ? ` ${pluralize(p.fills, "empty one")} will be filled.` : ""}
      </Text>
      {p.differ > 0 && (
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />} title={`${pluralize(p.differ, "record")} will change`} styles={{ body: { minWidth: 0 } }}>
          <Text size="sm" mb={6}>
            Their value now isn't what the formula gives (typed by hand, or a mistake). They get the formula's value.
          </Text>
          <Box style={{ overflowX: "auto" }}>
            <Table fz="sm" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">Record</Table.Th>
                  <Table.Th scope="col" ta="right">Now</Table.Th>
                  <Table.Th scope="col" ta="right">Becomes</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {check.examples.map((e) => (
                  <Table.Tr key={e.id}>
                    <Table.Td>
                      <Anchor component={Link} to={recordPath(table, e.id)} size="sm" target="_blank">
                        {e.title || "Open"}
                      </Anchor>
                    </Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{shown(e.now)}</Table.Td>
                    <Table.Td ta="right" className="tabular-nums">{shown(e.becomes)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Box>
          {p.differ > check.examples.length && (
            <Text size="xs" c="dimmed" mt={4}>
              and {pluralize(p.differ - check.examples.length, "more")}
            </Text>
          )}
        </Alert>
      )}
    </>
  );
}
