import { BarChart, DonutChart, LineChart } from "@mantine/charts";
import { Box, Text } from "@mantine/core";

import { formatNumber } from "../../lib/format";
import type { RecordColumn } from "./schema";
import { groupColor, type Summary, type SummaryChartKind, type SummaryGroup } from "./summary";

// The Summary view's chart (reports part 2), from the same numbers as its
// table. One series in the app's colour (bars, or a line for months); a
// donut only for a choice or Yes/No, in the options' own colours, with the
// table below as its legend. Loaded only when the Summary view is opened.

const MAX_BARS = 30;

export default function SummaryChart({
  summary,
  groupBy,
  kind,
  onOpenGroup,
}: {
  summary: Summary;
  groupBy: RecordColumn;
  kind: SummaryChartKind;
  onOpenGroup: (group: SummaryGroup) => void;
}) {
  const name = summary.fn === "count" ? "Records" : `${summary.fn === "sum" ? "Total" : "Average"} ${summary.field?.label ?? ""}`;
  // groups without a number (an average of nothing) aren't drawn
  const groups = summary.groups.filter((g) => g.value !== null).slice(0, MAX_BARS);
  const data = groups.map((g) => ({ group: g.label, value: g.value ?? 0 }));
  const cut = summary.groups.length > MAX_BARS;
  const open = (index: number) => {
    const g = groups[index];
    if (g) onOpenGroup(g);
  };
  const format = (v: number) => formatNumber(v);

  if (kind === "donut") {
    return (
      <Box py="xs" style={{ display: "flex", justifyContent: "center" }}>
        <DonutChart
          data={groups.map((g) => ({ name: g.label, value: g.value ?? 0, color: groupColor(groupBy, g) }))}
          size={200}
          thickness={28}
          paddingAngle={2}
          withTooltip
          tooltipDataSource="segment"
          valueFormatter={format}
          chartLabel={formatNumber(summary.total.value ?? summary.total.count)}
          pieProps={{ onClick: (_: unknown, index: number) => open(index), cursor: "pointer" }}
          aria-label={`${name} by ${summary.groupBy.label}: donut chart`}
        />
      </Box>
    );
  }

  const common = {
    data,
    dataKey: "group",
    series: [{ name: "value", label: name, color: "var(--mantine-primary-color-filled)" }],
    valueFormatter: format,
    tickLine: "none" as const,
    // a line: horizontal guide lines, to read the values
    gridAxis: kind === "line" ? ("x" as const) : ("none" as const),
    withLegend: false,
  };

  return (
    <Box>
      {kind === "line" ? (
        <LineChart
          {...common}
          h={240}
          curveType="monotone"
          strokeWidth={2}
          dotProps={{ r: 4 }}
          activeDotProps={{ r: 6, cursor: "pointer" }}
          // a click anywhere on a month opens its records
          lineChartProps={{ onClick: (state: { activeTooltipIndex?: number } | null) => open(state?.activeTooltipIndex ?? -1), style: { cursor: "pointer" } }}
          aria-label={`${name} by ${summary.groupBy.label}: line chart`}
        />
      ) : summary.groupBy.type === "date" ? (
        // months: columns left to right, oldest first
        <BarChart
          {...common}
          h={240}
          barProps={{ radius: [4, 4, 0, 0], onClick: (_: unknown, index: number) => open(index), cursor: "pointer" }}
          maxBarWidth={48}
          aria-label={`${name} by ${summary.groupBy.label}: bar chart`}
        />
      ) : (
        // names: bars across, so long names stay readable
        <BarChart
          {...common}
          h={Math.min(640, Math.max(140, data.length * 34 + 40))}
          orientation="vertical"
          yAxisProps={{ width: 120 }}
          barProps={{ radius: [0, 4, 4, 0], onClick: (_: unknown, index: number) => open(index), cursor: "pointer" }}
          maxBarWidth={22}
          aria-label={`${name} by ${summary.groupBy.label}: bar chart`}
        />
      )}
      {cut && (
        <Text size="xs" c="dimmed" mt={4}>
          The chart shows the first {MAX_BARS}; the table below has them all.
        </Text>
      )}
    </Box>
  );
}
