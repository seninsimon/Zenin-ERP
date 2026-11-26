import { lazy, Suspense, useEffect, useState } from "react";
import { Alert, Box, Button, ColorSwatch, Group, Loader, Modal, SegmentedControl, Skeleton, Stack, Table, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import { IconChartBar, IconChartDonut, IconChartLine, IconPin } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCurrentUser } from "../../auth/AuthContext";

import api, { errorMessage, type ListFilter } from "../../api/api";
import type { Filter } from "../../components/data-table";
import { chartKinds, fetchSummary, groupColor, groupFilter, measureLabel, summaryKey, type SummaryChartKind } from "./summary";

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
  const query = useQuery({
    queryKey: summaryKey(table, groupBy.name, show, search, filters),
    queryFn: () => fetchSummary(table, groupBy.name, show, search, filters),
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
  const title = `${measureLabel(s.fn, s.field?.label ?? "")} by ${s.groupBy.label.toLowerCase()}${groupBy.type === "date" ? " (month)" : ""}`;
  const counting = s.fn === "count";
  const valueTitle = counting ? null : measureLabel(s.fn, s.field?.label ?? "");
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
          {title}
        </Text>
        <Group gap="xs">
        <PinToHome table={table} groupBy={groupBy.name} show={show} chart={kind} filters={filters} search={search} suggested={title} />
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

// Admins: save this summary (with its chart and filters) as a report on Home,
// in its app's block. Everyone who can see the table sees it, with their own numbers.
function PinToHome({
  table,
  groupBy,
  show,
  chart,
  filters,
  search,
  suggested,
}: {
  table: string;
  groupBy: string;
  show: string;
  chart: SummaryChartKind;
  filters: ListFilter[];
  search: string;
  suggested: string;
}) {
  const { isAdmin } = useCurrentUser();
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [name, setName] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!isAdmin) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/reports", { name: name.trim(), table, groupBy, show, chart, filters });
      await qc.invalidateQueries({ queryKey: ["dashboards"] });
      notifications.show({ message: "Pinned to Home", color: "green" });
      setOpened(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="xs"
        variant="default"
        leftSection={<IconPin size={14} />}
        onClick={() => {
          setName(suggested);
          setOpened(true);
        }}
      >
        Pin to Home
      </Button>
      <Modal opened={opened} onClose={() => setOpened(false)} title="Pin to Home">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Stack>
            <Text size="sm" c="dimmed">
              It shows in this app on Home, with this chart{filters.length ? " and these filters" : ""}. Everyone who can see the table sees it, counting
              only the records they may see.{search ? " The search box isn't kept." : ""}
            </Text>
            <TextInput label="Name" withAsterisk maxLength={80} data-autofocus value={name} onChange={(e) => setName(e.currentTarget.value)} error={error} />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setOpened(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>
                Pin to Home
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}
