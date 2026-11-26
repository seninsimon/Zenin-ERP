import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Box, ColorSwatch, Group, Loader, SegmentedControl, Skeleton, Table, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChartBar, IconChartDonut, IconChartLine } from "@tabler/icons-react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import api, { errorMessage, type ListFilter } from "../../api/api";
import type { Filter } from "../../components/data-table";
import { chartKinds, groupColor, groupFilter, type Summary, type SummaryChartKind } from "./summary";

// the chart library loads only when a summary is shown
const SummaryChart = lazy(() => import("./SummaryChart"));

const CHART_LABELS: Record<SummaryChartKind, { label: string; icon: typeof IconChartBar }> = {
  bar: { label: "Bars", icon: IconChartBar },
  line: { label: "Line", icon: IconChartLine },
  donut: { label: "Donut", icon: IconChartDonut },
};
import { formatNumber, pluralize } from "../../lib/format";
import { useLiveChanges } from "../live/live";
import { columnLabel, type RecordColumn } from "./schema";
import classes from "./summary.module.css";

// Summary on any list (workspace/REPORTS_PLAN.md, part 1): the records grouped
// by one column, with the count or the sum / average of a number column.
// Worked out by the server (GET /table/:t/summary), with the list's search,
// filters and the person's permissions. Click a group to see its records.

export function SummaryView({
  table,
  groupBy,
  show,
  search,
  filters,
  chart,
  onChartChange,
  onOpenGroup,
}: {
  table: string;
  groupBy: RecordColumn;
  show: string; // "count" | "sum:amount" | "avg:amount"
  search: string;
  filters: ListFilter[];
  // the chart chosen (from the address); the first that fits when not set
  chart: string | null;
  onChartChange: (kind: SummaryChartKind) => void;
  onOpenGroup: (filter: Filter) => void;
}) {
  const [fn, field] = show.includes(":") ? show.split(":") : ["count", ""];
  const query = useQuery({
    queryKey: ["summary", table, groupBy.name, fn, field, search, filters],
    queryFn: async () =>
      (
        await api.get<Summary>(`/table/${encodeURIComponent(table)}/summary`, {
          params: { groupBy: groupBy.name, fn, field: field || undefined, search: search || undefined, filters: filters.length ? JSON.stringify(filters) : undefined },
        })
      ).data,
    placeholderData: keepPreviousData,
  });
  // others' changes: the numbers follow
  const [since] = useState(() => Date.now());
  const changes = useLiveChanges(table, since);
  const { refetch } = query;
  useEffect(() => {
    if (changes.length) void refetch();
  }, [changes.length, refetch]);

  if (query.isLoading) return <Loader size="sm" />;
  if (query.error || !query.data) return <Alert color="red">{errorMessage(query.error, "Couldn't work out the summary")}</Alert>;

  const s = query.data;
  const kinds = chartKinds(groupBy, show);
  const kind: SummaryChartKind = kinds.find((k) => k === chart) ?? kinds[0];
  const counting = s.fn === "count";
  const valueTitle = counting ? null : `${s.fn === "sum" ? "Total" : "Average"} ${s.field?.label ?? ""}`;
  const shown = (v: number | null) => (v === null ? "—" : formatNumber(v));

  if (!s.total.count) {
    return (
      <Text size="sm" c="dimmed" py="lg" ta="center">
        No records to summarise{search || filters.length ? " with this search and these filters" : ""}.
      </Text>
    );
  }

  return (
    <Box>
      <Group justify="space-between" mb="xs" gap="xs">
        <Text size="sm" fw={600}>
          {s.fn === "count" ? "Records" : `${s.fn === "sum" ? "Total" : "Average"} ${s.field?.label ?? ""}`} by {s.groupBy.label.toLowerCase()}
          {groupBy.type === "date" ? " (month)" : ""}
        </Text>
        {kinds.length > 1 && (
          <SegmentedControl
            size="xs"
            aria-label="Chart"
            value={kind}
            onChange={(v) => onChartChange(v as SummaryChartKind)}
            data={kinds.map((k) => {
              const { label, icon: I } = CHART_LABELS[k];
              return {
                value: k,
                label: (
                  <Group gap={4} wrap="nowrap">
                    <I size={14} aria-hidden />
                    {label}
                  </Group>
                ),
              };
            })}
          />
        )}
      </Group>
      <Box mb="md">
        <Suspense fallback={<Skeleton h={220} />}>
          <SummaryChart summary={s} groupBy={groupBy} kind={kind} onOpenGroup={(g) => onOpenGroup(groupFilter(groupBy, g))} />
        </Suspense>
      </Box>
      <Table verticalSpacing={8} highlightOnHover className={classes.summary} aria-label={`${columnLabel(groupBy)}: summary`}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th scope="col">{s.groupBy.label}</Table.Th>
            <Table.Th scope="col" ta="right" w={110}>
              Records
            </Table.Th>
            {valueTitle && (
              <Table.Th scope="col" ta="right" w={150}>
                {valueTitle}
              </Table.Th>
            )}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {s.groups.map((g) => (
            <Table.Tr key={g.key ?? "__empty"}>
              <Table.Td>
                <Tooltip label={`Show these ${pluralize(g.count, "record")}`} openDelay={400}>
                  <UnstyledButton className={classes.groupButton} onClick={() => onOpenGroup(groupFilter(groupBy, g))}>
                    <Group gap={6} wrap="nowrap">
                      {/* with a donut, the table is its legend */}
                      {kind === "donut" && <ColorSwatch size={10} color={`var(--mantine-color-${groupColor(groupBy, g).replace(".", "-")})`} withShadow={false} aria-hidden />}
                      <Text size="sm" fw={500} c={g.key === null ? "dimmed" : undefined} truncate>
                        {g.label}
                      </Text>
                    </Group>
                  </UnstyledButton>
                </Tooltip>
              </Table.Td>
              <Table.Td ta="right" className={classes.number}>
                {formatNumber(g.count)}
              </Table.Td>
              {valueTitle && (
                <Table.Td ta="right" className={classes.number}>
                  {shown(g.value)}
                </Table.Td>
              )}
            </Table.Tr>
          ))}
          {s.others && (
            <Table.Tr>
              <Table.Td>
                <Text size="sm" c="dimmed">
                  {s.others.label}
                </Text>
              </Table.Td>
              <Table.Td ta="right" className={classes.number}>
                {formatNumber(s.others.count)}
              </Table.Td>
              {valueTitle && (
                <Table.Td ta="right" className={classes.number}>
                  {shown(s.others.value)}
                </Table.Td>
              )}
            </Table.Tr>
          )}
        </Table.Tbody>
        <Table.Tfoot>
          <Table.Tr>
            <Table.Th scope="row">All</Table.Th>
            <Table.Td ta="right" fw={600} className={classes.number}>
              {formatNumber(s.total.count)}
            </Table.Td>
            {valueTitle && (
              <Table.Td ta="right" fw={600} className={classes.number}>
                {shown(s.total.value)}
              </Table.Td>
            )}
          </Table.Tr>
        </Table.Tfoot>
      </Table>
      <Group mt="xs">
        <Text size="xs" c="dimmed">
          Click a row to see its records.
          {groupBy.multiple ? " A record with several values counts in each." : ""}
          {search || filters.length ? " Only records that match the search and filters are counted." : ""}
        </Text>
      </Group>
    </Box>
  );
}
