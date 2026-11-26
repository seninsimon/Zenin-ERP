import { lazy, Suspense, useState } from "react";
import { ActionIcon, Box, Button, Group, Menu, Modal, Paper, Skeleton, Stack, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconDots, IconPencil, IconPinnedOff } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import api, { errorMessage, type ListFilter } from "../api/api";
import { useSchema } from "../api/reactQueryHooks/useTables";
import { useCurrentUser } from "../auth/AuthContext";
import { confirmDanger } from "../components/ui/confirm";
import { tablePath } from "../layout/nav";
import { formatNumber } from "../lib/format";
import type { TableSchemaInfo } from "./records/schema";
import { chartKinds, fetchSummary, groupFilter, summaryKey, summaryPath, type SummaryChartKind } from "./records/summary";

// A saved report on Home, in its app's block (reports part 3): its name and
// total, a compact chart (the numbers come from the table's summary, with the
// viewer's own permissions), and a click to the full Summary view. Admins
// rename it or take it off Home.

const SummaryChart = lazy(() => import("./records/SummaryChart"));

export type HomeReport = {
  id: string;
  name: string;
  table: string;
  groupBy: string;
  show: string;
  chart: string | null;
  filters: ListFilter[];
  problem?: string;
};

export function ReportCard({ report }: { report: HomeReport }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isAdmin } = useCurrentUser();
  const schema = useSchema(report.table).data as TableSchemaInfo | undefined;
  const groupBy = schema?.columns.find((c) => c.name === report.groupBy);
  const summary = useQuery({
    queryKey: summaryKey(report.table, report.groupBy, report.show, "", report.filters),
    queryFn: () => fetchSummary(report.table, report.groupBy, report.show, "", report.filters),
    enabled: !report.problem,
    staleTime: 60_000,
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const kinds = groupBy ? chartKinds(groupBy, report.show) : ["bar" as SummaryChartKind];
  const kind = kinds.find((k) => k === report.chart) ?? kinds[0];
  const open = () => navigate(summaryPath(report.table, report));
  const refresh = () => qc.invalidateQueries({ queryKey: ["dashboards"] });

  const rename = async () => {
    try {
      await api.put(`/reports/${report.id}`, { name: renaming?.trim() });
      await refresh();
      setRenaming(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const remove = () =>
    confirmDanger({
      title: "Take it off Home?",
      message: `"${report.name}" is removed from Home. The table and its records stay; you can pin it again from its Summary.`,
      confirmLabel: "Take off Home",
      onConfirm: async () => {
        await api.delete(`/reports/${report.id}`);
        await refresh();
        notifications.show({ message: "Taken off Home", color: "green" });
      },
    });

  const total = summary.data?.total;
  return (
    <Paper p="md" radius="lg" bg="var(--app-surface)" style={{ border: "1px solid var(--app-border)" }}>
      <Group justify="space-between" wrap="nowrap" gap="xs" mb="sm" align="flex-start">
        <UnstyledButton onClick={open} style={{ minWidth: 0 }} aria-label={`${report.name}: open the summary`}>
          <Text fw={600} size="sm" truncate>
            {report.name}
          </Text>
          {total && (
            <Text size="xs" c="dimmed" className="tabular-nums">
              {summary.data?.fn === "count" ? `${formatNumber(total.count)} records` : `All: ${total.value === null ? "—" : formatNumber(total.value)}`}
            </Text>
          )}
        </UnstyledButton>
        {isAdmin && (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label={`${report.name}: more`}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconPencil size={16} />} onClick={() => setRenaming(report.name)}>
                Rename
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconPinnedOff size={16} />} onClick={remove}>
                Take off Home
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>

      {report.problem ? (
        <Text size="sm" c="dimmed">
          {report.problem}. Take it off Home, or pin a new one from the table's Summary.
        </Text>
      ) : summary.isLoading || !groupBy ? (
        <Skeleton h={160} />
      ) : summary.isError ? (
        <Text size="sm" c="dimmed">
          {errorMessage(summary.error, "Couldn't work it out")}
        </Text>
      ) : !summary.data?.total.count ? (
        <Text size="sm" c="dimmed" py="md">
          No records yet.
        </Text>
      ) : (
        <Suspense fallback={<Skeleton h={160} />}>
          <Box>
            <SummaryChart
              compact
              summary={summary.data}
              groupBy={groupBy}
              kind={kind}
              onOpenGroup={(g) => navigate(`${tablePath(report.table)}?f=${encodeURIComponent(JSON.stringify([...report.filters, groupFilter(groupBy, g)]))}`)}
            />
          </Box>
        </Suspense>
      )}

      <Modal opened={renaming !== null} onClose={() => setRenaming(null)} title="Rename report">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
        >
          <Stack>
            <TextInput label="Name" withAsterisk maxLength={80} data-autofocus value={renaming ?? ""} onChange={(e) => setRenaming(e.currentTarget.value)} error={error} />
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!renaming?.trim()}>
                Save
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Paper>
  );
}
