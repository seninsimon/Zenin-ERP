import { useState } from "react";
import { Accordion, Alert, Badge, Button, Checkbox, FileInput, Group, Modal, ScrollArea, Stack, Table, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconAlertTriangle, IconCircleCheck, IconDownload, IconFileTypeCsv, IconInfoCircle, IconKey } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";

import api, { errorMessage } from "../../api/api";
import type { AppAccessOption } from "../../api/reactQueryHooks/useAdmin";
import { confirmDanger } from "../../components/ui/confirm";
import { pluralize } from "../../lib/format";

// Administration → Users → Import people: many logins from one CSV file.
// Choose a file, Check it (nothing is saved), then Add. Everyone added is a
// Member; people with an email get the welcome link (when email is set up),
// the others a temporary password, shown once, which they change at first
// sign-in. The server does the checking (controllers/peopleImport.ts).

type CheckedRow = {
  line: number;
  fullName: string;
  username: string;
  email: string;
  departments: string[];
  access: Record<string, string>;
  gets: "link" | "password";
  problems: string[];
};
type Checked = { rows: CheckedRow[]; ready: number; withProblems: number; mailWorks: boolean; ignoredColumns: string[]; hasDirectory: boolean };
type Imported = { message: string; added: number; invited: number; withPassword: number; notAdded: number; problemsCsv: string | null; passwordsCsv: string | null };

const MAX_SIZE = 2 * 1024 * 1024; // 500 people fit easily
// about Gmail's daily limit: more welcome emails than this, and a note
const MANY_EMAILS = 300;

function save(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadTemplate() {
  const { data } = await api.get<string>("/users/import/template", { responseType: "text" });
  save("people-template.csv", data);
}

function RowCheck({ row }: { row: CheckedRow }) {
  return row.problems.length ? (
    <Text size="sm" c="var(--mantine-color-error)">
      {row.problems.join("; ")}
    </Text>
  ) : (
    <Text size="sm" c="teal">
      {row.gets === "link" ? "OK · welcome email" : "OK · temporary password"}
    </Text>
  );
}

export function ImportPeopleModal({ opened, onClose, apps }: { opened: boolean; onClose: () => void; apps: AppAccessOption[] }) {
  const fullScreen = useMediaQuery("(max-width: 36em)");
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState("");
  const [checked, setChecked] = useState<Checked | null>(null);
  const [directory, setDirectory] = useState(true);
  const [done, setDone] = useState<Imported | null>(null);
  const [savedPasswords, setSavedPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setCsv("");
    setChecked(null);
    setDone(null);
    setSavedPasswords(false);
    setError(null);
  };
  const close = () => {
    if (done?.passwordsCsv && !savedPasswords) {
      confirmDanger({
        title: "Close without the passwords?",
        message: "The temporary passwords are shown only now. Without the file you'd have to reset each person's password yourself.",
        confirmLabel: "Close anyway",
        onConfirm: () => {
          reset();
          onClose();
        },
      });
      return;
    }
    reset();
    onClose();
  };

  const check = async () => {
    setError(null);
    if (!file) return setError("Choose a CSV file.");
    if (file.size > MAX_SIZE) return setError("The file is larger than 2 MB. Split it into smaller files.");
    setBusy(true);
    try {
      const text = await file.text();
      const { data } = await api.post<Checked>("/users/import/check", { csv: text });
      setCsv(text);
      setChecked(data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't read the file."));
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!checked) return;
    setError(null);
    setBusy(true);
    try {
      const { data } = await api.post<Imported>("/users/import", { csv, addToDirectory: checked.hasDirectory && directory });
      setDone(data);
      qc.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(errorMessage(err, "Couldn't add them."));
    } finally {
      setBusy(false);
    }
  };

  const links = checked?.rows.filter((r) => !r.problems.length && r.gets === "link").length ?? 0;
  const passwords = (checked?.ready ?? 0) - links;
  const title = done ? "People added" : checked ? "Check before adding" : "Import people";

  return (
    <Modal opened={opened} onClose={close} title={title} size="xl" fullScreen={fullScreen}>
      {done ? (
        <Stack>
          <Alert color="green" icon={<IconCircleCheck size={16} />} role="status">
            {done.message}.{" "}
            {done.invited > 0 && `${pluralize(done.invited, "welcome email")} on the way. `}
            {done.withPassword > 0 && `${pluralize(done.withPassword, "person", "people")} with a temporary password.`}
          </Alert>
          {done.passwordsCsv && (
            <Alert color="yellow" icon={<IconKey size={16} />} title="Download the temporary passwords now">
              <Stack gap="xs" align="flex-start">
                <Text size="sm">
                  They're shown only now. Give each person their username and password (in person or by phone, not in a group chat).
                  At first sign-in they choose their own.
                </Text>
                <Button
                  leftSection={<IconDownload size={16} />}
                  onClick={() => {
                    save("temporary-passwords.csv", done.passwordsCsv!);
                    setSavedPasswords(true);
                  }}
                >
                  Download passwords
                </Button>
              </Stack>
            </Alert>
          )}
          {done.problemsCsv && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} title={`${pluralize(done.notAdded, "row")} not added`}>
              <Stack gap="xs" align="flex-start">
                <Text size="sm">Download them with a "Problem" column, fix them, and import that file again.</Text>
                <Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => save("people-to-fix.csv", done.problemsCsv!)}>
                  Download rows to fix
                </Button>
              </Stack>
            </Alert>
          )}
          <Group justify="flex-end">
            <Button onClick={close}>Done</Button>
          </Group>
        </Stack>
      ) : checked ? (
        <Stack>
          <Group gap="xs">
            <Badge color="teal" variant="light" size="lg">
              {pluralize(checked.ready, "person", "people")} ready
            </Badge>
            {checked.withProblems > 0 && (
              <Badge color="red" variant="light" size="lg">
                {pluralize(checked.withProblems, "row")} with problems
              </Badge>
            )}
          </Group>
          <Text size="sm">
            {links > 0 && `${pluralize(links, "person", "people")} will get a welcome email to choose a password. `}
            {passwords > 0 && `${pluralize(passwords, "person", "people")} will get a temporary password that you hand out; they choose their own at first sign-in.`}
            {checked.withProblems > 0 && " Rows with problems are left out; you can download them afterwards to fix."}
          </Text>
          {!checked.mailWorks && passwords > 0 && (
            <Text size="xs" c="dimmed">
              Set up email in Administration → Email, and people with an email address get a welcome email instead.
            </Text>
          )}
          {links > MANY_EMAILS && (
            <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />}>
              <Text size="sm">Gmail sends about 500 emails a day. For this many people, think about importing in parts on different days.</Text>
            </Alert>
          )}
          {checked.ignoredColumns.length > 0 && (
            <Text size="xs" c="dimmed">
              Not used: {checked.ignoredColumns.join(", ")} (not a column of the template).
            </Text>
          )}

          <ScrollArea.Autosize mah="45vh" type="auto">
            {/* phones: access and the check sit under the person, no sideways scrolling */}
            <Table fz="sm" verticalSpacing={6} striped stickyHeader>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">Line</Table.Th>
                  <Table.Th scope="col">Person</Table.Th>
                  {!fullScreen && <Table.Th scope="col">Access</Table.Th>}
                  {!fullScreen && <Table.Th scope="col">Check</Table.Th>}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {checked.rows.map((r) => {
                  const access = Object.entries(r.access)
                    .map(([app, level]) => `${app}: ${level}`)
                    .join(", ");
                  return (
                    <Table.Tr key={r.line}>
                      <Table.Td c="dimmed">{r.line}</Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={500}>
                          {r.fullName || "—"}
                        </Text>
                        <Text size="xs" c="dimmed">
                          @{r.username || "—"}
                          {r.email && ` · ${r.email}`}
                          {r.departments.length > 0 && ` · ${r.departments.join(", ")}`}
                        </Text>
                        {fullScreen && access && <Text size="xs">{access}</Text>}
                        {fullScreen && <RowCheck row={r} />}
                      </Table.Td>
                      {!fullScreen && (
                        <Table.Td>
                          {access || (
                            <Text span c="dimmed" size="sm">
                              None yet
                            </Text>
                          )}
                        </Table.Td>
                      )}
                      {!fullScreen && (
                        <Table.Td>
                          <RowCheck row={r} />
                        </Table.Td>
                      )}
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>

          {checked.hasDirectory && (
            <Checkbox
              label="Add them to the People directory too"
              description="Each gets an entry there, linked to their login"
              checked={directory}
              onChange={(e) => setDirectory(e.currentTarget.checked)}
            />
          )}
          {error && (
            <Text size="sm" c="var(--mantine-color-error)" role="alert">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setChecked(null)}>
              Back
            </Button>
            <Button onClick={add} loading={busy} disabled={!checked.ready}>
              {checked.ready ? `Add ${pluralize(checked.ready, "person", "people")}` : "Nothing to add"}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="sm" c="dimmed">
              Start from the template: one row per person. Fill it in Excel, LibreOffice or Google Sheets and save it as CSV. Up to 500 people per file.
            </Text>
            <Button
              variant="default"
              leftSection={<IconDownload size={16} />}
              onClick={() => downloadTemplate().catch((err) => setError(errorMessage(err)))}
              style={{ flexShrink: 0 }}
            >
              Download template
            </Button>
          </Group>

          <Accordion variant="contained" radius="md">
            <Accordion.Item value="columns">
              <Accordion.Control>What goes in each column</Accordion.Control>
              <Accordion.Panel>
                <Table fz="sm" verticalSpacing={4}>
                  <Table.Tbody>
                    <Table.Tr>
                      <Table.Td style={{ whiteSpace: "nowrap" }}>
                        Full name{" "}
                        <Badge size="xs" variant="light" color="red">
                          Required
                        </Badge>
                      </Table.Td>
                      <Table.Td c="dimmed">Like Meera Nair</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Username</Table.Td>
                      <Table.Td c="dimmed">For signing in. Leave empty and one is made from the email or name (meera.nair)</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Email</Table.Td>
                      <Table.Td c="dimmed">With an email, they get a welcome email to choose their password</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Phone</Table.Td>
                      <Table.Td c="dimmed">Any format</Table.Td>
                    </Table.Tr>
                    <Table.Tr>
                      <Table.Td>Departments</Table.Td>
                      <Table.Td c="dimmed">Department names, separated by ; (Sales; Support)</Table.Td>
                    </Table.Tr>
                    {apps.map((a) => (
                      <Table.Tr key={a.key}>
                        <Table.Td>{a.name}</Table.Td>
                        <Table.Td c="dimmed">{[...a.levels.map((l) => l.label), "or empty for no access"].join(", ")}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>

          <FileInput
            label="CSV file"
            placeholder="Choose a .csv file"
            accept=".csv,text/csv"
            leftSection={<IconFileTypeCsv size={16} />}
            value={file}
            onChange={(f) => {
              setFile(f);
              setError(null);
            }}
            clearable
            withAsterisk
          />

          <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />}>
            <Text size="xs">
              Everyone is added as a regular person, never as an Administrator. Nothing is saved until you've checked the file and
              pressed Add.
            </Text>
          </Alert>

          {error && (
            <Text size="sm" c="var(--mantine-color-error)" role="alert">
              {error}
            </Text>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={close}>
              Cancel
            </Button>
            <Button onClick={check} loading={busy} disabled={!file}>
              Check file
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
