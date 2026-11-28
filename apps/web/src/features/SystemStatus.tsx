import { Group, Loader, Modal, Progress, Stack, Text } from "@mantine/core";

import { useSystemHealth } from "../api/reactQueryHooks/useHealth";

// Settings → System status: how busy the server is (admins).
export function SystemStatus({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { data, isLoading } = useSystemHealth(opened);
  const row = (label: string, value: number, detail: string, color: string) => (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="sm">{label}</Text>
        <Text size="sm" c="dimmed" className="tabular-nums">
          {detail}
        </Text>
      </Group>
      <Progress value={value} color={value > 85 ? "red" : color} aria-label={`${label} ${value}%`} />
    </Stack>
  );
  return (
    <Modal opened={opened} onClose={onClose} title="System status" size="sm">
      {isLoading || !data ? (
        <Loader size="sm" />
      ) : (
        <Stack>
          {row("CPU", Number(data.cpu), `${data.cpu}%`, "blue")}
          {row("Memory", Number(data.ram), `${data.ramUsed} / ${data.ramTotal} GB`, "teal")}
          {row("Disk", Number(data.disk), `${data.diskUsed} / ${data.diskTotal} GB`, "grape")}
        </Stack>
      )}
    </Modal>
  );
}
