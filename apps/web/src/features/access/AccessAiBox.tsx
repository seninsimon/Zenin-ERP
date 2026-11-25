import { useState } from "react";
import { Alert, Badge, Button, Group, List, Paper, Stack, Text, Textarea } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconSparkles } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import api, { errorMessage } from "../../api/api";
import { HelpTip } from "../../components/ui/HelpTip";

// Users → "Tell Zenin what to change" (AI · Beta, admins): say what you want
// in plain words. The AI answers questions, or suggests a change with a
// preview of exactly what it does for each person. Nothing changes until
// Apply. See docs/WORKFLOW.md "Change access with AI".

type Turn = { role: "user" | "assistant"; content: string };
type Proposal = {
  summary: string;
  steps: string[];
  people: { name: string; lines: string[] }[];
  warnings: string[];
  changes: unknown[];
};

export function AccessAiBox() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["accessAi"],
    queryFn: async () => (await api.get<{ available: boolean }>("/ai/access")).data,
    staleTime: 60_000,
  });
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: async (next: Turn[]) =>
      (await api.post<{ answer: string; proposal: Proposal | null }>("/ai/access", { turns: next }, { timeout: 180_000 })).data,
  });
  const apply = useMutation({
    mutationFn: async (p: Proposal) => (await api.post("/ai/access/apply", { summary: p.summary, changes: p.changes })).data,
    onSuccess: () => {
      for (const key of ["users", "accessLevels", "roles", "appAccessOptions", "tables", "schema", "tableUse"]) qc.invalidateQueries({ queryKey: [key] });
      notifications.show({ title: "Applied", message: "Access is changed", color: "green" });
    },
  });

  if (!data?.available) return null;

  const send = () => {
    const question = text.trim();
    if (!question) return;
    const next: Turn[] = [...turns, { role: "user", content: question }];
    setError(null);
    setProposal(null);
    ask.mutateAsync(next).then(
      (res) => {
        setTurns([...next, { role: "assistant", content: res.answer }]);
        setProposal(res.proposal);
        setText("");
      },
      (err) => setError(errorMessage(err))
    );
  };
  const answer = [...turns].reverse().find((t) => t.role === "assistant")?.content;

  return (
    <Paper withBorder radius="lg" p="md" mb="lg">
      <Stack gap="sm">
        <Group gap="xs" wrap="nowrap">
          <IconSparkles size={18} />
          <Text fw={600}>Tell Zenin what to change</Text>
          <Badge size="xs" variant="light" color="violet">
            AI · Beta
          </Badge>
          <HelpTip topic="accessAi" size={14} />
        </Group>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <Textarea
              aria-label="What should change"
              placeholder="e.g. Let Senin edit leave requests. Or ask: what can Asha do?"
              autosize
              minRows={1}
              maxRows={4}
              maxLength={2000}
              style={{ flex: 1 }}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <Button type="submit" loading={ask.isPending} disabled={!text.trim()}>
              Ask
            </Button>
          </Group>
        </form>
        {ask.isPending && (
          <Text size="sm" c="dimmed">
            Looking it up… this can take a few seconds.
          </Text>
        )}
        {error && (
          <Alert color="red" p="sm">
            {error}
          </Alert>
        )}
        {answer && !ask.isPending && (
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
            {answer}
          </Text>
        )}

        {proposal && !ask.isPending && (
          <Paper withBorder radius="md" p="md" bg="var(--app-muted)">
            <Stack gap="sm">
              <Text fw={600}>Suggested: {proposal.summary}</Text>
              <div>
                <Text size="sm" fw={500}>
                  What changes
                </Text>
                <List size="sm" spacing={2}>
                  {proposal.steps.map((s) => (
                    <List.Item key={s}>{s}</List.Item>
                  ))}
                </List>
              </div>
              <div>
                <Text size="sm" fw={500}>
                  For each person
                </Text>
                <Stack gap={4}>
                  {proposal.people.map((p) => (
                    <div key={p.name}>
                      <Text size="sm" fw={600}>
                        {p.name}
                      </Text>
                      {p.lines.map((l) => (
                        <Text key={l} size="sm" pl="sm">
                          {l}
                        </Text>
                      ))}
                    </div>
                  ))}
                </Stack>
              </div>
              {proposal.warnings.map((w) => (
                <Text key={w} size="sm" c="var(--mantine-color-yellow-light-color)">
                  <IconAlertTriangle size={14} style={{ verticalAlign: "-2px" }} /> {w}
                </Text>
              ))}
              <Text size="xs" c="dimmed">
                AI can make mistakes: read what changes before you apply it. Nothing has changed yet.
              </Text>
              <Group justify="flex-end" gap="xs">
                <Button variant="default" onClick={() => setProposal(null)}>
                  Discard
                </Button>
                <Button
                  leftSection={<IconCheck size={16} />}
                  loading={apply.isPending}
                  onClick={() =>
                    apply.mutateAsync(proposal).then(
                      () => {
                        setProposal(null);
                        setTurns((t) => [...t, { role: "assistant", content: "Applied." }]);
                      },
                      (err) => setError(errorMessage(err))
                    )
                  }
                >
                  Apply
                </Button>
              </Group>
            </Stack>
          </Paper>
        )}
        {turns.length > 0 && !ask.isPending && (
          <Group>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => {
                setTurns([]);
                setProposal(null);
                setError(null);
              }}
            >
              Start over
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
