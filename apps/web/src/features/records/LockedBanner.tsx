import { useState } from "react";
import { Alert, Anchor, Button, Group, Modal, Select, Stack, Text, Textarea } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import api, { errorMessage } from "../../api/api";
import { recordPath, tableTitle } from "../../layout/nav";

// A record locked at a status ("Paid"): nobody can change or delete it. A
// Manager of the app (or an admin) can reopen it with a reason
// (POST /table/:t/:id/reopen; the server checks everything, see schema/locks.ts).
export type RecordLock = {
  column: string;
  label: string; // the column's label: "Status"
  status: string; // "Paid"
  parent: { table: string; id: string } | null; // a line of a locked record
  canReopen: boolean;
  reopenTo: string[];
};

export function LockedBanner({ table, id, lock }: { table: string; id: string; lock: RecordLock }) {
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  const [reason, setReason] = useState("");
  const [to, setTo] = useState<string | null>(lock.reopenTo[0] ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reopen = async () => {
    if (!reason.trim()) return setError("Say why it's reopened");
    setBusy(true);
    setError(null);
    try {
      await api.post(`/table/${table}/${id}/reopen`, { reason: reason.trim(), to });
      notifications.show({ message: "Reopened: it can be changed again", color: "green" });
      setOpened(false);
      setReason("");
      for (const key of ["singleData", "tableData", "sheet", "related"]) await qc.invalidateQueries({ queryKey: [key] });
      await qc.invalidateQueries({ queryKey: ["audit", "record", table, id] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Alert color="orange" variant="light" icon={<IconLock size={18} />} mb="lg" title={`Locked: ${lock.label} is ${lock.status}`}>
        <Group justify="space-between" gap="sm" wrap="wrap">
          <Text size="sm">
            {lock.parent ? (
              <>
                It belongs to a{" "}
                <Anchor component={Link} to={recordPath(lock.parent.table, lock.parent.id)} inherit>
                  locked {tableTitle(lock.parent.table).toLowerCase()} record
                </Anchor>
                , so nobody can change or delete it.
              </>
            ) : (
              <>Nobody can change or delete it. {lock.canReopen ? "To fix something, reopen it." : "A manager of this app can reopen it."}</>
            )}
          </Text>
          {lock.canReopen && (
            <Button size="xs" variant="default" leftSection={<IconLock size={14} />} onClick={() => setOpened(true)}>
              Reopen
            </Button>
          )}
        </Group>
      </Alert>

      <Modal opened={opened} onClose={() => setOpened(false)} title="Reopen this record">
        <Stack>
          <Text size="sm" c="dimmed">
            It can be changed again until it's {lock.status} once more. Your reason is kept in the audit log.
          </Text>
          <Textarea
            label="Why?"
            placeholder="e.g. The amount was wrong"
            withAsterisk
            autosize
            minRows={2}
            maxLength={500}
            data-autofocus
            value={reason}
            onChange={(e) => {
              setReason(e.currentTarget.value);
              setError(null);
            }}
            error={error}
          />
          <Select
            label={`${lock.label} after reopening`}
            data={lock.reopenTo}
            value={to}
            onChange={setTo}
            allowDeselect={false}
            comboboxProps={{ withinPortal: false }}
          />
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setOpened(false)}>
              Cancel
            </Button>
            <Button color="orange" loading={busy} disabled={!to} onClick={reopen}>
              Reopen
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
